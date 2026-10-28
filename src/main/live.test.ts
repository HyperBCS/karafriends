// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { LiveEvent, LiveState, QueueItem } from "../common/api";
import { createLiveHub, toLiveState, type Viewer } from "./live";
import {
  createStateStore,
  failDownload,
  removeDownload,
  startDownload,
  type StateStore,
} from "./state";

const INTERVAL_MS = 50;

const DISPLAY: Viewer = { deviceId: null, isDisplay: true };

const item: QueueItem = {
  kind: "nico",
  songId: "sm9",
  name: "Song",
  artistName: "Artist",
  playtime: 100,
  timestamp: "1",
  user: { deviceId: "d", nickname: "n" },
};

const config = { supervisedMode: false, everyoneIsAdmin: false };

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-live-test-"));
  store = createStateStore(path.join(dir, "queue.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const { user: _user, ...itemFields } = item;
// item as a phone sees it.
const shared = (isMine: boolean) => ({
  ...itemFields,
  user: { nickname: "n" },
  isMine,
});

const otherItem: QueueItem = {
  ...item,
  songId: "sm10",
  timestamp: "2",
  user: { deviceId: "other", nickname: "o" },
};

describe("toLiveState", () => {
  test("shares no secrets and names download kinds", () => {
    store.update((state) => {
      state.songQueue.push(item);
      const download = startDownload(state.downloadQueue, {
        kind: "youtube",
        userIdentity: { deviceId: "d", nickname: "n" },
        songId: "jNQXAC9IVRw",
        suffix: null,
      });
      download.progress = 0.25;
      const failed = startDownload(state.downloadQueue, {
        kind: "joysound",
        userIdentity: { deviceId: "d", nickname: "n" },
        songId: "123",
        suffix: "jNQXAC9IVRw",
      });
      failDownload(state.downloadQueue, failed, "Video unavailable");
      state.toolsProblem = { message: "Update the tools", since: 5 };
      state.guideMelodyLevel = 0.5;
      state.songVolume = 70;
      state.mics = [
        { id: "Mic#0", label: "Mic, channel 1", gain: 50, echo: 0 },
      ];
      state.currentSongStartedAt = 1000;
      state.currentSongPausedSince = 1500;
    });
    const live = toLiveState(store.getState(), {
      supervisedMode: true,
      everyoneIsAdmin: true,
      // Not passed on.
      adminPasswordHash: "secret",
    } as LiveState["config"]);
    assert.deepEqual(live.config, {
      supervisedMode: true,
      everyoneIsAdmin: true,
    });
    assert.equal(live.toolsProblem, "Update the tools");
    assert.equal(live.guideMelodyLevel, 0.5);
    assert.equal(live.songVolume, 70);
    assert.deepEqual(live.mics, [
      { id: "Mic#0", label: "Mic, channel 1", gain: 50, echo: 0 },
    ]);
    assert.deepEqual(
      [live.currentSongStartedAt, live.currentSongPausedSince],
      [1000, 1500],
    );
    assert.deepEqual(live.queue, [shared(false)]);
    const [download, failed] = store.getState().downloadQueue;
    assert.deepEqual(live.downloads, [
      {
        id: download.id,
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        suffix: null,
        progress: 0.25,
        status: "downloading",
        reason: null,
        isMine: false,
      },
      {
        id: failed.id,
        kind: "joysound",
        songId: "123",
        suffix: "jNQXAC9IVRw",
        progress: 0,
        status: "failed",
        reason: "Video unavailable",
        isMine: false,
      },
    ]);
  });

  test("marks the watching device's songs and downloads, and no one else's", () => {
    store.update((state) => {
      state.currentSong = otherItem;
      state.songQueue.push(item, { ...otherItem, timestamp: "3" });
      startDownload(state.downloadQueue, {
        kind: "nico",
        userIdentity: { deviceId: "d", nickname: "n" },
        songId: "sm1",
        suffix: null,
      });
      startDownload(state.downloadQueue, {
        kind: "nico",
        userIdentity: { deviceId: "other", nickname: "o" },
        songId: "sm2",
        suffix: null,
      });
    });
    const mine = (deviceId: string | null) => {
      const live = toLiveState(store.getState(), config, deviceId);
      return {
        currentSong: live.currentSong?.isMine,
        queue: live.queue.map((entry) => entry.isMine),
        downloads: live.downloads.map((download) => download.isMine),
      };
    };
    assert.deepEqual(mine("d"), {
      currentSong: false,
      queue: [true, false],
      downloads: [true, false],
    });
    assert.deepEqual(mine("other"), {
      currentSong: true,
      queue: [false, true],
      downloads: [false, true],
    });
    for (const nobody of [null, "someone-else"]) {
      assert.deepEqual(mine(nobody), {
        currentSong: false,
        queue: [false, false],
        downloads: [false, false],
      });
    }
    // Nothing anywhere says a device ID.
    const all = JSON.stringify(toLiveState(store.getState(), config, "d"));
    assert.doesNotMatch(all, /deviceId|"other"|"d"/);
  });

  test("gives the current song its video's length, once the display knows it", () => {
    store.update((state) => {
      state.currentSong = item;
      state.songQueue.push(otherItem);
    });
    const playtimes = () => {
      const live = toLiveState(store.getState(), config);
      return [live.currentSong?.playtime, live.queue[0].playtime];
    };
    assert.deepEqual(playtimes(), [100, 100]);
    store.update((state) => {
      state.currentSongLength = 245;
    });
    assert.deepEqual(playtimes(), [245, 100]);
    // The song itself keeps what it was queued with.
    assert.equal(store.getState().currentSong?.playtime, 100);
  });
});

describe("createLiveHub: who sees what", () => {
  test("each phone sees its own songs; phones with none share one event", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const events = new Map<string, LiveEvent[]>();
    const watch = (name: string, deviceId: string | null) => {
      events.set(name, []);
      return hub.subscribe((event) => events.get(name)!.push(event), {
        deviceId,
      });
    };
    const stops = [
      watch("d", "d"),
      watch("d again", "d"),
      watch("other", "other"),
      watch("no ID", null),
      watch("idle phone", "idle"),
    ];
    store.update((state) => state.songQueue.push(item, otherItem));
    await sleep(INTERVAL_MS * 3);
    stops.forEach((stop) => stop());

    const second = (name: string) => events.get(name)!.slice(1);
    const [dState] = second("d");
    assert.deepEqual(
      dState.type === "state" && dState.state.queue.map((e) => e.isMine),
      [true, false],
    );
    const [oState] = second("other");
    assert.deepEqual(
      oState.type === "state" && oState.state.queue.map((e) => e.isMine),
      [false, true],
    );

    // The same objects, so they are serialized once (see server.ts).
    assert.equal(second("d again")[0], dState);
    assert.equal(second("idle phone")[0], second("no ID")[0]);
    assert.notEqual(second("no ID")[0], dState);

    for (const list of events.values()) {
      assert.doesNotMatch(JSON.stringify(list), /deviceId|"other"|"d"/);
    }
  });

  test("messages go to the display only: phones read the state", () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const messages = new Map<string, LiveEvent[]>();
    const watch = (name: string, viewer: Viewer) => {
      messages.set(name, []);
      return hub.subscribe((event) => {
        if (event.type !== "state") messages.get(name)!.push(event);
      }, viewer);
    };
    const stops = [
      watch("d", { deviceId: "d" }),
      watch("other", { deviceId: "other" }),
      watch("no ID", { deviceId: null }),
      watch("display", { deviceId: null, isDisplay: true }),
    ];
    hub.publish({ type: "queueAdded", item });
    hub.publish({ type: "emote", emote: "🎉", user: item.user });
    hub.publish({ type: "queueFailed", item, reason: "Video unavailable" });
    hub.publish({ type: "micLevels", id: "Mic#0", echo: 30 });
    stops.forEach((stop) => stop());

    assert.deepEqual(messages.get("display"), [
      { type: "queueAdded", item: shared(false) },
      { type: "emote", emote: "🎉", user: { nickname: "n" } },
      { type: "queueFailed", item: shared(false), reason: "Video unavailable" },
      { type: "micLevels", id: "Mic#0", echo: 30 },
    ]);
    assert.deepEqual(messages.get("d"), []);
    assert.deepEqual(messages.get("other"), []);
    assert.deepEqual(messages.get("no ID"), []);
  });

  test("a failed download stays in the state until it's removed", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const seen: string[][] = [];
    const stop = hub.subscribe(
      (event) => {
        if (event.type === "state") {
          seen.push(
            event.state.downloads.map(
              (d) => `${d.status}:${d.reason}:${d.isMine}`,
            ),
          );
        }
      },
      { deviceId: "d" },
    );
    const { downloadQueue } = store.getState();
    const download = startDownload(downloadQueue, {
      kind: "youtube",
      userIdentity: item.user,
      songId: "jNQXAC9IVRw",
      suffix: null,
    });
    await sleep(INTERVAL_MS * 3);
    failDownload(downloadQueue, download, "Private video");
    await sleep(INTERVAL_MS * 3);
    removeDownload(downloadQueue, download);
    await sleep(INTERVAL_MS * 3);
    stop();
    assert.deepEqual(seen, [
      [],
      ["downloading:null:true"],
      ["failed:Private video:true"],
      [],
    ]);
  });
});

describe("createLiveHub", () => {
  test("sends the state on subscribe, then changes and messages", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const events: LiveEvent[] = [];
    const before = Date.now();
    const stop = hub.subscribe((event) => events.push(event), DISPLAY);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "state");
    // With the server's time, for the phones' clocks.
    const { sentAt } = events[0] as Extract<LiveEvent, { type: "state" }>;
    assert.ok(sentAt >= before && sentAt <= Date.now());

    store.update((state) => state.songQueue.push(item));
    hub.publish({ type: "queueAdded", item });
    // An update that changes nothing sends nothing.
    store.update(() => {});
    await sleep(INTERVAL_MS * 3);

    assert.deepEqual(
      events.map((event) => event.type),
      ["state", "state", "queueAdded"],
    );
    const last = events[1] as Extract<LiveEvent, { type: "state" }>;
    assert.deepEqual(last.state.queue, [shared(false)]);

    stop();
    store.update((state) => state.songQueue.push({ ...item, timestamp: "2" }));
    await sleep(INTERVAL_MS * 2);
    assert.equal(events.length, 3);
  });

  test("refresh() sends the state when the config changed", async () => {
    const config = { supervisedMode: false, everyoneIsAdmin: false };
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const modes: LiveState["config"][] = [];
    const stop = hub.subscribe((event) => {
      if (event.type === "state") modes.push(event.state.config);
    });
    await sleep(INTERVAL_MS * 2);
    // Nothing changed: nothing sent.
    hub.refresh();
    await sleep(INTERVAL_MS * 2);
    config.supervisedMode = true;
    hub.refresh();
    await sleep(INTERVAL_MS * 2);
    config.everyoneIsAdmin = true;
    hub.refresh();
    await sleep(INTERVAL_MS * 2);
    stop();
    assert.deepEqual(modes, [
      { supervisedMode: false, everyoneIsAdmin: false },
      { supervisedMode: true, everyoneIsAdmin: false },
      { supervisedMode: true, everyoneIsAdmin: true },
    ]);
  });

  test("sends at most one state per interval, ending with the latest", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const queueLengths: number[] = [];
    const stop = hub.subscribe((event) => {
      if (event.type === "state") queueLengths.push(event.state.queue.length);
    });
    await sleep(INTERVAL_MS * 2);
    for (let n = 1; n <= 5; n++) {
      store.update((state) =>
        state.songQueue.push({ ...item, timestamp: String(n) }),
      );
    }
    await sleep(INTERVAL_MS * 3);
    stop();
    // The first change goes out at once (it's been a while), the rest
    // together after the interval.
    assert.deepEqual(queueLengths, [0, 1, 5]);
  });

  test("a backward step of the wall clock doesn't hold back the state", async (t) => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const states: string[] = [];
    const stop = hub.subscribe((event) => {
      if (event.type === "state") states.push(event.state.playbackState);
    });
    // The host's clock goes back 3 s (a time sync), just after a flush.
    await sleep(INTERVAL_MS * 2);
    store.update((state) => {
      state.playbackState = "PLAYING";
    });
    const realNow = Date.now;
    t.mock.method(Date, "now", () => realNow() - 3000);
    store.update((state) => {
      state.pitchShiftSemis = 1;
    });
    store.update((state) => {
      state.playbackState = "PAUSED";
    });
    await sleep(INTERVAL_MS * 4);
    stop();
    // It used to wait the 3 s out.
    assert.deepEqual(states, ["WAITING", "PLAYING", "PAUSED"]);
  });

  test("a listener that joins between flushes ends up with the latest state", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const playbackStates = (events: LiveEvent[]) =>
      events.flatMap((event) =>
        event.type === "state" ? [event.state.playbackState] : [],
      );
    const first: LiveEvent[] = [];
    const stopFirst = hub.subscribe((event) => first.push(event));
    await sleep(INTERVAL_MS * 2);
    // Goes out at once: it's been a while.
    store.update((state) => {
      state.playbackState = "PLAYING";
    });
    // Within the next interval: a change, a new phone, and the change undone.
    store.update((state) => {
      state.playbackState = "PAUSED";
    });
    const second: LiveEvent[] = [];
    const stopSecond = hub.subscribe((event) => second.push(event));
    store.update((state) => {
      state.playbackState = "PLAYING";
    });
    await sleep(INTERVAL_MS * 3);
    stopFirst();
    stopSecond();
    assert.deepEqual(playbackStates(first), [
      "WAITING",
      "PLAYING",
      "PAUSED",
      "PLAYING",
    ]);
    // It used to get PAUSED and nothing after: PLAYING was what was last sent.
    assert.deepEqual(playbackStates(second), ["PAUSED", "PLAYING"]);
  });

  test("notices download progress, which changes outside the store", async () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const progress: number[][] = [];
    const stop = hub.subscribe((event) => {
      if (event.type === "state") {
        progress.push(event.state.downloads.map((d) => d.progress));
      }
    });
    const { downloadQueue } = store.getState();
    const download = startDownload(downloadQueue, {
      kind: "nico",
      userIdentity: { deviceId: "d", nickname: "n" },
      songId: "sm9",
      suffix: null,
    });
    await sleep(INTERVAL_MS * 3);
    download.progress = 0.5;
    await sleep(INTERVAL_MS * 3);
    downloadQueue.splice(0, 1);
    await sleep(INTERVAL_MS * 3);
    stop();
    assert.deepEqual(progress, [[], [0], [0.5], []]);
  });

  test("a failing listener doesn't stop the others", () => {
    const hub = createLiveHub(store, config, INTERVAL_MS);
    const seen: string[] = [];
    const original = console.error;
    console.error = () => {};
    try {
      const stopBad = hub.subscribe(() => {
        throw new Error("broken");
      }, DISPLAY);
      const stopGood = hub.subscribe((event) => seen.push(event.type), DISPLAY);
      hub.publish({ type: "emote", emote: "🎉", user: item.user });
      stopBad();
      stopGood();
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, ["state", "emote"]);
  });
});
