// Input checks for POST /api/<method>, since phones are untrusted. Each
// check throws an ApiError (400) naming the
// field, and returns the input typed for its handler. Unknown fields are
// refused too, so a client typo shows up at once.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type {
  ApiInput,
  ApiMethod,
  MicInfo,
  PageInput,
  PlaybackState,
  QueueItemKind,
  QueueSongInput,
  SettingsChanges,
} from "../common/api";
import { LYRICS_MODES, PLAYBACK_STATES, READINGS_MODES } from "../common/api";
import { isCaptionCode } from "../common/captionCode";
import { ApiError } from "./api";
import { SETTABLE_KEYS } from "./settings";

type Fields = Record<string, unknown>;

function fail(message: string): never {
  throw new ApiError(400, message);
}

// The body as an object, refusing fields not in `allowed` (if given).
function fields(raw: unknown, allowed?: readonly string[]): Fields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("The body must be a JSON object");
  }
  for (const key of allowed ? Object.keys(raw) : []) {
    if (!allowed?.includes(key)) fail(`Unknown field "${key}"`);
  }
  return raw as Fields;
}

function string(input: Fields, key: string, maxLength = 1000): string {
  const value = input[key];
  if (typeof value !== "string" || value.length > maxLength) {
    fail(`"${key}" must be a string of at most ${maxLength} characters`);
  }
  return value;
}

// Missing and null both mean null.
function stringOrNull(
  input: Fields,
  key: string,
  maxLength = 1000,
): string | null {
  return input[key] === undefined || input[key] === null
    ? null
    : string(input, key, maxLength);
}

function integer(input: Fields, key: string, min: number, max: number) {
  const value = input[key];
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    fail(`"${key}" must be a whole number from ${min} to ${max}`);
  }
  return value as number;
}

function number(input: Fields, key: string, min: number, max: number) {
  const value = input[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail(`"${key}" must be a number from ${min} to ${max}`);
  }
  return value;
}

function optionalInteger(
  input: Fields,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return input[key] === undefined ? undefined : integer(input, key, min, max);
}

function boolean(input: Fields, key: string): boolean {
  if (typeof input[key] !== "boolean") fail(`"${key}" must be true or false`);
  return input[key] as boolean;
}

function oneOf<T extends string>(
  input: Fields,
  key: string,
  values: readonly T[],
): T {
  if (!values.includes(input[key] as T)) {
    fail(`"${key}" must be one of ${values.join(", ")}`);
  }
  return input[key] as T;
}

// The display's mic list: more than any party plugs in.
const MAX_MICS = 32;

function mic(raw: unknown): MicInfo {
  const input = fields(raw, ["id", "label", "gain", "echo"]);
  return {
    id: string(input, "id", 300),
    label: string(input, "label", 300),
    gain: integer(input, "gain", 0, 200),
    echo: integer(input, "echo", 0, 100),
  };
}

const PAGE_KEYS = ["offset", "limit"] as const;

function page(input: Fields): PageInput {
  return {
    offset: optionalInteger(input, "offset", 0, 1_000_000),
    limit: optionalInteger(input, "limit", 1, 100),
  };
}

function search(raw: unknown) {
  const input = fields(raw, ["query", ...PAGE_KEYS]);
  return { query: string(input, "query", 200), ...page(input) };
}

function idPage(raw: unknown) {
  const input = fields(raw, ["id", ...PAGE_KEYS]);
  return { id: string(input, "id", 64), ...page(input) };
}

function id(raw: unknown) {
  return { id: string(fields(raw, ["id"]), "id", 64) };
}

function videoId(raw: unknown) {
  return { videoId: string(fields(raw, ["videoId"]), "videoId", 64) };
}

function nothing(raw: unknown): Record<string, never> {
  fields(raw, []);
  return {};
}

const QUEUE_KINDS: readonly QueueItemKind[] = [
  "dam",
  "joysound",
  "youtube",
  "nico",
];

const QUEUE_FIELDS = [
  "kind",
  "songId",
  "name",
  "artistName",
  "nameYomi",
  "artistNameYomi",
  "readingsMode",
  "playtime",
  "tryHeadOfQueue",
];

const QUEUE_KIND_FIELDS: Record<QueueItemKind, string[]> = {
  dam: ["streamingUrlIdx"],
  joysound: ["lyricsMode", "youtubeVideoId"],
  youtube: ["adhocLyrics", "captionCode", "gainValue"],
  nico: [],
};

// Song and video IDs become temp file names (dam-<id>.log, yt-<id>.mp4, ...),
// so only allow characters that can't step outside the temp folder. Real DAM,
// Joysound, YouTube and Niconico IDs all fit.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeId(id: string, key: string): string {
  if (!SAFE_ID.test(id)) {
    fail(`"${key}" may only contain letters, digits, "-" and "_"`);
  }
  return id;
}

function queueSong(raw: unknown): QueueSongInput {
  const kind = oneOf(fields(raw), "kind", QUEUE_KINDS);
  const input = fields(raw, [...QUEUE_FIELDS, ...QUEUE_KIND_FIELDS[kind]]);
  const song = {
    songId: safeId(string(input, "songId", 64), "songId"),
    name: string(input, "name"),
    artistName: string(input, "artistName"),
    // Left out when not given.
    ...(input.nameYomi !== undefined && {
      nameYomi: string(input, "nameYomi", 200),
    }),
    ...(input.artistNameYomi !== undefined && {
      artistNameYomi: string(input, "artistNameYomi", 200),
    }),
    ...(input.readingsMode !== undefined && {
      readingsMode: oneOf(input, "readingsMode", READINGS_MODES),
    }),
    playtime:
      input.playtime === undefined || input.playtime === null
        ? null
        : integer(input, "playtime", 0, 24 * 60 * 60),
    tryHeadOfQueue:
      input.tryHeadOfQueue === undefined
        ? undefined
        : boolean(input, "tryHeadOfQueue"),
  };
  switch (kind) {
    case "dam":
      return {
        kind,
        ...song,
        streamingUrlIdx: integer(input, "streamingUrlIdx", 0, 99),
      };
    case "joysound": {
      const youtubeVideoId = stringOrNull(input, "youtubeVideoId", 64);
      return {
        kind,
        ...song,
        lyricsMode: oneOf(input, "lyricsMode", LYRICS_MODES),
        youtubeVideoId:
          youtubeVideoId === null
            ? null
            : safeId(youtubeVideoId, "youtubeVideoId"),
      };
    }
    case "youtube": {
      const gainValue = number(input, "gainValue", 0, 100);
      // Refused here, since the download that uses it starts after the
      // phone has its answer.
      const captionCode = stringOrNull(input, "captionCode", 16);
      if (captionCode !== null && !isCaptionCode(captionCode)) {
        fail(`"captionCode" must be a language code like "en" or "pt-BR"`);
      }
      return {
        kind,
        ...song,
        adhocLyrics: stringOrNull(input, "adhocLyrics", 100_000),
        captionCode,
        gainValue,
      };
    }
    case "nico":
      return { kind, ...song };
  }
}

export const validators: {
  [M in ApiMethod]: (raw: unknown) => ApiInput<M>;
} = {
  damSearchSongs: search,
  damSearchArtists: search,
  damArtist: idPage,
  damSong: id,
  joysoundSearchSongs: search,
  joysoundSearchArtists: search,
  joysoundArtistSongs: idPage,
  joysoundSong: id,
  youtubeInfo: videoId,
  nicoInfo: videoId,
  adhocLyrics: (raw) => ({
    songId: string(fields(raw, ["songId"]), "songId", 64),
  }),
  history: (raw) => page(fields(raw, PAGE_KEYS)),
  queueSong,
  removeSong: (raw) => {
    const input = fields(raw, ["songId", "timestamp"]);
    return {
      songId: string(input, "songId", 64),
      timestamp: string(input, "timestamp", 32),
    };
  },
  moveSong: (raw) => {
    const input = fields(raw, ["songId", "timestamp", "toIndex"]);
    return {
      songId: string(input, "songId", 64),
      timestamp: string(input, "timestamp", 32),
      toIndex: integer(input, "toIndex", 0, 1_000_000),
    };
  },
  setPlaybackState: (raw) => ({
    playbackState: oneOf<PlaybackState>(
      fields(raw, ["playbackState"]),
      "playbackState",
      PLAYBACK_STATES,
    ),
  }),
  reportSongPosition: (raw) => {
    const input = fields(raw, [
      "songId",
      "timestamp",
      "position",
      "length",
      "playing",
    ]);
    return {
      songId: string(input, "songId", 64),
      timestamp: string(input, "timestamp", 32),
      position: number(input, "position", 0, 24 * 60 * 60),
      length:
        input.length === null ? null : number(input, "length", 0, 24 * 60 * 60),
      playing: boolean(input, "playing"),
    };
  },
  setPitchShiftSemis: (raw) => ({
    semis: integer(fields(raw, ["semis"]), "semis", -24, 24),
  }),
  setGuideMelodyLevel: (raw) => ({
    level: number(fields(raw, ["level"]), "level", 0, 1),
  }),
  setSongVolume: (raw) => ({
    volume: integer(fields(raw, ["volume"]), "volume", 0, 100),
  }),
  setMicLevels: (raw) => {
    const input = fields(raw, ["id", "gain", "echo"]);
    return {
      id: string(input, "id", 300),
      gain: optionalInteger(input, "gain", 0, 200),
      echo: optionalInteger(input, "echo", 0, 100),
    };
  },
  pushAdhocLyrics: (raw) => ({
    lyricIndex: integer(fields(raw, ["lyricIndex"]), "lyricIndex", 0, 100_000),
  }),
  sendEmote: (raw) => {
    const emote = string(fields(raw, ["emote"]), "emote", 32);
    if (emote === "") fail(`"emote" must not be empty`);
    return { emote };
  },
  setMics: (raw) => {
    const mics = fields(raw, ["mics"]).mics;
    if (!Array.isArray(mics) || mics.length > MAX_MICS) {
      fail(`"mics" must be a list of at most ${MAX_MICS} mics`);
    }
    return { mics: mics.map(mic) };
  },
  downloadsInfo: nothing,
  clearDownloads: nothing,
  clearDownload: (raw) => {
    const input = fields(raw, ["songId", "suffix"]);
    return {
      songId: string(input, "songId", 64),
      suffix: string(input, "suffix", 64),
    };
  },
  popSong: nothing,
  whoami: nothing,
  adminLogin: (raw) => {
    const password = string(fields(raw, ["password"]), "password", 200);
    if (password === "") fail(`"password" must not be empty`);
    return { password };
  },
  adminLogout: nothing,

  getSettings: nothing,
  // The values' types and ranges are the handler's to check: it answers
  // with every problem at once, for the settings screen.
  setSettings: (raw) => {
    const settings = fields(fields(raw, ["settings"]).settings, SETTABLE_KEYS);
    return { settings: settings as SettingsChanges };
  },
  setAdminPassword: (raw) => ({
    password: string(fields(raw, ["password"]), "password", 200),
  }),
  testLogin: (raw) => ({
    service: oneOf(fields(raw, ["service"]), "service", [
      "dam",
      "joysound",
    ] as const),
  }),
  exportConfig: nothing,
  importConfig: (raw) => ({
    yaml: string(fields(raw, ["yaml"]), "yaml", 1_000_000),
  }),
  restartApp: nothing,
  getToolsStatus: nothing,
  updateTools: nothing,
};
