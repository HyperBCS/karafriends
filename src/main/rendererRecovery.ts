// When to reload the display after its renderer crashes. Once or twice is
// a GPU reset or a fault worth retrying, after a growing wait. A third time
// within a minute is a crash on every load (a mic whose driver faults when
// opened, say): reloading again would loop about once a second and keep
// the host out of Settings, so it stops and asks instead.

export const CRASH_WINDOW_MS = 60_000;
// The waits before the reloads after the 1st and 2nd crash in the window.
export const RELOAD_DELAYS_MS = [1_000, 3_000];

export function createCrashReloads(now: () => number = Date.now) {
  let crashes: number[] = [];
  return {
    // After a crash: how long to wait before reloading, or null to stop and
    // ask the host.
    crashed(): number | null {
      const at = now();
      crashes = [...crashes.filter((t) => at - t < CRASH_WINDOW_MS), at];
      return RELOAD_DELAYS_MS[crashes.length - 1] ?? null;
    },
    // The host asked for a reload: count afresh.
    reset() {
      crashes = [];
    },
  };
}
