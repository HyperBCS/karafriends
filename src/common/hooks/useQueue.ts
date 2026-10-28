import { useEffect, useMemo, useState } from "react";

import type { LiveState, SharedQueueItem } from "../api";
import { useLiveState } from "../apiClient";

// A queued song and the seconds until it's expected to start.
export type QueueEntry = [SharedQueueItem, number];

type Timing = Pick<
  LiveState,
  "currentSongStartedAt" | "currentSongPausedMs" | "currentSongPausedSince"
>;

// What is left of a playtime at now (ms since the epoch): the playtime less
// the time the song has played, never below 0 or above the playtime. All of
// it until the song starts (no startedAt: none playing, or still loading).
function left(playtime: number, timing: Timing, now: number): number {
  if (timing.currentSongStartedAt == null) return playtime;
  const until = timing.currentSongPausedSince ?? now;
  const playedMs =
    until - timing.currentSongStartedAt - timing.currentSongPausedMs;
  return Math.max(0, Math.round(playtime - Math.max(0, playedMs) / 1000));
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

// How many seconds of the current song's playtime have gone by, once a
// second while it plays (live); not live, always 0.
function usePlayed(live: boolean): number {
  const playtime = useLiveState((state) => state?.currentSong?.playtime || 0);
  const startedAt = useLiveState(
    (state) => state?.currentSongStartedAt ?? null,
  );
  const pausedMs = useLiveState((state) => state?.currentSongPausedMs ?? 0);
  const pausedSince = useLiveState(
    (state) => state?.currentSongPausedSince ?? null,
  );
  const [now, setNow] = useState(Date.now);
  const ticking = live && startedAt !== null && pausedSince === null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, startedAt]);
  if (!live) return 0;
  const timing = {
    currentSongStartedAt: startedAt,
    currentSongPausedMs: pausedMs,
    currentSongPausedSince: pausedSince,
  };
  return playtime - left(playtime, timing, now);
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
