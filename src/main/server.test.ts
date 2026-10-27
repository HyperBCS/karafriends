// Runs on Node's test runner through tsx (yarn test:unit). The router runs on
// a real Express server, with stub handlers and a stub live feed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import compression from "compression";
import express from "express";

import type { LiveEvent, LiveState } from "../common/api";
import { ApiError, type Caller } from "./api";
import type { Viewer } from "./live";
import {
  apiRouter,
  eventWriter,
  rateLimiter,
  serializeEvent,
  shouldCompress,
  streamCounter,
} from "./server";

const callers: Caller[] = [];
const handlers = {
  whoami: async (_input: unknown, caller: Caller) => {
    callers.push(caller);
    return { isAdmin: caller.isDisplay };
  },
  setPlaybackState: async () => {
    throw new ApiError(403, "Supervised mode: no");
  },
  removeSong: async () => false,
  adminLogin: async ({ password }: { password: string }) => {
    if (password !== "right") throw new ApiError(403, "Wrong admin password");
    return { token: "t".repeat(64) };
  },
  popSong: async () => {
    throw new Error("DAM is down");
  },
};

let subscribers = 0;
const viewers: Viewer[] = [];
const hub = {
  subscribe(listener: (event: LiveEvent) => void, viewer: Viewer) {
    subscribers++;
    viewers.push(viewer);
    listener({ type: "emote", emote: "👋", user: { nickname: "" } });
    return () => {
      subscribers--;
    };
  },
  publish() {},
};

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(compression({ filter: shouldCompress }));
  app.use("/api", apiRouter(handlers as never, hub));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const post = (
  method: string,
  body: string | undefined,
  headers: Record<string, string> = { "Content-Type": "application/json" },
) => fetch(`${base}/${method}`, { method: "POST", headers, body });

describe("POST /api/<method>", () => {
  test("answers with the handler's output", async () => {
    const res = await post("whoami", "{}");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { isAdmin: false });
    assert.equal(
      (await post("removeSong", '{"songId":"a","timestamp":"1"}')).status,
      200,
    );
  });

  test("takes an empty body as no input", async () => {
    const res = await post("whoami", undefined);
    assert.equal(res.status, 200);
  });

  test("passes the caller from the headers, never the display", async () => {
    callers.length = 0;
    const res = await post("whoami", "{}", {
      "Content-Type": "application/json; charset=utf-8",
      "X-Karafriends-Device-Id": "phone-1",
      "X-Karafriends-Nickname": encodeURIComponent("歌手"),
      "X-Karafriends-Admin-Token": "ab".repeat(32),
    });
    assert.deepEqual(await res.json(), { isAdmin: false });
    await post("whoami", "{}");
    assert.deepEqual(callers, [
      {
        deviceId: "phone-1",
        nickname: "歌手",
        adminToken: "ab".repeat(32),
        isDisplay: false,
      },
      { deviceId: null, nickname: null, adminToken: null, isDisplay: false },
    ]);
  });

  test("refuses anything but JSON with 415, and sends no CORS headers", async () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain",
    ]) {
      const res = await post("whoami", "{}", {
        "Content-Type": type,
        Origin: "https://example.com",
      });
      assert.equal(res.status, 415, type);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    assert.equal((await post("whoami", "{}", {})).status, 415);
  });

  test("404 for an unknown method or route", async () => {
    assert.equal((await post("nope", "{}")).status, 404);
    assert.equal((await post("toString", "{}")).status, 404);
    assert.equal((await post("events", "{}")).status, 404);
    assert.equal((await fetch(`${base}/whoami`)).status, 404);
  });

  test("400 for malformed JSON or bad input", async () => {
    assert.equal((await post("whoami", "{x")).status, 400);
    assert.equal((await post("whoami", '{"admin":true}')).status, 400);
    const res = await post("setPlaybackState", '{"playbackState":"LOUD"}');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /playbackState/);
  });

  test("the handler's ApiError status, or 500", async () => {
    const forbidden = await post(
      "setPlaybackState",
      '{"playbackState":"PAUSED"}',
    );
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "Supervised mode: no" });

    const original = console.error;
    console.error = () => {};
    try {
      const failed = await post("popSong", "{}");
      assert.equal(failed.status, 500);
    } finally {
      console.error = original;
    }
  });
});

describe("GET /api/events", () => {
  test("streams events uncompressed, and stops when the client goes", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: { "Accept-Encoding": "gzip" },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(res.headers.get("content-encoding"), null);

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("\n\ndata: ") || !text.endsWith("\n\n")) {
      text += (await reader.read()).value;
    }
    assert.match(text, /^retry: \d+\n\ndata: \{"type":"emote"/);
    assert.equal(subscribers, 1);

    controller.abort();
    for (let i = 0; i < 50 && subscribers > 0; i++) await sleep(20);
    assert.equal(subscribers, 0);
  });

  test("tells the hub which device is watching, and its admin token", async () => {
    viewers.length = 0;
    for (const query of [
      "",
      `?deviceId=${encodeURIComponent("phone 1/ü")}`,
      "?deviceId=",
      `?deviceId=p2&adminToken=${"cd".repeat(32)}`,
      "?adminToken=&adminToken=x",
    ]) {
      const controller = new AbortController();
      const res = await fetch(`${base}/events${query}`, {
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      controller.abort();
    }
    assert.deepEqual(viewers, [
      { deviceId: null, adminToken: null },
      { deviceId: "phone 1/ü", adminToken: null },
      { deviceId: null, adminToken: null },
      { deviceId: "p2", adminToken: "cd".repeat(32) },
      { deviceId: null, adminToken: null },
    ]);
  });
});

describe("adminLogin rate limit", () => {
  test("rateLimiter: so many tries per key in a sliding window", () => {
    let time = 0;
    const limiter = rateLimiter({ tries: 3, windowMs: 1000 }, () => time);
    assert.equal(limiter.tryHit("a"), true);
    time = 400;
    assert.equal(limiter.tryHit("a"), true);
    assert.equal(limiter.tryHit("a"), true);
    assert.equal(limiter.tryHit("a"), false);
    // Another address has its own.
    assert.equal(limiter.tryHit("b"), true);
    // A refused try doesn't count, and the first try leaves the window.
    time = 1000;
    assert.equal(limiter.tryHit("a"), true);
    assert.equal(limiter.tryHit("a"), false);
    time = 1400;
    assert.equal(limiter.tryHit("a"), true);
    assert.equal(limiter.tryHit("a"), true);
    assert.equal(limiter.tryHit("a"), false);
  });

  test("POST /api/adminLogin: 5 tries a minute, right or wrong, then 429", async () => {
    const login = (password: string) =>
      post("adminLogin", JSON.stringify({ password }));
    for (const password of ["wrong", "wrong", "right", "wrong"]) {
      assert.equal(
        (await login(password)).status,
        password === "right" ? 200 : 403,
      );
    }
    // Bad input counts too.
    assert.equal((await post("adminLogin", '{"password":""}')).status, 400);
    const refused = await login("right");
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.match((await refused.json()).error, /Too many sign-in tries/);
    // Other methods aren't limited.
    assert.equal((await post("whoami", "{}")).status, 200);
  });
});

describe("event stream limits", () => {
  test("streamCounter: so many in all, and from one address but this machine's", () => {
    const streams = streamCounter({ total: 4, perAddress: 2 });
    assert.equal(streams.tryOpen("192.168.1.20"), true);
    assert.equal(streams.tryOpen("192.168.1.20"), true);
    assert.equal(streams.tryOpen("192.168.1.20"), false);
    // A proxy here connects for every phone.
    assert.equal(streams.tryOpen("127.0.0.1"), true);
    assert.equal(streams.tryOpen("::ffff:127.0.0.1"), true);
    assert.equal(streams.tryOpen("192.168.1.21"), false);
    streams.close("192.168.1.20");
    assert.equal(streams.tryOpen("192.168.1.21"), true);
    assert.equal(streams.tryOpen("127.0.0.1"), false);
  });

  test("GET /api/events answers 503 past the limit, until one closes", async () => {
    const app = express();
    app.use(
      "/api",
      apiRouter(handlers as never, hub, { total: 2, perAddress: 1 }),
    );
    const limited = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => limited.once("listening", resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/events`;
    const controllers: AbortController[] = [];
    const open = async () => {
      const controller = new AbortController();
      controllers.push(controller);
      return (await fetch(url, { signal: controller.signal })).status;
    };
    try {
      assert.deepEqual(
        [await open(), await open(), await open()],
        [200, 200, 503],
      );
      controllers[0].abort();
      let status = 503;
      for (let i = 0; i < 50 && status === 503; i++) {
        await sleep(20);
        status = await open();
      }
      assert.equal(status, 200);
    } finally {
      for (const controller of controllers) controller.abort();
      limited.closeAllConnections();
      limited.close();
    }
  });

  // A response whose buffer is full until drained.
  class FakeResponse extends EventEmitter {
    written: string[] = [];
    full = false;
    destroyed = false;
    write(chunk: string) {
      this.written.push(chunk);
      return !this.full;
    }
    destroy() {
      this.destroyed = true;
    }
    drain() {
      this.full = false;
      this.emit("drain");
    }
  }

  const state = (pitchShiftSemis: number): LiveEvent => ({
    type: "state",
    state: { pitchShiftSemis } as LiveState,
  });
  const emote: LiveEvent = {
    type: "emote",
    emote: "🎉",
    user: { nickname: "n" },
  };

  test("eventWriter holds back all but the latest state while a phone is behind", () => {
    const res = new FakeResponse();
    const writer = eventWriter(res);
    writer.start();
    writer.send(state(1));
    res.full = true;
    // This one fills the buffer: from now on, the phone is behind.
    writer.send(state(2));
    writer.send(state(3));
    writer.send(emote);
    writer.send(state(4));
    writer.heartbeat();
    assert.equal(res.written.length, 3);

    res.drain();
    writer.send(emote);
    assert.deepEqual(res.written.slice(1), [
      `data: ${JSON.stringify(state(1))}\n\n`,
      `data: ${JSON.stringify(state(2))}\n\n`,
      `data: ${JSON.stringify(state(4))}\n\n`,
      `data: ${JSON.stringify(emote)}\n\n`,
    ]);
    assert.equal(res.destroyed, false);
  });

  test("eventWriter cuts off a phone that stays behind", () => {
    const res = new FakeResponse();
    let now = 0;
    const writer = eventWriter(res, () => now);
    res.full = true;
    writer.send(state(1));
    now = 10_000;
    writer.heartbeat();
    assert.equal(res.destroyed, false);
    now = 20_000;
    writer.heartbeat();
    assert.equal(res.destroyed, true);
  });
});

describe("serializeEvent", () => {
  test("serializes an event once, however many phones get it", () => {
    const event: LiveEvent = {
      type: "emote",
      emote: "🎉",
      user: { nickname: "n" },
    };
    const first = serializeEvent(event);
    assert.equal(first, JSON.stringify(event));
    // Same object, same string (not just an equal one).
    event.emote = "changed";
    assert.equal(serializeEvent(event), first);
    assert.notEqual(serializeEvent({ ...event }), first);
  });
});
