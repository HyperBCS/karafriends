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

// How many whole seconds of a playtime have gone by at now: 0 until the song
// starts, never more than the playtime. The countdowns take it off.
export function secondsPlayed(
  playtime: number,
  timing: SongTiming,
  now: number,
): number {
  return playtime - secondsLeft(playtime, timing, now);
}
