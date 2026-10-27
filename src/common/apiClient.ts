// The client side of the JSON RPC API in src/common/api.ts, for the phone
// remote and the display: call() runs a method, and LiveStateProvider keeps
// one live-state stream (GET /api/events) per page for useLiveState() and
// useLiveEvent().
//
// A phone talks to the server that served its page. The display window is
// loaded from the Parcel dev server (dev) or a file URL (prod), so it talks
// to the same server on localhost; the webRequest rewrites in
// src/main/index.ts let it past CORS until Phase 5f moves it to IPC.
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  EVENTS_DEVICE_ID_PARAM,
  IDENTITY_HEADERS,
  type ApiInput,
  type ApiMethod,
  type ApiOutput,
  type LiveEvent,
  type LiveEventType,
  type LiveState,
} from "./api";

// The display window (it has the preload's API); phones don't.
function isDisplay(): boolean {
  return typeof window !== "undefined" && window.karafriends !== undefined;
}

export function serverUrl(path: string): string {
  return isDisplay()
    ? `http://localhost:${window.karafriends.karafriendsConfig().remoconPort}${path}`
    : path;
}

function storedIdentity(): {
  deviceId: string | null;
  nickname: string | null;
} {
  try {
    return {
      deviceId: localStorage.getItem("deviceId") || null,
      nickname: localStorage.getItem("nickname") || null,
    };
  } catch {
    // No localStorage (blocked, or not a browser): anonymous.
    return { deviceId: null, nickname: null };
  }
}

// Who is asking, for the server's admin checks: the display sends its secret,
// a phone its device ID and nickname (percent-encoded, since a nickname may
// not be ASCII).
export function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isDisplay()) {
    const token = window.karafriends.displayToken();
    if (token) headers[IDENTITY_HEADERS.displayToken] = token;
    return headers;
  }
  const { deviceId, nickname } = storedIdentity();
  if (deviceId) {
    headers[IDENTITY_HEADERS.deviceId] = encodeURIComponent(deviceId);
  }
  if (nickname) {
    headers[IDENTITY_HEADERS.nickname] = encodeURIComponent(nickname);
  }
  return headers;
}

// A method the server refused or failed: the HTTP status and its message.
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

export async function call<M extends ApiMethod>(
  method: M,
  input: ApiInput<M>,
): Promise<ApiOutput<M>> {
  const res = await fetch(serverUrl(`/api/${method}`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...identityHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = `${method} failed with HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Not JSON (a proxy's error page, say): keep the status.
    }
    throw new ApiCallError(res.status, message);
  }
  return res.json();
}

// The stream's address. A phone gives its device ID, so its copy of the state
// marks its own songs (isMine); the display gives none.
export function eventsUrl(deviceId: string | null): string {
  const query = deviceId
    ? `?${EVENTS_DEVICE_ID_PARAM}=${encodeURIComponent(deviceId)}`
    : "";
  return serverUrl(`/api/events${query}`);
}

// One `data:` line of the stream, or null if it isn't a LiveEvent.
export function parseLiveEvent(data: string): LiveEvent | null {
  try {
    const event = JSON.parse(data);
    return typeof event?.type === "string" ? event : null;
  } catch {
    return null;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// The new state, keeping the previous one's parts that didn't change, so a
// component that depends on, say, the queue only updates when the queue
// does. Returns prev itself if nothing changed.
export function mergeLiveState(
  prev: LiveState | null,
  next: LiveState,
): LiveState {
  if (prev === null) return next;
  let changed = false;
  const merged = { ...next };
  for (const key of Object.keys(next) as (keyof LiveState)[]) {
    if (sameJson(prev[key], next[key])) {
      (merged as Record<keyof LiveState, unknown>)[key] = prev[key];
    } else {
      changed = true;
    }
  }
  return changed ? merged : prev;
}

type Listener = (event: LiveEvent) => void;

interface LiveEvents {
  subscribe(listener: Listener): () => void;
}

const LiveStateContext = createContext<LiveState | null>(null);
const LiveEventsContext = createContext<LiveEvents>({
  subscribe: () => () => {},
});
const AdminContext = createContext<boolean | undefined>(undefined);

// How long to wait before opening a new stream when EventSource gives up.
const RESTART_MS = 5_000;

// One stream for the page. Mount it once, at the root. With checkAdmin, it
// also asks whoami each time it connects, for useIsAdmin().
export function LiveStateProvider({
  children,
  checkAdmin = false,
}: {
  children?: React.ReactNode;
  checkAdmin?: boolean;
}) {
  const [state, setState] = useState<LiveState | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);
  const [listeners] = useState(() => new Set<Listener>());
  const [events] = useState<LiveEvents>(() => ({
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }));

  useEffect(() => {
    let source: EventSource | null = null;
    let restart: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      // Read now, not at render: the remote stores a new phone's device ID in
      // an effect, which runs before this one.
      const current = new EventSource(
        eventsUrl(isDisplay() ? null : storedIdentity().deviceId),
      );
      source = current;
      current.onopen = () => {
        if (!checkAdmin) return;
        call("whoami", {})
          .then((who) => !stopped && setIsAdmin(who.isAdmin))
          .catch((err) => console.warn("Couldn't ask whoami:", err));
      };
      current.onmessage = (message) => {
        const event = parseLiveEvent(message.data);
        if (event === null) {
          console.warn("Ignoring a live event I can't read:", message.data);
          return;
        }
        if (event.type === "state") {
          setState((prev) => mergeLiveState(prev, event.state));
        }
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (err) {
            console.error(`A ${event.type} listener failed:`, err);
          }
        }
      };
      // EventSource reconnects by itself when a connection drops (the server
      // then sends the whole state again), but gives up when the server
      // answers with an error, like a proxy's 502 while the app restarts.
      // Then start over.
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED || stopped) return;
        current.close();
        restart = setTimeout(connect, RESTART_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (restart) clearTimeout(restart);
    };
  }, [checkAdmin, listeners]);

  return React.createElement(
    LiveEventsContext.Provider,
    { value: events },
    React.createElement(
      AdminContext.Provider,
      { value: isAdmin },
      React.createElement(
        LiveStateContext.Provider,
        { value: state },
        children,
      ),
    ),
  );
}

// The live state, or null until the first one arrives.
export function useLiveState(): LiveState | null {
  return useContext(LiveStateContext);
}

// Calls callback with every event of a type ("emote", "queueAdded") from now
// on.
export function useLiveEvent<T extends LiveEventType>(
  type: T,
  callback: (event: Extract<LiveEvent, { type: T }>) => void,
) {
  const events = useContext(LiveEventsContext);
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type === type) {
          latest.current(event as Extract<LiveEvent, { type: T }>);
        }
      }),
    [events, type],
  );
}

// Whether the server counts this phone as an admin; undefined until it
// answers. Needs <LiveStateProvider checkAdmin>.
export function useIsAdmin(): boolean | undefined {
  return useContext(AdminContext);
}
