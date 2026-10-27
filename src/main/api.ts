// The API's handlers: one function per method in src/common/api.ts, holding
// the logic the GraphQL resolvers used to. Both the JSON RPC router
// (server.ts) and the GraphQL resolvers (graphql.ts) call these.
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
  PoppedSong,
  QueueItem,
  UserIdentity,
  VocalType,
  YoutubeQueueItem,
  YoutubeVideoInfo,
} from "../common/api";
import type { KarafriendsConfig } from "../common/config";
import type { DkwebsysAPI, MinseiAPI } from "./damApi";
import type { JoysoundAPI } from "./joysoundApi";
import type { LiveMessage } from "./live";
import { nextOffset } from "./paging";
import type { StateStore } from "./state";

// Who is calling, from the request headers (see caller.ts). Null when the
// header was missing.
export interface Caller {
  deviceId: string | null;
  nickname: string | null;
}

// An error the caller caused, with the HTTP status to answer with.
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
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
    | "adminNicks"
    | "adminDeviceIds"
    | "paxSongQueueLimit"
    | "supervisedMode"
    | "useLowBitrateUrl"
  >;
  store: StateStore;
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
  // to play, and only then is the song queued.
  downloads: {
    dam(url: string, songId: string, suffix: string): void;
    joysound(
      item: JoysoundQueueItem,
      pushToHead: boolean,
      onReady: (item: JoysoundQueueItem, pushToHead: boolean) => void,
    ): void;
    youtube(
      item: YoutubeQueueItem,
      captionCode: string | null,
      onReady: () => void,
    ): void;
    nico(item: NicoQueueItem, onReady: () => void): void;
  };
  publish: (message: LiveMessage) => void;
  now?: () => number;
}

// Song and video IDs end up in file names and yt-dlp arguments.
const SONG_ID = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_LIMIT = { dam: 30, joysound: 100, history: 30 };

export function createApi(deps: ApiDeps): ApiHandlers {
  const { config, store } = deps;
  const now = deps.now ?? Date.now;

  const isAdmin = (caller: Caller) =>
    (caller.nickname !== null && config.adminNicks.includes(caller.nickname)) ||
    (caller.deviceId !== null &&
      config.adminDeviceIds.includes(caller.deviceId));

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
    const downloading = downloadQueue.filter(
      (item) => item.userIdentity.deviceId === user.deviceId,
    ).length;
    console.log(
      `hasMaxSongsInQueue: user ${user.nickname} has ${queued}, ${downloading} downloading`,
    );
    return (
      !isAdmin(caller) &&
      config.paxSongQueueLimit > 0 &&
      queued + downloading >= config.paxSongQueueLimit
    );
  };

  // Seconds until a song added to the end of the queue would start.
  const queueEta = () => {
    const { currentSong, songQueue } = store.getState();
    return (
      (currentSong?.playtime || 0) +
      songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0)
    );
  };

  const pushSongToQueue = (item: QueueItem, pushToHead: boolean) => {
    console.log(
      `pushSongToQueue: pushing ${JSON.stringify(item)}; pushToHead=${pushToHead}`,
    );
    store.update((state) => {
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

  const streamingUrls = async (songId: string) =>
    (await deps.minsei.getMusicStreamingUrls(songId)).list.map((info) =>
      config.useLowBitrateUrl ? info.lowBitrateUrl : info.highBitrateUrl,
    );

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

  return {
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

    async nicoInfo({ videoId }) {
      try {
        return { ok: true, info: await deps.getNicoVideoInfo(videoId) };
      } catch (e) {
        console.error(`Failed getting Niconico info for ${videoId}:`, e);
        return {
          ok: false,
          reason: "Failed getting video info. Maybe an invalid VideoID?",
        };
      }
    },

    async adhocLyrics({ songId }) {
      return store.getState().idToAdhocLyrics[songId] ?? null;
    },

    async history({ offset = 0, limit = DEFAULT_LIMIT.history }) {
      const { songHistory } = store.getState();
      return {
        items: songHistory
          .slice(offset, offset + limit)
          .map((entry) => entry.song),
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

      const pushToHead = input.tryHeadOfQueue === true && isAdmin(caller);
      console.log(`queueSong: ${input.kind}, pushToHead=${pushToHead}`);
      const eta = queueEta();
      const base = {
        songId: input.songId,
        name: input.name,
        artistName: input.artistName,
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
                url,
                item.songId,
                item.streamingUrlIdx.toString(),
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
        case "joysound":
          deps.downloads.joysound(
            {
              kind: "joysound",
              ...base,
              isRomaji: input.isRomaji,
              youtubeVideoId: input.youtubeVideoId,
            },
            pushToHead,
            pushSongToQueue,
          );
          break;
        case "youtube": {
          const item: YoutubeQueueItem = {
            kind: "youtube",
            ...base,
            hasAdhocLyrics: Boolean(input.adhocLyrics),
            hasCaptions: Boolean(input.captionCode),
            gainValue: input.gainValue,
          };
          if (input.adhocLyrics) {
            const lyrics = input.adhocLyrics
              .split("\n")
              .filter((line) => line.trim() !== "");
            store.update((state) => {
              state.idToAdhocLyrics[item.songId] = lyrics;
            });
          }
          deps.downloads.youtube(item, input.captionCode, () =>
            pushSongToQueue(item, pushToHead),
          );
          break;
        }
        case "nico": {
          const item: NicoQueueItem = { kind: "nico", ...base };
          deps.downloads.nico(item, () => pushSongToQueue(item, pushToHead));
          break;
        }
      }

      // The song may still be downloading, but assume it will queue.
      return { ok: true, eta };
    },

    async removeSong({ songId, timestamp }) {
      return store.update((state) => {
        const index = state.songQueue.findIndex(
          (item) => item.songId === songId && item.timestamp === timestamp,
        );
        // The song may already be playing or removed by another phone.
        if (index === -1) return false;
        state.songQueue.splice(index, 1);
        return true;
      });
    },

    async setPlaybackState({ playbackState }) {
      store.update((state) => {
        state.playbackState = playbackState;
      });
      return true;
    },

    async setPitchShiftSemis({ semis }) {
      store.update((state) => {
        state.pitchShiftSemis = semis;
      });
      return true;
    },

    async pushAdhocLyrics({ lyric, lyricIndex }) {
      store.update((state) => {
        state.currentSongAdhocLyrics.push({ lyric, lyricIndex });
      });
      return true;
    },

    async sendEmote({ emote }, caller) {
      deps.publish({ type: "emote", emote, user: requireIdentity(caller) });
      return true;
    },

    async popSong() {
      const song = store.update((state) => {
        const next = state.songQueue.shift() ?? null;
        state.currentSongAdhocLyrics = [];
        const previous = state.currentSong;
        if (previous?.kind === "youtube" && previous.hasAdhocLyrics) {
          delete state.idToAdhocLyrics[previous.songId];
        }
        state.currentSong = next;

        if (next) {
          const last = state.songHistory[0]?.song;
          if (
            !last ||
            last.kind !== next.kind ||
            last.songId !== next.songId ||
            last.timestamp !== next.timestamp
          ) {
            state.songHistory.unshift({ song: next });
          }
        }
        return next;
      });

      if (song?.kind !== "dam") return song;
      // The display streams a DAM song if its download isn't there, and
      // scores the singing against the scoring data. Without the scoring data
      // it can still play the song.
      const [urls, scoringData] = await Promise.all([
        streamingUrls(song.songId),
        deps.minsei
          .getScoringData(song.songId)
          .then((data) => Array.from(new Uint8Array(data)))
          .catch((err) => {
            console.error(`No scoring data for ${song.songId}:`, err);
            return [];
          }),
      ]);
      const popped: PoppedSong = { ...song, streamingUrls: urls, scoringData };
      return popped;
    },

    async whoami(_input, caller) {
      return { isAdmin: isAdmin(caller) };
    },
  };
}
