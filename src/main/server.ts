// The JSON RPC API over HTTP, mounted at /api:
//
//   POST /api/<method>  JSON in, JSON out (src/common/api.ts has the types).
//                       415 unless Content-Type is application/json, 404 for
//                       an unknown method, 400 for bad input, 403 when the
//                       caller may not do it.
//   GET  /api/events    Server-Sent Events: the live state on connect and on
//                       every change, plus emote and queueAdded events. A
//                       phone adds ?deviceId=<its ID> to see which songs are
//                       its own; no device IDs are sent.
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
import { ApiError, ApiHandlers } from "./api";
import { callerFromHeaders, deviceIdFromQuery } from "./caller";
import type { LiveHub } from "./live";
import { validators } from "./validate";

export const EVENTS_PATH = "/api/events";

const HEARTBEAT_MS = 20_000;

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

function isMethod(name: string): name is ApiMethod {
  return Object.prototype.hasOwnProperty.call(validators, name);
}

function isJson(req: Request): boolean {
  const type = req.headers["content-type"] ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/json";
}

export function apiRouter(handlers: ApiHandlers, hub: LiveHub): Router {
  const router = express.Router();

  router.get("/events", (req, res) => {
    const viewer = {
      deviceId: deviceIdFromQuery(req.query[EVENTS_DEVICE_ID_PARAM]),
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Ask proxies (e.g. a Cloudflare tunnel) not to buffer it either.
      "X-Accel-Buffering": "no",
    });
    // How long EventSource waits before reconnecting.
    res.write("retry: 2000\n\n");

    const send = (event: LiveEvent) => {
      res.write(`data: ${serializeEvent(event)}\n\n`);
    };
    const unsubscribe = hub.subscribe(send, viewer);
    // Keeps idle connections open through proxies, and notices dead ones.
    const heartbeat = setInterval(
      () => res.write(": heartbeat\n\n"),
      HEARTBEAT_MS,
    );
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
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
      next();
    },
    express.json({ limit: "1mb" }),
    async (req, res, next) => {
      const method = req.params.method as ApiMethod;
      try {
        // An empty body means no input.
        const input = validators[method](req.body ?? {});
        const caller = callerFromHeaders(req.headers);
        const handler = handlers[method] as (
          input: unknown,
          caller: unknown,
        ) => Promise<unknown>;
        const output = await handler(input, caller);
        res.json(output ?? null);
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
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      // express.json's own errors: malformed JSON, too large and so on.
      const status = (err as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        res.status(status).json({ error: (err as Error).message });
        return;
      }
      console.error(`/api${req.path} failed:`, err);
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    },
  );

  return router;
}
