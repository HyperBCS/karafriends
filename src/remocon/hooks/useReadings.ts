import { useSyncExternalStore } from "react";

import {
  pickReadings,
  READINGS_KEY,
  type Readings,
} from "../../common/readings";

// The phone's Readings setting (see readings.ts), which every row with a
// title follows, the queue sheet's included, as soon as it changes.

const listeners = new Set<() => void>();

function stored(): Readings {
  try {
    return pickReadings(localStorage.getItem(READINGS_KEY));
  } catch {
    return "written";
  }
}

let current = stored();

export function saveReadings(readings: Readings) {
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

const useReadings = (): Readings =>
  useSyncExternalStore(subscribe, () => current);

export default useReadings;
