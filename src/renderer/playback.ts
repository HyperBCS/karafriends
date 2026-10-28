import type { PoppedDamSong, PoppedSong } from "../common/api";

// The display's own settings (Settings → Display), kept in its localStorage
// like the mics, and the playback arithmetic that follows from them. Pure,
// so the unit tests reach them.

// Audio/video offset in ms: positive delays the sound, negative delays what
// the display draws from the video's time.
export const AV_OFFSET_KEY = "avOffsetMs";
export const AV_OFFSETS = Array.from({ length: 61 }, (_, i) => -300 + i * 10);

// UI scale in percent of the root font size (index.css).
export const UI_SCALE_KEY = "uiScale";
export const UI_SCALES = Array.from({ length: 16 }, (_, i) => 50 + i * 10);

// A saved choice, or fallback when nothing (or something else) is saved.
export function savedChoice(
  saved: string | null,
  choices: readonly number[],
  fallback: number,
): number {
  return saved && choices.includes(Number(saved)) ? Number(saved) : fallback;
}

// How long the sound waits for the picture, in seconds.
export function audioDelay(offsetMs: number): number {
  return Math.max(0, offsetMs) / 1000;
}

// The time the lyrics and the piano roll draw at, in seconds: behind the
// video's by a negative offset, to wait for sound that comes late.
export function drawTime(videoTime: number, offsetMs: number): number {
  return videoTime + Math.min(0, offsetMs) / 1000;
}

// The song's time the singer hears, in seconds, which the mic's pitch is
// filed at: behind the video's by the offset either way (a plus offset
// delays the sound, a minus one is sound that comes late).
export function pitchTime(videoTime: number, offsetMs: number): number {
  return videoTime - Math.abs(offsetMs) / 1000;
}

// The buffer stalls in one DAM song before it moves to the low bitrate.
export const STALLS_BEFORE_LOW = 3;

// After a song's stalls-th buffer stall: the low-bitrate URL to switch to,
// for the same vocal type, or null (not the third stall, or it started on
// the low bitrate).
export function lowBitrateFallback(
  song: PoppedDamSong,
  stalls: number,
): string | null {
  if (song.startWithLowBitrate || stalls !== STALLS_BEFORE_LOW) return null;
  return song.streamingUrls[song.streamingUrlIdx]?.low ?? null;
}

// The song's gain in the audio graph. Every song sets its own, so none plays
// at the gain the one before it left. Joysound plays as DAM does; a YouTube
// song's comes from YouTube's loudness figure (queueSong).
// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const JOYSOUND_GAIN = 1.0;
const NICO_GAIN = 0.8;

export function songGain(song: PoppedSong): number {
  switch (song.kind) {
    case "dam":
      return DAM_GAIN;
    case "joysound":
      return JOYSOUND_GAIN;
    case "youtube":
      return song.gainValue;
    case "nico":
      return NICO_GAIN;
  }
}
