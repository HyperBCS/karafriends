// The API's handlers: one function per method in src/common/api.ts. The
// JSON RPC router (server.ts, for phones) and the display's IPC (ipc.ts)
// call these, through dispatch.ts.
//
// The upstream clients, downloads and live-event sink come in as
// dependencies, and nothing here imports Electron, so unit tests can load
// this file under plain Node with fakes.
import type {
  ApiInput,
  ApiMethod,
  ApiOutput,
  DamArtist,
  DamQueueItem,
  DamSong,
  JoysoundQueueItem,
  NicoQueueItem,
  NicoVideoInfo,
  PoppedDamSong,
  PoppedSong,
  QueueItem,
  UserIdentity,
  VocalType,
  YoutubeQueueItem,
  YoutubeVideoInfo,
} from "../common/api";
import { isAdminPassword } from "../common/adminPassword";
import {
  isToolProblem,
  TOOLS_PROBLEM,
  ytdlpFailureReason,
} from "../common/downloadFailure";
import { isNicoVideoId } from "../common/nicoVideoInfo";
import type { KarafriendsConfig } from "../common/config";
import { songKey } from "../common/currentSong";
import { songFilesOf, type SongFiles } from "../common/songFiles";
import type { AdminSessions } from "./adminAuth";
import type { DkwebsysAPI, MinseiAPI } from "./damApi";
import type { JoysoundAPI } from "./joysoundApi";
import { shareQueueItem, type HubMessage } from "./live";
import { nextOffset } from "./paging";
import type { SettingsMethod } from "./settings";
import {
  currentSongSecondsLeft,
  isDownloading,
  MAX_HISTORY,
  type PendingSong,
  type StateStore,
} from "./state";

// Who is calling: a phone, from its request headers (see caller.ts), with
// null for a missing header; or the display, over IPC (see ipc.ts).
export interface Caller {
  deviceId: string | null;
  nickname: string | null;
  // The admin session the phone signed in to (adminLogin), if any.
  adminToken: string | null;
  // The display window, which is always an admin.
  isDisplay: boolean;
}

// An error the caller caused, with the HTTP status to answer with.
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiHandlers = {
  [M in ApiMethod]: (
    input: ApiInput<M>,
    caller: Caller,
  ) => Promise<ApiOutput<M>>;
};

export interface ApiDeps {
  config: Pick<
    KarafriendsConfig,
    | "adminPasswordHash"
    | "adminPasswordSalt"
    | "everyoneIsAdmin"
    | "paxSongQueueLimit"
    | "supervisedMode"
    | "useLowBitrateUrl"
  >;
  store: StateStore;
  // The phones signed in as admins.
  adminSessions: AdminSessions;
  minsei: Pick<MinseiAPI, "getMusicStreamingUrls" | "getScoringData">;
  dkwebsys: Pick<
    DkwebsysAPI,
    | "getMusicDetailsInfo"
    | "getMusicByKeyword"
    | "getArtistByKeyword"
    | "getMusicListByArtist"
  >;
  joysound: Pick<
    JoysoundAPI,
    | "getSongListByKeyword"
    | "getArtistListByKeyword"
    | "getSongListByArtist"
    | "getSongDetail"
  >;
  // The YouTube client, created on first use.
  youtube: () => Promise<{ getBasicInfo(videoId: string): Promise<unknown> }>;
  getNicoVideoInfo: (videoId: string) => Promise<NicoVideoInfo>;
  // Start a download. The non-DAM ones call onReady once the video is ready
  // to play, and only then is the song queued; or onFailed with a reason for
  // guests if it can't be downloaded. A DAM song is queued at once, and
  // calls onFailed only when DAM sent a sample (its playtime, in seconds,
  // tells).
  downloads: {
    dam(
      url: string,
      songId: string,
      suffix: string,
      playtime: number | null,
      onFailed: (reason: string) => void,
    ): void;
    // The downloads folder (see downloads/folder.ts).
    info(): { files: number; bytes: number };
    clear(inUse: SongFiles[]): {
      deleted: number;
      bytes: number;
      kept: number;
    };
    clearDam(songId: string, suffix: string): boolean;
    joysound(
      item: JoysoundQueueItem,
      pushToHead: boolean,
      onReady: (item: JoysoundQueueItem, pushToHead: boolean) => void,
      onFailed: (reason: string) => void,
    ): void;
    youtube(
      item: YoutubeQueueItem,
      captionCode: string | null,
      onReady: () => void,
      onFailed: (reason: string) => void,
    ): void;
    nico(
      item: NicoQueueItem,
      onReady: () => void,
      onFailed: (reason: string) => void,
    ): void;
  };
  publish: (message: HubMessage) => void;
  now?: () => number;
  // How long popSong waits for DAM (see DAM_POP_TIMEOUT_MS).
  damPopTimeoutMs?: number;
}

// popSong has already started the song when it asks DAM for the song's
// streaming URLs and scoring data, and the display waits for the answer. A
// failing request is tried for a few seconds more (QUICK_RETRIES), and a
// silent server can take 30 seconds a try, so give up after this long, and
// start the song without them: a downloaded song plays from its file, and a
// song without scoring data still plays.
const DAM_POP_TIMEOUT_MS = 10_000;

// promise's outcome, or a rejection after ms. (promise carries on, but its
// outcome is ignored.)
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The most adhoc lyrics one song can show (pushAdhocLyrics). Every live-state
// event carries them all, to every phone, so they must stay small. A singer
// sends a few dozen lines; these leave room to go round a song again.
const MAX_ADHOC_LINES_SHOWN = 400;
const MAX_ADHOC_CHARS_SHOWN = 30_000;

// The most adhoc lyrics the queue holds, all songs together. They are saved
// to queue.json on every change, and one song's may be 100,000 characters.
const MAX_ADHOC_CHARS_QUEUED = 1_000_000;

const totalLength = (lines: readonly string[]) =>
  lines.reduce((sum, line) => sum + line.length, 0);

// How far the display's report of where the song is may be from the
// server's reckoning and change nothing: about the trip over IPC, and not
// worth a new live state for every phone every 10 seconds.
const POSITION_SLACK_MS = 500;

// Song and video IDs end up in file names and yt-dlp arguments.
const SONG_ID = /^[A-Za-z0-9_-]{1,64}$/;

// nicoInfo's answer for an ID that isn't a Niconico video's. The remote
// says it in the phone's language (src/remocon/i18n/reasons.ts).
const NICO_INFO_FAILED = "Failed getting video info. Maybe an invalid VideoID?";

const DEFAULT_LIMIT = { dam: 30, joysound: 100, history: 30 };

// Every method but the settings ones (settings.ts).
export function createApi(
  deps: ApiDeps,
): Omit<ApiHandlers, SettingsMethod> & { resumeDownloads(): void } {
  const { config, store } = deps;
  const now = deps.now ?? Date.now;

  // The display, or a phone signed in with the admin password. Nicknames
  // grant nothing, since anyone can pick any nickname and every phone sees
  // everyone's. Device IDs never leave the server, so they decide whose a
  // song is, but not who is an admin.
  const isRealAdmin = (caller: Caller) =>
    caller.isDisplay || deps.adminSessions.has(caller.adminToken);
  // That, or every phone while everyoneIsAdmin is on.
  const isAdmin = (caller: Caller) =>
    config.everyoneIsAdmin || isRealAdmin(caller);

  // Whether the caller queued item, from the same device (isMine, to the
  // phones).
  const owns = (item: QueueItem | null, caller: Caller) =>
    item !== null &&
    caller.deviceId !== null &&
    item.user.deviceId === caller.deviceId;

  // In supervised mode, only an admin or the singer of the current song may
  // pause, skip, restart or change the key: what the remote's controls
  // allow.
  const requirePlaybackControl = (caller: Caller) => {
    if (
      config.supervisedMode &&
      !isAdmin(caller) &&
      !owns(store.getState().currentSong, caller)
    ) {
      throw new ApiError(
        403,
        "Supervised mode: only an admin or the current singer can do that",
      );
    }
  };

  // Whether a command for song (its songKey) may act now: song must be the
  // current one, and for a phone, one the display has started (not WAITING,
  // while it loads). Otherwise it's a tap meant for the song before, sent
  // just as it ended, or one sent while nothing plays: it changes nothing
  // and isn't an error.
  const isForCurrentSong = (song: string, caller: Caller) => {
    const { currentSong, playbackState } = store.getState();
    return (
      currentSong !== null &&
      songKey(currentSong) === song &&
      (caller.isDisplay || playbackState !== "WAITING")
    );
  };

  // server.ts refuses the display's methods to phones; this checks again.
  const requireDisplay = (caller: Caller) => {
    if (!caller.isDisplay) {
      throw new ApiError(403, "Only the display can do that");
    }
  };

  const requireIdentity = (caller: Caller): UserIdentity => {
    if (caller.deviceId === null || caller.nickname === null) {
      throw new ApiError(
        400,
        "Missing the X-Karafriends-Device-Id and X-Karafriends-Nickname headers",
      );
    }
    return { deviceId: caller.deviceId, nickname: caller.nickname };
  };

  const hasMaxSongsInQueue = (user: UserIdentity, caller: Caller) => {
    const { songQueue, downloadQueue } = store.getState();
    const queued = songQueue.filter(
      (item) => item.user.deviceId === user.deviceId,
    ).length;
    // A failed download is shown for a while, but frees its slot at once.
    const downloading = downloadQueue.filter(
      (item) =>
        item.status === "downloading" &&
        item.userIdentity.deviceId === user.deviceId,
    ).length;
    console.log(
      `hasMaxSongsInQueue: user ${user.nickname} has ${queued}, ${downloading} downloading`,
    );
    // The limit is fairness, so everyoneIsAdmin keeps it.
    return (
      !isRealAdmin(caller) &&
      config.paxSongQueueLimit > 0 &&
      queued + downloading >= config.paxSongQueueLimit
    );
  };

  // Seconds until a song queued now would start: what is left of the current
  // song and the playtimes ahead of it, the whole queue's, or for a song
  // pushed to the head (which goes in second: pushSongToQueue) the next
  // song's only.
  const queueEta = (pushToHead: boolean) => {
    const state = store.getState();
    const ahead = pushToHead ? state.songQueue.slice(0, 1) : state.songQueue;
    return (
      currentSongSecondsLeft(state, now()) +
      ahead.reduce((acc, cur) => acc + (cur.playtime || 0), 0)
    );
  };

  const queuedLyricsLength = () =>
    Object.values(store.getState().idToAdhocLyrics).reduce(
      (sum, lines) => sum + totalLength(lines),
      0,
    );

  // A YouTube song's adhoc lyrics, if it has them.
  const adhocLyricsOf = (item: QueueItem | null) =>
    item?.kind === "youtube" && item.hasAdhocLyrics
      ? store.getState().idToAdhocLyrics[songKey(item)]
      : undefined;

  // adhocLyrics: a YouTube song's, kept with it while it is queued.
  const pushSongToQueue = (
    item: QueueItem,
    pushToHead: boolean,
    adhocLyrics?: string[],
  ) => {
    console.log(
      `pushSongToQueue: pushing ${JSON.stringify(item)}; pushToHead=${pushToHead}`,
    );
    store.update((state) => {
      if (adhocLyrics) {
        state.idToAdhocLyrics[songKey(item)] = adhocLyrics;
      }
      if (pushToHead) {
        // To give things time to download, we don't actually push to the
        // front, but the second. splice handles an empty queue too.
        state.songQueue.splice(1, 0, item);
      } else {
        state.songQueue.push(item);
      }
    });
    deps.publish({ type: "queueAdded", item });
  };

  // Tells the display that item won't be queued (or, for a DAM song, play
  // its download).
  const queueFailed = (item: QueueItem) => (reason: string) => {
    console.log(`queueFailed: ${item.kind} ${item.songId}: ${reason}`);
    deps.publish({ type: "queueFailed", item, reason });
  };

  // YouTube and Niconico downloads run yt-dlp: one that fails because of it
  // sets the tools problem the display shows, and one that works clears it.
  const ytdlpWorked = () => {
    if (store.getState().toolsProblem) {
      store.update((state) => {
        state.toolsProblem = null;
      });
    }
  };
  const ytdlpFailed = (item: QueueItem) => (reason: string) => {
    if (isToolProblem(reason)) {
      store.update((state) => {
        state.toolsProblem ??= { message: TOOLS_PROBLEM, since: now() };
      });
    }
    queueFailed(item)(reason);
  };

  // Downloads a YouTube, Niconico or Joysound song (queueSong's, or one a
  // restart cut short: resumeDownloads), which is a pending song until the
  // download is done and the song is queued, or it fails.
  const downloadSong = (pending: PendingSong) => {
    const { item, pushToHead } = pending;
    const done = () =>
      store.update((state) => {
        const index = state.pendingSongs.findIndex(
          (other) => songKey(other.item) === songKey(item),
        );
        if (index !== -1) state.pendingSongs.splice(index, 1);
      });
    switch (item.kind) {
      case "joysound":
        deps.downloads.joysound(
          item,
          pushToHead,
          (ready, toHead) => {
            done();
            pushSongToQueue(ready, toHead);
          },
          (reason) => {
            done();
            queueFailed(item)(reason);
          },
        );
        break;
      case "youtube": {
        const lyrics = pending.adhocLyrics;
        deps.downloads.youtube(
          item,
          pending.captionCode,
          () => {
            done();
            ytdlpWorked();
            if (!item.hasAdhocLyrics) {
              pushSongToQueue(item, pushToHead);
            } else if (
              queuedLyricsLength() + totalLength(lyrics) <=
              MAX_ADHOC_CHARS_QUEUED
            ) {
              pushSongToQueue(item, pushToHead, lyrics);
            } else {
              // Others came in while it downloaded.
              console.warn(
                `Queueing ${item.songId} without its lyrics: the queue holds too many`,
              );
              pushSongToQueue({ ...item, hasAdhocLyrics: false }, pushToHead);
            }
          },
          (reason) => {
            done();
            ytdlpFailed(item)(reason);
          },
        );
        break;
      }
      case "nico":
        deps.downloads.nico(
          item,
          () => {
            done();
            ytdlpWorked();
            pushSongToQueue(item, pushToHead);
          },
          (reason) => {
            done();
            ytdlpFailed(item)(reason);
          },
        );
        break;
    }
  };

  // queueSong's start of a download: kept in the state (and queue.json)
  // until it's done.
  const queueAfterDownload = (pending: PendingSong) => {
    store.update((state) => {
      state.pendingSongs.push(pending);
    });
    downloadSong(pending);
  };

  // One per vocal type, at both bitrates.
  const streamingUrls = async (songId: string) =>
    (await deps.minsei.getMusicStreamingUrls(songId)).list.map((info) => ({
      high: info.highBitrateUrl,
      low: info.lowBitrateUrl,
    }));

  const toDamSong = (song: {
    requestNo: string;
    title: string;
    titleYomi: string;
    artist: string;
    artistYomi: string;
  }): DamSong => ({
    id: song.requestNo,
    name: song.title,
    nameYomi: song.titleYomi,
    artistName: song.artist,
    artistNameYomi: song.artistYomi,
  });

  const toJoysoundSong = (song: {
    selSongNo: string;
    songName: string;
    artistName: string;
  }) => ({
    id: song.selSongNo,
    name: song.songName,
    artistName: song.artistName,
  });

  // Joysound counts from 1, and has no total: a full page may have more after
  // it.
  const joysoundPage = async <T, U>(
    fetchPage: (start: number, count: number) => Promise<T[]>,
    toItem: (item: T) => U,
    offset = 0,
    limit = DEFAULT_LIMIT.joysound,
  ) => {
    const items = await fetchPage(offset + 1, limit);
    return {
      items: items.map(toItem),
      nextOffset: items.length === limit ? offset + limit : null,
    };
  };

  // The last song (songId@timestamp) popSong gave a reloaded display again.
  let resumedSong: string | null = null;

  return {
    // Not a method: index.ts calls it once, at launch. Starts again the
    // downloads queue.json says were running when the app last stopped.
    resumeDownloads() {
      // A copy: a Joysound song already downloaded is done at once, and
      // leaves the list as it goes.
      for (const pending of store.getState().pendingSongs.slice()) {
        console.log(
          `resumeDownloads: ${pending.item.kind} ${pending.item.songId}`,
        );
        downloadSong(pending);
      }
    },

    async damSearchSongs({ query, offset = 0, limit = DEFAULT_LIMIT.dam }) {
      const result = await deps.dkwebsys.getMusicByKeyword(
        query,
        limit,
        offset,
      );
      return {
        items: result.list.map(toDamSong),
        nextOffset: nextOffset(offset, limit, result.data.totalCount),
      };
    },

    async damSearchArtists({ query, offset = 0, limit = DEFAULT_LIMIT.dam }) {
      const result = await deps.dkwebsys.getArtistByKeyword(
        query,
        limit,
        offset,
      );
      return {
        items: result.list.map((artist): DamArtist => ({
          id: artist.artistCode.toString(),
          name: artist.artist,
          nameYomi: artist.artistYomi,
          songCount: artist.holdMusicCount,
        })),
        nextOffset: nextOffset(offset, limit, result.data.totalCount),
      };
    },

    async damArtist({ id, offset = 0, limit = DEFAULT_LIMIT.dam }) {
      const result = await deps.dkwebsys.getMusicListByArtist(
        id,
        limit,
        offset,
      );
      return {
        id,
        name: result.data.artist,
        nameYomi: result.data.artistYomi_Kana,
        songCount: result.data.totalCount,
        songs: {
          items: result.list.map(toDamSong),
          nextOffset: nextOffset(offset, limit, result.data.totalCount),
        },
      };
    },

    async damSong({ id }) {
      const { data, list } = await deps.dkwebsys.getMusicDetailsInfo(id);
      const info = list[0].mModelMusicInfoList[0];
      return {
        id,
        name: data.title,
        nameYomi: data.titleYomi_Kana,
        artistName: data.artist,
        // DAM's song details give no artist reading (checked 2026-10-28);
        // the remote's song page takes it from the row that opened it.
        artistNameYomi: "",
        lyricsPreview: data.firstLine || null,
        vocalTypes: info.guideVocal.split(",").map((vocalType): VocalType => {
          switch (vocalType) {
            case "0":
              return "NORMAL";
            case "1":
              return "GUIDE_MALE";
            case "2":
              return "GUIDE_FEMALE";
            default:
              console.warn(`unknown vocal type ${vocalType}`);
              return "UNKNOWN";
          }
        }),
        tieUp: info.highlightTieUp || null,
        playtime: parseInt(info.playtime, 10) || null,
      };
    },

    joysoundSearchSongs: ({ query, offset, limit }) =>
      joysoundPage(
        (start, count) =>
          deps.joysound.getSongListByKeyword(query, start, count),
        toJoysoundSong,
        offset,
        limit,
      ),

    joysoundSearchArtists: ({ query, offset, limit }) =>
      joysoundPage(
        (start, count) =>
          deps.joysound.getArtistListByKeyword(query, start, count),
        (artist) => ({ id: artist.artistId_digi, name: artist.artistName }),
        offset,
        limit,
      ),

    joysoundArtistSongs: ({ id, offset, limit }) =>
      joysoundPage(
        (start, count) => deps.joysound.getSongListByArtist(id, start, count),
        toJoysoundSong,
        offset,
        limit,
      ),

    async joysoundSong({ id }) {
      const detail = await deps.joysound.getSongDetail(id);
      return {
        id,
        name: detail.name,
        artistName: detail.artistName,
        lyricsPreview: detail.lyricsPreview,
        tieUp: detail.tieUp,
      };
    },

    async youtubeInfo({ videoId }) {
      const youtube = await deps.youtube();
      // youtubei.js's response is loosely/partially typed and its shape
      // shifts between versions, so treat it as untyped here.
      const data: any = await youtube.getBasicInfo(videoId);
      if (data.playability_status?.status !== "OK") {
        return {
          ok: false,
          reason: data.playability_status?.reason ?? "Unknown",
        };
      }

      const captionTracks = data.captions?.caption_tracks || [];
      const captionLanguages: YoutubeVideoInfo["captionLanguages"] =
        captionTracks
          .filter((captionTrack: any) => !captionTrack.vss_id.startsWith("a"))
          .map((captionTrack: any) => ({
            code: captionTrack.language_code,
            name: captionTrack.name.text ?? "",
          }));

      const loudnessDb = data.player_config?.audio_config?.loudness_db || 0.0;

      return {
        ok: true,
        info: {
          author: data.basic_info.author,
          captionLanguages,
          channelId: data.basic_info.channel_id,
          keywords: data.basic_info.keywords ?? [],
          lengthSeconds: data.basic_info.duration,
          description: data.basic_info.short_description,
          title: data.basic_info.title,
          viewCount: data.basic_info.view_count,
          gainValue: 10 ** ((-1 * loudnessDb) / 20),
        },
      };
    },

    // ok: false only when the answer is about the video (no such ID, or
    // yt-dlp says it's gone, private or blocked here): the phone keeps that
    // answer for a while. Anything else (yt-dlp broken or slow, too many
    // lookups at once) is an error, which the phone offers to try again.
    async nicoInfo({ videoId }) {
      if (!isNicoVideoId(videoId)) {
        return { ok: false, reason: NICO_INFO_FAILED };
      }
      try {
        return { ok: true, info: await deps.getNicoVideoInfo(videoId) };
      } catch (err) {
        console.error(`Failed getting Niconico info for ${videoId}:`, err);
        const failure = err as { stderr?: unknown; killed?: boolean } | null;
        if (failure?.killed) {
          throw new Error(
            "Couldn't get the video's details: Niconico took too long. Try again.",
            { cause: err },
          );
        }
        if (typeof failure?.stderr === "string") {
          const reason = ytdlpFailureReason(failure.stderr);
          if (!isToolProblem(reason)) return { ok: false, reason };
          throw new Error(
            "Couldn't get the video's details: the downloader failed. Try again, or Update tools in the TV's Settings.",
            { cause: err },
          );
        }
        throw new Error(
          `Couldn't get the video's details: ${(err as Error)?.message ?? err}`,
          { cause: err },
        );
      }
    },

    async adhocLyrics({ songId }) {
      // The video's that is playing, or else the next one's in the queue.
      const { currentSong, songQueue } = store.getState();
      const item = [currentSong, ...songQueue].find(
        (item) => item?.songId === songId && adhocLyricsOf(item),
      );
      return adhocLyricsOf(item ?? null) ?? null;
    },

    async history({ offset = 0, limit = DEFAULT_LIMIT.history }, caller) {
      const { songHistory } = store.getState();
      return {
        // Without device IDs, like the live state.
        items: songHistory.slice(offset, offset + limit).map((entry) => ({
          ...shareQueueItem(entry.song, caller.deviceId),
          playedAt: entry.playedAt,
        })),
        nextOffset: nextOffset(offset, limit, songHistory.length),
      };
    },

    async queueSong(input, caller) {
      const user = requireIdentity(caller);
      if (
        !SONG_ID.test(input.songId) ||
        (input.kind === "joysound" &&
          input.youtubeVideoId !== null &&
          !SONG_ID.test(input.youtubeVideoId))
      ) {
        throw new ApiError(400, "Invalid song ID");
      }

      if (hasMaxSongsInQueue(user, caller)) {
        return {
          ok: false,
          reason: `${user.nickname} already has ${config.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      // The download that's running would ignore this one, and its song
      // queues as whoever started it. (A DAM song queues at once.)
      if (
        input.kind !== "dam" &&
        isDownloading(store.getState().downloadQueue, {
          kind: input.kind,
          songId: input.songId,
          suffix: input.kind === "joysound" ? input.youtubeVideoId : null,
        })
      ) {
        return { ok: false, reason: "Someone is already adding this song" };
      }

      const pushToHead = input.tryHeadOfQueue === true && isAdmin(caller);
      console.log(`queueSong: ${input.kind}, pushToHead=${pushToHead}`);
      const eta = queueEta(pushToHead);
      const base = {
        songId: input.songId,
        name: input.name,
        artistName: input.artistName,
        ...(input.nameYomi !== undefined && { nameYomi: input.nameYomi }),
        ...(input.artistNameYomi !== undefined && {
          artistNameYomi: input.artistNameYomi,
        }),
        ...(input.readingsMode !== undefined && {
          readingsMode: input.readingsMode,
        }),
        playtime: input.playtime ?? null,
        timestamp: now().toString(),
        user,
      };

      switch (input.kind) {
        case "dam": {
          const item: DamQueueItem = {
            kind: "dam",
            ...base,
            streamingUrlIdx: input.streamingUrlIdx,
          };
          console.log(`Starting offline download of ${item.songId}`);
          streamingUrls(item.songId)
            .then((urls) => {
              const url = urls[item.streamingUrlIdx];
              if (url === undefined) {
                throw new Error(`no streaming URL ${item.streamingUrlIdx}`);
              }
              deps.downloads.dam(
                config.useLowBitrateUrl ? url.low : url.high,
                item.songId,
                item.streamingUrlIdx.toString(),
                item.playtime,
                queueFailed(item),
              );
            })
            .catch((err) =>
              console.error(
                `Failed to start the download of DAM song ${item.songId}:`,
                err,
              ),
            );
          pushSongToQueue(item, pushToHead);
          break;
        }
        case "joysound": {
          const item: JoysoundQueueItem = {
            kind: "joysound",
            ...base,
            lyricsMode: input.lyricsMode,
            youtubeVideoId: input.youtubeVideoId,
          };
          queueAfterDownload({
            item,
            pushToHead,
            captionCode: null,
            adhocLyrics: [],
          });
          break;
        }
        case "youtube": {
          const lyrics = (input.adhocLyrics ?? "")
            .split("\n")
            .filter((line) => line.trim() !== "");
          if (
            lyrics.length > 0 &&
            queuedLyricsLength() + totalLength(lyrics) > MAX_ADHOC_CHARS_QUEUED
          ) {
            return {
              ok: false,
              reason:
                "The queue holds too many lyrics already. Try again after a few songs, or without lyrics.",
            };
          }
          const item: YoutubeQueueItem = {
            kind: "youtube",
            ...base,
            hasAdhocLyrics: lyrics.length > 0,
            hasCaptions: Boolean(input.captionCode),
            gainValue: input.gainValue,
          };
          // The lyrics join idToAdhocLyrics only once the song is queued: a
          // download that fails never is.
          queueAfterDownload({
            item,
            pushToHead,
            captionCode: input.captionCode,
            adhocLyrics: lyrics,
          });
          break;
        }
        case "nico": {
          const item: NicoQueueItem = { kind: "nico", ...base };
          queueAfterDownload({
            item,
            pushToHead,
            captionCode: null,
            adhocLyrics: [],
          });
          break;
        }
      }

      // The song may still be downloading, but assume it will queue.
      return { ok: true, eta };
    },

    async removeSong({ songId, timestamp }, caller) {
      const item = store
        .getState()
        .songQueue.find(
          (item) => item.songId === songId && item.timestamp === timestamp,
        );
      // The song may already be playing or removed by another phone.
      if (!item) return false;
      if (config.supervisedMode && !isAdmin(caller) && !owns(item, caller)) {
        throw new ApiError(
          403,
          "Supervised mode: only an admin or whoever queued it can remove a song",
        );
      }
      return store.update((state) => {
        state.songQueue.splice(state.songQueue.indexOf(item), 1);
        delete state.idToAdhocLyrics[songKey(item)];
        return true;
      });
    },

    async moveSong({ songId, timestamp, toIndex }, caller) {
      if (!isAdmin(caller)) {
        throw new ApiError(403, "Only an admin can reorder the queue");
      }
      return store.update((state) => {
        const from = state.songQueue.findIndex(
          (item) => item.songId === songId && item.timestamp === timestamp,
        );
        // The song may already be playing or removed by another phone.
        if (from === -1) return { ok: false };
        const [item] = state.songQueue.splice(from, 1);
        // splice puts it at the end if toIndex is past it.
        state.songQueue.splice(toIndex, 0, item);
        return { ok: true };
      });
    },

    async setPlaybackState({ playbackState, song }, caller) {
      if (!isForCurrentSong(song, caller)) return false;
      requirePlaybackControl(caller);
      // Only the state: the song's clock follows the display's video, which
      // reports each start, pause, restart and seek (reportSongPosition).
      store.update((state) => {
        state.playbackState = playbackState;
      });
      return true;
    },

    async reportSongPosition(
      { songId, timestamp, position, length, playing },
      caller,
    ) {
      requireDisplay(caller);
      const state = store.getState();
      const song = state.currentSong;
      // The song before's, sent as this one started.
      if (song?.songId !== songId || song.timestamp !== timestamp) return false;
      const at = now();
      const positionMs = Math.round(position * 1000);
      const startedAt = state.currentSongStartedAt;
      const pausedSince = state.currentSongPausedSince;
      const inStep =
        startedAt !== null &&
        (pausedSince === null) === playing &&
        Math.abs((pausedSince ?? at) - startedAt - positionMs) <
          POSITION_SLACK_MS;
      const songLength =
        length === null ? state.currentSongLength : Math.round(length);
      if (inStep && songLength === state.currentSongLength) return true;
      store.update((state) => {
        state.currentSongLength = songLength;
        if (inStep) return;
        // From scratch: position played by now, and paused since now unless
        // it's moving.
        state.currentSongStartedAt = at - positionMs;
        state.currentSongPausedSince = playing ? null : at;
      });
      return true;
    },

    async setPitchShiftSemis({ semis, song }, caller) {
      if (!isForCurrentSong(song, caller)) return false;
      requirePlaybackControl(caller);
      store.update((state) => {
        state.pitchShiftSemis = semis;
      });
      return true;
    },

    async setGuideMelodyLevel({ level }, caller) {
      if (!isAdmin(caller)) {
        throw new ApiError(403, "Only an admin can change the guide melody");
      }
      store.update((state) => {
        state.guideMelodyLevel = level;
      });
      return true;
    },

    async setSongVolume({ volume }, caller) {
      if (!isAdmin(caller)) {
        throw new ApiError(403, "Only an admin can change the song volume");
      }
      store.update((state) => {
        state.songVolume = volume;
      });
      return true;
    },

    async setMicLevels({ id, gain, echo }, caller) {
      if (!isAdmin(caller)) {
        throw new ApiError(403, "Only an admin can change the mics");
      }
      if (!store.getState().mics.some((mic) => mic.id === id)) return false;
      // The display owns the levels: it applies just the ones given (so a
      // change the host is making to the other stands), and its setMics
      // then shows them to the phones.
      deps.publish({
        type: "micLevels",
        id,
        ...(gain !== undefined && { gain }),
        ...(echo !== undefined && { echo }),
      });
      return true;
    },

    async pushAdhocLyrics({ lyricIndex, song }, caller) {
      if (!isForCurrentSong(song, caller)) return false;
      const { currentSong, currentSongAdhocLyrics } = store.getState();
      const lyrics = adhocLyricsOf(currentSong);
      if (lyrics === undefined) return false;
      // Who may sing along is who may control the song.
      requirePlaybackControl(caller);
      // The line comes from the lyrics queued with the song, never from the
      // phone.
      const lyric = lyrics[lyricIndex];
      if (lyric === undefined) {
        throw new ApiError(400, `The song has no line ${lyricIndex}`);
      }
      const shownChars = currentSongAdhocLyrics.reduce(
        (sum, entry) => sum + entry.lyric.length,
        0,
      );
      if (
        currentSongAdhocLyrics.length >= MAX_ADHOC_LINES_SHOWN ||
        shownChars + lyric.length > MAX_ADHOC_CHARS_SHOWN
      ) {
        throw new ApiError(400, "This song can't show any more lines");
      }
      store.update((state) => {
        state.currentSongAdhocLyrics.push({ lyric, lyricIndex });
      });
      return true;
    },

    async sendEmote({ emote }, caller) {
      deps.publish({ type: "emote", emote, user: requireIdentity(caller) });
      return true;
    },

    async setMics({ mics }, caller) {
      if (!caller.isDisplay) {
        throw new ApiError(403, "Only the display has mics");
      }
      store.update((state) => {
        state.mics = mics;
      });
      return true;
    },

    async downloadsInfo(_input, caller) {
      requireDisplay(caller);
      return deps.downloads.info();
    },

    async clearDownloads(_input, caller) {
      requireDisplay(caller);
      // The files of the current song and of every queued song (a queued
      // YouTube song without its file would be skipped at its turn), and the
      // downloads running now's. (The DAM ones running are the downloads'
      // to keep: they aren't in the queue.)
      const { currentSong, songQueue, downloadQueue } = store.getState();
      const inUse: SongFiles[] = downloadQueue
        .filter((item) => item.status === "downloading")
        .map(({ kind, songId, suffix }) => ({ kind, songId, suffix }));
      for (const song of [currentSong, ...songQueue]) {
        if (song) inUse.push(songFilesOf(song));
      }
      const result = deps.downloads.clear(inUse);
      console.log(`clearDownloads: ${JSON.stringify(result)}`);
      return result;
    },

    async clearDownload({ songId, suffix }, caller) {
      requireDisplay(caller);
      if (!SONG_ID.test(songId) || !SONG_ID.test(suffix)) {
        throw new ApiError(400, "Invalid song ID");
      }
      return deps.downloads.clearDam(songId, suffix);
    },

    async popSong({ resume }, caller) {
      // Not an admin's phone either: the song it took would never play.
      if (!caller.isDisplay) {
        throw new ApiError(403, "Only the display starts the next song");
      }
      // The idle display asks every 5 seconds: with nothing to start and
      // nothing to clear, don't save (and serialize) the state each time.
      const before = store.getState();
      if (
        before.currentSong === null &&
        before.songQueue.length === 0 &&
        before.playbackState === "WAITING" &&
        before.currentSongStartedAt === null &&
        before.currentSongPausedSince === null &&
        before.currentSongLength === null &&
        before.currentSongAdhocLyrics.length === 0
      ) {
        return null;
      }
      const song = store.update((state) => {
        const skipping = state.playbackState === "SKIPPING";
        // WAITING until the display has loaded the song and says PLAYING:
        // the phones' controls wait, and the server drops their commands
        // (isForCurrentSong), so none can act on the video before, which
        // has ended. The display's first report starts the clock
        // (reportSongPosition).
        state.playbackState = "WAITING";
        state.currentSongStartedAt = null;
        state.currentSongPausedSince = null;
        state.currentSongLength = null;
        const current = state.currentSong;
        if (
          resume &&
          current &&
          !skipping &&
          songKey(current) !== resumedSong
        ) {
          // A reloaded display: the same song from the start, keeping its
          // place in the history and its lines pushed so far.
          resumedSong = songKey(current);
          return current;
        }
        const next = state.songQueue.shift() ?? null;
        state.currentSongAdhocLyrics = [];
        const previous = state.currentSong;
        if (previous) delete state.idToAdhocLyrics[songKey(previous)];
        state.currentSong = next;

        if (next) {
          const last = state.songHistory[0]?.song;
          if (
            !last ||
            last.kind !== next.kind ||
            last.songId !== next.songId ||
            last.timestamp !== next.timestamp
          ) {
            state.songHistory.unshift({ song: next, playedAt: now() });
            state.songHistory.splice(MAX_HISTORY);
          }
        }
        return next;
      });

      if (song?.kind !== "dam") return song;
      // The display streams a DAM song if its download isn't there, and
      // scores the singing against the scoring data. Neither is essential,
      // and the song has already started, so neither may hold it up for long
      // or fail it.
      const timeoutMs = deps.damPopTimeoutMs ?? DAM_POP_TIMEOUT_MS;
      const [urls, scoringData] = await Promise.all([
        withTimeout(streamingUrls(song.songId), timeoutMs).catch(
          (err): PoppedDamSong["streamingUrls"] => {
            console.error(`No streaming URLs for ${song.songId}:`, err);
            return [];
          },
        ),
        withTimeout(deps.minsei.getScoringData(song.songId), timeoutMs)
          .then((data) => Array.from(new Uint8Array(data)))
          .catch((err): number[] => {
            console.error(`No scoring data for ${song.songId}:`, err);
            return [];
          }),
      ]);
      const popped: PoppedSong = {
        ...song,
        streamingUrls: urls,
        startWithLowBitrate: config.useLowBitrateUrl,
        scoringData,
      };
      return popped;
    },

    async whoami(_input, caller) {
      return { isAdmin: isAdmin(caller) };
    },

    // server.ts limits how often one address may try.
    async adminLogin({ password }, caller) {
      if (caller.isDisplay) {
        throw new ApiError(400, "The display is always an admin");
      }
      if (config.adminPasswordHash === "") {
        // Not 403, so the phone doesn't say "Wrong password".
        throw new ApiError(409, "The host hasn't set an admin password");
      }
      const hash = config.adminPasswordHash;
      if (!(await isAdminPassword(password, config))) {
        throw new ApiError(403, "Wrong admin password");
      }
      // The host set a new password while this was hashed, which ended
      // every session: this one mustn't outlive it.
      if (config.adminPasswordHash !== hash) {
        throw new ApiError(403, "Wrong admin password");
      }
      console.log(`adminLogin: ${caller.nickname ?? "a phone"} signed in`);
      return { token: deps.adminSessions.create() };
    },

    async adminLogout(_input, caller) {
      deps.adminSessions.remove(caller.adminToken);
      return {};
    },
  };
}
