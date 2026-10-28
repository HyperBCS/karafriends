import { useSyncExternalStore } from "react";

import type { ReadingsMode } from "../../common/api";
import { pickReadings, READINGS_KEY } from "../../common/readings";
import { getItem, setItem } from "../../common/storage";

// The phone's Readings setting (see readings.ts), which every row with a
// title follows, the queue sheet's included, as soon as it changes.

const listeners = new Set<() => void>();

let current = pickReadings(getItem(READINGS_KEY));

export function saveReadings(readings: ReadingsMode) {
  setItem(READINGS_KEY, readings);
  current = readings;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const useReadings = (): ReadingsMode =>
  useSyncExternalStore(subscribe, () => current);

export default useReadings;
