// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { LiveEvent, QueueItem } from "../common/api";
import { createLiveHub, toLiveState } from "./live";
import { createStateStore, type StateStore } from "./state";

const INTERVAL_MS = 50;

const item: QueueItem = {
  kind: "nico",
  songId: "sm9",
  name: "Song",
  artistName: "Artist",
  playtime: 100,
  timestamp: "1",
  user: { deviceId: "d", nickname: "n" },
};

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-live-test-"));
  store = createStateStore(path.join(dir, "queue.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("toLiveState", () => {
  test("shares no secrets and names download kinds", () => {
    store.update((state) => {
      state.songQueue.push(item);
      state.downloadQueue.push({
        downloadType: 1,
        userIdentity: { deviceId: "d", nickname: "n" },
        songId: "jNQXAC9IVRw",
        suffix: null,
        progress: 0.25,
      });
    });
    const live = toLiveState(store.getState(), {
      supervisedMode: true,
      // Not passed on.
      adminDeviceIds: ["secret"],
    } as { supervisedMode: boolean });
    assert.deepEqual(live.config, { supervisedMode: true });
    assert.deepEqual(live.queue, [item]);
    assert.deepEqual(live.downloads, [
      {
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        suffix: null,
        progress: 0.25,
        deviceId: "d",
      },
    ]);
  });
});

describe("createLiveHub", () => {
  test("sends the state on subscribe, then changes and messages", async () => {
    const hub = createLiveHub(store, { supervisedMode: false }, INTERVAL_MS);
    const events: LiveEvent[] = [];
    const stop = hub.subscribe((event) => events.push(event));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "state");

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
    assert.deepEqual(last.state.queue, [item]);

    stop();
    store.update((state) => state.songQueue.push({ ...item, timestamp: "2" }));
    await sleep(INTERVAL_MS * 2);
    assert.equal(events.length, 3);
  });

  test("sends at most one state per interval, ending with the latest", async () => {
    const hub = createLiveHub(store, { supervisedMode: false }, INTERVAL_MS);
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

  test("notices download progress, which changes outside the store", async () => {
    const hub = createLiveHub(store, { supervisedMode: false }, INTERVAL_MS);
    const progress: number[][] = [];
    const stop = hub.subscribe((event) => {
      if (event.type === "state") {
        progress.push(event.state.downloads.map((d) => d.progress));
      }
    });
    const download = {
      downloadType: 2,
      userIdentity: { deviceId: "d", nickname: "n" },
      songId: "sm9",
      suffix: null,
      progress: 0,
    };
    const { downloadQueue } = store.getState();
    downloadQueue.push(download);
    await sleep(INTERVAL_MS * 3);
    download.progress = 0.5;
    await sleep(INTERVAL_MS * 3);
    downloadQueue.splice(0, 1);
    await sleep(INTERVAL_MS * 3);
    stop();
    assert.deepEqual(progress, [[], [0], [0.5], []]);
  });

  test("a failing listener doesn't stop the others", () => {
    const hub = createLiveHub(store, { supervisedMode: false }, INTERVAL_MS);
    const seen: string[] = [];
    const original = console.error;
    console.error = () => {};
    try {
      const stopBad = hub.subscribe(() => {
        throw new Error("broken");
      });
      const stopGood = hub.subscribe((event) => seen.push(event.type));
      hub.publish({ type: "emote", emote: "🎉", user: item.user });
      stopBad();
      stopGood();
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, ["state", "emote"]);
  });
});
