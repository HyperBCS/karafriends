// Runs on Node's test runner through tsx (yarn test:unit). The router runs on
// a real Express server, with stub handlers and a stub live feed.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import compression from "compression";
import express from "express";

import type { LiveEvent } from "../common/api";
import { ApiError, type Caller } from "./api";
import { displayToken } from "./caller";
import { apiRouter, shouldCompress } from "./server";

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
  popSong: async () => {
    throw new Error("DAM is down");
  },
};

let subscribers = 0;
const hub = {
  subscribe(listener: (event: LiveEvent) => void) {
    subscribers++;
    listener({
      type: "emote",
      emote: "👋",
      user: { deviceId: "", nickname: "" },
    });
    return () => {
      subscribers--;
    };
  },
  publish() {},
  onMessage: () => () => {},
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

  test("passes the caller from the headers", async () => {
    callers.length = 0;
    await post("whoami", "{}", {
      "Content-Type": "application/json; charset=utf-8",
      "X-Karafriends-Device-Id": "phone-1",
      "X-Karafriends-Nickname": encodeURIComponent("歌手"),
    });
    const res = await post("whoami", "{}", {
      "Content-Type": "application/json",
      "X-Karafriends-Display-Token": displayToken,
    });
    assert.deepEqual(await res.json(), { isAdmin: true });
    assert.deepEqual(callers, [
      { deviceId: "phone-1", nickname: "歌手", isDisplay: false },
      { deviceId: null, nickname: null, isDisplay: true },
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
});
