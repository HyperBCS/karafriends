// Runs on Node's test runner through tsx (yarn test:unit). DAM, Joysound,
// YouTube and the downloads are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { QueueItem } from "../common/api";
import { ApiError, type ApiDeps, type Caller, createApi } from "./api";
import type { HubMessage } from "./live";
import { damPageWindow, nextOffset } from "./paging";
import { createStateStore, type StateStore } from "./state";
import { validators } from "./validate";

const ADMIN_DEVICE = "admin-device";
// In the deprecated adminNicks, which grants nothing: tests that check a phone
// can't pass for an admin by nickname list it.
const ADMIN_NICK = "host";
const WITH_ADMIN_NICK = { adminNicks: [ADMIN_NICK] };

const phone = (deviceId: string, nickname: string): Caller => ({
  deviceId,
  nickname,
  isDisplay: false,
});
const display: Caller = { deviceId: null, nickname: null, isDisplay: true };
const alice = phone("alice-device", "alice");
const bob = phone("bob-device", "bob");

const song = (n: number, owner: Caller): QueueItem => ({
  kind: "nico",
  songId: `sm${n}`,
  name: `Song ${n}`,
  artistName: "Artist",
  playtime: 100,
  timestamp: String(n),
  user: { deviceId: owner.deviceId!, nickname: owner.nickname! },
});

let dir: string;
let store: StateStore;
let published: HubMessage[];
let downloads: string[];
let dkwebsysCalls: unknown[][];
let joysoundCalls: unknown[][];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-api-test-"));
  store = createStateStore(path.join(dir, "queue.json"));
  published = [];
  downloads = [];
  dkwebsysCalls = [];
  joysoundCalls = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// DAM search results: `total` songs, numbered from 0.
function fakeDamSearch(total: number) {
  return async (keyword: string, first: number, after: number) => {
    dkwebsysCalls.push([keyword, first, after]);
    const end = Math.min(after + first, total);
    return {
      data: { totalCount: total },
      list: Array.from({ length: Math.max(end - after, 0) }, (_, i) => ({
        requestNo: `${after + i}`,
        title: `Song ${after + i}`,
        titleYomi: "",
        artist: "Artist",
        artistYomi: "",
      })),
    };
  };
}

function makeApi(
  config: Partial<ApiDeps["config"]> = {},
  overrides: Partial<ApiDeps> = {},
) {
  const deps = {
    config: {
      adminDeviceIds: [ADMIN_DEVICE],
      paxSongQueueLimit: 0,
      supervisedMode: false,
      useLowBitrateUrl: false,
      ...config,
    },
    store,
    minsei: {
      getMusicStreamingUrls: async () => ({
        list: [
          { highBitrateUrl: "https://dam/high0", lowBitrateUrl: "low0" },
          { highBitrateUrl: "https://dam/high1", lowBitrateUrl: "low1" },
        ],
      }),
      getScoringData: async () => new Uint8Array([1, 2, 3]).buffer,
    },
    dkwebsys: {
      getMusicByKeyword: fakeDamSearch(75),
      getArtistByKeyword: fakeDamSearch(0),
      getMusicListByArtist: fakeDamSearch(0),
      getMusicDetailsInfo: async () => {
        throw new Error("not faked");
      },
    },
    joysound: {
      getSongListByKeyword: async (
        keyword: string,
        start: number,
        count: number,
      ) => {
        joysoundCalls.push([keyword, start, count]);
        // 150 results in all.
        const n = Math.max(Math.min(count, 151 - start), 0);
        return Array.from({ length: n }, (_, i) => ({
          selSongNo: `${start + i}`,
          songName: `Song ${start + i}`,
          artistName: "Artist",
        }));
      },
      getArtistListByKeyword: async () => [],
      getSongListByArtist: async () => [],
      getSongDetail: async () => {
        throw new Error("not faked");
      },
    },
    youtube: async () => ({
      getBasicInfo: async () => ({
        playability_status: { status: "LOGIN_REQUIRED", reason: "Bot check" },
      }),
    }),
    getNicoVideoInfo: async () => {
      throw new Error("offline");
    },
    downloads: {
      dam: (url: string) => downloads.push(url),
      // Ready at once.
      joysound: (
        item: QueueItem,
        pushToHead: boolean,
        onReady: (item: QueueItem, pushToHead: boolean) => void,
      ) => onReady(item, pushToHead),
      youtube: (_item: QueueItem, _captions: unknown, onReady: () => void) =>
        onReady(),
      nico: (_item: QueueItem, onReady: () => void) => onReady(),
    },
    publish: (message: HubMessage) => published.push(message),
    now: () => 42,
    ...overrides,
  };
  return createApi(deps as unknown as ApiDeps);
}

const rejectsWith = (promise: Promise<unknown>, status: number) =>
  assert.rejects(
    promise,
    (err) => err instanceof ApiError && err.status === status,
  );

describe("admin checks", () => {
  test("whoami: the display and the phones on the admin list", async () => {
    const api = makeApi(WITH_ADMIN_NICK);
    assert.deepEqual(await api.whoami({}, display), { isAdmin: true });
    assert.deepEqual(await api.whoami({}, phone(ADMIN_DEVICE, "x")), {
      isAdmin: true,
    });
    // adminNicks no longer counts: anyone can take a nickname.
    assert.deepEqual(await api.whoami({}, phone("x", ADMIN_NICK)), {
      isAdmin: false,
    });
    assert.deepEqual(await api.whoami({}, alice), { isAdmin: false });
    assert.deepEqual(
      await api.whoami(
        {},
        { deviceId: null, nickname: null, isDisplay: false },
      ),
      { isAdmin: false },
    );
  });

  test("without supervised mode anyone may remove a song or pause", async () => {
    const api = makeApi();
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.songQueue.push(song(2, alice));
    });
    assert.equal(
      await api.removeSong({ songId: "sm2", timestamp: "2" }, bob),
      true,
    );
    assert.equal(
      await api.setPlaybackState({ playbackState: "PAUSED" }, bob),
      true,
    );
    assert.equal(store.getState().playbackState, "PAUSED");
  });

  describe("in supervised mode", () => {
    beforeEach(() => {
      store.update((state) => {
        state.currentSong = song(1, alice);
        state.songQueue.push(song(2, alice), song(3, alice));
        state.playbackState = "PLAYING";
      });
    });

    test("only the owner or an admin may remove a song", async () => {
      const api = makeApi({ ...WITH_ADMIN_NICK, supervisedMode: true });
      const remove = (n: number, caller: Caller) =>
        api.removeSong({ songId: `sm${n}`, timestamp: String(n) }, caller);

      await rejectsWith(remove(2, bob), 403);
      await rejectsWith(
        remove(2, { deviceId: null, nickname: null, isDisplay: false }),
        403,
      );
      assert.equal(store.getState().songQueue.length, 2);

      // By device ID, as isMine says, whatever the nickname. Every phone
      // sees the nickname, so it proves nothing.
      await rejectsWith(remove(3, phone("other-device", "alice")), 403);
      await rejectsWith(remove(3, phone("other-device", ADMIN_NICK)), 403);
      assert.equal(await remove(2, phone("alice-device", "someone")), true);
      assert.equal(await remove(3, alice), true);

      store.update((state) => state.songQueue.push(song(4, alice)));
      assert.equal(await remove(4, phone(ADMIN_DEVICE, "x")), true);
      store.update((state) => state.songQueue.push(song(5, alice)));
      assert.equal(await remove(5, display), true);

      // Already gone: not an error.
      assert.equal(await remove(5, bob), false);
    });

    test("only the current singer or an admin may control playback", async () => {
      const api = makeApi({ ...WITH_ADMIN_NICK, supervisedMode: true });

      await rejectsWith(
        api.setPlaybackState({ playbackState: "PAUSED" }, bob),
        403,
      );
      await rejectsWith(api.setPitchShiftSemis({ semis: 2 }, bob), 403);
      // The singer's or an admin's nickname, from another phone.
      for (const nickname of ["alice", ADMIN_NICK]) {
        await rejectsWith(
          api.setPlaybackState(
            { playbackState: "SKIPPING" },
            phone("other-device", nickname),
          ),
          403,
        );
      }
      assert.equal(store.getState().playbackState, "PLAYING");
      assert.equal(store.getState().pitchShiftSemis, 0);

      assert.equal(
        await api.setPlaybackState({ playbackState: "PAUSED" }, alice),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "SKIPPING" },
          phone(ADMIN_DEVICE, "x"),
        ),
        true,
      );
      assert.equal(
        await api.setPlaybackState({ playbackState: "PLAYING" }, display),
        true,
      );
      assert.equal(await api.setPitchShiftSemis({ semis: -1 }, alice), true);
      assert.equal(store.getState().pitchShiftSemis, -1);
    });
  });

  test("only the display (or an admin) may start the next song", async () => {
    const api = makeApi();
    store.update((state) => state.songQueue.push(song(1, alice)));
    await rejectsWith(api.popSong({}, alice), 403);
    assert.equal(store.getState().songQueue.length, 1);

    const popped = await api.popSong({}, display);
    assert.equal(popped?.songId, "sm1");
    assert.equal(store.getState().currentSong?.songId, "sm1");
    assert.deepEqual(store.getState().songHistory, [{ song: song(1, alice) }]);
    assert.equal(await api.popSong({}, display), null);
  });

  describe("popSong with a DAM song", () => {
    const damSong: QueueItem = {
      kind: "dam",
      songId: "1234-56",
      name: "DAM song",
      artistName: "Artist",
      playtime: 200,
      timestamp: "7",
      user: { deviceId: "alice-device", nickname: "alice" },
      streamingUrlIdx: 0,
    };

    test("comes with its streaming URLs and scoring data", async () => {
      const api = makeApi();
      store.update((state) => state.songQueue.push(damSong));
      assert.deepEqual(await api.popSong({}, display), {
        ...damSong,
        streamingUrls: ["https://dam/high0", "https://dam/high1"],
        scoringData: [1, 2, 3],
      });
    });

    test(
      "starts the song without them when DAM fails or hangs",
      {
        timeout: 5000,
      },
      async () => {
        const api = makeApi(
          {},
          {
            minsei: {
              getMusicStreamingUrls: async () => {
                throw new Error("DAM is down");
              },
              // Retrying for minutes.
              getScoringData: () => new Promise(() => {}),
            },
            damPopTimeoutMs: 50,
          },
        );
        store.update((state) => state.songQueue.push(damSong));
        const started = Date.now();
        assert.deepEqual(await api.popSong({}, display), {
          ...damSong,
          streamingUrls: [],
          scoringData: [],
        });
        assert.ok(Date.now() - started < 2000);
        // Still the current song: the display plays it from its download.
        assert.equal(store.getState().currentSong?.songId, "1234-56");
        assert.deepEqual(store.getState().songQueue, []);
      },
    );
  });

  test("only an admin's song may jump the queue", async () => {
    const api = makeApi(WITH_ADMIN_NICK);
    const queue = (caller: Caller, n: number) =>
      api.queueSong(
        {
          kind: "nico",
          songId: `sm${n}`,
          name: `Song ${n}`,
          artistName: "",
          tryHeadOfQueue: true,
        },
        caller,
      );
    await queue(alice, 1);
    await queue(alice, 2);
    await queue(bob, 3);
    assert.deepEqual(
      store.getState().songQueue.map((item) => item.songId),
      ["sm1", "sm2", "sm3"],
    );
    // An admin's goes second, leaving the first time to download.
    await queue(phone(ADMIN_DEVICE, "host phone"), 4);
    // Not by nickname.
    await queue(phone("other-device", ADMIN_NICK), 5);
    assert.deepEqual(
      store.getState().songQueue.map((item) => item.songId),
      ["sm1", "sm4", "sm2", "sm3", "sm5"],
    );
  });

  test("adminNicks is only read, to warn that it no longer counts", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => warnings.push(message));
    const api = makeApi({ adminNicks: [ADMIN_NICK], supervisedMode: true });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /adminNicks .* no longer makes anyone an admin/);

    // A phone that takes that nickname is told nothing, but the host learns
    // its device ID, to list it if the phone is theirs.
    const impostor = phone("impostor-device", ADMIN_NICK);
    assert.deepEqual(await api.whoami({}, impostor), { isAdmin: false });
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /impostor-device/);
    await rejectsWith(api.popSong({}, impostor), 403);

    // Without adminNicks, no warning.
    makeApi({ adminNicks: [] });
    makeApi({ adminNicks: undefined });
    await makeApi({ adminNicks: undefined }).whoami({}, impostor);
    assert.equal(warnings.length, 2);
  });
});

describe("paging", () => {
  test("damPageWindow covers [offset, offset + limit) with DAM's 30-result pages", () => {
    assert.deepEqual(damPageWindow(0, 30), {
      firstPage: 1,
      pageCount: 1,
      start: 0,
      end: 30,
    });
    assert.deepEqual(damPageWindow(30, 30), {
      firstPage: 2,
      pageCount: 1,
      start: 0,
      end: 30,
    });
    // The old maths fetched one page here and returned 20 results.
    assert.deepEqual(damPageWindow(10, 30), {
      firstPage: 1,
      pageCount: 2,
      start: 10,
      end: 40,
    });
    assert.deepEqual(damPageWindow(45, 10), {
      firstPage: 2,
      pageCount: 1,
      start: 15,
      end: 25,
    });
    assert.deepEqual(damPageWindow(29, 2), {
      firstPage: 1,
      pageCount: 2,
      start: 29,
      end: 31,
    });
    assert.deepEqual(damPageWindow(0, 100), {
      firstPage: 1,
      pageCount: 4,
      start: 0,
      end: 100,
    });
  });

  test("nextOffset", () => {
    assert.equal(nextOffset(0, 30, 75), 30);
    assert.equal(nextOffset(30, 30, 75), 60);
    assert.equal(nextOffset(60, 30, 75), null);
    assert.equal(nextOffset(0, 30, 30), null);
    assert.equal(nextOffset(0, 30, 0), null);
  });

  test("DAM search pages by offset", async () => {
    const api = makeApi();
    const first = await api.damSearchSongs({ query: "x" }, alice);
    assert.equal(first.items.length, 30);
    assert.equal(first.items[0].id, "0");
    assert.equal(first.nextOffset, 30);
    assert.deepEqual(dkwebsysCalls[0], ["x", 30, 0]);

    const last = await api.damSearchSongs(
      { query: "x", offset: 60, limit: 30 },
      alice,
    );
    assert.deepEqual(
      last.items.map((item) => item.id),
      Array.from({ length: 15 }, (_, i) => `${60 + i}`),
    );
    assert.equal(last.nextOffset, null);
  });

  test("Joysound search counts from 1 and pages while pages are full", async () => {
    const api = makeApi();
    const first = await api.joysoundSearchSongs({ query: "x" }, alice);
    assert.deepEqual(joysoundCalls[0], ["x", 1, 100]);
    assert.equal(first.items.length, 100);
    assert.equal(first.items[0].id, "1");
    assert.equal(first.nextOffset, 100);

    const second = await api.joysoundSearchSongs(
      { query: "x", offset: 100 },
      alice,
    );
    assert.deepEqual(joysoundCalls[1], ["x", 101, 100]);
    assert.equal(second.items.length, 50);
    assert.equal(second.nextOffset, null);
  });

  test("history pages through every song, newest first", async () => {
    const api = makeApi();
    store.update((state) => {
      for (let n = 1; n <= 35; n++) {
        state.songHistory.unshift({ song: song(n, alice) });
      }
    });
    const first = await api.history({}, alice);
    assert.equal(first.items.length, 30);
    assert.equal(first.items[0].songId, "sm35");
    assert.equal(first.nextOffset, 30);
    const rest = await api.history({ offset: first.nextOffset! }, alice);
    assert.deepEqual(
      rest.items.map((item) => item.songId),
      ["sm5", "sm4", "sm3", "sm2", "sm1"],
    );
    assert.equal(rest.nextOffset, null);
  });

  test("history names singers by nickname only, and marks the caller's", async () => {
    const api = makeApi();
    store.update((state) => {
      state.songHistory.unshift({ song: song(1, alice) });
      state.songHistory.unshift({ song: song(2, bob) });
    });
    const { items } = await api.history({}, alice);
    assert.deepEqual(
      items.map((item) => [item.songId, item.user, item.isMine]),
      [
        ["sm2", { nickname: "bob" }, false],
        ["sm1", { nickname: "alice" }, true],
      ],
    );
    assert.doesNotMatch(JSON.stringify(items), /-device/);
    const anonymous = await api.history({}, display);
    assert.deepEqual(
      anonymous.items.map((item) => item.isMine),
      [false, false],
    );
  });
});

describe("queueSong", () => {
  test("queues as the caller and tells listeners", async () => {
    const api = makeApi();
    const result = await api.queueSong(
      {
        kind: "dam",
        songId: "1234-56",
        name: "DAM song",
        artistName: "Artist",
        playtime: 200,
        streamingUrlIdx: 1,
      },
      alice,
    );
    assert.deepEqual(result, { ok: true, eta: 0 });
    const item = {
      kind: "dam",
      songId: "1234-56",
      name: "DAM song",
      artistName: "Artist",
      playtime: 200,
      timestamp: "42",
      user: { deviceId: "alice-device", nickname: "alice" },
      streamingUrlIdx: 1,
    };
    assert.deepEqual(store.getState().songQueue, [item]);
    assert.deepEqual(published, [{ type: "queueAdded", item }]);
    // The download starts once DAM answers.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(downloads, ["https://dam/high1"]);

    const next = await api.queueSong(
      { kind: "nico", songId: "sm9", name: "", artistName: "" },
      bob,
    );
    assert.deepEqual(next, { ok: true, eta: 200 });
  });

  test("keeps a YouTube song's adhoc lyrics", async () => {
    const api = makeApi();
    await api.queueSong(
      {
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        name: "Me at the zoo",
        artistName: "",
        adhocLyrics: "line one\n\n  \nline two\n",
        captionCode: null,
        gainValue: 1,
      },
      alice,
    );
    assert.deepEqual(await api.adhocLyrics({ songId: "jNQXAC9IVRw" }, bob), [
      "line one",
      "line two",
    ]);
    assert.equal(store.getState().songQueue[0].kind, "youtube");
  });

  test("needs the caller's identity", async () => {
    const api = makeApi();
    await rejectsWith(
      api.queueSong(
        { kind: "nico", songId: "sm9", name: "", artistName: "" },
        display,
      ),
      400,
    );
  });

  test("refuses IDs that could escape the downloads folder", async () => {
    const api = makeApi();
    for (const songId of ["../../evil", "--exec=calc", "a b", ""]) {
      await rejectsWith(
        api.queueSong(
          { kind: "nico", songId, name: "", artistName: "" },
          alice,
        ),
        400,
      );
    }
    await rejectsWith(
      api.queueSong(
        {
          kind: "joysound",
          songId: "123",
          name: "",
          artistName: "",
          isRomaji: false,
          youtubeVideoId: "../x",
        },
        alice,
      ),
      400,
    );
    assert.deepEqual(store.getState().songQueue, []);
  });

  test("stops at the per-person limit, except for admins", async () => {
    const api = makeApi({ ...WITH_ADMIN_NICK, paxSongQueueLimit: 1 });
    const queue = (caller: Caller, n: number) =>
      api.queueSong(
        { kind: "nico", songId: `sm${n}`, name: "", artistName: "" },
        caller,
      );
    assert.equal((await queue(alice, 1)).ok, true);
    assert.deepEqual(await queue(alice, 2), {
      ok: false,
      reason: "alice already has 1 song(s) in the queue or downloading",
    });
    assert.equal((await queue(bob, 3)).ok, true);
    const host = phone(ADMIN_DEVICE, "host phone");
    assert.equal((await queue(host, 4)).ok, true);
    assert.equal((await queue(host, 5)).ok, true);
    // Not by nickname.
    const impostor = phone("impostor-device", ADMIN_NICK);
    assert.equal((await queue(impostor, 6)).ok, true);
    assert.equal((await queue(impostor, 7)).ok, false);
  });
});

describe("pushAdhocLyrics", () => {
  const VIDEO = "jNQXAC9IVRw";
  const lyricsSong: QueueItem = {
    kind: "youtube",
    songId: VIDEO,
    name: "Me at the zoo",
    artistName: "",
    playtime: 19,
    timestamp: "5",
    user: { deviceId: "alice-device", nickname: "alice" },
    hasAdhocLyrics: true,
    hasCaptions: false,
    gainValue: 1,
  };

  // Alice's video, playing, with these lyrics.
  const play = (lyrics: string[]) =>
    store.update((state) => {
      state.currentSong = lyricsSong;
      state.idToAdhocLyrics[VIDEO] = lyrics;
    });
  const shown = () => store.getState().currentSongAdhocLyrics;

  test("shows the line the singer picks, from the song's own lyrics", async () => {
    const api = makeApi();
    play(["line one", "line two"]);
    assert.equal(await api.pushAdhocLyrics({ lyricIndex: 1 }, alice), true);
    assert.equal(await api.pushAdhocLyrics({ lyricIndex: 0 }, alice), true);
    assert.deepEqual(shown(), [
      { lyric: "line two", lyricIndex: 1 },
      { lyric: "line one", lyricIndex: 0 },
    ]);
    // Only lines the song has.
    await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 2 }, alice), 400);
    assert.equal(shown().length, 2);
  });

  test("in supervised mode, only the singer or an admin may", async () => {
    const api = makeApi({ ...WITH_ADMIN_NICK, supervisedMode: true });
    play(["line one"]);
    for (const caller of [
      bob,
      phone("other-device", "alice"),
      phone("other-device", ADMIN_NICK),
      { deviceId: null, nickname: null, isDisplay: false },
    ]) {
      await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 0 }, caller), 403);
    }
    assert.deepEqual(shown(), []);
    for (const caller of [alice, phone(ADMIN_DEVICE, "x"), display]) {
      assert.equal(await api.pushAdhocLyrics({ lyricIndex: 0 }, caller), true);
    }
    assert.equal(shown().length, 3);
  });

  test("without supervised mode, anyone may", async () => {
    const api = makeApi();
    play(["line one"]);
    assert.equal(await api.pushAdhocLyrics({ lyricIndex: 0 }, bob), true);
  });

  test("does nothing unless a song with adhoc lyrics is playing", async () => {
    const api = makeApi();
    assert.equal(await api.pushAdhocLyrics({ lyricIndex: 0 }, alice), false);
    store.update((state) => {
      state.currentSong = song(1, alice);
    });
    assert.equal(await api.pushAdhocLyrics({ lyricIndex: 0 }, alice), false);
    assert.deepEqual(shown(), []);
  });

  test("stops at a few hundred lines, or 30,000 characters", async () => {
    const api = makeApi();
    play(["la", "x".repeat(10_000)]);
    for (let i = 0; i < 400; i++) {
      await api.pushAdhocLyrics({ lyricIndex: 0 }, alice);
    }
    await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 0 }, alice), 400);
    assert.equal(shown().length, 400);

    store.update((state) => {
      state.currentSongAdhocLyrics = [];
    });
    for (let i = 0; i < 3; i++) {
      assert.equal(await api.pushAdhocLyrics({ lyricIndex: 1 }, alice), true);
    }
    // 30,000 characters: no more, however short.
    await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 1 }, alice), 400);
    await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 0 }, alice), 400);
    assert.equal(shown().length, 3);
  });
});

describe("validators", () => {
  const invalid = (method: keyof typeof validators, raw: unknown) =>
    assert.throws(
      () => validators[method](raw),
      (err) => err instanceof ApiError && err.status === 400,
    );

  test("queueSong takes one input per kind", () => {
    assert.deepEqual(
      validators.queueSong({
        kind: "joysound",
        songId: "123",
        name: "Song",
        artistName: "Artist",
        playtime: 200,
        isRomaji: false,
      }),
      {
        kind: "joysound",
        songId: "123",
        name: "Song",
        artistName: "Artist",
        playtime: 200,
        tryHeadOfQueue: undefined,
        isRomaji: false,
        youtubeVideoId: null,
      },
    );
    assert.equal(
      validators.queueSong({
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        name: "Me at the zoo",
        artistName: "jawed",
        gainValue: 1.5,
        tryHeadOfQueue: true,
      }).kind,
      "youtube",
    );
  });

  test("queueSong refuses bad input", () => {
    const nico = { kind: "nico", songId: "sm9", name: "x", artistName: "y" };
    invalid("queueSong", null);
    invalid("queueSong", []);
    invalid("queueSong", "sm9");
    invalid("queueSong", { ...nico, kind: "cassette" });
    invalid("queueSong", { ...nico, kind: undefined });
    invalid("queueSong", { ...nico, songId: 9 });
    invalid("queueSong", { ...nico, name: undefined });
    invalid("queueSong", { ...nico, name: "x".repeat(1001) });
    invalid("queueSong", { ...nico, playtime: -1 });
    invalid("queueSong", { ...nico, playtime: 1.5 });
    invalid("queueSong", { ...nico, tryHeadOfQueue: "yes" });
    // A field of another kind.
    invalid("queueSong", { ...nico, streamingUrlIdx: 0 });
    invalid("queueSong", { ...nico, kind: "dam" });
    invalid("queueSong", { ...nico, kind: "dam", streamingUrlIdx: "0" });
    invalid("queueSong", { ...nico, kind: "joysound" });
    invalid("queueSong", { ...nico, kind: "youtube", gainValue: Infinity });
    invalid("queueSong", { ...nico, kind: "youtube", gainValue: "1" });
    invalid("queueSong", {
      ...nico,
      kind: "youtube",
      gainValue: 1,
      captionCode: 5,
    });
    invalid("queueSong", { ...nico, __proto__: { admin: true }, x: 1 });
  });

  test("other methods", () => {
    assert.deepEqual(validators.whoami({}), {});
    invalid("whoami", { isAdmin: true });
    assert.deepEqual(validators.setPlaybackState({ playbackState: "PAUSED" }), {
      playbackState: "PAUSED",
    });
    invalid("setPlaybackState", { playbackState: "paused" });
    invalid("setPitchShiftSemis", { semis: 99 });
    invalid("setPitchShiftSemis", { semis: "1" });
    assert.deepEqual(validators.damSearchSongs({ query: "a", limit: 30 }), {
      query: "a",
      offset: undefined,
      limit: 30,
    });
    invalid("damSearchSongs", { query: "a", limit: 0 });
    invalid("damSearchSongs", { query: "a", limit: 101 });
    invalid("damSearchSongs", { query: "a", offset: -1 });
    invalid("damSearchSongs", { name: "a" });
    invalid("removeSong", { songId: "sm9" });
    invalid("sendEmote", { emote: "" });
    assert.deepEqual(validators.pushAdhocLyrics({ lyricIndex: 3 }), {
      lyricIndex: 3,
    });
    invalid("pushAdhocLyrics", { lyricIndex: -1 });
    // The server looks the line up: a phone can't send its own text.
    invalid("pushAdhocLyrics", { lyric: "la", lyricIndex: 0 });
  });
});

describe("lookups", () => {
  test("a YouTube lookup that YouTube refuses is a result, not an error", async () => {
    const api = makeApi();
    assert.deepEqual(await api.youtubeInfo({ videoId: "x" }, alice), {
      ok: false,
      reason: "Bot check",
    });
  });

  test("a failed Niconico lookup is a result, not an error", async () => {
    const api = makeApi();
    const result = await api.nicoInfo({ videoId: "sm9" }, alice);
    assert.equal(result.ok, false);
  });
});
