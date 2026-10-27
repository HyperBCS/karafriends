// Runs on Node's test runner through tsx (yarn test:unit). DAM, Joysound,
// YouTube and the downloads are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashAdminPassword } from "../common/adminPassword";
import type { QueueItem } from "../common/api";
import { createAdminSessions, type AdminSessions } from "./adminAuth";
import { ApiError, type ApiDeps, type Caller, createApi } from "./api";
import type { HubMessage } from "./live";
import { damPageWindow, nextOffset } from "./paging";
import {
  adhocLyricsKey,
  createStateStore,
  failDownload,
  startDownload,
  type StateStore,
} from "./state";
import { validators } from "./validate";

const ADMIN_DEVICE = "admin-device";
// The admin's phone's nickname: taking it makes nobody an admin.
const ADMIN_NICK = "host";
const ADMIN_PASSWORD = "sing-it-loud";
const ADMIN_SALT = "0123456789abcdef0123456789abcdef";
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD, ADMIN_SALT);

const phone = (deviceId: string, nickname: string): Caller => ({
  deviceId,
  nickname,
  adminToken: null,
  isDisplay: false,
});
const anonymous: Caller = {
  deviceId: null,
  nickname: null,
  adminToken: null,
  isDisplay: false,
};
const display: Caller = { ...anonymous, isDisplay: true };
// The admin's phone, signed in (adminToken is a live session's).
const admin = (nickname: string): Caller => ({
  ...phone(ADMIN_DEVICE, nickname),
  adminToken,
});
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
let adminSessions: AdminSessions;
let adminToken: string;
let published: HubMessage[];
let downloads: string[];
let dkwebsysCalls: unknown[][];
let joysoundCalls: unknown[][];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-api-test-"));
  store = createStateStore(path.join(dir, "queue.json"));
  adminSessions = createAdminSessions(path.join(dir, "adminSessions.json"));
  adminToken = adminSessions.create();
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
      adminPasswordHash: ADMIN_HASH,
      adminPasswordSalt: ADMIN_SALT,
      paxSongQueueLimit: 0,
      supervisedMode: false,
      useLowBitrateUrl: false,
      ...config,
    },
    store,
    adminSessions,
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
  test("whoami: the display and the phones signed in as admins", async () => {
    const api = makeApi();
    assert.deepEqual(await api.whoami({}, display), { isAdmin: true });
    assert.deepEqual(await api.whoami({}, admin("x")), {
      isAdmin: true,
    });
    // Not by nickname, nor by device: only the token counts.
    assert.deepEqual(await api.whoami({}, phone("x", ADMIN_NICK)), {
      isAdmin: false,
    });
    assert.deepEqual(await api.whoami({}, phone(ADMIN_DEVICE, ADMIN_NICK)), {
      isAdmin: false,
    });
    assert.deepEqual(
      await api.whoami({}, { ...alice, adminToken: "f".repeat(64) }),
      { isAdmin: false },
    );
    assert.deepEqual(await api.whoami({}, alice), { isAdmin: false });
    assert.deepEqual(await api.whoami({}, anonymous), { isAdmin: false });
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
      const api = makeApi({ supervisedMode: true });
      const remove = (n: number, caller: Caller) =>
        api.removeSong({ songId: `sm${n}`, timestamp: String(n) }, caller);

      await rejectsWith(remove(2, bob), 403);
      await rejectsWith(remove(2, anonymous), 403);
      assert.equal(store.getState().songQueue.length, 2);

      // By device ID, as isMine says, whatever the nickname. Every phone
      // sees the nickname, so it proves nothing.
      await rejectsWith(remove(3, phone("other-device", "alice")), 403);
      await rejectsWith(remove(3, phone("other-device", ADMIN_NICK)), 403);
      assert.equal(await remove(2, phone("alice-device", "someone")), true);
      assert.equal(await remove(3, alice), true);

      store.update((state) => state.songQueue.push(song(4, alice)));
      assert.equal(await remove(4, admin("x")), true);
      store.update((state) => state.songQueue.push(song(5, alice)));
      assert.equal(await remove(5, display), true);

      // Already gone: not an error.
      assert.equal(await remove(5, bob), false);
    });

    test("only the current singer or an admin may control playback", async () => {
      const api = makeApi({ supervisedMode: true });

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
        await api.setPlaybackState({ playbackState: "SKIPPING" }, admin("x")),
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
    const api = makeApi();
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
    await queue(admin("host phone"), 4);
    // Not by nickname.
    await queue(phone("other-device", ADMIN_NICK), 5);
    assert.deepEqual(
      store.getState().songQueue.map((item) => item.songId),
      ["sm1", "sm4", "sm2", "sm3", "sm5"],
    );
  });
});

describe("moveSong", () => {
  beforeEach(() => {
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.songQueue.push(song(2, alice), song(3, bob), song(4, bob));
    });
  });

  const move = (
    api: ReturnType<typeof makeApi>,
    n: number,
    toIndex: number,
    caller: Caller = admin("x"),
  ) =>
    api.moveSong({ songId: `sm${n}`, timestamp: String(n), toIndex }, caller);
  const order = () => store.getState().songQueue.map((item) => item.songId);

  test("moves a song to the top, down, or past the end to the end", async () => {
    const api = makeApi();
    let changes = 0;
    store.onChange(() => changes++);

    assert.deepEqual(await move(api, 4, 0), { ok: true });
    assert.deepEqual(order(), ["sm4", "sm2", "sm3"]);
    assert.equal(changes, 1);
    // Saved to queue.json too. (A restart queues the current song first.)
    assert.deepEqual(
      createStateStore(path.join(dir, "queue.json"))
        .getState()
        .songQueue.map((item) => item.songId),
      ["sm1", "sm4", "sm2", "sm3"],
    );

    assert.deepEqual(await move(api, 4, 1), { ok: true });
    assert.deepEqual(order(), ["sm2", "sm4", "sm3"]);
    assert.deepEqual(await move(api, 2, 99), { ok: true });
    assert.deepEqual(order(), ["sm4", "sm3", "sm2"]);
    // Onto its own place: nothing moves.
    assert.deepEqual(await move(api, 3, 1), { ok: true });
    assert.deepEqual(order(), ["sm4", "sm3", "sm2"]);
  });

  test("a song not in the queue is not an error", async () => {
    const api = makeApi();
    // The current song, and one that was never queued.
    assert.deepEqual(await move(api, 1, 0), { ok: false });
    assert.deepEqual(await move(api, 9, 0), { ok: false });
    assert.deepEqual(order(), ["sm2", "sm3", "sm4"]);
  });

  test("only an admin may move a song, in supervised mode or not", async () => {
    for (const supervisedMode of [false, true]) {
      const api = makeApi({ supervisedMode });
      // Not even its owner.
      await rejectsWith(move(api, 4, 0, bob), 403);
      await rejectsWith(move(api, 4, 0, phone(ADMIN_DEVICE, ADMIN_NICK)), 403);
      await rejectsWith(move(api, 4, 0, anonymous), 403);
      assert.deepEqual(order(), ["sm2", "sm3", "sm4"]);
    }
    const api = makeApi({ supervisedMode: true });
    assert.deepEqual(await move(api, 4, 0, display), { ok: true });
    assert.deepEqual(order(), ["sm4", "sm2", "sm3"]);
  });
});

describe("admin sign-in", () => {
  test("the right password gives a token that makes the phone an admin", async () => {
    const api = makeApi({ supervisedMode: true });
    const { token } = await api.adminLogin({ password: ADMIN_PASSWORD }, bob);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, adminToken);
    const signedIn = { ...bob, adminToken: token };
    assert.deepEqual(await api.whoami({}, signedIn), { isAdmin: true });
    // On any device, under any nickname: the token is the admin.
    assert.deepEqual(
      await api.whoami(
        {},
        { ...phone("other-device", "x"), adminToken: token },
      ),
      { isAdmin: true },
    );
    assert.equal(
      await api.setPlaybackState({ playbackState: "PAUSED" }, signedIn),
      true,
    );
  });

  test("a wrong password, or none set, is refused", async () => {
    const api = makeApi();
    for (const password of ["Sing-it-loud", "sing-it-loud ", "x"]) {
      await rejectsWith(api.adminLogin({ password }, bob), 403);
    }
    await rejectsWith(
      makeApi({ adminPasswordHash: "" }).adminLogin(
        { password: ADMIN_PASSWORD },
        bob,
      ),
      403,
    );
    // A hash that isn't one.
    await rejectsWith(
      makeApi({ adminPasswordHash: "not hex" }).adminLogin(
        { password: ADMIN_PASSWORD },
        bob,
      ),
      403,
    );
  });

  test("the display doesn't sign in", async () => {
    await rejectsWith(
      makeApi().adminLogin({ password: ADMIN_PASSWORD }, display),
      400,
    );
  });

  test("adminLogout ends that phone's session only", async () => {
    const api = makeApi();
    const { token } = await api.adminLogin({ password: ADMIN_PASSWORD }, bob);
    const signedIn = { ...bob, adminToken: token };
    assert.deepEqual(await api.adminLogout({}, signedIn), {});
    assert.deepEqual(await api.whoami({}, signedIn), { isAdmin: false });
    assert.deepEqual(await api.whoami({}, admin("x")), { isAdmin: true });
    // Signed out already, or never signed in: nothing to do.
    assert.deepEqual(await api.adminLogout({}, signedIn), {});
    assert.deepEqual(await api.adminLogout({}, alice), {});
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

  describe("a YouTube song's adhoc lyrics", () => {
    const VIDEO = "jNQXAC9IVRw";
    // Downloads that finish when the test says.
    let finishDownloads: (() => void)[];
    let clock: number;
    const api = (config: Partial<ApiDeps["config"]> = {}) =>
      makeApi(config, {
        downloads: {
          youtube: (_item, _captions, onReady) => finishDownloads.push(onReady),
        } as ApiDeps["downloads"],
        now: () => ++clock,
      });
    const queue = (
      handlers: ReturnType<typeof makeApi>,
      caller: Caller,
      adhocLyrics: string | null,
    ) =>
      handlers.queueSong(
        {
          kind: "youtube",
          songId: VIDEO,
          name: "Me at the zoo",
          artistName: "",
          adhocLyrics,
          captionCode: null,
          gainValue: 1,
        },
        caller,
      );
    const stored = () => store.getState().idToAdhocLyrics;

    beforeEach(() => {
      finishDownloads = [];
      clock = 0;
    });

    test("are kept once the song is queued, not before", async () => {
      const handlers = api();
      await queue(handlers, alice, "la");
      // Downloading, or failed: nothing kept.
      assert.deepEqual(stored(), {});
      assert.equal(await handlers.adhocLyrics({ songId: VIDEO }, bob), null);

      finishDownloads[0]();
      const [item] = store.getState().songQueue;
      assert.deepEqual(stored(), { [adhocLyricsKey(item)]: ["la"] });
    });

    test("are each queueing's own, and go with it", async () => {
      const handlers = api();
      await queue(handlers, alice, "alice's line");
      await queue(handlers, bob, "bob's line");
      await queue(handlers, bob, null);
      finishDownloads.forEach((finish) => finish());
      const [alices, bobs, plain] = store.getState().songQueue;
      assert.equal(plain.kind === "youtube" && plain.hasAdhocLyrics, false);
      assert.equal(Object.keys(stored()).length, 2);
      // The first queued, until it plays.
      assert.deepEqual(await handlers.adhocLyrics({ songId: VIDEO }, bob), [
        "alice's line",
      ]);

      // Taken off the queue: its lyrics go.
      assert.equal(
        await handlers.removeSong(
          { songId: VIDEO, timestamp: alices.timestamp },
          alice,
        ),
        true,
      );
      assert.deepEqual(stored(), { [adhocLyricsKey(bobs)]: ["bob's line"] });

      // Played: they go when the next song starts.
      await handlers.popSong({}, display);
      assert.deepEqual(await handlers.adhocLyrics({ songId: VIDEO }, bob), [
        "bob's line",
      ]);
      assert.equal(
        await handlers.pushAdhocLyrics({ lyricIndex: 0 }, bob),
        true,
      );
      assert.deepEqual(store.getState().currentSongAdhocLyrics, [
        { lyric: "bob's line", lyricIndex: 0 },
      ]);
      await handlers.popSong({}, display);
      assert.deepEqual(stored(), {});
    });

    test("stop at a million characters in all", async () => {
      const handlers = api();
      const big = "x".repeat(100_000);
      for (let i = 0; i < 9; i++) {
        assert.equal((await queue(handlers, alice, big)).ok, true);
        finishDownloads[i]();
      }
      // Two more that fit now, but not together.
      assert.equal((await queue(handlers, bob, "y".repeat(60_000))).ok, true);
      assert.equal((await queue(handlers, bob, "z".repeat(60_000))).ok, true);
      assert.deepEqual(await queue(handlers, bob, big + "!"), {
        ok: false,
        reason:
          "The queue holds too many lyrics already. Try again after a few songs, or without lyrics.",
      });
      finishDownloads[9]();
      finishDownloads[10]();
      // The second is queued without its lyrics.
      const queued = store.getState().songQueue;
      assert.equal(queued.length, 11);
      assert.deepEqual(
        queued
          .slice(9)
          .map((item) => item.kind === "youtube" && item.hasAdhocLyrics),
        [true, false],
      );
      assert.equal(Object.keys(stored()).length, 10);
      // Without lyrics, it still queues.
      assert.equal((await queue(handlers, bob, null)).ok, true);
    });
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
    const api = makeApi({ paxSongQueueLimit: 1 });
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
    const host = admin("host phone");
    assert.equal((await queue(host, 4)).ok, true);
    assert.equal((await queue(host, 5)).ok, true);
    // Not by nickname.
    const impostor = phone("impostor-device", ADMIN_NICK);
    assert.equal((await queue(impostor, 6)).ok, true);
    assert.equal((await queue(impostor, 7)).ok, false);
  });
});

describe("a failed download", () => {
  const queueVideo = (api: ReturnType<typeof makeApi>, caller: Caller) =>
    api.queueSong(
      {
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        name: "Me at the zoo",
        artistName: "jawed",
        adhocLyrics: "la",
        captionCode: null,
        gainValue: 1,
      },
      caller,
    );

  test("tells the phone that queued it, and queues nothing", async () => {
    const api = makeApi(
      {},
      {
        downloads: {
          youtube: (_item, _captions, _onReady, onFailed) =>
            onFailed("Video unavailable"),
        } as ApiDeps["downloads"],
      },
    );
    assert.equal((await queueVideo(api, alice)).ok, true);
    assert.deepEqual(store.getState().songQueue, []);
    assert.deepEqual(store.getState().idToAdhocLyrics, {});
    assert.equal(published.length, 1);
    const [message] = published;
    assert.equal(message.type, "queueFailed");
    assert.ok(message.type === "queueFailed");
    assert.equal(message.reason, "Video unavailable");
    assert.equal(message.item.songId, "jNQXAC9IVRw");
    assert.deepEqual(message.item.user, {
      deviceId: "alice-device",
      nickname: "alice",
    });
  });

  test("frees its place under the per-person limit at once", async () => {
    const api = makeApi(
      { paxSongQueueLimit: 1 },
      {
        downloads: {
          // Still downloading.
          youtube: () => {},
        } as unknown as ApiDeps["downloads"],
      },
    );
    const { downloadQueue } = store.getState();
    const download = startDownload(downloadQueue, {
      kind: "youtube",
      userIdentity: { deviceId: "alice-device", nickname: "alice" },
      songId: "jNQXAC9IVRw",
      suffix: null,
    });
    assert.equal((await queueVideo(api, alice)).ok, false);
    failDownload(downloadQueue, download, "Video unavailable");
    assert.equal((await queueVideo(api, alice)).ok, true);
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
      state.idToAdhocLyrics[adhocLyricsKey(lyricsSong)] = lyrics;
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
    const api = makeApi({ supervisedMode: true });
    play(["line one"]);
    for (const caller of [
      bob,
      phone("other-device", "alice"),
      phone("other-device", ADMIN_NICK),
      anonymous,
    ]) {
      await rejectsWith(api.pushAdhocLyrics({ lyricIndex: 0 }, caller), 403);
    }
    assert.deepEqual(shown(), []);
    for (const caller of [alice, admin("x"), display]) {
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
    // IDs become temp file names, so path characters are refused.
    invalid("queueSong", { ...nico, songId: "../evil" });
    invalid("queueSong", { ...nico, songId: "..\\evil" });
    invalid("queueSong", { ...nico, songId: "a/b" });
    invalid("queueSong", {
      ...nico,
      kind: "dam",
      songId: "1.2",
      streamingUrlIdx: 0,
    });
    invalid("queueSong", {
      ...nico,
      kind: "joysound",
      songId: "123",
      isRomaji: false,
      youtubeVideoId: "../x",
    });
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
    assert.deepEqual(validators.adminLogin({ password: "パスワード" }), {
      password: "パスワード",
    });
    assert.deepEqual(validators.adminLogin({ password: "x".repeat(200) }), {
      password: "x".repeat(200),
    });
    invalid("adminLogin", {});
    invalid("adminLogin", { password: "" });
    invalid("adminLogin", { password: "x".repeat(201) });
    invalid("adminLogin", { password: 1234 });
    invalid("adminLogin", { password: "x", token: "y" });
    assert.deepEqual(validators.adminLogout({}), {});
    invalid("adminLogout", { token: "y" });
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
    assert.deepEqual(
      validators.moveSong({ songId: "sm9", timestamp: "9", toIndex: 0 }),
      { songId: "sm9", timestamp: "9", toIndex: 0 },
    );
    invalid("moveSong", { songId: "sm9", timestamp: "9" });
    invalid("moveSong", { songId: "sm9", timestamp: "9", toIndex: -1 });
    invalid("moveSong", { songId: "sm9", timestamp: "9", toIndex: 1.5 });
    invalid("moveSong", { songId: "sm9", timestamp: "9", toIndex: "0" });
    invalid("moveSong", { songId: 9, timestamp: "9", toIndex: 0 });
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
