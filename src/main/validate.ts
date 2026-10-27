// Input checks for POST /api/<method>, since phones are untrusted. Each
// check throws an ApiError (400) naming the
// field, and returns the input typed for its handler. Unknown fields are
// refused too, so a client typo shows up at once.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type {
  ApiInput,
  ApiMethod,
  PageInput,
  PlaybackState,
  QueueItemKind,
  QueueSongInput,
} from "../common/api";
import { PLAYBACK_STATES } from "../common/api";
import { ApiError } from "./api";

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
  "playtime",
  "tryHeadOfQueue",
];

const QUEUE_KIND_FIELDS: Record<QueueItemKind, string[]> = {
  dam: ["streamingUrlIdx"],
  joysound: ["isRomaji", "youtubeVideoId"],
  youtube: ["adhocLyrics", "captionCode", "gainValue"],
  nico: [],
};

function queueSong(raw: unknown): QueueSongInput {
  const kind = oneOf(fields(raw), "kind", QUEUE_KINDS);
  const input = fields(raw, [...QUEUE_FIELDS, ...QUEUE_KIND_FIELDS[kind]]);
  const song = {
    songId: string(input, "songId", 64),
    name: string(input, "name"),
    artistName: string(input, "artistName"),
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
    case "joysound":
      return {
        kind,
        ...song,
        isRomaji: boolean(input, "isRomaji"),
        youtubeVideoId: stringOrNull(input, "youtubeVideoId", 64),
      };
    case "youtube": {
      const gainValue = input.gainValue;
      if (
        typeof gainValue !== "number" ||
        !Number.isFinite(gainValue) ||
        gainValue < 0 ||
        gainValue > 100
      ) {
        fail(`"gainValue" must be a number from 0 to 100`);
      }
      return {
        kind,
        ...song,
        adhocLyrics: stringOrNull(input, "adhocLyrics", 100_000),
        captionCode: stringOrNull(input, "captionCode", 16),
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
  setPlaybackState: (raw) => ({
    playbackState: oneOf<PlaybackState>(
      fields(raw, ["playbackState"]),
      "playbackState",
      PLAYBACK_STATES,
    ),
  }),
  setPitchShiftSemis: (raw) => ({
    semis: integer(fields(raw, ["semis"]), "semis", -24, 24),
  }),
  pushAdhocLyrics: (raw) => {
    const input = fields(raw, ["lyric", "lyricIndex"]);
    return {
      lyric: string(input, "lyric"),
      lyricIndex: integer(input, "lyricIndex", 0, 100_000),
    };
  },
  sendEmote: (raw) => {
    const emote = string(fields(raw, ["emote"]), "emote", 32);
    if (emote === "") fail(`"emote" must not be empty`);
    return { emote };
  },
  popSong: nothing,
  whoami: nothing,
};
