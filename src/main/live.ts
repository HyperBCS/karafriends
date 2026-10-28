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

// What the API publishes for the display, with whole identities. The hub
// passes these on without the device IDs.
export type HubMessage =
  | { type: "emote"; emote: string; user: UserIdentity }
  | { type: "queueAdded"; item: QueueItem }
  | { type: "queueFailed"; item: QueueItem; reason: string }
  | { type: "micLevels"; id: string; gain?: number; echo?: number };

// Who is listening: a phone gives its device ID; the display, or a phone
// that gives none, owns nothing.
export interface Viewer {
  deviceId: string | null;
  isDisplay?: boolean;
}

const NOBODY: Viewer = { deviceId: null };

export interface LiveHub {
  // Sends message's event to the display (no phone uses one).
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

// The downloads as deviceId's phone sees them.
function liveDownloads(
  state: Readonly<State>,
  deviceId: string | null,
): DownloadProgress[] {
  return state.downloadQueue.map((download) => ({
    id: download.id,
    kind: download.kind,
    songId: download.songId,
    suffix: download.suffix,
    progress: download.progress,
    status: download.status,
    reason: download.reason,
    isMine: deviceId !== null && download.userIdentity.deviceId === deviceId,
  }));
}

// The live state as deviceId's phone sees it (null: as the display does).
// The current song's playtime is its video's length once the display has
// reported it.
export function toLiveState(
  state: Readonly<State>,
  config: LiveState["config"],
  deviceId: string | null = null,
): LiveState {
  return {
    currentSong: state.currentSong
      ? {
          ...shareQueueItem(state.currentSong, deviceId),
          playtime: state.currentSongLength ?? state.currentSong.playtime,
        }
      : null,
    currentSongStartedAt: state.currentSongStartedAt,
    currentSongPausedSince: state.currentSongPausedSince,
    queue: state.songQueue.map((item) => shareQueueItem(item, deviceId)),
    playbackState: state.playbackState,
    pitchShiftSemis: state.pitchShiftSemis,
    guideMelodyLevel: state.guideMelodyLevel,
    songVolume: state.songVolume,
    mics: state.mics,
    adhocLyrics: state.currentSongAdhocLyrics,
    downloads: liveDownloads(state, deviceId),
    config: {
      supervisedMode: config.supervisedMode,
      everyoneIsAdmin: config.everyoneIsAdmin,
    },
    toolsProblem: state.toolsProblem?.message ?? null,
    remoconProblem: state.remoconProblem,
    adminSignOuts: state.adminSignOuts,
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
  config: LiveState["config"],
  shared: LiveState = toLiveState(state, config),
) {
  const sentAt = Date.now();
  const sharedEvent: LiveEvent = { type: "state", state: shared, sentAt };
  const byDevice = new Map<string, LiveEvent>();
  return (viewer: Viewer): LiveEvent => {
    const { deviceId } = viewer;
    if (deviceId === null) return sharedEvent;
    let event = byDevice.get(deviceId);
    if (!event) {
      event = ownsAny(state, deviceId)
        ? {
            type: "state",
            state: toLiveState(state, config, deviceId),
            sentAt,
          }
        : sharedEvent;
      byDevice.set(deviceId, event);
    }
    return event;
  };
}

// The downloads events for a change to them alone, shared as stateEvents'
// are: one for every listener downloading nothing, and one per device that
// is.
function downloadsEvents(
  state: Readonly<State>,
  shared: DownloadProgress[] = liveDownloads(state, null),
) {
  const sharedEvent: LiveEvent = { type: "downloads", downloads: shared };
  const byDevice = new Map<string, LiveEvent>();
  return (viewer: Viewer): LiveEvent => {
    const { deviceId } = viewer;
    if (deviceId === null) return sharedEvent;
    let event = byDevice.get(deviceId);
    if (!event) {
      event = state.downloadQueue.some(
        (download) => download.userIdentity.deviceId === deviceId,
      )
        ? { type: "downloads", downloads: liveDownloads(state, deviceId) }
        : sharedEvent;
      byDevice.set(deviceId, event);
    }
    return event;
  };
}

// The display's event for message. Messages are the display's alone: the
// phones use only the state (a failed download shows in its downloads).
function messageEvent(message: HubMessage): LiveEvent {
  switch (message.type) {
    case "emote":
      return {
        type: "emote",
        emote: message.emote,
        user: { nickname: message.user.nickname },
      };
    case "queueAdded":
      return { type: "queueAdded", item: shareQueueItem(message.item, null) };
    case "queueFailed":
      return {
        type: "queueFailed",
        item: shareQueueItem(message.item, null),
        reason: message.reason,
      };
    case "micLevels":
      return { ...message };
  }
}

export function createLiveHub(
  store: StateStore,
  config: LiveState["config"],
  // At most one state or downloads event per interval: about 4 a second
  // while downloads report progress.
  intervalMs = 250,
): LiveHub & {
  // Sends the state again if it changed some other way than through the
  // store: config's supervisedMode or everyoneIsAdmin, from the settings.
  refresh(): void;
} {
  const listeners = new Map<(event: LiveEvent) => void, Viewer>();
  // The last state sent to everyone, serialized, so unchanged state isn't
  // sent again: its downloads apart, since their progress changes several
  // times a second while the rest stays, and goes out alone (a downloads
  // event, a few hundred bytes, not the whole state).
  let lastSent: string | null = null;
  let lastDownloads: string | null = null;
  // Takes shared as sent, and says what changed since the last.
  const remember = (shared: LiveState) => {
    const { downloads, ...rest } = shared;
    const serialized = JSON.stringify(rest);
    const serializedDownloads = JSON.stringify(downloads);
    const changed = {
      state: serialized !== lastSent,
      downloads: serializedDownloads !== lastDownloads,
    };
    lastSent = serialized;
    lastDownloads = serializedDownloads;
    return changed;
  };
  // When, by the monotonic clock (performance.now()): the wall clock may
  // step back (a time sync), which would hold every change back that long.
  // Only an event's sentAt is the wall clock's, for the phones.
  let lastSentAt = -Infinity;
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
    lastSentAt = performance.now();
    const state = store.getState();
    const shared = toLiveState(state, config);
    const changed = remember(shared);
    if (changed.state) {
      deliver(stateEvents(state, config, shared));
    } else if (changed.downloads) {
      deliver(downloadsEvents(state, shared.downloads));
    }
  };

  const scheduleFlush = () => {
    if (listeners.size === 0 || flushTimer) return;
    const wait = lastSentAt + intervalMs - performance.now();
    if (wait <= 0) {
      flush();
    } else {
      flushTimer = setTimeout(flush, wait);
    }
  };

  store.onChange(scheduleFlush);

  // src/main/downloads updates downloads in place, without going through the
  // store, so look at them while any are running or failed (or just went).
  // A poll, not a notice from every place that changes one: it costs a
  // length check each interval and can't miss a change.
  let downloadsSent = 0;
  const watchDownloads = () => {
    const running = store.getState().downloadQueue.length;
    if (running > 0 || downloadsSent > 0) scheduleFlush();
    downloadsSent = running;
  };

  return {
    refresh: scheduleFlush,
    publish(message) {
      // Send a pending state change first, so a client never hears about a
      // queued song before it can see it in the queue.
      if (flushTimer) flush();
      const event = messageEvent(message);
      deliver((viewer) => (viewer.isDisplay ? event : null));
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
        remember(toLiveState(state, config));
        lastSentAt = performance.now();
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
