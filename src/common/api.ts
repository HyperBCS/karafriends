// The JSON RPC API shared by the main process, the phone remote and the
// display. Phones use HTTP: `POST /api/<method>` with a JSON body, plus one
// Server-Sent Events stream, `GET /api/events`, that pushes the live state.
// The display window uses the same methods and events over Electron IPC
// (src/common/ipc.ts), as an admin.
//
// Types only, so any process can import it. The handlers are in
// src/main/api.ts, the Express wiring in src/main/server.ts and the IPC
// wiring in src/main/ipc.ts.

// Who is calling. The remote sends these as the X-Karafriends-Device-Id and
// X-Karafriends-Nickname headers, each percent-encoded (encodeURIComponent),
// since a nickname may not be ASCII.
export interface UserIdentity {
  deviceId: string;
  nickname: string;
}

export const IDENTITY_HEADERS = {
  deviceId: "X-Karafriends-Device-Id",
  nickname: "X-Karafriends-Nickname",
} as const;

export type PlaybackState =
  "PAUSED" | "PLAYING" | "RESTARTING" | "SKIPPING" | "WAITING";

export const PLAYBACK_STATES: readonly PlaybackState[] = [
  "PAUSED",
  "PLAYING",
  "RESTARTING",
  "SKIPPING",
  "WAITING",
];

// One page of a list. Pass `nextOffset` back as `offset` to get the next page;
// it is null on the last page.
export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

// Offsets count from 0. Each method has its own default and maximum limit.
export interface PageInput {
  offset?: number;
  limit?: number;
}

// Queue items

export type QueueItemKind = "dam" | "joysound" | "youtube" | "nico";

interface QueueItemBase {
  songId: string;
  name: string;
  artistName: string;
  // Seconds, when known.
  playtime: number | null;
  // When it was queued: Date.now() as a string. With songId it identifies an
  // item in the queue.
  timestamp: string;
  user: UserIdentity;
}

export interface DamQueueItem extends QueueItemBase {
  kind: "dam";
  streamingUrlIdx: number;
}

export interface JoysoundQueueItem extends QueueItemBase {
  kind: "joysound";
  isRomaji: boolean;
  youtubeVideoId: string | null;
}

export interface YoutubeQueueItem extends QueueItemBase {
  kind: "youtube";
  hasAdhocLyrics: boolean;
  hasCaptions: boolean;
  gainValue: number;
}

export interface NicoQueueItem extends QueueItemBase {
  kind: "nico";
}

export type QueueItem =
  DamQueueItem | JoysoundQueueItem | YoutubeQueueItem | NicoQueueItem;

// Who queued a song, as everyone may see it: the nickname only. A device ID
// is as good as a password (admins are listed by device ID), so it never
// leaves the server.
export interface PublicUser {
  nickname: string;
}

type Shared<Item> = Item extends QueueItem
  ? Omit<Item, "user"> & {
      user: PublicUser;
      // Whether the phone asking queued it (from the same device).
      isMine: boolean;
    }
  : never;

// A queue item as the live state and history show it.
export type SharedQueueItem = Shared<QueueItem>;

// What popSong hands the display. A DAM song comes with what the display needs
// to play and score it, as far as DAM answered in time: either list may be
// empty.
export interface PoppedDamSong extends DamQueueItem {
  // For a song that isn't downloaded.
  streamingUrls: string[];
  scoringData: number[];
}

export type PoppedSong = Exclude<QueueItem, DamQueueItem> | PoppedDamSong;

// queueSong input: the fields of the item to queue. The server adds the
// timestamp and the caller's identity.
interface SongToQueueBase {
  songId: string;
  name: string;
  artistName: string;
  playtime?: number | null;
  // Admins only; anyone else's song goes to the end, as before.
  tryHeadOfQueue?: boolean;
}

export type QueueSongInput =
  | (SongToQueueBase & { kind: "dam"; streamingUrlIdx: number })
  | (SongToQueueBase & {
      kind: "joysound";
      isRomaji: boolean;
      youtubeVideoId: string | null;
    })
  | (SongToQueueBase & {
      kind: "youtube";
      // Lyrics to show line by line, one per line, or null.
      adhocLyrics: string | null;
      captionCode: string | null;
      gainValue: number;
    })
  | (SongToQueueBase & { kind: "nico" });

// eta: seconds until the song is expected to start.
export type QueueSongResult =
  { ok: true; eta: number } | { ok: false; reason: string };

// Live state

export interface AdhocLyricsEntry {
  lyric: string;
  lyricIndex: number;
}

// A Joysound, YouTube or Niconico download in progress. (DAM songs download
// in the background without reporting progress.)
export interface DownloadProgress {
  kind: Exclude<QueueItemKind, "dam">;
  songId: string;
  // Joysound: the YouTube video used as the background, if any.
  suffix: string | null;
  // 0 to 1.
  progress: number;
  // Whether the phone watching started it.
  isMine: boolean;
}

// A phone sees which songs and downloads are its own, but no device IDs: it
// passes its own as GET /api/events?deviceId=..., and isMine is worked out on
// the server.
export interface LiveState {
  currentSong: SharedQueueItem | null;
  // The songs after currentSong. Clients work out ETAs from playtime.
  queue: SharedQueueItem[];
  playbackState: PlaybackState;
  pitchShiftSemis: number;
  // The current song's adhoc lyrics pushed so far.
  adhocLyrics: AdhocLyricsEntry[];
  downloads: DownloadProgress[];
  // Only what every phone may see: no credentials, no admin list (ask
  // whoami instead).
  config: { supervisedMode: boolean };
}

// What GET /api/events sends: one JSON LiveEvent per `data:` line. A "state"
// event comes first on every (re)connect, and again whenever the state
// changes (at most about 4 a second).
export type LiveEvent =
  | { type: "state"; state: LiveState }
  | { type: "emote"; emote: string; user: PublicUser }
  | { type: "queueAdded"; item: SharedQueueItem };

export type LiveEventType = LiveEvent["type"];

// The query parameter GET /api/events takes the phone's device ID in.
// (EventSource can't send headers.)
export const EVENTS_DEVICE_ID_PARAM = "deviceId";

// Lookups

export interface DamSong {
  id: string;
  name: string;
  nameYomi: string;
  artistName: string;
  artistNameYomi: string;
}

export type VocalType = "NORMAL" | "GUIDE_MALE" | "GUIDE_FEMALE" | "UNKNOWN";

export interface DamSongDetail extends DamSong {
  lyricsPreview: string | null;
  // One per streaming URL; queueSong's streamingUrlIdx picks one.
  vocalTypes: VocalType[];
  tieUp: string | null;
  playtime: number | null;
}

export interface DamArtist {
  id: string;
  name: string;
  nameYomi: string;
  songCount: number;
}

export interface JoysoundSong {
  id: string;
  name: string;
  artistName: string;
}

export interface JoysoundSongDetail extends JoysoundSong {
  lyricsPreview: string | null;
  tieUp: string | null;
}

export interface JoysoundArtist {
  id: string;
  name: string;
}

export interface VideoInfo {
  author: string;
  channelId: string;
  lengthSeconds: number;
  description: string;
  title: string;
  viewCount: number;
}

export interface YoutubeVideoInfo extends VideoInfo {
  captionLanguages: { code: string; name: string }[];
  keywords: string[];
  // Multiplier that evens out the video's loudness.
  gainValue: number;
}

export interface NicoVideoInfo extends VideoInfo {
  thumbnailUrl: string;
}

// A lookup that can fail in a way worth showing to the person, as data.
export type LookupResult<T> =
  { ok: true; info: T } | { ok: false; reason: string };

// Every method: its input and output. Methods that take nothing take {}.
export interface Api {
  // Lookups
  damSearchSongs: {
    input: { query: string } & PageInput;
    output: Page<DamSong>;
  };
  damSearchArtists: {
    input: { query: string } & PageInput;
    output: Page<DamArtist>;
  };
  damArtist: {
    input: { id: string } & PageInput;
    output: DamArtist & { songs: Page<DamSong> };
  };
  damSong: { input: { id: string }; output: DamSongDetail };
  joysoundSearchSongs: {
    input: { query: string } & PageInput;
    output: Page<JoysoundSong>;
  };
  joysoundSearchArtists: {
    input: { query: string } & PageInput;
    output: Page<JoysoundArtist>;
  };
  joysoundArtistSongs: {
    input: { id: string } & PageInput;
    output: Page<JoysoundSong>;
  };
  joysoundSong: { input: { id: string }; output: JoysoundSongDetail };
  youtubeInfo: {
    input: { videoId: string };
    output: LookupResult<YoutubeVideoInfo>;
  };
  nicoInfo: {
    input: { videoId: string };
    output: LookupResult<NicoVideoInfo>;
  };
  // A YouTube song's adhoc lyrics, null if it has none.
  adhocLyrics: { input: { songId: string }; output: string[] | null };
  // Newest first.
  history: { input: PageInput; output: Page<SharedQueueItem> };

  // Commands. queueSong and sendEmote need the identity headers. In
  // supervised mode, removeSong is for the song's owner or an admin, and
  // setPlaybackState and setPitchShiftSemis for the current song's owner or
  // an admin.
  queueSong: { input: QueueSongInput; output: QueueSongResult };
  // False if the song isn't in the queue (any more).
  removeSong: {
    input: { songId: string; timestamp: string };
    output: boolean;
  };
  setPlaybackState: {
    input: { playbackState: PlaybackState };
    output: boolean;
  };
  setPitchShiftSemis: { input: { semis: number }; output: boolean };
  pushAdhocLyrics: { input: AdhocLyricsEntry; output: boolean };
  sendEmote: { input: { emote: string }; output: boolean };

  // The display only: start the next song, or null if the queue is empty.
  popSong: { input: Record<string, never>; output: PoppedSong | null };

  whoami: { input: Record<string, never>; output: { isAdmin: boolean } };
}

export type ApiMethod = keyof Api;
export type ApiInput<M extends ApiMethod> = Api[M]["input"];
export type ApiOutput<M extends ApiMethod> = Api[M]["output"];
