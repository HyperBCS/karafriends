// The JSON RPC API shared by the main process, the phone remote and the
// display: `POST /api/<method>` with a JSON body, plus one Server-Sent Events
// stream, `GET /api/events`, that pushes the live state.
//
// Types only, so any process can import it. The handlers are in
// src/main/api.ts and the Express wiring in src/main/server.ts.

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
  // The display window's secret (from the preload). It makes the caller an
  // admin.
  displayToken: "X-Karafriends-Display-Token",
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

// What popSong hands the display. A DAM song comes with what the display needs
// to play and score it.
export interface PoppedDamSong extends DamQueueItem {
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
  deviceId: string;
}

export interface LiveState {
  currentSong: QueueItem | null;
  // The songs after currentSong. Clients work out ETAs from playtime.
  queue: QueueItem[];
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
  | { type: "emote"; emote: string; user: UserIdentity }
  | { type: "queueAdded"; item: QueueItem };

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
  history: { input: PageInput; output: Page<QueueItem> };

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
