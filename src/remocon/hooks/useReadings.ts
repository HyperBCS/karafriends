import { useSyncExternalStore } from "react";

import type { ReadingsMode } from "../../common/api";
import { pickReadings, READINGS_KEY } from "../../common/readings";

// The phone's Readings setting (see readings.ts), which every row with a
// title follows, the queue sheet's included, as soon as it changes.

const listeners = new Set<() => void>();

function stored(): ReadingsMode {
  try {
    return pickReadings(localStorage.getItem(READINGS_KEY));
  } catch {
    return "written";
  }
}

let current = stored();

export function saveReadings(readings: ReadingsMode) {
  try {
    localStorage.setItem(READINGS_KEY, readings);
  } catch {
    // Not saved; it still applies until the page reloads.
  }
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
