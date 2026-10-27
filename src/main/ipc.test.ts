// Runs on Node's test runner through tsx (yarn test:unit). Electron's
// WebContents and IPC events are faked.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LiveEvent, LiveState } from "../common/api";
import { IPC_CHANNELS } from "../common/ipc";
import { ApiError, type Caller } from "./api";
import { createDisplayIpc, sameSite, type IpcSource } from "./ipc";
import type { LiveHub } from "./live";

// What index.ts passes on Windows in prod (pathToFileURL), and what Chromium
// reports for that page.
const DISPLAY_URL = "file:///C:/karafriends/build/prod/web/renderer/index.html";
const DISPLAY_PAGE = DISPLAY_URL;

const liveState: LiveState = {
  currentSong: null,
  queue: [],
  playbackState: "WAITING",
  pitchShiftSemis: 0,
  adhocLyrics: [],
  downloads: [],
  config: { supervisedMode: false },
  toolsProblem: null,
};

function fakeContents() {
  const sent: unknown[][] = [];
  const contents = {
    sent,
    destroyed: false,
    send: (channel: string, ...args: unknown[]) => {
      sent.push([channel, ...args]);
    },
    isDestroyed: () => contents.destroyed,
  };
  return contents;
}

function setup() {
  const callers: Caller[] = [];
  const handlers = {
    whoami: async (_input: unknown, caller: Caller) => {
      callers.push(caller);
      return { isAdmin: caller.isDisplay };
    },
    setPlaybackState: async () => {
      throw new ApiError(403, "Supervised mode: no");
    },
    popSong: async () => {
      throw new Error("DAM is down");
    },
    adhocLyrics: async () => undefined,
  };

  // A live hub that sends the state on subscribing, as the real one does.
  const listeners = new Set<(event: LiveEvent) => void>();
  const hub: LiveHub = {
    publish() {},
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "state", state: liveState });
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: LiveEvent) => listeners.forEach((l) => l(event));

  const display = fakeContents();
  let open = true;
  const ipc = createDisplayIpc({
    handlers: handlers as never,
    hub,
    display: () => (open ? display : null),
    displayUrl: DISPLAY_URL,
  });
  const fromDisplay = {
    sender: display,
    senderFrame: { parent: null, url: DISPLAY_PAGE },
  };
  return {
    ipc,
    callers,
    listeners,
    emit,
    display,
    fromDisplay,
    close: () => (open = false),
  };
}

// Runs fn with console.warn and console.error silenced, returning what they
// were called with.
async function quietly(fn: () => unknown): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const { warn, error } = console;
  console.warn = console.error = (...args: unknown[]) => logged.push(args);
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return logged;
}

describe("call", () => {
  test("runs the method as the display, an admin", async () => {
    const { ipc, callers, fromDisplay } = setup();
    assert.deepEqual(await ipc.call(fromDisplay, "whoami", {}), {
      ok: true,
      output: { isAdmin: true },
    });
    // No input means {}, as with an empty POST body.
    assert.deepEqual(await ipc.call(fromDisplay, "whoami", undefined), {
      ok: true,
      output: { isAdmin: true },
    });
    assert.deepEqual(callers[0], {
      deviceId: null,
      nickname: null,
      adminToken: null,
      isDisplay: true,
    });
  });

  test("answers no output with null, as /api does", async () => {
    const { ipc, fromDisplay } = setup();
    assert.deepEqual(
      await ipc.call(fromDisplay, "adhocLyrics", { songId: "abc" }),
      { ok: true, output: null },
    );
  });

  test("checks the input with /api's validators", async () => {
    const { ipc, callers, fromDisplay } = setup();
    const bad = await ipc.call(fromDisplay, "setPlaybackState", {
      playbackState: "LOUD",
    });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.status, 400);
    assert.match(!bad.ok ? bad.error : "", /playbackState/);
    assert.deepEqual(await ipc.call(fromDisplay, "whoami", { admin: true }), {
      ok: false,
      status: 400,
      error: 'Unknown field "admin"',
    });
    assert.equal(callers.length, 0);
  });

  test("404 for an unknown method", async () => {
    const { ipc, fromDisplay } = setup();
    for (const method of ["nope", "toString", 42, undefined]) {
      assert.deepEqual(await ipc.call(fromDisplay, method, {}), {
        ok: false,
        status: 404,
        error: `No API method ${String(method)}`,
      });
    }
  });

  test("answers a failure with the status and message /api would", async () => {
    const { ipc, fromDisplay } = setup();
    assert.deepEqual(
      await ipc.call(fromDisplay, "setPlaybackState", {
        playbackState: "PAUSED",
      }),
      { ok: false, status: 403, error: "Supervised mode: no" },
    );
    let answer: unknown;
    const logged = await quietly(async () => {
      answer = await ipc.call(fromDisplay, "popSong", {});
    });
    assert.deepEqual(answer, { ok: false, status: 500, error: "DAM is down" });
    assert.match(String(logged[0][0]), /popSong failed/);
  });

  test("refuses anyone but the display window's own page", async () => {
    const { ipc, callers, display, fromDisplay, close } = setup();
    const refused = {
      ok: false,
      status: 403,
      error: "Only the display window may call the API over IPC",
    };
    const others: IpcSource[] = [
      // Another window.
      { ...fromDisplay, sender: fakeContents() },
      // A frame inside the display's page.
      {
        sender: display,
        senderFrame: { parent: {}, url: DISPLAY_PAGE },
      },
      // A frame that is gone.
      { sender: display, senderFrame: null },
      // Another site the window was sent to.
      {
        sender: display,
        senderFrame: { parent: null, url: "https://example.com/" },
      },
      { sender: display, senderFrame: { parent: null, url: "" } },
    ];
    const logged = await quietly(async () => {
      for (const source of others) {
        assert.deepEqual(await ipc.call(source, "whoami", {}), refused);
      }
      close();
      assert.deepEqual(await ipc.call(fromDisplay, "whoami", {}), refused);
    });
    assert.equal(logged.length, others.length + 1);
    assert.equal(callers.length, 0);
  });
});

describe("subscribeLive", () => {
  test("sends the live state at once, then every event", () => {
    const { ipc, emit, display, fromDisplay } = setup();
    ipc.subscribeLive(fromDisplay);
    const emote: LiveEvent = {
      type: "emote",
      emote: "🎉",
      user: { nickname: "n" },
    };
    emit(emote);
    assert.deepEqual(display.sent, [
      [IPC_CHANNELS.live, { type: "state", state: liveState }],
      [IPC_CHANNELS.live, emote],
    ]);
  });

  test("a reloaded page's subscription replaces the old one", () => {
    const { ipc, listeners, display, fromDisplay } = setup();
    ipc.subscribeLive(fromDisplay);
    ipc.subscribeLive(fromDisplay);
    assert.equal(listeners.size, 1);
    // A state for each (re)load.
    assert.equal(display.sent.length, 2);
    ipc.endLive();
    assert.equal(listeners.size, 0);
  });

  test("sends nothing to a destroyed window", () => {
    const { ipc, emit, display, fromDisplay } = setup();
    ipc.subscribeLive(fromDisplay);
    display.destroyed = true;
    emit({ type: "emote", emote: "🎉", user: { nickname: "n" } });
    assert.equal(display.sent.length, 1);
  });

  test("refuses anyone but the display", async () => {
    const { ipc, listeners, fromDisplay } = setup();
    const other = fakeContents();
    await quietly(() => ipc.subscribeLive({ ...fromDisplay, sender: other }));
    assert.equal(listeners.size, 0);
    assert.deepEqual(other.sent, []);
  });
});

describe("remoconProblem", () => {
  test("tells the display now, and its next page when it asks", () => {
    const { ipc, display, fromDisplay } = setup();
    assert.equal(ipc.remoconProblem(fromDisplay), null);
    ipc.reportRemoconProblem("Phones can't connect: port 8080 is in use.");
    assert.deepEqual(display.sent, [
      [
        IPC_CHANNELS.remoconProblem,
        "Phones can't connect: port 8080 is in use.",
      ],
    ]);
    assert.equal(
      ipc.remoconProblem(fromDisplay),
      "Phones can't connect: port 8080 is in use.",
    );
    // Nobody else.
    assert.equal(
      ipc.remoconProblem({ ...fromDisplay, sender: fakeContents() }),
      null,
    );
  });

  test("sends nothing to a destroyed window, but keeps it", () => {
    const { ipc, display, fromDisplay } = setup();
    display.destroyed = true;
    ipc.reportRemoconProblem("down");
    assert.deepEqual(display.sent, []);
    display.destroyed = false;
    assert.equal(ipc.remoconProblem(fromDisplay), "down");
  });
});

describe("sameSite", () => {
  test("same scheme, host and port", () => {
    assert.equal(sameSite(DISPLAY_PAGE, DISPLAY_URL), true);
    assert.equal(sameSite("file:///D:/elsewhere.html", DISPLAY_URL), true);
    const dev = "http://localhost:5173/renderer/";
    assert.equal(sameSite("http://localhost:5173/renderer/#x", dev), true);
    assert.equal(sameSite("http://localhost:8080/", dev), false);
    assert.equal(sameSite("https://localhost:5173/", dev), false);
    assert.equal(sameSite("http://example.com/", dev), false);
    assert.equal(sameSite(DISPLAY_PAGE, dev), false);
    assert.equal(sameSite("not a URL", dev), false);
  });
});
