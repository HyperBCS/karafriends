// The live-state feed: what GET /api/events streams to phones, and what the
// display gets over IPC (ipc.ts). Transport-agnostic: a listener gets
// LiveEvent objects and serializes them itself, synchronously.
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
  | { type: "queueAdded"; item: QueueItem }
  // Goes only to the phone that queued item, and the display.
  | { type: "queueFailed"; item: QueueItem; reason: string };

// Who is listening: a phone gives its device ID; the display, or a phone
// that gives none, owns nothing.
export interface Viewer {
  deviceId: string | null;
  isDisplay?: boolean;
}

const NOBODY: Viewer = { deviceId: null };

export interface LiveHub {
  // Sends an emote or queueAdded event to every listener, or a queueFailed
  // event to its phone and the display.
  publish(message: HubMessage): void;
  // The listener gets the current state at once, then every state change
  // (throttled) and every message. Returns a function that stops it.
  subscribe(listener: (event: LiveEvent) => void, viewer?: Viewer): () => void;
}

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
    downloads: state.downloadQueue.map((download): DownloadProgress => ({
      id: download.id,
      kind: download.kind,
      songId: download.songId,
      suffix: download.suffix,
      progress: download.progress,
      status: download.status,
      reason: download.reason,
      isMine: deviceId !== null && download.userIdentity.deviceId === deviceId,
    })),
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

// The event each viewer gets for message, or null for none.
function messageEvents(
  message: HubMessage,
): (viewer: Viewer) => LiveEvent | null {
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
    case "queueFailed": {
      const { item, reason } = message;
      let forDisplay: LiveEvent | null = null;
      let forOwner: LiveEvent | null = null;
      return (viewer: Viewer): LiveEvent | null => {
        if (viewer.isDisplay) {
          forDisplay ??= {
            type: "queueFailed",
            item: shareQueueItem(item, null),
            reason,
          };
          return forDisplay;
        }
        if (viewer.deviceId === null || viewer.deviceId !== item.user.deviceId)
          return null;
        forOwner ??= {
          type: "queueFailed",
          item: shareQueueItem(item, viewer.deviceId),
          reason,
        };
        return forOwner;
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

  const deliver = (eventFor: (viewer: Viewer) => LiveEvent | null) => {
    for (const [listener, viewer] of listeners) {
      const event = eventFor(viewer);
      if (event) tell(listener, event);
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
  // store, so look at them while any are running or failed (or just went).
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
      // Send a pending state change first, so the new listener starts from
      // what was last sent. Otherwise, should the state change back before
      // the pending flush, that flush would see nothing new to send and
      // leave the new listener with a state that no longer exists.
      if (flushTimer) flush();
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
