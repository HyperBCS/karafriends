// The client side of the JSON RPC API in src/common/api.ts, for the phone
// remote and the display: call() runs a method, and LiveStateProvider keeps
// one live-event stream per page for useLiveState() and useLiveEvent().
//
// Same methods and events, two transports:
// - A phone talks HTTP to the server that served its page: POST
//   /api/<method>, and GET /api/events through EventSource.
// - The display window talks to its own main process over Electron IPC,
//   through its preload's window.karafriends.api (src/common/ipc.ts), so it
//   needs no HTTP server at all.
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
import type { ApiResponse, DisplayApi } from "./ipc";

// The display window's IPC transport, from its preload. Phones have none.
function displayApi(): DisplayApi | null {
  return (typeof window !== "undefined" && window.karafriends?.api) || null;
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

// Who is asking, for the server's admin checks: a phone's device ID and
// nickname (percent-encoded, since a nickname may not be ASCII).
export function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
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
// Over IPC, the status and message /api would have answered with.
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
  const ipc = displayApi();
  return ipc ? callOverIpc(ipc, method, input) : callOverHttp(method, input);
}

async function callOverIpc<M extends ApiMethod>(
  ipc: DisplayApi,
  method: M,
  input: ApiInput<M>,
): Promise<ApiOutput<M>> {
  let res: ApiResponse<M>;
  try {
    // Through JSON, so the main process gets just what /api would (no
    // undefined fields, say).
    res = await ipc.call(method, JSON.parse(JSON.stringify(input ?? {})));
  } catch (err) {
    // The main process didn't answer at all.
    throw new ApiCallError(
      500,
      `${method} failed: ${(err as Error)?.message ?? err}`,
    );
  }
  if (!res.ok) throw new ApiCallError(res.status, res.error);
  return res.output;
}

async function callOverHttp<M extends ApiMethod>(
  method: M,
  input: ApiInput<M>,
): Promise<ApiOutput<M>> {
  const res = await fetch(`/api/${method}`, {
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

// A phone's stream address. It gives its device ID, so its copy of the state
// marks its own songs (isMine).
export function eventsUrl(deviceId: string | null): string {
  const query = deviceId
    ? `?${EVENTS_DEVICE_ID_PARAM}=${encodeURIComponent(deviceId)}`
    : "";
  return `/api/events${query}`;
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

// Opens the page's live-event stream: over IPC on the display, through
// EventSource on a phone. Calls onOpen each time it (re)connects, and
// onEvent with every event, the live state first. Returns a function that
// closes it.
export function openLiveStream(
  onOpen: () => void,
  onEvent: (event: LiveEvent) => void,
): () => void {
  const ipc = displayApi();
  if (ipc) {
    onOpen();
    return ipc.onLive(onEvent);
  }

  let source: EventSource | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const connect = () => {
    // Read now, not when the page rendered: the remote stores a new phone's
    // device ID in an effect, which runs before the one that opens this.
    const current = new EventSource(eventsUrl(storedIdentity().deviceId));
    source = current;
    current.onopen = onOpen;
    current.onmessage = (message) => {
      const event = parseLiveEvent(message.data);
      if (event === null) {
        console.warn("Ignoring a live event I can't read:", message.data);
        return;
      }
      onEvent(event);
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
}

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
    let stopped = false;
    const close = openLiveStream(
      () => {
        if (!checkAdmin) return;
        call("whoami", {})
          .then((who) => !stopped && setIsAdmin(who.isAdmin))
          .catch((err) => console.warn("Couldn't ask whoami:", err));
      },
      (event) => {
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
      },
    );
    return () => {
      stopped = true;
      close();
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
