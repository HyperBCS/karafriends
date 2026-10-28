import { useEffect, useMemo, useState } from "react";

import type { LiveState, SharedQueueItem } from "../api";
import { serverNow, useLiveState } from "../apiClient";

// A queued song and the seconds until it's expected to start.
export type QueueEntry = [SharedQueueItem, number];

type Timing = Pick<
  LiveState,
  "currentSongStartedAt" | "currentSongPausedMs" | "currentSongPausedSince"
>;

// What is left of a playtime at now (ms since the epoch, by the server's
// clock): the playtime less the time the song has played, never below 0 or
// above the playtime. All of it until the song starts (no startedAt: none
// playing, or still loading).
function left(playtime: number, timing: Timing, now: number): number {
  if (timing.currentSongStartedAt == null) return playtime;
  const until = timing.currentSongPausedSince ?? now;
  const playedMs =
    until - timing.currentSongStartedAt - timing.currentSongPausedMs;
  return Math.max(0, Math.round(playtime - Math.max(0, playedMs) / 1000));
}

// How many whole seconds of a playtime have gone by at now: 0 until the song
// starts, never more than the playtime. The countdowns take it off, and the
// progress line shows it.
export function secondsPlayed(
  playtime: number,
  timing: Timing,
  now: number,
): number {
  return playtime - left(playtime, timing, now);
}

// The ETAs add up the playtimes before each song, starting with what is left
// of the current song's at now. Without now, as if it had just started.
export function withETAs(
  currentSong: SharedQueueItem | null,
  queue: SharedQueueItem[],
  timing?: Timing,
  now?: number,
): QueueEntry[] {
  let eta = currentSong?.playtime || 0;
  if (timing && now !== undefined) eta = left(eta, timing, now);
  return queue.map((item) => {
    const entry: QueueEntry = [item, eta];
    eta += item.playtime || 0;
    return entry;
  });
}

// How many seconds of the current song's playtime have gone by (the
// server makes it the video's length once the display knows it): read
// afresh on each render, which comes once a second while it plays (live) and
// whenever its timing changes (a pause, a seek); not live, always 0.
function usePlayed(live: boolean): number {
  const playtime = useLiveState((state) => state?.currentSong?.playtime || 0);
  const startedAt = useLiveState(
    (state) => state?.currentSongStartedAt ?? null,
  );
  const pausedMs = useLiveState((state) => state?.currentSongPausedMs ?? 0);
  const pausedSince = useLiveState(
    (state) => state?.currentSongPausedSince ?? null,
  );
  const [, setTicks] = useState(0);
  const ticking = live && startedAt !== null && pausedSince === null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTicks((ticks) => ticks + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!live) return 0;
  const timing = {
    currentSongStartedAt: startedAt,
    currentSongPausedMs: pausedMs,
    currentSongPausedSince: pausedSince,
  };
  return secondsPlayed(playtime, timing, serverNow());
}

// A song's wait from useQueue(false), counting down once a second while
// the current song plays: for the one part of a row that changes every
// second, so the rest of it doesn't.
export function useWait(eta: number): number {
  return eta - usePlayed(true);
}

// Where the current song is, in seconds of its length, by the same clock as
// the waits: once a second while it plays, still while it's paused. Null
// while none plays or its length isn't known.
export function useSongProgress(): { position: number; length: number } | null {
  const length = useLiveState((state) => state?.currentSong?.playtime || 0);
  const position = usePlayed(true);
  return length > 0 ? { position, length } : null;
}

const EMPTY: SharedQueueItem[] = [];

// The songs after the current one, with ETAs that count down once a second
// while a song plays (live), or as if it had just started (not live: for
// whatever acts on the ETAs rather than showing them, since they change every
// second). A new array only when they change: not live, only when the
// current song or the queue does.
export default function useQueue(live = true): QueueEntry[] {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const queue = useLiveState((state) => state?.queue ?? EMPTY);
  const played = usePlayed(live);
  const etas = useMemo(
    () => withETAs(currentSong, queue),
    [currentSong, queue],
  );
  return useMemo(
    () =>
      played
        ? etas.map(([item, eta]): QueueEntry => [item, eta - played])
        : etas,
    [etas, played],
  );
}
