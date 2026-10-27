// The live-state feed: what GET /api/events streams to phones (and, from
// Phase 5f, what the display gets over IPC). Transport-agnostic: a listener
// gets LiveEvent objects and serializes them itself, synchronously.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { DownloadProgress, LiveEvent, LiveState } from "../common/api";
import type { State, StateStore } from "./state";

// The events that aren't state snapshots.
export type LiveMessage = Exclude<LiveEvent, { type: "state" }>;

export interface LiveHub {
  // Sends an emote or queueAdded event to every listener.
  publish(message: LiveMessage): void;
  // The listener gets the current state at once, then every state change
  // (throttled) and every message. Returns a function that stops it.
  subscribe(listener: (event: LiveEvent) => void): () => void;
  // Messages only, for the GraphQL subscriptions.
  onMessage(listener: (message: LiveMessage) => void): () => void;
}

// DownloadQueueItem.downloadType, as videoDownloader numbers them.
const DOWNLOAD_KINDS: DownloadProgress["kind"][] = [
  "joysound",
  "youtube",
  "nico",
];

export function toLiveState(
  state: Readonly<State>,
  config: { supervisedMode: boolean },
): LiveState {
  return {
    currentSong: state.currentSong,
    queue: state.songQueue,
    playbackState: state.playbackState,
    pitchShiftSemis: state.pitchShiftSemis,
    adhocLyrics: state.currentSongAdhocLyrics,
    downloads: state.downloadQueue.flatMap((download) => {
      const kind = DOWNLOAD_KINDS[download.downloadType];
      return kind
        ? [
            {
              kind,
              songId: download.songId,
              suffix: download.suffix,
              progress: download.progress,
              deviceId: download.userIdentity.deviceId,
            },
          ]
        : [];
    }),
    config: { supervisedMode: config.supervisedMode },
  };
}

export function createLiveHub(
  store: StateStore,
  config: { supervisedMode: boolean },
  // At most one state event per interval: about 4 a second while downloads
  // report progress.
  intervalMs = 250,
): LiveHub {
  const listeners = new Set<(event: LiveEvent) => void>();
  const messageListeners = new Set<(message: LiveMessage) => void>();
  // The last state sent to everyone, serialized, so unchanged state isn't
  // sent again.
  let lastSent: string | null = null;
  let lastSentAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let downloadWatch: ReturnType<typeof setInterval> | null = null;

  const deliver = <E>(targets: Set<(event: E) => void>, event: E) => {
    for (const listener of targets) {
      try {
        listener(event);
      } catch (err) {
        console.error("A live-state listener failed:", err);
      }
    }
  };

  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    lastSentAt = Date.now();
    const state = toLiveState(store.getState(), config);
    const serialized = JSON.stringify(state);
    if (serialized === lastSent) return;
    lastSent = serialized;
    deliver(listeners, { type: "state", state });
  };

  const scheduleFlush = () => {
    if (listeners.size === 0 || flushTimer) return;
    const wait = lastSentAt + intervalMs - Date.now();
    if (wait <= 0) {
      flush();
    } else {
      flushTimer = setTimeout(flush, wait);
    }
  };

  store.onChange(scheduleFlush);

  // videoDownloader updates downloads in place, without going through the
  // store, so look at them while any are running (or just finished).
  let downloadsSent = 0;
  const watchDownloads = () => {
    const running = store.getState().downloadQueue.length;
    if (running > 0 || downloadsSent > 0) scheduleFlush();
    downloadsSent = running;
  };

  return {
    publish(message) {
      // Send a pending state change first, so a client never hears about a
      // queued song before it can see it in the queue.
      if (flushTimer) flush();
      deliver(listeners, message);
      deliver(messageListeners, message);
    },
    subscribe(listener) {
      listeners.add(listener);
      const state = toLiveState(store.getState(), config);
      if (listeners.size === 1) {
        // Nobody was listening, so what was last sent is stale.
        lastSent = JSON.stringify(state);
        lastSentAt = Date.now();
        downloadWatch = setInterval(watchDownloads, intervalMs);
        downloadWatch.unref?.();
      }
      try {
        listener({ type: "state", state });
      } catch (err) {
        console.error("A live-state listener failed:", err);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (downloadWatch) clearInterval(downloadWatch);
          if (flushTimer) clearTimeout(flushTimer);
          downloadWatch = null;
          flushTimer = null;
        }
      };
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
  };
}
