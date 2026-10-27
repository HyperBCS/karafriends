// The live-state feed: what GET /api/events streams to phones (and, from
// Phase 5f, what the display gets over IPC). Transport-agnostic: a listener
// gets LiveEvent objects and serializes them itself, synchronously.
//
// No device IDs go out: a listener says which device it is, and sees which
// songs and downloads are its own (isMine). Whatever a listener doesn't own
// is the same object for every listener, so a transport can serialize it once
// per change instead of once per phone (server.ts does).
//
// No Electron imports, so unit tests can load this file under plain Node.
import type {
  DownloadProgress,
  LiveEvent,
  LiveState,
  QueueItem,
  SharedQueueItem,
  UserIdentity,
} from "../common/api";
import type { State, StateStore } from "./state";

// What the API publishes, with whole identities. The hub passes these on
// without the device IDs.
export type HubMessage =
  | { type: "emote"; emote: string; user: UserIdentity }
  | { type: "queueAdded"; item: QueueItem };

// Who is listening: a phone gives its device ID; the display, or a phone
// that gives none, owns nothing.
export interface Viewer {
  deviceId: string | null;
}

const NOBODY: Viewer = { deviceId: null };

export interface LiveHub {
  // Sends an emote or queueAdded event to every listener.
  publish(message: HubMessage): void;
  // The listener gets the current state at once, then every state change
  // (throttled) and every message. Returns a function that stops it.
  subscribe(listener: (event: LiveEvent) => void, viewer?: Viewer): () => void;
}

// DownloadQueueItem.downloadType, as videoDownloader numbers them.
const DOWNLOAD_KINDS: DownloadProgress["kind"][] = [
  "joysound",
  "youtube",
  "nico",
];

// A queue item as deviceId's phone may see it: the singer's nickname, and
// whether that phone queued it.
export function shareQueueItem(
  item: QueueItem,
  deviceId: string | null,
): SharedQueueItem {
  const { user, ...fields } = item;
  return {
    ...fields,
    user: { nickname: user.nickname },
    isMine: deviceId !== null && user.deviceId === deviceId,
  } as SharedQueueItem;
}

// The live state as deviceId's phone sees it (null: as the display does).
export function toLiveState(
  state: Readonly<State>,
  config: { supervisedMode: boolean },
  deviceId: string | null = null,
): LiveState {
  return {
    currentSong: state.currentSong
      ? shareQueueItem(state.currentSong, deviceId)
      : null,
    queue: state.songQueue.map((item) => shareQueueItem(item, deviceId)),
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
              isMine:
                deviceId !== null &&
                download.userIdentity.deviceId === deviceId,
            },
          ]
        : [];
    }),
    config: { supervisedMode: config.supervisedMode },
  };
}

// Whether deviceId queued or is downloading anything. Most phones don't,
// and they all share one copy of the state.
function ownsAny(state: Readonly<State>, deviceId: string): boolean {
  return (
    state.currentSong?.user.deviceId === deviceId ||
    state.songQueue.some((item) => item.user.deviceId === deviceId) ||
    state.downloadQueue.some(
      (download) => download.userIdentity.deviceId === deviceId,
    )
  );
}

// Builds the state events for one change: one shared by every listener that
// owns nothing, and one per device that owns something.
function stateEvents(
  state: Readonly<State>,
  config: { supervisedMode: boolean },
  shared: LiveState = toLiveState(state, config),
) {
  const sharedEvent: LiveEvent = { type: "state", state: shared };
  const byDevice = new Map<string, LiveEvent>();
  return (viewer: Viewer): LiveEvent => {
    const { deviceId } = viewer;
    if (deviceId === null) return sharedEvent;
    let event = byDevice.get(deviceId);
    if (!event) {
      event = ownsAny(state, deviceId)
        ? { type: "state", state: toLiveState(state, config, deviceId) }
        : sharedEvent;
      byDevice.set(deviceId, event);
    }
    return event;
  };
}

function messageEvents(message: HubMessage) {
  switch (message.type) {
    case "emote": {
      const event: LiveEvent = {
        type: "emote",
        emote: message.emote,
        user: { nickname: message.user.nickname },
      };
      return () => event;
    }
    case "queueAdded": {
      const { item } = message;
      const shared: LiveEvent = {
        type: "queueAdded",
        item: shareQueueItem(item, null),
      };
      let mine: LiveEvent | null = null;
      return (viewer: Viewer): LiveEvent => {
        if (viewer.deviceId !== item.user.deviceId) return shared;
        mine ??= {
          type: "queueAdded",
          item: shareQueueItem(item, viewer.deviceId),
        };
        return mine;
      };
    }
  }
}

export function createLiveHub(
  store: StateStore,
  config: { supervisedMode: boolean },
  // At most one state event per interval: about 4 a second while downloads
  // report progress.
  intervalMs = 250,
): LiveHub {
  const listeners = new Map<(event: LiveEvent) => void, Viewer>();
  // The last state sent to everyone, serialized, so unchanged state isn't
  // sent again.
  let lastSent: string | null = null;
  let lastSentAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let downloadWatch: ReturnType<typeof setInterval> | null = null;

  const tell = <E>(listener: (event: E) => void, event: E) => {
    try {
      listener(event);
    } catch (err) {
      console.error("A live-state listener failed:", err);
    }
  };

  const deliver = (eventFor: (viewer: Viewer) => LiveEvent) => {
    for (const [listener, viewer] of listeners) {
      tell(listener, eventFor(viewer));
    }
  };

  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    lastSentAt = Date.now();
    const state = store.getState();
    const shared = toLiveState(state, config);
    const serialized = JSON.stringify(shared);
    if (serialized === lastSent) return;
    lastSent = serialized;
    deliver(stateEvents(state, config, shared));
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
      deliver(messageEvents(message));
    },
    subscribe(listener, viewer = NOBODY) {
      listeners.set(listener, viewer);
      const state = store.getState();
      if (listeners.size === 1) {
        // Nobody was listening, so what was last sent is stale.
        lastSent = JSON.stringify(toLiveState(state, config));
        lastSentAt = Date.now();
        downloadWatch = setInterval(watchDownloads, intervalMs);
        downloadWatch.unref?.();
      }
      tell(listener, stateEvents(state, config)(viewer));
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
  };
}
