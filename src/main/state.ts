// The app's shared state (queue, now playing, playback, history...) and its
// persistence to queue.json.
//
// Everything that changes the state goes through update(), which saves it and
// tells the listeners. The one exception is downloadQueue, which
// videoDownloader changes in place as downloads start, progress and finish.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

import type {
  AdhocLyricsEntry,
  PlaybackState,
  QueueItem,
  QueueItemKind,
  UserIdentity,
} from "../common/api";
import { PLAYBACK_STATES } from "../common/api";

// A download in progress.
export interface DownloadQueueItem {
  // 0 Joysound, 1 YouTube, 2 Niconico.
  downloadType: number;
  userIdentity: UserIdentity;
  songId: string;
  suffix: string | null;
  progress: number;
}

export interface HistoryItem {
  song: QueueItem;
}

export interface State {
  currentSong: QueueItem | null;
  currentSongAdhocLyrics: AdhocLyricsEntry[];
  // The lines of each queued (or current) YouTube song with adhoc lyrics, by
  // adhocLyricsKey. Nothing else: they go when the song does.
  idToAdhocLyrics: Record<string, string[]>;
  pitchShiftSemis: number;
  playbackState: PlaybackState;
  // The songs after currentSong.
  songQueue: QueueItem[];
  downloadQueue: DownloadQueueItem[];
  // Newest first.
  songHistory: HistoryItem[];
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

// A queue item's key in idToAdhocLyrics: the queue item, not the video,
// since anyone may queue the same video again with other lyrics.
export function adhocLyricsKey(item: {
  songId: string;
  timestamp: string;
}): string {
  return `${item.songId}@${item.timestamp}`;
}

export function emptyState(): State {
  return {
    currentSong: null,
    currentSongAdhocLyrics: [],
    idToAdhocLyrics: {},
    pitchShiftSemis: 0,
    playbackState: "WAITING",
    songQueue: [],
    downloadQueue: [],
    songHistory: [],
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

// What goes in queue.json. The current song is saved at the head of the queue,
// so after a restart it plays again from the start; downloads, pitch and the
// pushed adhoc lyrics start over.
export function serializeState(state: Readonly<State>): string {
  return JSON.stringify({
    ...state,
    pitchShiftSemis: 0,
    currentSong: null,
    currentSongAdhocLyrics: [],
    songQueue: state.currentSong
      ? [state.currentSong, ...state.songQueue]
      : state.songQueue,
    downloadQueue: [],
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

// Builds a State from a parsed queue.json, keeping whatever is valid. Reads
// both this format and the GraphQL-shaped items older versions saved
// (`__typename` and `userIdentity` instead of `kind` and `user`). Drops the
// null that older versions saved at the head of the queue when nothing was
// playing.
export function parseState(raw: Record<string, unknown>): State {
  const state = emptyState();
  state.currentSong = parseQueueItem(raw.currentSong);
  state.songQueue = parseList(raw.songQueue, parseQueueItem);
  state.songHistory = parseList(raw.songHistory, (entry) => {
    const song = isObject(entry) ? parseQueueItem(entry.song) : null;
    return song ? { song } : null;
  });
  state.currentSongAdhocLyrics = parseList(
    raw.currentSongAdhocLyrics,
    (entry) =>
      isObject(entry) &&
      typeof entry.lyric === "string" &&
      typeof entry.lyricIndex === "number"
        ? { lyric: entry.lyric, lyricIndex: entry.lyricIndex }
        : null,
  );
  // Only the lyrics of songs still queued: older versions kept those of
  // songs that never played. And they saved them by video ID.
  const savedLyrics = isObject(raw.idToAdhocLyrics) ? raw.idToAdhocLyrics : {};
  const saved = (key: string) =>
    Object.hasOwn(savedLyrics, key) ? savedLyrics[key] : undefined;
  for (const item of [state.currentSong, ...state.songQueue]) {
    if (item?.kind !== "youtube" || !item.hasAdhocLyrics) continue;
    const key = adhocLyricsKey(item);
    const lyrics = saved(key) ?? saved(item.songId);
    if (Array.isArray(lyrics)) {
      state.idToAdhocLyrics[key] = lyrics.filter(
        (line): line is string => typeof line === "string",
      );
    }
  }
  if (typeof raw.pitchShiftSemis === "number") {
    state.pitchShiftSemis = raw.pitchShiftSemis;
  }
  if (PLAYBACK_STATES.includes(raw.playbackState as PlaybackState)) {
    state.playbackState = raw.playbackState as PlaybackState;
  }
  return state;
}

const KIND_BY_TYPENAME: Record<string, QueueItemKind> = {
  DamQueueItem: "dam",
  JoysoundQueueItem: "joysound",
  YoutubeQueueItem: "youtube",
  NicoQueueItem: "nico",
};

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
        isRomaji: raw.isRomaji === true,
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
