// Runs on Node's test runner through tsx (yarn test:unit). DAM, Joysound,
// YouTube and the downloads are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashAdminPassword } from "../common/adminPassword";
import type { PlaybackCommand, QueueItem } from "../common/api";
import { songKey } from "../common/currentSong";
import { REASONS } from "../common/downloadFailure";
import { createAdminSessions, type AdminSessions } from "./adminAuth";
import { ApiError, type ApiDeps, type Caller, createApi } from "./api";
import { shareQueueItem, type HubMessage } from "./live";
import { damPageWindow, nextOffset } from "./paging";
import {
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
// The DAM downloads' playtimes and onFailed.
let damDownloads: {
  playtime: number | null;
  onFailed: (reason: string) => void;
}[];
// What clearDownloads kept, and the DAM videos clearDownload deleted.
let clearedInUse: unknown[][];
let clearedDam: [string, string][];
let dkwebsysCalls: unknown[][];
let joysoundCalls: unknown[][];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-api-test-"));
  store = createStateStore(path.join(dir, "queue.json"));
  adminSessions = createAdminSessions(path.join(dir, "adminSessions.json"));
  adminToken = adminSessions.create();
  published = [];
  downloads = [];
  damDownloads = [];
  clearedInUse = [];
  clearedDam = [];
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
      everyoneIsAdmin: false,
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
      dam: (
        url: string,
        _songId: string,
        _suffix: string,
        playtime: number | null,
        onFailed: (reason: string) => void,
      ) => {
        downloads.push(url);
        damDownloads.push({ playtime, onFailed });
      },
      info: () => ({ files: 3, bytes: 3000 }),
      clear: (inUse: unknown[]) => {
        clearedInUse.push(inUse);
        return { deleted: 2, bytes: 2000, kept: inUse.length };
      },
      clearDam: (songId: string, suffix: string) => {
        clearedDam.push([songId, suffix]);
        return true;
      },
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
      state.playbackState = "PLAYING";
    });
    assert.equal(
      await api.removeSong({ songId: "sm2", timestamp: "2" }, bob),
      true,
    );
    assert.equal(
      await api.setPlaybackState(
        { playbackState: "PAUSED", song: "sm1@1" },
        bob,
      ),
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
        api.setPlaybackState({ playbackState: "PAUSED", song: "sm1@1" }, bob),
        403,
      );
      await rejectsWith(
        api.setPitchShiftSemis({ semis: 2, song: "sm1@1" }, bob),
        403,
      );
      // The singer's or an admin's nickname, from another phone.
      for (const nickname of ["alice", ADMIN_NICK]) {
        await rejectsWith(
          api.setPlaybackState(
            { playbackState: "SKIPPING", song: "sm1@1" },
            phone("other-device", nickname),
          ),
          403,
        );
      }
      assert.equal(store.getState().playbackState, "PLAYING");
      assert.equal(store.getState().pitchShiftSemis, 0);

      assert.equal(
        await api.setPlaybackState(
          { playbackState: "PAUSED", song: "sm1@1" },
          alice,
        ),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "SKIPPING", song: "sm1@1" },
          admin("x"),
        ),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "PLAYING", song: "sm1@1" },
          display,
        ),
        true,
      );
      assert.equal(
        await api.setPitchShiftSemis({ semis: -1, song: "sm1@1" }, alice),
        true,
      );
      assert.equal(store.getState().pitchShiftSemis, -1);
    });
  });

  describe("while everyone is an admin", () => {
    beforeEach(() => {
      store.update((state) => {
        state.currentSong = song(1, alice);
        state.songQueue.push(song(2, alice), song(3, alice));
        state.playbackState = "PLAYING";
      });
    });

    test("a phone with no token may do what an admin does, even supervised", async () => {
      const api = makeApi({ supervisedMode: true, everyoneIsAdmin: true });
      assert.deepEqual(await api.whoami({}, bob), { isAdmin: true });
      assert.deepEqual(
        await api.moveSong({ songId: "sm3", timestamp: "3", toIndex: 0 }, bob),
        { ok: true },
      );
      assert.deepEqual(
        store.getState().songQueue.map((item) => item.songId),
        ["sm3", "sm2"],
      );
      assert.equal(
        await api.removeSong({ songId: "sm2", timestamp: "2" }, bob),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "PAUSED", song: "sm1@1" },
          bob,
        ),
        true,
      );
      assert.equal(store.getState().playbackState, "PAUSED");
      assert.equal(
        await api.setPitchShiftSemis({ semis: 2, song: "sm1@1" }, bob),
        true,
      );
      assert.equal(store.getState().pitchShiftSemis, 2);
    });

    test("the display's own methods stay the display's", async () => {
      const api = makeApi({ everyoneIsAdmin: true });
      await rejectsWith(api.popSong({}, bob), 403);
      assert.equal(store.getState().currentSong?.songId, "sm1");
    });
  });

  test("only the display may start the next song", async () => {
    const api = makeApi();
    store.update((state) => state.songQueue.push(song(1, alice)));
    await rejectsWith(api.popSong({}, alice), 403);
    // Not an admin's phone: the song would never play.
    await rejectsWith(api.popSong({}, admin("host")), 403);
    assert.equal(store.getState().songQueue.length, 1);

    const popped = await api.popSong({}, display);
    assert.equal(popped?.songId, "sm1");
    assert.equal(store.getState().currentSong?.songId, "sm1");
    assert.deepEqual(store.getState().songHistory, [{ song: song(1, alice) }]);
    assert.equal(await api.popSong({}, display), null);
  });

  describe("a reloaded display (popSong with resume)", () => {
    let clock: number;
    const api = () => makeApi({}, { now: () => clock });
    beforeEach(() => {
      clock = 1000;
      store.update((state) =>
        state.songQueue.push(song(1, alice), song(2, bob)),
      );
    });

    test("gets the current song back, from the start, once", async () => {
      const handlers = api();
      await handlers.popSong({}, display);
      await handlers.setPlaybackState(
        { playbackState: "PLAYING", song: "sm1@1" },
        display,
      );
      await handlers.reportSongPosition(
        {
          songId: "sm1",
          timestamp: "1",
          position: 0,
          length: 100,
          playing: true,
        },
        display,
      );
      clock = 30_000;
      await handlers.setPlaybackState(
        { playbackState: "PAUSED", song: "sm1@1" },
        alice,
      );
      assert.equal(store.getState().currentSongStartedAt, 1000);

      const resumed = await handlers.popSong({ resume: true }, display);
      assert.equal(resumed?.songId, "sm1");
      const state = store.getState();
      assert.equal(state.currentSong?.songId, "sm1");
      assert.deepEqual(
        state.songQueue.map((item) => item.songId),
        ["sm2"],
      );
      // Not twice in the history.
      assert.deepEqual(
        state.songHistory.map((entry) => entry.song.songId),
        ["sm1"],
      );
      // Its clock starts again with the display's first report.
      assert.deepEqual(
        [
          state.currentSongStartedAt,
          state.currentSongPausedSince,
          state.currentSongLength,
        ],
        [null, null, null],
      );

      // Reloaded again (the song crashes the display, say): it moves on.
      assert.equal(
        (await handlers.popSong({ resume: true }, display))?.songId,
        "sm2",
      );
      assert.equal(store.getState().currentSong?.songId, "sm2");
      // sm2 may still come back once.
      assert.equal(
        (await handlers.popSong({ resume: true }, display))?.songId,
        "sm2",
      );
    });

    test("takes the next song when none is current", async () => {
      assert.equal(
        (await api().popSong({ resume: true }, display))?.songId,
        "sm1",
      );
      assert.deepEqual(
        store.getState().songQueue.map((item) => item.songId),
        ["sm2"],
      );
    });

    test("takes the next song when the current one was being skipped", async () => {
      const handlers = api();
      await handlers.popSong({}, display);
      await handlers.setPlaybackState(
        { playbackState: "PLAYING", song: "sm1@1" },
        display,
      );
      await handlers.setPlaybackState(
        { playbackState: "SKIPPING", song: "sm1@1" },
        alice,
      );
      assert.equal(
        (await handlers.popSong({ resume: true }, display))?.songId,
        "sm2",
      );
    });

    test("keeps the song's lines pushed so far", async () => {
      const handlers = api();
      await handlers.popSong({}, display);
      store.update((state) => {
        state.currentSongAdhocLyrics = [{ lyric: "la", lyricIndex: 0 }];
      });
      await handlers.popSong({ resume: true }, display);
      assert.deepEqual(store.getState().currentSongAdhocLyrics, [
        { lyric: "la", lyricIndex: 0 },
      ]);
    });

    test("is still the display's alone", async () => {
      const handlers = makeApi({ everyoneIsAdmin: true });
      await handlers.popSong({}, display);
      await rejectsWith(handlers.popSong({ resume: true }, bob), 403);
      assert.equal(store.getState().currentSong?.songId, "sm1");
    });
  });

  describe("the current song's timing", () => {
    let clock: number;
    const timing = () => {
      const state = store.getState();
      return [state.currentSongStartedAt, state.currentSongPausedSince];
    };
    const api = () => makeApi({}, { now: () => clock });
    const play = (playbackState: PlaybackCommand, song = "sm1@1") =>
      api().setPlaybackState({ playbackState, song }, display);
    // Where song 1's video is: position seconds in, moving or not.
    const report = (
      position: number,
      playing = true,
      length: number | null = null,
      timestamp = "1",
    ) =>
      api().reportSongPosition(
        { songId: "sm1", timestamp, position, length, playing },
        display,
      );
    // Seconds played at the clock, as the phones work it out.
    const played = () => {
      const [startedAt, pausedSince] = timing() as [number, number | null];
      return ((pausedSince ?? clock) - startedAt) / 1000;
    };

    // Song 1 is popped at 0, and its video starts playing at 1000.
    beforeEach(async () => {
      clock = 0;
      store.update((state) => state.songQueue.push(song(1, alice)));
      await api().popSong({}, display);
      clock = 1000;
      await play("PLAYING");
      await report(0);
    });

    test("starts with the display's first report, not at popSong or PLAYING", async () => {
      store.update((state) => state.songQueue.push(song(2, alice)));
      clock = 2000;
      await api().popSong({}, display);
      // popSong may wait for DAM, and the display has yet to load the song.
      assert.deepEqual(timing(), [null, null]);
      clock = 2500;
      assert.equal(await play("PLAYING", "sm2@2"), true);
      assert.deepEqual(timing(), [null, null]);
      // Its video has loaded (loadedmetadata), and then plays.
      const report2 = (position: number, playing: boolean) =>
        api().reportSongPosition(
          { songId: "sm2", timestamp: "2", position, length: 99.6, playing },
          display,
        );
      clock = 3000;
      assert.equal(await report2(0, false), true);
      assert.deepEqual(timing(), [3000, 3000]);
      assert.equal(store.getState().currentSongLength, 100);
      clock = 3100;
      await report2(0, true);
      assert.deepEqual(timing(), [3100, null]);
    });

    test("setPlaybackState leaves it to the video's reports", async () => {
      clock = 5000;
      await play("PAUSED");
      assert.deepEqual(timing(), [1000, null]);
      // The video's 'pause', a moment later.
      await report(4, false);
      assert.deepEqual(timing(), [1000, 5000]);
      clock = 8000;
      await play("PLAYING");
      await report(4, true);
      assert.deepEqual(timing(), [4000, null]);
      // A restart: the video's 'seeked' at 0.
      clock = 9000;
      await play("RESTARTING");
      assert.deepEqual(timing(), [4000, null]);
      await report(0, true);
      assert.deepEqual(timing(), [9000, null]);
    });

    test("a skip leaves it, and the next popSong starts over", async () => {
      clock = 5000;
      await report(4, false);
      await play("SKIPPING");
      assert.deepEqual(timing(), [1000, 5000]);
      store.update((state) => state.songQueue.push(song(2, alice)));
      clock = 6000;
      await api().popSong({}, display);
      assert.deepEqual(timing(), [null, null]);
    });

    test("is empty while no song plays", async () => {
      await api().popSong({}, display);
      assert.deepEqual(timing(), [null, null]);
      assert.equal(await report(0), false);
      assert.deepEqual(timing(), [null, null]);
    });

    describe("from the display's reports", () => {
      test("follows a seek, paused or not", async () => {
        clock = 11_000;
        assert.equal(played(), 10);
        // Sought forward to 40 s.
        assert.equal(await report(40), true);
        assert.deepEqual(timing(), [11_000 - 40_000, null]);
        clock = 13_000;
        assert.equal(played(), 42);
        // Back to 5 s while paused: it stays there.
        await report(5, false);
        clock = 60_000;
        assert.equal(played(), 5);
        await report(5, true);
        clock = 61_000;
        assert.equal(played(), 6);
      });

      test("stops during a stall or the video's own pause, and goes on after", async () => {
        clock = 11_000;
        await report(10, false);
        clock = 20_000;
        assert.equal(played(), 10);
        assert.equal(store.getState().playbackState, "PLAYING");
        await report(10.5, true);
        clock = 21_000;
        assert.equal(played(), 11.5);
      });

      test("a report in step with the clock changes nothing", async () => {
        let changes = 0;
        store.onChange(() => changes++);
        clock = 11_000;
        await report(10.3);
        await report(9.7);
        assert.deepEqual(timing(), [1000, null]);
        assert.equal(changes, 0);
        // A second off is a change.
        await report(11);
        assert.equal(changes, 1);
      });

      test("keeps the video's length, in whole seconds, until the next song", async () => {
        clock = 11_000;
        await report(10, true, 59.6);
        assert.equal(store.getState().currentSongLength, 60);
        // Not known: as it was.
        await report(10, true, null);
        assert.equal(store.getState().currentSongLength, 60);
        // Queued now, it waits for the 50 s left of the 60, not of the 100
        // the song was queued with.
        assert.deepEqual(
          await api().queueSong(
            { kind: "nico", songId: "sm9", name: "", artistName: "" },
            bob,
          ),
          { ok: true, eta: 50 },
        );
        await api().popSong({}, display);
        assert.equal(store.getState().currentSongLength, null);
      });

      test("ignores the song before's, and anyone but the display", async () => {
        clock = 11_000;
        assert.equal(await report(40, true, 60, "0"), false);
        assert.deepEqual(timing(), [1000, null]);
        assert.equal(store.getState().currentSongLength, null);
        await rejectsWith(
          api().reportSongPosition(
            {
              songId: "sm1",
              timestamp: "1",
              position: 40,
              length: null,
              playing: true,
            },
            admin(ADMIN_NICK),
          ),
          403,
        );
        assert.deepEqual(timing(), [1000, null]);
      });
    });
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

    test("comes with both streaming URLs of each vocal type and scoring data", async () => {
      const api = makeApi();
      store.update((state) => state.songQueue.push(damSong));
      assert.deepEqual(await api.popSong({}, display), {
        ...damSong,
        streamingUrls: [
          { high: "https://dam/high0", low: "low0" },
          { high: "https://dam/high1", low: "low1" },
        ],
        startWithLowBitrate: false,
        scoringData: [1, 2, 3],
      });
    });

    test("comes with them again for a reloaded display", async () => {
      const api = makeApi();
      store.update((state) => state.songQueue.push(damSong));
      const popped = await api.popSong({}, display);
      assert.deepEqual(await api.popSong({ resume: true }, display), popped);
    });

    test("says to start low when config.yaml asks for the low bitrate", async () => {
      const api = makeApi({ useLowBitrateUrl: true });
      store.update((state) => state.songQueue.push(damSong));
      const popped = await api.popSong({}, display);
      assert.ok(popped?.kind === "dam");
      assert.equal(popped.startWithLowBitrate, true);
      // Both still come.
      assert.deepEqual(popped.streamingUrls[0], {
        high: "https://dam/high0",
        low: "low0",
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
          startWithLowBitrate: false,
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

describe("setGuideMelodyLevel", () => {
  test("only an admin may set it, in supervised mode or not", async () => {
    for (const supervisedMode of [false, true]) {
      const api = makeApi({ supervisedMode });
      await rejectsWith(api.setGuideMelodyLevel({ level: 1 }, bob), 403);
      await rejectsWith(
        api.setGuideMelodyLevel({ level: 1 }, phone(ADMIN_DEVICE, ADMIN_NICK)),
        403,
      );
      await rejectsWith(api.setGuideMelodyLevel({ level: 1 }, anonymous), 403);
      assert.equal(store.getState().guideMelodyLevel, 0);
    }
    const api = makeApi({ supervisedMode: true });
    assert.equal(
      await api.setGuideMelodyLevel({ level: 0.7 }, admin("x")),
      true,
    );
    assert.equal(store.getState().guideMelodyLevel, 0.7);
    assert.equal(await api.setGuideMelodyLevel({ level: 0 }, display), true);
    assert.equal(store.getState().guideMelodyLevel, 0);
    // Saved to queue.json, unlike the pitch.
    assert.equal(
      await api.setGuideMelodyLevel({ level: 0.4 }, admin("x")),
      true,
    );
    assert.equal(
      createStateStore(path.join(dir, "queue.json")).getState()
        .guideMelodyLevel,
      0.4,
    );
  });

  test("while everyone is an admin, any phone may set it", async () => {
    const api = makeApi({ supervisedMode: true, everyoneIsAdmin: true });
    assert.equal(await api.setGuideMelodyLevel({ level: 1 }, bob), true);
    assert.equal(store.getState().guideMelodyLevel, 1);
  });
});

describe("the song volume and the mics", () => {
  const mic = (n: number) => ({
    id: `Mic ${n} (Windows)#0`,
    label: `Mic ${n} (Windows), channel 1`,
    gain: 100,
    echo: 40,
  });

  test("only an admin may set the song volume", async () => {
    const api = makeApi({ supervisedMode: false });
    assert.equal(store.getState().songVolume, 100);
    await rejectsWith(api.setSongVolume({ volume: 50 }, bob), 403);
    await rejectsWith(
      api.setSongVolume({ volume: 50 }, phone(ADMIN_DEVICE, ADMIN_NICK)),
      403,
    );
    assert.equal(store.getState().songVolume, 100);
    assert.equal(await api.setSongVolume({ volume: 50 }, admin("x")), true);
    assert.equal(store.getState().songVolume, 50);
    assert.equal(await api.setSongVolume({ volume: 0 }, display), true);
    assert.equal(store.getState().songVolume, 0);
    const everyone = makeApi({ supervisedMode: false, everyoneIsAdmin: true });
    assert.equal(await everyone.setSongVolume({ volume: 80 }, bob), true);
    assert.equal(store.getState().songVolume, 80);
  });

  test("only the display lists its mics", async () => {
    const api = makeApi({ supervisedMode: false });
    await rejectsWith(api.setMics({ mics: [mic(1)] }, admin("x")), 403);
    await rejectsWith(api.setMics({ mics: [mic(1)] }, bob), 403);
    assert.deepEqual(store.getState().mics, []);
    assert.equal(await api.setMics({ mics: [mic(1), mic(2)] }, display), true);
    assert.deepEqual(store.getState().mics, [mic(1), mic(2)]);
    assert.equal(await api.setMics({ mics: [mic(2)] }, display), true);
    assert.deepEqual(store.getState().mics, [mic(2)]);
  });

  test("an admin sets one mic's levels; an unknown mic is false", async () => {
    const api = makeApi({ supervisedMode: false });
    await api.setMics({ mics: [mic(1), mic(2)] }, display);
    await rejectsWith(api.setMicLevels({ id: mic(1).id, gain: 0 }, bob), 403);
    assert.equal(
      await api.setMicLevels({ id: mic(1).id, gain: 150 }, admin("x")),
      true,
    );
    assert.equal(
      await api.setMicLevels({ id: mic(2).id, echo: 0 }, display),
      true,
    );
    assert.deepEqual(store.getState().mics, [
      { ...mic(1), gain: 150 },
      { ...mic(2), echo: 0 },
    ]);
    assert.equal(
      await api.setMicLevels({ id: "Gone (Windows)#0", gain: 10 }, admin("x")),
      false,
    );
    assert.deepEqual(store.getState().mics, [
      { ...mic(1), gain: 150 },
      { ...mic(2), echo: 0 },
    ]);
  });
});

describe("the downloads folder", () => {
  test("is the display's only", async () => {
    const api = makeApi();
    for (const caller of [bob, admin("x")]) {
      await rejectsWith(api.downloadsInfo({}, caller), 403);
      await rejectsWith(api.clearDownloads({}, caller), 403);
      await rejectsWith(
        api.clearDownload({ songId: "1234-56", suffix: "0" }, caller),
        403,
      );
    }
    assert.deepEqual(clearedInUse, []);
    assert.deepEqual(clearedDam, []);
    assert.deepEqual(await api.downloadsInfo({}, display), {
      files: 3,
      bytes: 3000,
    });
  });

  test("clearing keeps the files of the current song, the queue and the running downloads", async () => {
    const api = makeApi();
    store.update((state) => {
      state.currentSong = {
        ...song(1, alice),
        kind: "dam",
        songId: "1234-56",
        streamingUrlIdx: 2,
      } as QueueItem;
      // Queued, not playing: its files stay too, or it would be skipped.
      state.songQueue.push(song(2, alice));
      startDownload(state.downloadQueue, {
        kind: "joysound",
        songId: "777",
        suffix: "bg",
        userIdentity: { deviceId: "alice-device", nickname: "alice" },
      });
      const failed = startDownload(state.downloadQueue, {
        kind: "youtube",
        songId: "gone",
        suffix: null,
        userIdentity: { deviceId: "bob-device", nickname: "bob" },
      });
      failDownload(state.downloadQueue, failed, "Video unavailable");
    });
    assert.deepEqual(await api.clearDownloads({}, display), {
      deleted: 2,
      bytes: 2000,
      kept: 3,
    });
    assert.deepEqual(clearedInUse, [
      [
        { kind: "joysound", songId: "777", suffix: "bg" },
        { kind: "dam", songId: "1234-56", suffix: "2" },
        { kind: "nico", songId: "sm2", suffix: null },
      ],
    ]);
  });

  test("clearDownload deletes one DAM video, by a safe name", async () => {
    const api = makeApi();
    assert.equal(
      await api.clearDownload({ songId: "1234-56", suffix: "0" }, display),
      true,
    );
    assert.deepEqual(clearedDam, [["1234-56", "0"]]);
    await rejectsWith(
      api.clearDownload({ songId: "../queue", suffix: "0" }, display),
      400,
    );
    await rejectsWith(
      api.clearDownload({ songId: "1234-56", suffix: "0.mp4/.." }, display),
      400,
    );
    assert.equal(clearedDam.length, 1);
  });
});

describe("commands for the current song", () => {
  // Song 1 is playing, song 2 is next.
  const start = async (api: ReturnType<typeof makeApi>) => {
    store.update((state) => state.songQueue.push(song(1, alice), song(2, bob)));
    await api.popSong({}, display);
    await api.setPlaybackState(
      { playbackState: "PLAYING", song: "sm1@1" },
      display,
    );
  };

  test("a skip meant for the song before doesn't skip the next one", async () => {
    const api = makeApi();
    await start(api);
    // Two guests tap Skip. The first one's ends song 1, and the display
    // starts song 2...
    assert.equal(
      await api.setPlaybackState(
        { playbackState: "SKIPPING", song: "sm1@1" },
        alice,
      ),
      true,
    );
    await api.popSong({}, display);
    await api.setPlaybackState(
      { playbackState: "PLAYING", song: "sm2@2" },
      display,
    );
    // ...before the second one's lands.
    assert.equal(
      await api.setPlaybackState(
        { playbackState: "SKIPPING", song: "sm1@1" },
        bob,
      ),
      false,
    );
    assert.equal(store.getState().playbackState, "PLAYING");
    // A late key tap, and the display's own command for the song before.
    assert.equal(
      await api.setPitchShiftSemis({ semis: 3, song: "sm1@1" }, alice),
      false,
    );
    assert.equal(
      await api.setPlaybackState(
        { playbackState: "PAUSED", song: "sm1@1" },
        display,
      ),
      false,
    );
    assert.equal(store.getState().pitchShiftSemis, 0);
    assert.equal(store.getState().playbackState, "PLAYING");
    // For song 2, they work.
    assert.equal(
      await api.setPitchShiftSemis({ semis: 3, song: "sm2@2" }, alice),
      true,
    );
    assert.equal(store.getState().pitchShiftSemis, 3);
  });

  test("with no song current, every command is dropped", async () => {
    const api = makeApi();
    await start(api);
    store.update((state) => state.songQueue.splice(0));
    // The queue ran dry.
    assert.equal(await api.popSong({}, display), null);
    assert.equal(store.getState().playbackState, "WAITING");
    for (const caller of [alice, display]) {
      for (const playbackState of ["PAUSED", "PLAYING", "SKIPPING"] as const) {
        assert.equal(
          await api.setPlaybackState({ playbackState, song: "sm1@1" }, caller),
          false,
        );
      }
    }
    assert.equal(
      await api.setPitchShiftSemis({ semis: 1, song: "sm1@1" }, alice),
      false,
    );
    assert.equal(store.getState().playbackState, "WAITING");
    assert.equal(store.getState().pitchShiftSemis, 0);
  });

  describe("while the display loads the next song", () => {
    // A DAM song whose streaming URLs take as long as the test says.
    let answerDam: (() => void) | null;
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
    const slowDam = () =>
      makeApi(
        {},
        {
          minsei: {
            getMusicStreamingUrls: () =>
              new Promise((resolve) => {
                answerDam = () => resolve({ list: [] });
              }),
            getScoringData: async () => new ArrayBuffer(0),
          },
        },
      );

    beforeEach(() => {
      answerDam = null;
    });

    test("phones see WAITING, and their commands wait for the display's PLAYING", async () => {
      const api = slowDam();
      await start(api);
      store.update((state) => state.songQueue.splice(0, 1, damSong));
      const popping = api.popSong({}, display);
      // The DAM song is current, but the display has yet to start it.
      const state = store.getState();
      assert.equal(state.currentSong?.songId, "1234-56");
      assert.equal(state.playbackState, "WAITING");
      for (const playbackState of [
        "SKIPPING",
        "RESTARTING",
        "PAUSED",
        "PLAYING",
      ] as const) {
        assert.equal(
          await api.setPlaybackState(
            { playbackState, song: "1234-56@7" },
            admin("x"),
          ),
          false,
        );
      }
      assert.equal(
        await api.setPitchShiftSemis({ semis: 2, song: "1234-56@7" }, alice),
        false,
      );
      assert.equal(store.getState().playbackState, "WAITING");

      answerDam!();
      assert.equal((await popping)?.songId, "1234-56");
      // The display resets the key and starts the song, and from then on
      // the phones' commands work.
      assert.equal(
        await api.setPitchShiftSemis({ semis: 0, song: "1234-56@7" }, display),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "PLAYING", song: "1234-56@7" },
          display,
        ),
        true,
      );
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "SKIPPING", song: "1234-56@7" },
          alice,
        ),
        true,
      );
      assert.equal(store.getState().playbackState, "SKIPPING");
    });

    test("a reloaded display's song waits too", async () => {
      const api = makeApi();
      await start(api);
      assert.equal(
        (await api.popSong({ resume: true }, display))?.songId,
        "sm1",
      );
      assert.equal(store.getState().playbackState, "WAITING");
      assert.equal(
        await api.setPlaybackState(
          { playbackState: "PAUSED", song: "sm1@1" },
          alice,
        ),
        false,
      );
    });
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
    // Alice's song, which supervised mode keeps from bob but not an admin.
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.playbackState = "PLAYING";
    });
    await rejectsWith(
      api.setPlaybackState({ playbackState: "PAUSED", song: "sm1@1" }, bob),
      403,
    );
    assert.equal(
      await api.setPlaybackState(
        { playbackState: "PAUSED", song: "sm1@1" },
        signedIn,
      ),
      true,
    );
  });

  test("a wrong password (403), or none set (409), is refused", async () => {
    const api = makeApi();
    for (const password of ["Sing-it-loud", "sing-it-loud ", "x"]) {
      await rejectsWith(api.adminLogin({ password }, bob), 403);
    }
    await rejectsWith(
      makeApi({ adminPasswordHash: "" }).adminLogin(
        { password: ADMIN_PASSWORD },
        bob,
      ),
      409,
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
    // With the playtime, to refuse a sample; which the phone then hears of.
    assert.equal(damDownloads[0].playtime, 200);
    damDownloads[0].onFailed(REASONS.damSample);
    assert.deepEqual(published.at(-1), {
      type: "queueFailed",
      item,
      reason: REASONS.damSample,
    });
    published.pop();

    const next = await api.queueSong(
      { kind: "nico", songId: "sm9", name: "", artistName: "" },
      bob,
    );
    assert.deepEqual(next, { ok: true, eta: 200 });
  });

  test("counts only what is left of the current song", async () => {
    // Song 1 (100 s) has played 30 s.
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.currentSongStartedAt = 30_000;
      state.songQueue.push(song(2, alice));
    });
    const api = makeApi({}, { now: () => 60_000 });
    assert.deepEqual(
      await api.queueSong(
        { kind: "nico", songId: "sm9", name: "", artistName: "" },
        bob,
      ),
      { ok: true, eta: 70 + 100 },
    );
  });

  test("an admin's song for the head of the queue waits for the current song and the next", async () => {
    // Song 1 (100 s) has played 30 s; four more wait.
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.currentSongStartedAt = 30_000;
      state.songQueue.push(song(2, alice), song(3, alice), song(4, alice));
    });
    const api = makeApi({}, { now: () => 60_000 });
    const result = await api.queueSong(
      {
        kind: "dam",
        songId: "1234-56",
        name: "",
        artistName: "",
        streamingUrlIdx: 0,
        tryHeadOfQueue: true,
      },
      admin("x"),
    );
    // It goes in second (after song 2).
    assert.equal(store.getState().songQueue[1].songId, "1234-56");
    assert.deepEqual(result, { ok: true, eta: 70 + 100 });
    // A guest's goes to the end, as before (the DAM song came with no
    // playtime).
    assert.deepEqual(
      await api.queueSong(
        {
          kind: "nico",
          songId: "sm9",
          name: "",
          artistName: "",
          tryHeadOfQueue: true,
        },
        bob,
      ),
      { ok: true, eta: 70 + 300 },
    );
  });

  test("passes a DAM song's readings on to the queue item", async () => {
    const api = makeApi();
    await api.queueSong(
      {
        kind: "dam",
        songId: "1234-56",
        name: "恋",
        nameYomi: "コイ",
        artistName: "星野源",
        artistNameYomi: "ホシノゲン",
        streamingUrlIdx: 0,
      },
      alice,
    );
    const [item] = store.getState().songQueue;
    assert.equal(item.nameYomi, "コイ");
    assert.equal(item.artistNameYomi, "ホシノゲン");
  });

  test("passes the queuer's readings mode on to the item, everyone sees it", async () => {
    const api = makeApi();
    await api.queueSong(
      {
        kind: "nico",
        songId: "sm9",
        name: "恋",
        artistName: "星野源",
        readingsMode: "romaji",
      },
      alice,
    );
    await api.queueSong(
      { kind: "nico", songId: "sm10", name: "x", artistName: "y" },
      bob,
    );
    const [romaji, written] = store.getState().songQueue;
    assert.equal(romaji.readingsMode, "romaji");
    assert.equal("readingsMode" in written, false);
    // In the live state too, for the display and the other phones.
    assert.equal(shareQueueItem(romaji, "bob-device").readingsMode, "romaji");
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
      assert.deepEqual(stored(), { [songKey(item)]: ["la"] });
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
      assert.deepEqual(stored(), { [songKey(bobs)]: ["bob's line"] });

      // Played: they go when the next song starts.
      await handlers.popSong({}, display);
      assert.deepEqual(await handlers.adhocLyrics({ songId: VIDEO }, bob), [
        "bob's line",
      ]);
      await handlers.setPlaybackState(
        { playbackState: "PLAYING", song: songKey(bobs) },
        display,
      );
      assert.equal(
        await handlers.pushAdhocLyrics(
          { lyricIndex: 0, song: songKey(bobs) },
          bob,
        ),
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
          lyricsMode: "kana",
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

  test("keeps the limit while everyone is an admin", async () => {
    const api = makeApi({ paxSongQueueLimit: 1, everyoneIsAdmin: true });
    const queue = (caller: Caller, n: number) =>
      api.queueSong(
        { kind: "nico", songId: `sm${n}`, name: "", artistName: "" },
        caller,
      );
    assert.equal((await queue(bob, 1)).ok, true);
    assert.deepEqual(await queue(bob, 2), {
      ok: false,
      reason: "bob already has 1 song(s) in the queue or downloading",
    });
    // A phone signed in with the password still has none.
    const host = admin("host phone");
    assert.equal((await queue(host, 3)).ok, true);
    assert.equal((await queue(host, 4)).ok, true);
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

  test("one already downloading for someone else is refused, not dropped", async () => {
    const asked: string[] = [];
    const api = makeApi(
      {},
      {
        downloads: {
          youtube: () => asked.push("youtube"),
          joysound: () => asked.push("joysound"),
        } as unknown as ApiDeps["downloads"],
      },
    );
    const { downloadQueue } = store.getState();
    startDownload(downloadQueue, {
      kind: "youtube",
      userIdentity: { deviceId: "alice-device", nickname: "alice" },
      songId: "jNQXAC9IVRw",
      suffix: null,
    });
    startDownload(downloadQueue, {
      kind: "joysound",
      userIdentity: { deviceId: "alice-device", nickname: "alice" },
      songId: "123456",
      suffix: "bgVideo0001",
    });
    const queueJoysound = (youtubeVideoId: string | null) =>
      api.queueSong(
        {
          kind: "joysound",
          songId: "123456",
          name: "j",
          artistName: "",
          playtime: 1,
          lyricsMode: "kana",
          youtubeVideoId,
        },
        bob,
      );
    const refused = {
      ok: false,
      reason: "Someone is already adding this song",
    };
    assert.deepEqual(await queueVideo(api, bob), refused);
    assert.deepEqual(await queueJoysound("bgVideo0001"), refused);
    // Another background is another download.
    assert.equal((await queueJoysound(null)).ok, true);
    assert.deepEqual(asked, ["joysound"]);
  });

  test("of YouTube or Niconico, because of yt-dlp, sets the tools problem until one works", async () => {
    // Each download fails with the next reason, or works once they run out.
    let reasons: string[] = [];
    const finish = (
      onReady: () => void,
      onFailed: (reason: string) => void,
    ) => {
      const reason = reasons.shift();
      if (reason) onFailed(reason);
      else onReady();
    };
    let clock = 100;
    const api = makeApi(
      {},
      {
        downloads: {
          youtube: (_item, _captions, onReady, onFailed) =>
            finish(onReady, onFailed),
          nico: (_item, onReady, onFailed) => finish(onReady, onFailed),
          joysound: (_item, _pushToHead, _onReady, onFailed) =>
            onFailed("YouTube blocked the download"),
        } as ApiDeps["downloads"],
        now: () => clock,
      },
    );
    const queueNico = () =>
      api.queueSong(
        { kind: "nico", songId: "sm9", name: "n", artistName: "", playtime: 1 },
        alice,
      );
    const problem = () => store.getState().toolsProblem;
    const PROBLEM = {
      message: "YouTube downloads are failing; try Update tools in Settings",
      since: 100,
    };

    // The video's fault: no problem.
    reasons = ["Video unavailable", "Private video"];
    await queueVideo(api, alice);
    await queueNico();
    assert.equal(problem(), null);

    // Joysound's YouTube background isn't counted.
    await api.queueSong(
      {
        kind: "joysound",
        songId: "123",
        name: "j",
        artistName: "",
        lyricsMode: "kana",
        youtubeVideoId: "jNQXAC9IVRw",
      },
      alice,
    );
    assert.equal(problem(), null);

    reasons = ["YouTube blocked the download", "Couldn't start the downloader"];
    await queueVideo(api, alice);
    assert.deepEqual(problem(), PROBLEM);
    // Still the first failure's time.
    clock = 200;
    await queueNico();
    assert.deepEqual(problem(), PROBLEM);

    // A Niconico download that works clears it; so does a YouTube one.
    await queueNico();
    assert.equal(problem(), null);
    reasons = ["Download failed"];
    await queueNico();
    assert.equal(problem()?.message, PROBLEM.message);
    await queueVideo(api, alice);
    assert.equal(problem(), null);
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

  const LYRICS_SONG = songKey(lyricsSong);
  // Alice's video, playing, with these lyrics.
  const play = (lyrics: string[]) =>
    store.update((state) => {
      state.currentSong = lyricsSong;
      state.idToAdhocLyrics[LYRICS_SONG] = lyrics;
      state.playbackState = "PLAYING";
    });
  const shown = () => store.getState().currentSongAdhocLyrics;

  test("shows the line the singer picks, from the song's own lyrics", async () => {
    const api = makeApi();
    play(["line one", "line two"]);
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 1, song: LYRICS_SONG }, alice),
      true,
    );
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice),
      true,
    );
    assert.deepEqual(shown(), [
      { lyric: "line two", lyricIndex: 1 },
      { lyric: "line one", lyricIndex: 0 },
    ]);
    // Only lines the song has.
    await rejectsWith(
      api.pushAdhocLyrics({ lyricIndex: 2, song: LYRICS_SONG }, alice),
      400,
    );
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
      await rejectsWith(
        api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, caller),
        403,
      );
    }
    assert.deepEqual(shown(), []);
    for (const caller of [alice, admin("x"), display]) {
      assert.equal(
        await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, caller),
        true,
      );
    }
    assert.equal(shown().length, 3);
  });

  test("without supervised mode, anyone may", async () => {
    const api = makeApi();
    play(["line one"]);
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, bob),
      true,
    );
  });

  test("does nothing unless a song with adhoc lyrics is playing", async () => {
    const api = makeApi();
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice),
      false,
    );
    store.update((state) => {
      state.currentSong = song(1, alice);
      state.playbackState = "PLAYING";
    });
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: "sm1@1" }, alice),
      false,
    );
    assert.deepEqual(shown(), []);
  });

  test("drops a line meant for the song before", async () => {
    const api = makeApi();
    play(["line one"]);
    // The same video, queued again with other lyrics, now playing.
    store.update((state) => {
      state.currentSong = { ...lyricsSong, timestamp: "6" };
      state.idToAdhocLyrics[`${VIDEO}@6`] = ["other line"];
    });
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice),
      false,
    );
    assert.deepEqual(shown(), []);
    assert.equal(
      await api.pushAdhocLyrics({ lyricIndex: 0, song: `${VIDEO}@6` }, alice),
      true,
    );
    assert.deepEqual(shown(), [{ lyric: "other line", lyricIndex: 0 }]);
  });

  test("stops at a few hundred lines, or 30,000 characters", async () => {
    const api = makeApi();
    play(["la", "x".repeat(10_000)]);
    for (let i = 0; i < 400; i++) {
      await api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice);
    }
    await rejectsWith(
      api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice),
      400,
    );
    assert.equal(shown().length, 400);

    store.update((state) => {
      state.currentSongAdhocLyrics = [];
    });
    for (let i = 0; i < 3; i++) {
      assert.equal(
        await api.pushAdhocLyrics({ lyricIndex: 1, song: LYRICS_SONG }, alice),
        true,
      );
    }
    // 30,000 characters: no more, however short.
    await rejectsWith(
      api.pushAdhocLyrics({ lyricIndex: 1, song: LYRICS_SONG }, alice),
      400,
    );
    await rejectsWith(
      api.pushAdhocLyrics({ lyricIndex: 0, song: LYRICS_SONG }, alice),
      400,
    );
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
        lyricsMode: "kana",
      }),
      {
        kind: "joysound",
        songId: "123",
        name: "Song",
        artistName: "Artist",
        playtime: 200,
        tryHeadOfQueue: undefined,
        lyricsMode: "kana",
        youtubeVideoId: null,
      },
    );
    for (const lyricsMode of ["romaji", "both"]) {
      const input = validators.queueSong({
        kind: "joysound",
        songId: "123",
        name: "Song",
        artistName: "Artist",
        lyricsMode,
        youtubeVideoId: null,
      });
      assert.equal(input.kind === "joysound" && input.lyricsMode, lyricsMode);
    }
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

  test("queueSong takes a song's readings if given, as strings", () => {
    const dam = {
      kind: "dam",
      songId: "1234-56",
      name: "恋",
      artistName: "星野源",
      streamingUrlIdx: 0,
    };
    assert.deepEqual(
      validators.queueSong({
        ...dam,
        nameYomi: "コイ",
        artistNameYomi: "ホシノゲン",
      }),
      {
        ...dam,
        nameYomi: "コイ",
        artistNameYomi: "ホシノゲン",
        playtime: null,
        tryHeadOfQueue: undefined,
      },
    );
    assert.equal("nameYomi" in validators.queueSong(dam), false);
    invalid("queueSong", { ...dam, nameYomi: 1 });
    invalid("queueSong", { ...dam, artistNameYomi: "ア".repeat(201) });
  });

  test("queueSong takes a readings mode if given, one of the three", () => {
    const nico = { kind: "nico", songId: "sm9", name: "x", artistName: "y" };
    for (const readingsMode of ["written", "kana", "romaji"]) {
      assert.equal(
        validators.queueSong({ ...nico, readingsMode }).readingsMode,
        readingsMode,
      );
    }
    assert.equal("readingsMode" in validators.queueSong(nico), false);
    invalid("queueSong", { ...nico, readingsMode: "both" });
    invalid("queueSong", { ...nico, readingsMode: null });
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
      lyricsMode: "kana",
      youtubeVideoId: "../x",
    });
    const joysound = { ...nico, kind: "joysound", songId: "123" };
    invalid("queueSong", { ...joysound });
    invalid("queueSong", { ...joysound, lyricsMode: "hiragana" });
    invalid("queueSong", { ...joysound, lyricsMode: true });
    // The field it replaced.
    invalid("queueSong", { ...joysound, isRomaji: true });
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
    assert.deepEqual(validators.popSong({}), {});
    assert.deepEqual(validators.popSong({ resume: true }), { resume: true });
    assert.deepEqual(validators.popSong({ resume: false }), { resume: false });
    invalid("popSong", { resume: "yes" });
    invalid("popSong", { next: true });
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
    assert.deepEqual(
      validators.setPlaybackState({ playbackState: "PAUSED", song: "sm1@1" }),
      { playbackState: "PAUSED", song: "sm1@1" },
    );
    invalid("setPlaybackState", { playbackState: "paused", song: "sm1@1" });
    // WAITING is the server's own.
    invalid("setPlaybackState", { playbackState: "WAITING", song: "sm1@1" });
    // Each names its song.
    invalid("setPlaybackState", { playbackState: "PAUSED" });
    invalid("setPlaybackState", { playbackState: "PAUSED", song: 1 });
    invalid("setPlaybackState", {
      playbackState: "PAUSED",
      song: "x".repeat(98),
    });
    assert.deepEqual(
      validators.setPitchShiftSemis({ semis: -2, song: "a@1" }),
      {
        semis: -2,
        song: "a@1",
      },
    );
    invalid("setPitchShiftSemis", { semis: 99, song: "sm1@1" });
    invalid("setPitchShiftSemis", { semis: "1", song: "sm1@1" });
    invalid("setPitchShiftSemis", { semis: 1 });
    assert.deepEqual(validators.setGuideMelodyLevel({ level: 0.7 }), {
      level: 0.7,
    });
    assert.deepEqual(validators.setGuideMelodyLevel({ level: 1 }), {
      level: 1,
    });
    invalid("setGuideMelodyLevel", {});
    invalid("setGuideMelodyLevel", { level: 1.5 });
    invalid("setGuideMelodyLevel", { level: -0.1 });
    invalid("setGuideMelodyLevel", { level: "0.5" });
    invalid("setGuideMelodyLevel", { level: NaN });
    invalid("setGuideMelodyLevel", { level: 0.5, semis: 1 });
    assert.deepEqual(validators.setSongVolume({ volume: 0 }), { volume: 0 });
    assert.deepEqual(validators.setSongVolume({ volume: 100 }), {
      volume: 100,
    });
    invalid("setSongVolume", {});
    invalid("setSongVolume", { volume: 101 });
    invalid("setSongVolume", { volume: -1 });
    invalid("setSongVolume", { volume: 50.5 });
    invalid("setSongVolume", { volume: "50" });
    assert.deepEqual(validators.setMicLevels({ id: "m#0", gain: 200 }), {
      id: "m#0",
      gain: 200,
      echo: undefined,
    });
    assert.deepEqual(validators.setMicLevels({ id: "m#0", echo: 0 }), {
      id: "m#0",
      gain: undefined,
      echo: 0,
    });
    invalid("setMicLevels", { gain: 100 });
    invalid("setMicLevels", { id: "m#0", gain: 201 });
    invalid("setMicLevels", { id: "m#0", gain: 99.5 });
    invalid("setMicLevels", { id: "m#0", echo: 101 });
    invalid("setMicLevels", { id: "m#0", echo: -1 });
    invalid("setMicLevels", { id: "m#0", level: 1 });
    const mic = { id: "m#0", label: "M, channel 1", gain: 100, echo: 40 };
    assert.deepEqual(validators.setMics({ mics: [] }), { mics: [] });
    assert.deepEqual(validators.setMics({ mics: [mic] }), { mics: [mic] });
    invalid("setMics", {});
    invalid("setMics", { mics: mic });
    invalid("setMics", { mics: Array(33).fill(mic) });
    invalid("setMics", { mics: [{ ...mic, gain: 201 }] });
    invalid("setMics", { mics: [{ ...mic, echo: 40.5 }] });
    invalid("setMics", { mics: [{ ...mic, label: undefined }] });
    invalid("setMics", { mics: [{ ...mic, extra: 1 }] });
    const position = {
      songId: "sm1",
      timestamp: "1",
      position: 12.25,
      length: 245.5,
      playing: true,
    };
    assert.deepEqual(validators.reportSongPosition(position), position);
    assert.deepEqual(
      validators.reportSongPosition({ ...position, length: null }),
      { ...position, length: null },
    );
    invalid("reportSongPosition", { ...position, length: undefined });
    invalid("reportSongPosition", { ...position, position: -1 });
    invalid("reportSongPosition", { ...position, position: Infinity });
    invalid("reportSongPosition", { ...position, length: 25 * 60 * 60 });
    invalid("reportSongPosition", { ...position, playing: "yes" });
    invalid("reportSongPosition", { ...position, timestamp: 1 });
    invalid("reportSongPosition", { ...position, paused: false });
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
    assert.deepEqual(
      validators.pushAdhocLyrics({ lyricIndex: 3, song: "sm1@1" }),
      { lyricIndex: 3, song: "sm1@1" },
    );
    invalid("pushAdhocLyrics", { lyricIndex: -1, song: "sm1@1" });
    invalid("pushAdhocLyrics", { lyricIndex: 0 });
    // The server looks the line up: a phone can't send its own text.
    invalid("pushAdhocLyrics", { lyric: "la", lyricIndex: 0, song: "sm1@1" });
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
