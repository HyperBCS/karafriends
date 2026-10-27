// Runs on Node's test runner through tsx (yarn test:unit). Here there is no
// window, so these run as a phone would.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LiveState, SharedQueueItem } from "./api";
import {
  ApiCallError,
  call,
  eventsUrl,
  mergeLiveState,
  parseLiveEvent,
} from "./apiClient";

const song = (n: number, playtime: number | null = 60): SharedQueueItem => ({
  kind: "nico",
  songId: `sm${n}`,
  name: `Song ${n}`,
  artistName: "Artist",
  playtime,
  timestamp: String(n),
  user: { nickname: "n" },
  isMine: false,
});

const state = (overrides: Partial<LiveState> = {}): LiveState => ({
  currentSong: null,
  queue: [song(1), song(2)],
  playbackState: "WAITING",
  pitchShiftSemis: 0,
  adhocLyrics: [],
  downloads: [],
  config: { supervisedMode: false },
  ...overrides,
});

const realFetch = globalThis.fetch;
const g = globalThis as { localStorage?: unknown };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.localStorage;
});

describe("call", () => {
  test("POSTs JSON with the phone's identity, and returns the answer", async () => {
    g.localStorage = {
      getItem: (key: string) =>
        ({ deviceId: "phone-1", nickname: "歌手" })[key] ?? null,
    };
    const requests: [string, RequestInit][] = [];
    globalThis.fetch = async (url, init) => {
      requests.push([String(url), init!]);
      return Response.json({ isAdmin: true });
    };
    assert.deepEqual(await call("whoami", {}), { isAdmin: true });
    const [url, init] = requests[0];
    assert.equal(url, "/api/whoami");
    assert.equal(init.method, "POST");
    assert.equal(init.body, "{}");
    assert.deepEqual(init.headers, {
      "Content-Type": "application/json",
      "X-Karafriends-Device-Id": "phone-1",
      "X-Karafriends-Nickname": encodeURIComponent("歌手"),
    });
  });

  test("asks anonymously without localStorage", async () => {
    let headers: unknown;
    globalThis.fetch = async (_url, init) => {
      headers = init!.headers;
      return Response.json(true);
    };
    await call("removeSong", { songId: "sm1", timestamp: "1" });
    assert.deepEqual(headers, { "Content-Type": "application/json" });
  });

  test("throws the server's message on an error status", async () => {
    globalThis.fetch = async () =>
      Response.json({ error: "Supervised mode: no" }, { status: 403 });
    await assert.rejects(
      call("setPlaybackState", { playbackState: "PAUSED" }),
      (err) =>
        err instanceof ApiCallError &&
        err.status === 403 &&
        err.message === "Supervised mode: no",
    );

    globalThis.fetch = async () =>
      new Response("<h1>Bad gateway</h1>", { status: 502 });
    await assert.rejects(
      call("whoami", {}),
      (err) =>
        err instanceof ApiCallError &&
        err.status === 502 &&
        err.message === "whoami failed with HTTP 502",
    );
  });
});

describe("eventsUrl", () => {
  test("passes a phone's device ID, encoded", () => {
    assert.equal(eventsUrl(null), "/api/events");
    assert.equal(eventsUrl("a b&c"), "/api/events?deviceId=a%20b%26c");
  });
});

describe("parseLiveEvent", () => {
  test("reads an event and rejects anything else", () => {
    assert.deepEqual(parseLiveEvent('{"type":"emote","emote":"🎉"}'), {
      type: "emote",
      emote: "🎉",
    });
    assert.equal(parseLiveEvent("{oops"), null);
    assert.equal(parseLiveEvent("null"), null);
    assert.equal(parseLiveEvent('{"emote":"🎉"}'), null);
  });
});

describe("mergeLiveState", () => {
  test("keeps the parts that didn't change, so effects on them don't rerun", () => {
    const first = state();
    assert.equal(mergeLiveState(null, first), first);

    const same = mergeLiveState(first, state());
    assert.equal(same, first);

    const paused = mergeLiveState(first, state({ playbackState: "PAUSED" }));
    assert.notEqual(paused, first);
    assert.equal(paused.playbackState, "PAUSED");
    assert.equal(paused.queue, first.queue);
    assert.equal(paused.config, first.config);

    const shorter = mergeLiveState(paused, state({ queue: [song(2)] }));
    assert.deepEqual(shorter.queue, [song(2)]);
    assert.notEqual(shorter.queue, first.queue);
    // From the new state, not the old.
    assert.equal(shorter.playbackState, "WAITING");
  });
});
