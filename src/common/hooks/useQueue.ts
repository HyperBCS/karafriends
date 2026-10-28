import { useEffect, useMemo, useState } from "react";

import type { SharedQueueItem } from "../api";
import { serverNow, useLiveState } from "../apiClient";
import { secondsPlayed } from "../currentSong";

// A queued song and the seconds until it's expected to start.
export type QueueEntry = [SharedQueueItem, number];

// The ETAs add up the playtimes before each song, starting with the current
// song's whole playtime, as if it had just started: useQueue and useWait
// take off what has played.
export function withETAs(
  currentSong: SharedQueueItem | null,
  queue: SharedQueueItem[],
): QueueEntry[] {
  let eta = currentSong?.playtime || 0;
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
