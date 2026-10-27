import { useMemo } from "react";

import type { SharedQueueItem } from "../api";
import { useLiveState } from "../apiClient";

// A queued song and the seconds until it's expected to start.
export type QueueEntry = [SharedQueueItem, number];

// The ETAs add up the playtimes before each song, starting with the current
// song's (as if it had just started).
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

const EMPTY: SharedQueueItem[] = [];

// The songs after the current one, with ETAs; a new array only when they
// change.
export default function useQueue(): QueueEntry[] {
  const currentSong = useLiveState((state) => state?.currentSong ?? null);
  const queue = useLiveState((state) => state?.queue ?? EMPTY);
  return useMemo(() => withETAs(currentSong, queue), [currentSong, queue]);
}
