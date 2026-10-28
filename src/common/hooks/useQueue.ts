import { useEffect, useMemo, useState } from "react";

import type { LiveState, SharedQueueItem } from "../api";
import { useLiveState } from "../apiClient";

// A queued song and the seconds until it's expected to start.
export type QueueEntry = [SharedQueueItem, number];

type Timing = Pick<
  LiveState,
  "currentSongStartedAt" | "currentSongPausedMs" | "currentSongPausedSince"
>;

// The ETAs add up the playtimes before each song, starting with what is left
// of the current song's at now (ms since the epoch): its playtime less the
// time it has played, never below 0. Without now, as if it had just started.
export function withETAs(
  currentSong: SharedQueueItem | null,
  queue: SharedQueueItem[],
  timing?: Timing,
  now?: number,
): QueueEntry[] {
  let eta = currentSong?.playtime || 0;
  if (timing?.currentSongStartedAt != null && now !== undefined) {
    const until = timing.currentSongPausedSince ?? now;
    const playedMs =
      until - timing.currentSongStartedAt - timing.currentSongPausedMs;
    eta = Math.max(0, Math.round(eta - Math.max(0, playedMs) / 1000));
  }
  return queue.map((item) => {
    const entry: QueueEntry = [item, eta];
    eta += item.playtime || 0;
    return entry;
  });
}

const EMPTY: SharedQueueItem[] = [];

// The songs after the current one, with ETAs that count down once a second
// while a song plays (live), or as if it had just started (not live: for
// whatever acts on the ETAs rather than showing them, since they change every
// second). A new array only when they change.
export default function useQueue(live = true): QueueEntry[] {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const queue = useLiveState((state) => state?.queue ?? EMPTY);
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
  return useMemo(
    () =>
      live
        ? withETAs(
            currentSong,
            queue,
            {
              currentSongStartedAt: startedAt,
              currentSongPausedMs: pausedMs,
              currentSongPausedSince: pausedSince,
            },
            now,
          )
        : withETAs(currentSong, queue),
    [live, currentSong, queue, startedAt, pausedMs, pausedSince, now],
  );
}
