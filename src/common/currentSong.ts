// The current song, as the server and every page see it: the key commands
// name it by, and how far into it the party is. No React and no Electron, so
// the main process, the phones and the display share one copy.
import type { LiveState } from "./api";

// A queue item's key: songId@timestamp, unique among the songs queued (the
// same video may be queued twice). Commands that act on the current song
// (setPlaybackState, setPitchShiftSemis, pushAdhocLyrics) name it by this,
// and the server keeps each YouTube song's adhoc lyrics under it.
export function songKey(item: { songId: string; timestamp: string }): string {
  return `${item.songId}@${item.timestamp}`;
}

// The current song's clock (see LiveState).
export type SongTiming = Pick<
  LiveState,
  "currentSongStartedAt" | "currentSongPausedSince"
>;

// What is left of a playtime at now (ms since the epoch, by the server's
// clock): the playtime less the time the song has played, in whole seconds,
// never below 0 or above the playtime. All of it until the song starts (no
// startedAt: none playing, or still loading).
export function secondsLeft(
  playtime: number,
  timing: SongTiming,
  now: number,
): number {
  if (timing.currentSongStartedAt == null) return playtime;
  const until = timing.currentSongPausedSince ?? now;
  const playedMs = until - timing.currentSongStartedAt;
  return Math.max(0, Math.round(playtime - Math.max(0, playedMs) / 1000));
}

// Skip intro lands this many seconds before the singing starts: the first
// line is on the screen, with a moment to get ready.
export const INTRO_LEAD_S = 5;
// The phones offer it only while it would skip at least this much: a long
// intro, not the last few seconds of one.
export const MIN_INTRO_SKIP_S = 10;

// Where Skip intro goes, in seconds, in a song whose singing starts
// lyricsStart seconds in.
export function introEnd(lyricsStart: number): number {
  return Math.max(0, lyricsStart - INTRO_LEAD_S);
}

// How many seconds Skip intro would skip, played seconds into a song whose
// singing starts lyricsStart seconds in (null: unknown). Null while the
// phones don't offer it: no known start, or less than MIN_INTRO_SKIP_S of
// intro left.
export function introLeft(
  lyricsStart: number | null,
  played: number,
): number | null {
  if (lyricsStart === null) return null;
  const left = introEnd(lyricsStart) - played;
  return left >= MIN_INTRO_SKIP_S ? left : null;
}

// How many whole seconds of a playtime have gone by at now: 0 until the song
// starts, never more than the playtime. The countdowns take it off.
export function secondsPlayed(
  playtime: number,
  timing: SongTiming,
  now: number,
): number {
  return playtime - secondsLeft(playtime, timing, now);
}
