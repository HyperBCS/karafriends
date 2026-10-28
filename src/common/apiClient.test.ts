// Runs on Node's test runner through tsx (yarn test:unit). Here there is no
// window, so these run as a phone would, unless a test gives one with the
// display's preload API.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import type {
  DownloadProgress,
  LiveEvent,
  LiveState,
  SharedQueueItem,
} from "./api";
import {
  adminCheck,
  adminMayHaveChanged,
  adminSignIn,
  adminSignOut,
  ApiCallError,
  call,
  CLOCK_SAMPLES,
  deviceId,
  eventsUrl,
  liveStore,
  mergeLiveState,
  noteStateSentAt,
  onAdminTokenChange,
  openLiveStream,
  parseLiveEvent,
  resetClockOffset,
  serverNow,
  storedAdminToken,
  withDownloads,
} from "./apiClient";
import type { ApiResponse, DisplayApi } from "./ipc";
import { removeItem, setItem } from "./storage";

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
  currentSongStartedAt: null,
  currentSongPausedSince: null,
  queue: [song(1), song(2)],
  playbackState: "WAITING",
  pitchShiftSemis: 0,
  guideMelodyLevel: 0,
  songVolume: 100,
  mics: [],
  adhocLyrics: [],
  downloads: [],
  config: { supervisedMode: false, everyoneIsAdmin: false },
  toolsProblem: null,
  remoconProblem: null,
  adminSignOuts: 0,
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

  test("makes a new phone's device ID on its first request, and keeps it", async () => {
    const storage = fakeStorage();
    const headers: Record<string, string>[] = [];
    globalThis.fetch = async (_url, init) => {
      headers.push(init!.headers as Record<string, string>);
      return Response.json(true);
    };
    await call("removeSong", { songId: "sm1", timestamp: "1" });
    await call("removeSong", { songId: "sm1", timestamp: "1" });
    const id = storage.items.deviceId;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(headers, [
      { "Content-Type": "application/json", "X-Karafriends-Device-Id": id },
      { "Content-Type": "application/json", "X-Karafriends-Device-Id": id },
    ]);
    assert.equal(eventsUrl(deviceId()), `/api/events?deviceId=${id}`);
  });

  test("with storage blocked, keeps one device ID and nickname while the page is open", async () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    g.localStorage = {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    };
    setItem("nickname", "ken");
    const headers: Record<string, string>[] = [];
    globalThis.fetch = async (_url, init) => {
      headers.push(init!.headers as Record<string, string>);
      return Response.json(true);
    };
    await call("removeSong", { songId: "sm1", timestamp: "1" });
    await call("removeSong", { songId: "sm1", timestamp: "1" });
    assert.equal(headers.length, 2);
    assert.equal(headers[0]["X-Karafriends-Nickname"], "ken");
    assert.match(headers[0]["X-Karafriends-Device-Id"], /^[0-9a-f-]{36}$/);
    assert.deepEqual(headers[1], headers[0]);
    removeItem("nickname");
    removeItem("deviceId");
  });

  test("throws the server's message on an error status", async () => {
    globalThis.fetch = async () =>
      Response.json({ error: "Supervised mode: no" }, { status: 403 });
    await assert.rejects(
      call("setPlaybackState", { playbackState: "PAUSED", song: "sm1@1" }),
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
    assert.equal(Object.hasOwn(calls[1][1] as object, "offset"), false);
  });

  test("throws what it would over HTTP", async () => {
    asDisplay(async () => ({
      ok: false,
      status: 403,
      error: "Supervised mode: no",
    }));
    await assert.rejects(
      call("setPlaybackState", { playbackState: "PAUSED", song: "sm1@1" }),
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
    const event: LiveEvent = { type: "state", state: state(), sentAt: 0 };
    listener!(event);
    assert.deepEqual(events, [event]);
    close();
    assert.equal(listener, null);
  });
});

// An EventSource the test drives: open(), message(), ping() and fail().
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private named = new Map<string, () => void>();
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.named.set(type, listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  message(event: LiveEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  ping() {
    this.named.get("ping")?.();
  }
  // EventSource reconnecting by itself (CONNECTING), or giving up (CLOSED).
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

describe("openLiveStream on a phone", () => {
  const ge = globalThis as { EventSource?: unknown };
  let made: FakeEventSource[];
  const latest = () => made[made.length - 1];
  const live = (n: number): LiveEvent => ({
    type: "state",
    state: state({ pitchShiftSemis: n }),
    sentAt: 0,
  });

  beforeEach(() => {
    FakeEventSource.made = made = [];
    ge.EventSource = FakeEventSource;
    mock.timers.enable({ apis: ["setTimeout"] });
    fakeStorage({ deviceId: "phone-1" });
  });
  afterEach(() => {
    delete ge.EventSource;
    mock.timers.reset();
  });

  test("passes on events, opens on each (re)connect, and starts over 5 s after the server refuses", () => {
    let opened = 0;
    const events: LiveEvent[] = [];
    const close = openLiveStream(
      () => opened++,
      (event) => events.push(event),
    );
    assert.equal(made.length, 1);
    assert.equal(made[0].url, "/api/events?deviceId=phone-1");
    made[0].open();
    made[0].message(live(1));
    assert.deepEqual([opened, events], [1, [live(1)]]);

    // EventSource reconnects by itself: no new one.
    made[0].fail(FakeEventSource.CONNECTING);
    mock.timers.tick(10_000);
    assert.equal(made.length, 1);
    made[0].open();
    assert.equal(opened, 2);

    // A 503: it gave up, so a new one, after a while, with the device ID
    // as it is then.
    fakeStorage({ deviceId: "phone-2" });
    made[0].fail(FakeEventSource.CLOSED);
    mock.timers.tick(4_999);
    assert.equal(made.length, 1);
    mock.timers.tick(1);
    assert.equal(made.length, 2);
    assert.equal(latest().url, "/api/events?deviceId=phone-2");
    latest().open();
    latest().message(live(2));
    assert.deepEqual([opened, events], [3, [live(1), live(2)]]);

    // Closed while waiting to start over: nothing more.
    latest().fail(FakeEventSource.CLOSED);
    close();
    mock.timers.tick(60_000);
    assert.equal(made.length, 2);
  });

  test("a stream silent for 45 s is replaced; the server's pings keep it", () => {
    let opened = 0;
    const close = openLiveStream(
      () => opened++,
      () => {},
    );
    made[0].open();
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(20_000);
      made[0].ping();
    }
    assert.equal(made.length, 1);

    // The connection died without a word.
    mock.timers.tick(44_999);
    assert.equal(made.length, 1);
    mock.timers.tick(1);
    assert.equal(made.length, 2);
    assert.equal(made[0].readyState, FakeEventSource.CLOSED);
    latest().open();
    assert.equal(opened, 2);

    // One that never even opens is replaced too.
    mock.timers.tick(45_000);
    assert.equal(made.length, 3);
    mock.timers.tick(45_000);
    assert.equal(made.length, 4);

    close();
    mock.timers.tick(60_000);
    assert.equal(made.length, 4);
    assert.equal(latest().readyState, FakeEventSource.CLOSED);
  });
});

describe("withDownloads", () => {
  test("takes a downloads event's downloads, keeping the rest", () => {
    const before = state({ queue: [song(1)] });
    const download = {
      id: 1,
      kind: "nico" as const,
      songId: "sm2",
      suffix: null,
      progress: 0.5,
      status: "downloading" as const,
      reason: null,
      isMine: true,
    };
    const after = withDownloads(before, [download])!;
    assert.deepEqual(after.downloads, [download]);
    assert.equal(after.queue, before.queue);
    assert.equal(withDownloads(after, [download]), after);
    assert.equal(withDownloads(null, [download]), null);
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
    assert.equal(storage.items.adminToken, undefined);
  });

  test("sign-out forgets the token even when the server can't be reached", async (t) => {
    t.mock.method(console, "warn", () => {});
    const storage = fakeStorage({ adminToken: "ab".repeat(32) });
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await adminSignOut();
    assert.equal(storage.items.adminToken, undefined);
  });
});

describe("adminCheck", () => {
  const TOKEN = "ab".repeat(32);
  // whoami's answers, in the order the test gives them.
  function whoamiAnswers() {
    const pending: ((isAdmin: boolean) => void)[] = [];
    globalThis.fetch = () =>
      new Promise((resolve) =>
        pending.push((isAdmin) => resolve(Response.json({ isAdmin }))),
      );
    return pending;
  }

  test("only the latest answer counts", async () => {
    fakeStorage();
    const answers = whoamiAnswers();
    const seen: boolean[] = [];
    const check = adminCheck((isAdmin) => seen.push(isAdmin));
    const first = check.ask();
    const second = check.ask();
    answers[1](true);
    await second;
    // The first question's answer comes late, from before a sign-in, say.
    answers[0](false);
    await first;
    assert.deepEqual(seen, [true]);
    // Nor any once stopped.
    const third = check.ask();
    check.stop();
    answers[2](false);
    await third;
    assert.deepEqual(seen, [true]);
  });

  test("a no to the token still stored signs the phone out; to another, not", async () => {
    const storage = fakeStorage({ adminToken: TOKEN });
    const answers = whoamiAnswers();
    let changes = 0;
    const stop = onAdminTokenChange(() => changes++);
    try {
      const check = adminCheck(() => {});
      const asked = check.ask();
      answers[0](false);
      await asked;
      assert.equal(storage.items.adminToken, undefined);
      assert.equal(changes, 1);

      // Asked with one token, then the phone signed in again meanwhile.
      storage.items.adminToken = TOKEN;
      const again = check.ask();
      storage.items.adminToken = "cd".repeat(32);
      answers[1](false);
      await again;
      assert.equal(storage.items.adminToken, "cd".repeat(32));
      assert.equal(changes, 1);
    } finally {
      stop();
    }
  });

  test("asks again when everyone-admin mode flips, or a new password signs phones out", () => {
    const before = state();
    const sameAgain = state();
    const everyone = state({
      config: { supervisedMode: false, everyoneIsAdmin: true },
    });
    const signedOut = state({ adminSignOuts: 1 });
    assert.equal(adminMayHaveChanged(null, before, true), false);
    assert.equal(adminMayHaveChanged(before, sameAgain, true), false);
    assert.equal(adminMayHaveChanged(before, everyone, false), true);
    assert.equal(adminMayHaveChanged(before, signedOut, true), true);
    // A phone not signed in has nothing to lose.
    assert.equal(adminMayHaveChanged(before, signedOut, false), false);
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
    const download: DownloadProgress = {
      id: 1,
      kind: "youtube",
      songId: "v",
      suffix: null,
      progress: 0.5,
      status: "downloading",
      reason: null,
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

describe("serverNow", () => {
  test("takes off how far ahead this clock is, from the quickest state event", () => {
    const close = (a: number, b: number) =>
      assert.ok(Math.abs(a - b) < 50, `${a} is not about ${b}`);
    // This phone's clock is 5 s ahead, and the first event took 300 ms.
    noteStateSentAt(1_000_000, 1_005_300);
    close(serverNow(), Date.now() - 5300);
    // One that took 20 ms is closer to the truth.
    noteStateSentAt(2_000_000, 2_005_020);
    close(serverNow(), Date.now() - 5020);
    // One held up for 9 s (a phone asleep) changes nothing.
    noteStateSentAt(3_000_000, 3_014_000);
    close(serverNow(), Date.now() - 5020);
  });

  const close = (a: number, b: number) =>
    assert.ok(Math.abs(a - b) < 50, `${a} is not about ${b}`);

  test("follows a backward step of the server's clock, within the last 20 events", () => {
    resetClockOffset();
    noteStateSentAt(1_000_000, 1_000_020);
    close(serverNow(), Date.now() - 20);
    // The host's clock is put back 4 s: every event now looks 4 s later.
    for (let i = 1; i < CLOCK_SAMPLES; i++) {
      noteStateSentAt(2_000_000, 2_004_030);
      close(serverNow(), Date.now() - 20);
    }
    noteStateSentAt(2_000_000, 2_004_030);
    close(serverNow(), Date.now() - 4030);
  });

  test("starts over when the stream opens again", () => {
    resetClockOffset();
    noteStateSentAt(1_000_000, 1_000_020);
    resetClockOffset();
    close(serverNow(), Date.now());
    noteStateSentAt(2_000_000, 2_004_030);
    close(serverNow(), Date.now() - 4030);
  });
});
