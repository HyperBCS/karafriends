// The JSON RPC API over HTTP, mounted at /api:
//
//   POST /api/<method>  JSON in, JSON out (src/common/api.ts has the types).
//                       415 unless Content-Type is application/json, 404 for
//                       an unknown method, 400 for bad input, 403 when the
//                       caller may not do it (always, for the display's
//                       methods: DISPLAY_ONLY_METHODS). adminLogin answers
//                       429 after ADMIN_LOGIN_LIMIT tries from one address,
//                       or ADMIN_LOGIN_TOTAL_LIMIT from all.
//   GET  /api/events    Server-Sent Events: the live state on connect and on
//                       every change, its downloads alone when only they
//                       changed, and a ping event every HEARTBEAT_MS. (The
//                       other events are the display's, over IPC.) A phone
//                       adds ?deviceId=<its ID> to see which songs are its
//                       own; no device IDs are sent. 503 when too many are
//                       open (STREAM_LIMITS).
//
// No CORS headers: requiring a JSON content type then keeps other web pages
// from driving the queue (a cross-site form can't send it, and fetch() would
// need a preflight that fails).
import compression from "compression";
import express, { NextFunction, Request, Response, Router } from "express";

import {
  EVENTS_DEVICE_ID_PARAM,
  type ApiMethod,
  type LiveEvent,
} from "../common/api";
import type { ApiHandlers } from "./api";
import { callerFromHeaders, deviceIdFromQuery } from "./caller";
import { errorAnswer, isMethod, runMethod } from "./dispatch";
import type { LiveHub } from "./live";
import { SETTINGS_METHODS } from "./settings";

export const EVENTS_PATH = "/api/events";

// Methods only the display may call, over IPC: the settings, setMics,
// reportSongPosition, the downloads folder's and popSong. A phone gets 403
// before its body is read, whoever it is signed in as; each handler checks
// again, on purpose (a handler reached some other way stays shut).
export const DISPLAY_ONLY_METHODS: ReadonlySet<ApiMethod> = new Set<ApiMethod>([
  ...SETTINGS_METHODS,
  "setMics",
  "reportSongPosition",
  "downloadsInfo",
  "clearDownloads",
  "clearDownload",
  "popSong",
]);

// How often a stream gets a ping. openLiveStream counts a stream silent
// for a little over two of them as dead.
const HEARTBEAT_MS = 20_000;

// How many event streams may be open at once: in all, and from one address.
// A phone needs one per open remote page. A proxy on this machine (the dev
// server) connects for every phone, so its streams only count toward the
// total.
export interface StreamLimits {
  total: number;
  perAddress: number;
}

export const STREAM_LIMITS: StreamLimits = { total: 200, perAddress: 10 };

function isLoopback(address: string): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

// Counts the open event streams by remote address.
export function streamCounter({ total, perAddress }: StreamLimits) {
  let open = 0;
  const byAddress = new Map<string, number>();
  return {
    // Counts one more from address, or returns false if it's one too many.
    tryOpen(address: string): boolean {
      const fromAddress = byAddress.get(address) ?? 0;
      if (
        open >= total ||
        (!isLoopback(address) && fromAddress >= perAddress)
      ) {
        return false;
      }
      open++;
      byAddress.set(address, fromAddress + 1);
      return true;
    },
    close(address: string) {
      open--;
      const fromAddress = (byAddress.get(address) ?? 1) - 1;
      if (fromAddress > 0) {
        byAddress.set(address, fromAddress);
      } else {
        byAddress.delete(address);
      }
    },
  };
}

// Where an event stream writes: the response.
export interface EventSink {
  write(chunk: string): boolean;
  // Bytes written but not sent yet.
  readonly writableLength: number;
  on(event: "drain", listener: () => void): unknown;
  destroy(): void;
}

// What the heartbeat sends: an event named ping, which the phone's script
// sees (a comment it wouldn't), so a phone that hears nothing for a while
// knows its stream is dead (openLiveStream). Pages from before it ignore
// a named event.
export const PING = "event: ping\ndata: {}\n\n";

// Writes events to one stream. Node buffers whatever the phone hasn't read
// yet, without limit, so while a phone is behind (a slow or stalled phone,
// or a script that never reads), this holds back all but the latest state
// and the downloads since, and sends those once it catches up. Phones only
// need those: other events are dropped meanwhile. A phone still behind a
// heartbeat later is cut off; EventSource reconnects.
//
// Behind is more than twice the longest write waiting, not a full buffer:
// one state of 64 KB or more fills it on its own (write() returns false),
// and the event right after it would be dropped from a phone keeping up.
export function eventWriter(res: EventSink, now: () => number = Date.now) {
  let behindSince: number | null = null;
  let heldBack: LiveEvent | null = null;
  let heldDownloads: LiveEvent | null = null;
  let longest = 0;

  const write = (text: string) => {
    longest = Math.max(longest, Buffer.byteLength(text));
    if (
      !res.write(text) &&
      behindSince === null &&
      res.writableLength > 2 * longest
    ) {
      behindSince = now();
    }
  };
  const send = (event: LiveEvent) => {
    if (behindSince !== null) {
      if (event.type === "state") {
        heldBack = event;
        heldDownloads = null;
      } else if (event.type === "downloads") {
        heldDownloads = event;
      }
      return;
    }
    write(`data: ${serializeEvent(event)}\n\n`);
  };
  res.on("drain", () => {
    behindSince = null;
    const held = [heldBack, heldDownloads];
    heldBack = null;
    heldDownloads = null;
    for (const event of held) if (event) send(event);
  });

  return {
    // How long EventSource waits before reconnecting.
    start: () => write("retry: 2000\n\n"),
    send,
    // Every HEARTBEAT_MS. Keeps idle connections open through proxies, tells
    // the phone the stream is alive, and notices dead ones.
    heartbeat() {
      if (behindSince === null) {
        write(PING);
      } else if (now() - behindSince >= HEARTBEAT_MS) {
        res.destroy();
      }
    },
  };
}

// compression() would hold back the event stream to fill its buffer.
export function shouldCompress(req: Request, res: Response): boolean {
  return req.path !== EVENTS_PATH && compression.filter(req, res);
}

// Most events are one object shared by every phone (see live.ts), so each is
// serialized once, not once per phone.
const serialized = new WeakMap<LiveEvent, string>();

export function serializeEvent(event: LiveEvent): string {
  let json = serialized.get(event);
  if (json === undefined) {
    json = JSON.stringify(event);
    serialized.set(event, json);
  }
  return json;
}

// How many adminLogin tries one address gets in a window, so a phone can't
// guess the password at speed. Through a proxy on this machine (the dev
// server) every phone shares one address, and so one limit.
export interface RateLimit {
  tries: number;
  windowMs: number;
}

export const ADMIN_LOGIN_LIMIT: RateLimit = { tries: 5, windowMs: 60_000 };

// And how many all addresses get together: a phone can take as many IPv6
// addresses as it likes.
export const ADMIN_LOGIN_TOTAL_LIMIT: RateLimit = {
  tries: 30,
  windowMs: 60_000,
};

// Counts tries by key (a remote address) over a sliding window.
export function rateLimiter(
  { tries, windowMs }: RateLimit,
  now: () => number = Date.now,
) {
  // Each key's tries in the window, oldest first.
  const recent = new Map<string, number[]>();
  return {
    // Counts one more try from key, or returns false if it's one too many
    // (which doesn't count).
    tryHit(key: string): boolean {
      const time = now();
      // Forget addresses whose tries are all old, now and then.
      if (recent.size > 1000) {
        for (const [other, times] of recent) {
          if (times[times.length - 1] <= time - windowMs) recent.delete(other);
        }
      }
      const times = (recent.get(key) ?? []).filter(
        (then) => then > time - windowMs,
      );
      if (times.length >= tries) {
        recent.set(key, times);
        return false;
      }
      times.push(time);
      recent.set(key, times);
      return true;
    },
  };
}

function isJson(req: Request): boolean {
  const type = req.headers["content-type"] ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/json";
}

export function apiRouter(
  handlers: ApiHandlers,
  hub: LiveHub,
  streamLimits: StreamLimits = STREAM_LIMITS,
): Router {
  const router = express.Router();
  const streams = streamCounter(streamLimits);
  const logins = rateLimiter(ADMIN_LOGIN_LIMIT);
  const allLogins = rateLimiter(ADMIN_LOGIN_TOTAL_LIMIT);

  router.get("/events", (req, res) => {
    const address = req.socket.remoteAddress ?? "";
    if (!streams.tryOpen(address)) {
      // EventSource tries again after a while (see openLiveStream).
      res
        .status(503)
        .set("Retry-After", "5")
        .json({ error: "Too many live-state streams are open" });
      return;
    }
    const viewer = {
      deviceId: deviceIdFromQuery(req.query[EVENTS_DEVICE_ID_PARAM]),
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Ask any proxy not to buffer it either.
      "X-Accel-Buffering": "no",
    });
    const writer = eventWriter(res);
    writer.start();
    const unsubscribe = hub.subscribe(writer.send, viewer);
    const heartbeat = setInterval(writer.heartbeat, HEARTBEAT_MS);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.close(address);
    };
    // The phone went away (or the connection broke).
    res.on("close", stop);
    res.on("error", stop);
  });

  router.post(
    "/:method",
    (req, res, next) => {
      if (!isJson(req)) {
        res
          .status(415)
          .json({ error: "Content-Type must be application/json" });
        return;
      }
      if (!isMethod(req.params.method)) {
        res.status(404).json({ error: `No API method ${req.params.method}` });
        return;
      }
      if (DISPLAY_ONLY_METHODS.has(req.params.method)) {
        res.status(403).json({
          error: `${req.params.method} is for the display only, not phones`,
        });
        return;
      }
      // An address past its own limit doesn't use up everyone's.
      if (
        req.params.method === "adminLogin" &&
        (!logins.tryHit(req.socket.remoteAddress ?? "") ||
          !allLogins.tryHit("all"))
      ) {
        res
          .status(429)
          .set("Retry-After", String(ADMIN_LOGIN_LIMIT.windowMs / 1000))
          .json({
            error: "Too many sign-in tries. Wait a minute, then try again.",
          });
        return;
      }
      next();
    },
    express.json({ limit: "1mb" }),
    async (req, res, next) => {
      const method = req.params.method as ApiMethod;
      try {
        // An empty body (undefined) means no input.
        const output = await runMethod(
          handlers,
          method,
          req.body,
          callerFromHeaders(req.headers),
        );
        res.json(output);
      } catch (err) {
        next(err);
      }
    },
  );

  router.use((req, res) => {
    res.status(404).json({ error: `No API route ${req.method} ${req.path}` });
  });

  router.use(
    (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      // An ApiError, one of express.json's own (malformed JSON, too large and
      // so on), or a 500.
      const { status, error } = errorAnswer(err, `/api${req.path}`);
      res.status(status).json({ error });
    },
  );

  return router;
}
