// Runs on Node's test runner through tsx (yarn test:unit). Here there is no
// window, so these run as a phone would, unless a test gives one with the
// display's preload API.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LiveEvent, LiveState, SharedQueueItem } from "./api";
import {
  adminSignIn,
  adminSignOut,
  ApiCallError,
  call,
  eventsUrl,
  liveStore,
  mergeLiveState,
  onAdminTokenChange,
  openLiveStream,
  parseLiveEvent,
  storedAdminToken,
} from "./apiClient";
import type { ApiResponse, DisplayApi } from "./ipc";

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
  guideMelodyLevel: 0,
  adhocLyrics: [],
  downloads: [],
  config: { supervisedMode: false, everyoneIsAdmin: false },
  toolsProblem: null,
  ...overrides,
});

const realFetch = globalThis.fetch;
const g = globalThis as { localStorage?: unknown; window?: unknown };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.localStorage;
  delete g.window;
});

// Makes this the display window, with call() answering through answer().
function asDisplay(
  answer: (method: string, input: unknown) => Promise<ApiResponse>,
  onLive: DisplayApi["onLive"] = () => () => {},
) {
  const api = { call: answer, onLive } as DisplayApi;
  g.window = { karafriends: { api } };
  globalThis.fetch = async () => {
    throw new Error("The display must not use HTTP");
  };
}

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

describe("call on the display", () => {
  test("goes over IPC, with the input as JSON", async () => {
    const calls: [string, unknown][] = [];
    asDisplay(async (method, input) => {
      calls.push([method, input]);
      return { ok: true, output: { isAdmin: true } };
    });
    assert.deepEqual(await call("whoami", {}), { isAdmin: true });
    await call("history", { offset: undefined, limit: 5 });
    assert.deepEqual(calls, [
      ["whoami", {}],
      // As JSON.stringify would send it.
      ["history", { limit: 5 }],
    ]);
    assert.equal(Object.hasOwn(calls[1][1], "offset"), false);
  });

  test("throws what it would over HTTP", async () => {
    asDisplay(async () => ({
      ok: false,
      status: 403,
      error: "Supervised mode: no",
    }));
    await assert.rejects(
      call("setPlaybackState", { playbackState: "PAUSED" }),
      (err) =>
        err instanceof ApiCallError &&
        err.status === 403 &&
        err.message === "Supervised mode: no",
    );

    // The main process didn't answer.
    asDisplay(async () => {
      throw new Error("No handler registered for 'api'");
    });
    await assert.rejects(
      call("popSong", {}),
      (err) =>
        err instanceof ApiCallError &&
        err.status === 500 &&
        err.message === "popSong failed: No handler registered for 'api'",
    );
  });
});

describe("openLiveStream on the display", () => {
  test("listens over IPC, and stops when closed", () => {
    let listener: ((event: LiveEvent) => void) | null = null;
    asDisplay(
      async () => ({ ok: true, output: null }),
      (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    );
    let opened = 0;
    const events: LiveEvent[] = [];
    const close = openLiveStream(
      () => opened++,
      (event) => events.push(event),
    );
    assert.equal(opened, 1);
    const event: LiveEvent = { type: "state", state: state() };
    listener!(event);
    assert.deepEqual(events, [event]);
    close();
    assert.equal(listener, null);
  });
});

describe("eventsUrl", () => {
  test("passes a phone's device ID, encoded", () => {
    assert.equal(eventsUrl(null), "/api/events");
    assert.equal(eventsUrl("a b&c"), "/api/events?deviceId=a%20b%26c");
  });
});

// A localStorage for one test.
function fakeStorage(items: Record<string, string> = {}) {
  const storage = {
    items,
    getItem: (key: string) => items[key] ?? null,
    setItem: (key: string, value: string) => {
      items[key] = value;
    },
    removeItem: (key: string) => {
      delete items[key];
    },
  };
  g.localStorage = storage;
  return storage;
}

describe("admin sign-in", () => {
  test("sends the token in a header once signed in, and forgets it on sign-out", async () => {
    const storage = fakeStorage({ deviceId: "phone-1" });
    const requests: [string, RequestInit][] = [];
    globalThis.fetch = async (url, init) => {
      requests.push([String(url), init!]);
      return String(url).endsWith("adminLogin")
        ? Response.json({ token: "ab".repeat(32) })
        : Response.json({});
    };
    let changes = 0;
    const stop = onAdminTokenChange(() => changes++);
    try {
      await adminSignIn("sing-it-loud");
      assert.equal(storage.items.adminToken, "ab".repeat(32));
      assert.equal(storedAdminToken(), "ab".repeat(32));
      assert.equal(changes, 1);
      await adminSignOut();
      assert.equal(storage.items.adminToken, undefined);
      assert.equal(changes, 2);
    } finally {
      stop();
    }

    const [login, logout] = requests;
    assert.equal(login[0], "/api/adminLogin");
    assert.equal(login[1].body, '{"password":"sing-it-loud"}');
    assert.deepEqual(login[1].headers, {
      "Content-Type": "application/json",
      "X-Karafriends-Device-Id": "phone-1",
    });
    assert.equal(logout[0], "/api/adminLogout");
    assert.deepEqual(logout[1].headers, {
      "Content-Type": "application/json",
      "X-Karafriends-Device-Id": "phone-1",
      "X-Karafriends-Admin-Token": "ab".repeat(32),
    });
  });

  test("a refused sign-in stores nothing", async () => {
    const storage = fakeStorage();
    globalThis.fetch = async () =>
      Response.json({ error: "Wrong admin password" }, { status: 403 });
    await assert.rejects(
      adminSignIn("guess"),
      (err) => err instanceof ApiCallError && err.status === 403,
    );
    assert.deepEqual(storage.items, {});
  });

  test("sign-out forgets the token even when the server can't be reached", async (t) => {
    t.mock.method(console, "warn", () => {});
    const storage = fakeStorage({ adminToken: "ab".repeat(32) });
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await adminSignOut();
    assert.deepEqual(storage.items, {});
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

describe("liveStore", () => {
  test("tells its listeners about a new state, and only a new one", () => {
    const store = liveStore();
    assert.equal(store.get(), null);
    let calls = 0;
    const stop = store.subscribe(() => calls++);

    const first = state();
    store.set(first);
    assert.equal(store.get(), first);
    // What mergeLiveState returns when nothing changed.
    store.set(mergeLiveState(first, state()));
    assert.equal(calls, 1);

    // A download's progress changes the state, but a component that shows
    // the queue picks the same queue as before, so React leaves it be.
    const download = {
      kind: "youtube" as const,
      songId: "v",
      suffix: null,
      progress: 0.5,
      isMine: false,
    };
    store.set(mergeLiveState(first, state({ downloads: [download] })));
    assert.equal(calls, 2);
    assert.equal(store.get()!.queue, first.queue);

    stop();
    store.set(state({ playbackState: "PAUSED" }));
    assert.equal(calls, 2);
  });
});
