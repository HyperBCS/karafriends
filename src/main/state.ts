// The app's shared state (queue, now playing, playback, history...) and its
// persistence to queue.json.
//
// Everything that changes the state goes through update(), which saves it and
// tells the listeners. The one exception is downloadQueue, which
// src/main/downloads changes in place (with the helpers below) as downloads
// start, progress, finish and fail.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

import type {
  AdhocLyricsEntry,
  LyricsMode,
  MicInfo,
  PlaybackState,
  QueueItem,
  QueueItemKind,
  ReadingsMode,
  UserIdentity,
} from "../common/api";
import { LYRICS_MODES, READINGS_MODES } from "../common/api";
import { isCaptionCode } from "../common/captionCode";
import { secondsLeft, songKey } from "../common/currentSong";

// A download in progress, or one that failed in the last
// FAILED_DOWNLOAD_KEPT_MS (so the phone that asked for it can say why).
export interface DownloadQueueItem {
  // Unique among this run's downloads, so a phone can tell a new try at a
  // song from the failure before it.
  id: number;
  kind: QueueItemKind;
  userIdentity: UserIdentity;
  songId: string;
  // Joysound: the YouTube video used as the background, if any.
  suffix: string | null;
  progress: number;
  status: "downloading" | "failed";
  // Why it failed, in words for guests. Null while downloading.
  reason: string | null;
  // When it failed (ms since the epoch). Null while downloading.
  failedAt: number | null;
}

// How long a failed download stays in the download queue.
export const FAILED_DOWNLOAD_KEPT_MS = 30_000;

let lastDownloadId = 0;

// The download queue's changes. src/main/downloads makes them in place, outside
// update(); the live hub looks at the queue while it isn't empty.

// Adds a download of kind/songId/suffix to queue and returns it. A failure
// of the same download goes, as do failures older than
// FAILED_DOWNLOAD_KEPT_MS (in case a timer that should have removed one
// didn't run).
export function startDownload(
  queue: DownloadQueueItem[],
  download: Pick<
    DownloadQueueItem,
    "kind" | "userIdentity" | "songId" | "suffix"
  >,
  now = Date.now(),
): DownloadQueueItem {
  removeExpiredDownloads(queue, now);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].status === "failed" && sameDownload(queue[i], download)) {
      queue.splice(i, 1);
    }
  }
  const item: DownloadQueueItem = {
    ...download,
    id: ++lastDownloadId,
    progress: 0,
    status: "downloading",
    reason: null,
    failedAt: null,
  };
  queue.push(item);
  return item;
}

// Whether kind/songId/suffix is downloading now (a failure doesn't count).
export function isDownloading(
  queue: readonly DownloadQueueItem[],
  download: Pick<DownloadQueueItem, "kind" | "songId" | "suffix">,
): boolean {
  return queue.some(
    (item) => item.status === "downloading" && sameDownload(item, download),
  );
}

// Marks item failed with reason, unless it already failed or is gone.
// Returns whether it did.
export function failDownload(
  queue: readonly DownloadQueueItem[],
  item: DownloadQueueItem,
  reason: string,
  now = Date.now(),
): boolean {
  if (item.status !== "downloading" || !queue.includes(item)) return false;
  item.status = "failed";
  item.reason = reason;
  item.failedAt = now;
  return true;
}

// Takes item out of queue, if it's there.
export function removeDownload(
  queue: DownloadQueueItem[],
  item: DownloadQueueItem,
): void {
  const index = queue.indexOf(item);
  if (index !== -1) queue.splice(index, 1);
}

// Takes out the failures older than FAILED_DOWNLOAD_KEPT_MS. Returns whether
// any went.
export function removeExpiredDownloads(
  queue: DownloadQueueItem[],
  now = Date.now(),
): boolean {
  let removed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    const { failedAt } = queue[i];
    if (failedAt !== null && now - failedAt >= FAILED_DOWNLOAD_KEPT_MS) {
      queue.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

function sameDownload(
  a: Pick<DownloadQueueItem, "kind" | "songId" | "suffix">,
  b: Pick<DownloadQueueItem, "kind" | "songId" | "suffix">,
): boolean {
  return a.kind === b.kind && a.songId === b.songId && a.suffix === b.suffix;
}

export interface HistoryItem {
  song: QueueItem;
}

// A YouTube, Niconico or Joysound song whose download is running: it joins
// the queue once that's done (queueSong), with what came with it. Saved, so
// a restart starts the download again instead of losing the song.
export interface PendingSong {
  item: Exclude<QueueItem, { kind: "dam" }>;
  pushToHead: boolean;
  // A YouTube song's: the captions to download, and its adhoc lyrics.
  captionCode: string | null;
  adhocLyrics: string[];
}

export interface State {
  currentSong: QueueItem | null;
  // The current song's clock (see LiveState), so a phone can tell how far
  // into it the party is. The display's reportSongPosition is its one
  // writer; popSong clears it. Not saved, since after a restart the song
  // plays again from the start.
  currentSongStartedAt: number | null;
  currentSongPausedSince: number | null;
  // The current song's video's length, in whole seconds, once the display
  // reports it (null until then). The countdowns use it in place of the
  // playtime the song was queued with. Not saved either.
  currentSongLength: number | null;
  currentSongAdhocLyrics: AdhocLyricsEntry[];
  // The lines of each queued (or current) YouTube song with adhoc lyrics, by
  // songKey: the queue item, not the video, since anyone may queue the same
  // video again with other lyrics. Nothing else: they go when the song does.
  idToAdhocLyrics: Record<string, string[]>;
  pitchShiftSemis: number;
  // 0 to 1. Saved, unlike the pitch.
  guideMelodyLevel: number;
  // 0 to 100, and the display's open mics. Not saved: a launch starts at 100
  // and none.
  songVolume: number;
  mics: MicInfo[];
  playbackState: PlaybackState;
  // The songs after currentSong.
  songQueue: QueueItem[];
  pendingSongs: PendingSong[];
  downloadQueue: DownloadQueueItem[];
  // Newest first.
  songHistory: HistoryItem[];
  // Set when a YouTube or Niconico download fails because of yt-dlp
  // (isToolProblem), cleared when one works or the tools are updated. Not
  // saved.
  toolsProblem: { message: string; since: number } | null;
  // Why phones can't connect (the remote's server couldn't listen), as a
  // sentence for the display. Not saved.
  remoconProblem: string | null;
}

export interface StateStore {
  // The live state. Read it freely; change it only inside update().
  getState(): Readonly<State>;
  // Runs mutator on the state, saves it, then tells the listeners. Returns
  // what mutator returns.
  update<T>(mutator: (state: State) => T): T;
  // Called after every update(). Returns a function that stops it.
  onChange(listener: (state: Readonly<State>) => void): () => void;
}

// Seconds left of the current song at now (ms since the epoch): of its
// length (the video's, else the playtime it was queued with), counted as the
// phones count it (secondsLeft).
export function currentSongSecondsLeft(
  state: Pick<
    State,
    | "currentSong"
    | "currentSongStartedAt"
    | "currentSongPausedSince"
    | "currentSongLength"
  >,
  now: number,
): number {
  const playtime = state.currentSong
    ? (state.currentSongLength ?? state.currentSong.playtime) || 0
    : 0;
  return secondsLeft(playtime, state, now);
}

export function emptyState(): State {
  return {
    currentSong: null,
    currentSongStartedAt: null,
    currentSongPausedSince: null,
    currentSongLength: null,
    currentSongAdhocLyrics: [],
    idToAdhocLyrics: {},
    pitchShiftSemis: 0,
    guideMelodyLevel: 0,
    songVolume: 100,
    mics: [],
    playbackState: "WAITING",
    songQueue: [],
    pendingSongs: [],
    downloadQueue: [],
    songHistory: [],
    toolsProblem: null,
    remoconProblem: null,
  };
}

export function createStateStore(filePath: string): StateStore {
  const state = loadState(filePath);
  const events = new EventEmitter();
  // Every phone's live-state stream listens.
  events.setMaxListeners(0);
  let lastSaved: string | null = null;

  const save = () => {
    try {
      const serialized = serializeState(state);
      // The display asks for the next song every 5 seconds while idle; don't
      // rewrite the same file each time.
      if (serialized === lastSaved) return;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Write to a temp file and rename into place so an interrupted write
      // can never leave a half-written queue.json that fails to parse on next
      // launch.
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, serialized, "utf-8");
      fs.renameSync(tmpPath, filePath);
      lastSaved = serialized;
    } catch (err) {
      // A failed save shouldn't take down the app; the in-memory queue is
      // still intact and is saved again on the next update.
      console.error(`Failed to persist queue to ${filePath}:`, err);
    }
  };

  return {
    getState: () => state,
    update(mutator) {
      const result = mutator(state);
      save();
      for (const listener of events.listeners("change")) {
        try {
          listener(state);
        } catch (err) {
          console.error("A state change listener failed:", err);
        }
      }
      return result;
    },
    onChange(listener) {
      events.on("change", listener);
      return () => events.off("change", listener);
    },
  };
}

// What goes in queue.json: the queue, with the current song at its head so
// that after a restart it plays again from the start, the queued songs' adhoc
// lyrics, the songs still downloading (to download again), the history and
// the guide melody level. Everything else starts over: nothing plays
// (WAITING, until the display takes the first song), and the download
// queue, pitch, pushed lines, the song's timing, the song volume, the mics
// and the two problems are a launch's own.
export function serializeState(state: Readonly<State>): string {
  return JSON.stringify({
    songQueue: state.currentSong
      ? [state.currentSong, ...state.songQueue]
      : state.songQueue,
    idToAdhocLyrics: state.idToAdhocLyrics,
    pendingSongs: state.pendingSongs,
    songHistory: state.songHistory,
    guideMelodyLevel: state.guideMelodyLevel,
  });
}

export function loadState(filePath: string): State {
  let raw: unknown;
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!isObject(raw)) throw new Error("not a JSON object");
  } catch (err) {
    // A corrupt or partially-written queue.json (e.g. an interrupted save or a
    // power loss mid-party) used to throw here at startup, bricking every
    // launch. Keep the bad file for debugging and start from a clean state.
    console.error(
      `Failed to load saved queue from ${filePath}; ignoring it:`,
      err,
    );
    try {
      fs.renameSync(filePath, `${filePath}.corrupt`);
    } catch (renameErr) {
      console.error("Failed to back up corrupt queue file:", renameErr);
    }
    return emptyState();
  }
  return parseState(raw);
}

// Builds a State from a parsed queue.json (serializeState), keeping whatever
// is valid. Reads the GraphQL-shaped items older versions saved too
// (`__typename` and `userIdentity` instead of `kind` and `user`), and drops
// the null they saved at the head of the queue when nothing was playing. A
// current song in the file (none has saved one, but in case) goes at the
// head of the queue.
export function parseState(raw: Record<string, unknown>): State {
  const state = emptyState();
  const current = parseQueueItem(raw.currentSong);
  state.songQueue = parseList(raw.songQueue, parseQueueItem);
  if (current) state.songQueue.unshift(current);
  state.songHistory = parseList(raw.songHistory, (entry) => {
    const song = isObject(entry) ? parseQueueItem(entry.song) : null;
    return song ? { song } : null;
  });
  // Only the lyrics of songs still queued: older versions kept those of
  // songs that never played. And they saved them by video ID.
  const savedLyrics = isObject(raw.idToAdhocLyrics) ? raw.idToAdhocLyrics : {};
  const saved = (key: string) =>
    Object.hasOwn(savedLyrics, key) ? savedLyrics[key] : undefined;
  for (const item of state.songQueue) {
    if (item.kind !== "youtube" || !item.hasAdhocLyrics) continue;
    const key = songKey(item);
    const lyrics = saved(key) ?? saved(item.songId);
    if (Array.isArray(lyrics)) {
      state.idToAdhocLyrics[key] = lyrics.filter(
        (line): line is string => typeof line === "string",
      );
    }
  }
  state.pendingSongs = parseList(raw.pendingSongs, parsePendingSong);
  const level = raw.guideMelodyLevel;
  if (typeof level === "number" && level >= 0 && level <= 1) {
    state.guideMelodyLevel = level;
  }
  return state;
}

const KIND_BY_TYPENAME: Record<string, QueueItemKind> = {
  DamQueueItem: "dam",
  JoysoundQueueItem: "joysound",
  YoutubeQueueItem: "youtube",
  NicoQueueItem: "nico",
};

function parsePendingSong(raw: unknown): PendingSong | null {
  if (!isObject(raw)) return null;
  const item = parseQueueItem(raw.item);
  if (item === null || item.kind === "dam") return null;
  // It goes to yt-dlp: only a code queueSong would have taken.
  const captionCode =
    typeof raw.captionCode === "string" && isCaptionCode(raw.captionCode)
      ? raw.captionCode
      : null;
  return {
    item,
    pushToHead: raw.pushToHead === true,
    captionCode,
    adhocLyrics: Array.isArray(raw.adhocLyrics)
      ? raw.adhocLyrics.filter(
          (line): line is string => typeof line === "string",
        )
      : [],
  };
}

function parseQueueItem(raw: unknown): QueueItem | null {
  if (!isObject(raw)) return null;
  const kind =
    typeof raw.kind === "string"
      ? raw.kind
      : KIND_BY_TYPENAME[raw.__typename as string];
  const user = isObject(raw.user) ? raw.user : raw.userIdentity;
  if (
    typeof raw.songId !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.artistName !== "string" ||
    typeof raw.timestamp !== "string" ||
    !isObject(user) ||
    typeof user.deviceId !== "string" ||
    typeof user.nickname !== "string"
  ) {
    return null;
  }
  const base = {
    songId: raw.songId,
    name: raw.name,
    artistName: raw.artistName,
    ...(typeof raw.nameYomi === "string" && { nameYomi: raw.nameYomi }),
    ...(typeof raw.artistNameYomi === "string" && {
      artistNameYomi: raw.artistNameYomi,
    }),
    ...(READINGS_MODES.includes(raw.readingsMode as ReadingsMode) && {
      readingsMode: raw.readingsMode as ReadingsMode,
    }),
    playtime: typeof raw.playtime === "number" ? raw.playtime : null,
    timestamp: raw.timestamp,
    user: { deviceId: user.deviceId, nickname: user.nickname },
  };
  switch (kind) {
    case "dam": {
      const streamingUrlIdx = Number(raw.streamingUrlIdx);
      if (!Number.isInteger(streamingUrlIdx)) return null;
      return { kind, ...base, streamingUrlIdx };
    }
    case "joysound":
      return {
        kind,
        ...base,
        // Items saved before the three modes had isRomaji instead.
        lyricsMode: LYRICS_MODES.includes(raw.lyricsMode as LyricsMode)
          ? (raw.lyricsMode as LyricsMode)
          : raw.isRomaji === true
            ? "romaji"
            : "kana",
        youtubeVideoId:
          typeof raw.youtubeVideoId === "string" ? raw.youtubeVideoId : null,
      };
    case "youtube":
      return {
        kind,
        ...base,
        hasAdhocLyrics: raw.hasAdhocLyrics === true,
        hasCaptions: raw.hasCaptions === true,
        gainValue: typeof raw.gainValue === "number" ? raw.gainValue : 1,
      };
    case "nico":
      return { kind, ...base };
    default:
      return null;
  }
}

function parseList<T>(raw: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const entry of raw) {
    const item = parse(entry);
    if (item !== null) {
      items.push(item);
    } else if (entry !== null) {
      console.warn(
        `Dropping an unreadable saved entry: ${JSON.stringify(entry)}`,
      );
    }
  }
  return items;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
