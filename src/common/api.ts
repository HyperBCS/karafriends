// The JSON RPC API shared by the main process, the phone remote and the
// display. Phones use HTTP: `POST /api/<method>` with a JSON body, plus one
// Server-Sent Events stream, `GET /api/events`, that pushes the live state.
// The display window uses the same methods and events over Electron IPC
// (src/common/ipc.ts), as an admin.
//
// Types only, so any process can import it. The handlers are in
// src/main/api.ts, the Express wiring in src/main/server.ts and the IPC
// wiring in src/main/ipc.ts.

import type { KarafriendsConfig } from "./configSchema";

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

// A phone signed in as an admin (adminLogin) sends its session token in this
// header, as it is (it's hex).
export const ADMIN_TOKEN_HEADER = "X-Karafriends-Admin-Token";

// WAITING: nothing plays, or popSong has made the next song current and the
// display is still loading it (a DAM song may wait for DAM). The display's
// PLAYING, once it has started the song, ends it.
export type PlaybackState =
  "PAUSED" | "PLAYING" | "RESTARTING" | "SKIPPING" | "WAITING";

// What setPlaybackState may set: WAITING is the server's own (popSong).
export type PlaybackCommand = Exclude<PlaybackState, "WAITING">;

export const PLAYBACK_COMMANDS: readonly PlaybackCommand[] = [
  "PAUSED",
  "PLAYING",
  "RESTARTING",
  "SKIPPING",
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

// How a phone shows titles and artists (its Settings' Readings): as written,
// or as the kana reading or its romaji.
export const READINGS_MODES = ["written", "kana", "romaji"] as const;
export type ReadingsMode = (typeof READINGS_MODES)[number];

interface QueueItemBase {
  songId: string;
  name: string;
  artistName: string;
  // The kana readings DAM gives, for the phones that show them: on DAM
  // songs queued from this version on.
  nameYomi?: string;
  artistNameYomi?: string;
  // How the phone that queued it reads, so the display shows the song that
  // way too. Missing: as written.
  readingsMode?: ReadingsMode;
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

// How a Joysound song's lyrics show on the display: kanji with kana ruby,
// romaji, or the romaji line under the kanji line.
export const LYRICS_MODES = ["kana", "romaji", "both"] as const;
export type LyricsMode = (typeof LYRICS_MODES)[number];

export interface JoysoundQueueItem extends QueueItemBase {
  kind: "joysound";
  lyricsMode: LyricsMode;
  youtubeVideoId: string | null;
  // The song's guide-vocal version (another recording, its guide channel a
  // sung vocal), not its guide-melody one.
  guideVocal: boolean;
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
// decides whose a song is (who may remove it in supervised mode), so it never
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

// A song in the history: as the queue showed it, and when it started (ms
// since the epoch; null for one sung before that was kept).
export type PlayedSong = SharedQueueItem & { playedAt: number | null };

// What popSong hands the display. A DAM song comes with what the display needs
// to play and score it, as far as DAM answered in time: either list may be
// empty.
export interface PoppedDamSong extends DamQueueItem {
  // For a song that isn't downloaded: one per vocal type (streamingUrlIdx
  // picks), at both bitrates.
  streamingUrls: { high: string; low: string }[];
  // Which bitrate to start with: config.yaml's useLowBitrateUrl.
  startWithLowBitrate: boolean;
  scoringData: number[];
}

export type PoppedSong = Exclude<QueueItem, DamQueueItem> | PoppedDamSong;

// queueSong input: the fields of the item to queue. The server adds the
// timestamp and the caller's identity.
interface SongToQueueBase {
  songId: string;
  name: string;
  artistName: string;
  nameYomi?: string;
  artistNameYomi?: string;
  readingsMode?: ReadingsMode;
  playtime?: number | null;
  // Admins only; anyone else's song goes to the end, as before.
  tryHeadOfQueue?: boolean;
}

export type QueueSongInput =
  | (SongToQueueBase & { kind: "dam"; streamingUrlIdx: number })
  | (SongToQueueBase & {
      kind: "joysound";
      lyricsMode: LyricsMode;
      youtubeVideoId: string | null;
      // Its guide-vocal version; the guide-melody one if left out.
      guideVocal?: boolean;
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

// A Joysound, YouTube or Niconico download in progress, or one that failed
// in the last 30 seconds. (DAM songs download in the background without
// reporting progress.) The song joins the queue once its download is done.
export interface DownloadProgress {
  // Unique among the server's downloads: a new try at the same song gets a
  // new id.
  id: number;
  kind: QueueItemKind;
  songId: string;
  // Joysound: the YouTube video used as the background, if any.
  suffix: string | null;
  // 0 to 1.
  progress: number;
  status: "downloading" | "failed";
  // Why it failed, in words for guests ("Video unavailable"). Null while
  // downloading.
  reason: string | null;
  // Whether the phone watching started it.
  isMine: boolean;
}

// A mic the display has open, as the phones see it.
export interface MicInfo {
  id: string; // `${name}#${channel}`: stable while the mic stays plugged in
  label: string; // "Blue Yeti (Windows), channel 1"
  gain: number; // 0..200, percent
  echo: number; // 0..100, percent of the full reverb
  gate: number; // the noise gate, whole dB: GATE_OFF_DB (off)..GATE_MAX_DB
}

// A phone sees which songs and downloads are its own, but no device IDs: it
// passes its own as GET /api/events?deviceId=..., and isMine is worked out on
// the server.
export interface LiveState {
  // Its playtime is its video's length, in whole seconds, once the display
  // knows it (reportSongPosition).
  currentSong: SharedQueueItem | null;
  // The current song's clock, from the display's reports of where its video
  // is (reportSongPosition): when it would have started had it played
  // straight through (ms since the epoch, by the server's clock; null while
  // none plays, or until the display has loaded it), and since when it is
  // paused or stalled (null while it plays). How far into the song the party
  // is: (pausedSince ?? now) - startedAt (secondsPlayed in
  // src/common/currentSong.ts).
  currentSongStartedAt: number | null;
  currentSongPausedSince: number | null;
  // The songs after currentSong. Clients work out ETAs from playtime and the
  // timing above.
  queue: SharedQueueItem[];
  playbackState: PlaybackState;
  pitchShiftSemis: number;
  // How loud Joysound's guide melody (the ogg's centre channel) plays, from
  // 0 (muted, as it always was) to 1. A party setting: it stays from song
  // to song and across restarts.
  guideMelodyLevel: number;
  // The song's volume, 0 to 100 percent, for every source. Starts at 100 on
  // every launch.
  songVolume: number;
  // The mics the display has open (setMics), with their levels. Starts empty
  // on every launch.
  mics: MicInfo[];
  // The current song's adhoc lyrics pushed so far.
  adhocLyrics: AdhocLyricsEntry[];
  downloads: DownloadProgress[];
  // Only what every phone may see: no credentials, no admin list (ask
  // whoami instead).
  config: {
    supervisedMode: boolean;
    everyoneIsAdmin: boolean;
  };
  // DAM's and Joysound's songs: phones show a catalog's only while it is
  // on (see CatalogStatus).
  catalogs: Record<LoginService, CatalogStatus>;
  // ffmpeg and yt-dlp are being downloaded for the first time, so YouTube
  // and Niconico songs wait: how far along (0 to 100, or null while it
  // can't tell). Null otherwise.
  toolsDownload: { percent: number | null } | null;
  // ToolsStatus's problem, for the display's notice. Phones ignore it.
  toolsProblem: string | null;
  // Why phones can't connect (the server couldn't listen: "Phones can't
  // connect: port 8080 is in use..."), for the display's notice too.
  remoconProblem: string | null;
  // Goes up each time the host's new admin password signs every phone out:
  // a phone signed in asks whoami again, and signs out.
  adminSignOuts: number;
}

// What GET /api/events sends: one JSON LiveEvent per `data:` line. A "state"
// event comes first on every (re)connect, and again whenever the state
// changes (at most about 4 a second). Its sentAt is the server's clock when
// it was made (ms since the epoch), so a phone can tell how far off its own
// clock is. A "downloads" event comes when only the downloads changed (their
// progress, mostly, several times a second): the state's downloads are now
// these. The other events are the display's only.
export type LiveEvent =
  | { type: "state"; state: LiveState; sentAt: number }
  | { type: "downloads"; downloads: DownloadProgress[] }
  | { type: "emote"; emote: string; user: PublicUser }
  | { type: "queueAdded"; item: SharedQueueItem }
  // A song's download failed, so it won't join the queue. (The phone that
  // queued it sees the failure in the state's downloads.)
  | { type: "queueFailed"; item: SharedQueueItem; reason: string }
  // An admin's setMicLevels, with just the levels it gave. The display
  // applies them, and its setMics shows them to the phones.
  | {
      type: "micLevels";
      id: string;
      gain?: number;
      echo?: number;
      gate?: number;
    };

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
  // In seconds.
  playtime: number | null;
  // Whether /api/songPicture/dam/<id> has its karaoke video's title card.
  picture: boolean;
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
  // Whether it has a guide-vocal version.
  guideVocal: boolean;
  // Whether /api/songPicture/joysound/<id> has its album art.
  picture: boolean;
}

export interface JoysoundArtist {
  id: string;
  name: string;
}

// Browse (Joysound): its genres, and its featured lists.
export interface JoysoundGenre {
  id: string;
  name: string;
}

export interface JoysoundFeatureSummary {
  id: string;
  title: string;
  songCount: number;
  // Whether /api/songPicture/joysoundFeature/<id> has its picture.
  picture: boolean;
}

export interface JoysoundFeatureDetail {
  id: string;
  title: string;
  description: string;
  picture: boolean;
  // In the list's order; songs Joysound no longer has are left out.
  songs: JoysoundSong[];
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

// Settings (the display only)

// What getSettings shows for a password that is set. setSettings takes it
// back as "unchanged".
export const MASKED_PASSWORD = "••••••";

// config.yaml as the settings screen sees it. damPassword and
// joysoundPassword are MASKED_PASSWORD when not empty. The admin password's
// hash and salt never leave the main process: adminPasswordSet says whether
// there is one.
export type Settings = Omit<
  KarafriendsConfig,
  "adminPasswordHash" | "adminPasswordSalt"
> & { adminPasswordSet: boolean };

// What setSettings may change: any of Settings but adminPasswordSet (see
// setAdminPassword).
export type SettingsChanges = Partial<Omit<Settings, "adminPasswordSet">>;

export type LoginService = "dam" | "joysound";

// ok: false comes with a sentence for the host ("Joysound answered 403:
// this usually means no Japanese IP address"); ok: true may come with one
// too, a note on how karafriends' link to the Joysound account stands.
// canSwitchLink: karafriends isn't the account's TV app (another may be),
// and switchJoysoundLink can make it so.
// How a catalog (DAM's songs, or Joysound's) stands on this karaoke PC:
// off, no login is filled in; checking, signing in; on, signed in, so
// guests can find and sing its songs. unreachable: the service couldn't be
// reached (no connection, or no Japanese IP address: the VPN), and is tried
// again by itself at retryAt. failed: the service refused the login (a
// wrong password, an account that isn't a paid member, another TV app
// holding Joysound's link), until the host changes it. reason says why, in
// a sentence for the host.
export type CatalogStatus =
  | { state: "off" | "checking" | "on" }
  | { state: "unreachable"; reason: string; retryAt: number }
  | { state: "failed"; reason: string; canSwitchLink?: boolean };

export type TestLoginResult =
  | { ok: true; note?: string; canSwitchLink?: boolean }
  | { ok: false; reason: string; canSwitchLink?: boolean };

// ffmpeg's or yt-dlp's status. version: what it gave as its version
// (ffmpeg -version, yt-dlp --version), or null (not asked yet, or it
// couldn't say). updatedAt: when karafriends
// downloaded it, in ms since the epoch. overridden: KARAFRIENDS_FFMPEG_PATH
// or KARAFRIENDS_YTDLP_PATH names the copy in use, which karafriends never
// downloads (updatedAt is null).
export interface ToolStatus {
  version: string | null;
  updatedAt: number | null;
  overridden: boolean;
}

export interface ToolsStatus {
  ffmpeg: ToolStatus;
  ytdlp: ToolStatus;
  // When this launch last checked for new versions, or null.
  lastCheck: number | null;
  // "YouTube downloads are failing; try Update tools in Settings" while
  // YouTube or Niconico downloads fail for a reason that isn't the video's,
  // and since when; null once one works or Update tools has run.
  problem: string | null;
  problemSince: number | null;
}

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
  // songCount: all the artist's songs, if Joysound said.
  joysoundArtistSongs: {
    input: { id: string } & PageInput;
    output: Page<JoysoundSong> & { songCount: number | null };
  };
  joysoundSong: { input: { id: string }; output: JoysoundSongDetail };
  // Browse: Joysound's genres; a genre's songs, most popular first; its
  // newest songs; its featured lists, and one of them with its songs.
  joysoundGenres: { input: Record<string, never>; output: JoysoundGenre[] };
  joysoundGenreSongs: {
    input: { id: string } & PageInput;
    output: Page<JoysoundSong>;
  };
  joysoundNewSongs: { input: PageInput; output: Page<JoysoundSong> };
  joysoundFeatures: {
    input: Record<string, never>;
    output: JoysoundFeatureSummary[];
  };
  joysoundFeature: { input: { id: string }; output: JoysoundFeatureDetail };
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
  // Newest first: the last 1,000 songs sung.
  // Everyone's songs, or with mine, just the ones the calling phone queued.
  history: {
    input: PageInput & { mine?: boolean };
    output: Page<PlayedSong>;
  };

  // Commands. queueSong and sendEmote need the identity headers. In
  // supervised mode, removeSong is for the song's owner or an admin, and
  // setPlaybackState and setPitchShiftSemis for the current song's owner or
  // an admin. The owner is the device that queued it (isMine), and an admin
  // is the display or a phone signed in with the admin password (adminLogin):
  // a nickname counts for nothing.
  queueSong: { input: QueueSongInput; output: QueueSongResult };
  // False if the song isn't in the queue (any more).
  removeSong: {
    input: { songId: string; timestamp: string };
    output: boolean;
  };
  // Moves a queued song (song: its songKey, songId@timestamp) in front of
  // the song before names (its songKey), or to the end for null: where the
  // phone put it, even if songs above have started or gone since its view.
  // If before isn't queued any more, to position toIndex in the queue
  // (after the current song; past the end is the end). For admins only, in
  // supervised mode or not. ok is false if the song isn't in the queue (any
  // more).
  moveSong: {
    input: { song: string; before: string | null; toIndex: number };
    output: { ok: boolean };
  };
  // The commands that act on the current song (setPlaybackState,
  // setPitchShiftSemis, pushAdhocLyrics) name it: song is its songKey
  // (songId@timestamp, src/common/currentSong.ts). They answer false, and
  // change nothing, when that isn't the current song (a tap meant for the
  // song before, sent just as it ended) or nothing plays, and from a phone
  // while the display is still loading the song (WAITING). The song's clock
  // follows the display's reports (reportSongPosition), not these.
  setPlaybackState: {
    input: { playbackState: PlaybackCommand; song: string };
    output: boolean;
  };
  setPitchShiftSemis: {
    input: { semis: number; song: string };
    output: boolean;
  };
  // For admins only, in supervised mode or not.
  setGuideMelodyLevel: { input: { level: number }; output: boolean };
  // For admins only. volume: 0 to 100, a whole number.
  setSongVolume: { input: { volume: number }; output: boolean };
  // For admins only: one mic's levels (gain 0 to 200, echo 0 to 100, the
  // noise gate GATE_OFF_DB to GATE_MAX_DB, whole numbers; one left out stays
  // as it is). The display applies them. False if the display has no such
  // mic (any more).
  setMicLevels: {
    input: { id: string; gain?: number; echo?: number; gate?: number };
    output: boolean;
  };
  // Shows line lyricIndex of the current song's adhoc lyrics. In supervised
  // mode, for its owner or an admin. False as for setPlaybackState, and if
  // the song has no adhoc lyrics.
  pushAdhocLyrics: {
    input: { lyricIndex: number; song: string };
    output: boolean;
  };
  sendEmote: { input: { emote: string }; output: boolean };

  // The display only: start the next song, or null if the queue is empty.
  // Either way the playback state is WAITING after it, until the display
  // has loaded the song and sets PLAYING. resume: the display's page asks for the first time (it has just
  // loaded, or reloaded after a crash or F5). It gets the current song
  // again, to play from the start, if there is one and it wasn't being
  // skipped. Once per song (songId@timestamp), so a song that crashes the
  // display can't come back forever: after that, as without resume, the
  // next song.
  popSong: { input: { resume?: boolean }; output: PoppedSong | null };
  // The display only (a phone gets 403): where the current song's video
  // really is, for the countdowns: position seconds in, of length seconds
  // (null until it knows), and whether it is moving (false while paused or
  // stalled). The display sends it as the song loads, starts, pauses,
  // stalls, seeks and resumes, and every 10 seconds. False if songId and
  // timestamp aren't the current song (any more).
  reportSongPosition: {
    input: {
      songId: string;
      timestamp: string;
      position: number;
      length: number | null;
      playing: boolean;
    };
    output: boolean;
  };
  // The display only (a phone gets 403): the mics it has open, whenever one
  // is added, removed or its levels change on the display.
  setMics: { input: { mics: MicInfo[] }; output: boolean };
  // The display only (a phone gets 403), for Settings: how many files the
  // downloads folder holds, and their bytes.
  downloadsInfo: {
    input: Record<string, never>;
    output: { files: number; bytes: number };
  };
  // The display only: deletes every download but the files in use (a
  // download running, the current song's). kept counts those, and any that
  // couldn't be deleted.
  clearDownloads: {
    input: Record<string, never>;
    output: { deleted: number; bytes: number; kept: number };
  };
  // The display only: deletes a DAM song's downloaded video, which it found
  // is a sample. False if there was none, or it's downloading.
  clearDownload: {
    input: { songId: string; suffix: string };
    output: boolean;
  };

  // Whether the caller is an admin: the display, or a phone that sent a
  // live session's token in ADMIN_TOKEN_HEADER.
  whoami: { input: Record<string, never>; output: { isAdmin: boolean } };
  // Signs a phone in as an admin. 403 for a wrong password, 409 when the host
  // has set none; 429 after 5 tries in a minute from one address. The phone
  // sends the token in ADMIN_TOKEN_HEADER from then on. The display never
  // signs in: it is always an admin.
  adminLogin: { input: { password: string }; output: { token: string } };
  // Ends the session in ADMIN_TOKEN_HEADER, if there is one.
  adminLogout: {
    input: Record<string, never>;
    output: Record<string, never>;
  };

  // Settings: the display only (over IPC). A phone gets 403 for each.

  // setup: there was no config.yaml at launch (a first start), and the
  // host hasn't finished or skipped the setup screen yet (finishSetup).
  // needsRestart: a setting that only takes effect after a restart
  // (remoconPort) is saved with a value other than the one the app started
  // with.
  // loadProblem: why config.yaml couldn't be read at launch, so the
  // defaults are in use ("config.yaml couldn't be read (line 3 isn't valid
  // YAML)..."), or null.
  getSettings: {
    input: Record<string, never>;
    output: {
      settings: Settings;
      setup: boolean;
      needsRestart: boolean;
      loadProblem: string | null;
    };
  };
  // Changes the given settings, all or none: ok: false lists what's wrong
  // ("remoconPort must be a whole number from 1 to 65535") and changes
  // nothing. A password given as MASKED_PASSWORD stays as it is. Changing a
  // login signs that service out, so the next search signs in again.
  setSettings: {
    input: { settings: SettingsChanges };
    output:
      { ok: true; needsRestart: boolean } | { ok: false; problems: string[] };
  };
  // Sets the admin password ("" for none) and signs every phone out.
  setAdminPassword: {
    input: { password: string };
    output: Record<string, never>;
  };
  // Signs in to DAM or Joysound with the saved login, without keeping the
  // session. Gives up after 15 seconds.
  testLogin: {
    input: { service: LoginService };
    output: TestLoginResult;
  };
  // Links karafriends to the saved Joysound account as its TV app, even if
  // another TV app holds the link: that one is unlinked (an account links
  // one at a time). Only when the host asks. Gives up after 30 seconds.
  switchJoysoundLink: {
    input: Record<string, never>;
    output: TestLoginResult;
  };
  // config.yaml, logins and admin password hash included, with a
  // "karafriendsConfigVersion: 1" line first.
  exportConfig: {
    input: Record<string, never>;
    output: { yaml: string };
  };
  // Applies a file from exportConfig, or any config.yaml. Settings the file
  // leaves out stay as they are; unknown and obsolete keys are dropped. ok:
  // false (nothing changed) if the file isn't YAML or any value is wrong,
  // with what's wrong. ok: true lists what was dropped, then how each login
  // test went ("DAM login works."): a failed login doesn't undo the import.
  importConfig: {
    input: { yaml: string };
    output:
      { ok: true; problems: string[] } | { ok: false; problems: string[] };
  };
  // The setup screen is done (finished, or skipped): it doesn't open again
  // until config.yaml is new again.
  finishSetup: {
    input: Record<string, never>;
    output: Record<string, never>;
  };
  // Restarts the app, for remoconPort. Answers first.
  restartApp: {
    input: Record<string, never>;
    output: Record<string, never>;
  };
  // ffmpeg's and yt-dlp's versions, and whether YouTube downloads fail.
  getToolsStatus: {
    input: Record<string, never>;
    output: ToolsStatus;
  };
  // Downloads ffmpeg and yt-dlp again (those not overridden), even if the
  // cached copies look current, and clears the tools problem. ok: false
  // with a sentence for the host if a download failed (the old copy stays).
  updateTools: {
    input: Record<string, never>;
    output: { ok: true } | { ok: false; reason: string };
  };
}

export type ApiMethod = keyof Api;
export type ApiInput<M extends ApiMethod> = Api[M]["input"];
export type ApiOutput<M extends ApiMethod> = Api[M]["output"];
