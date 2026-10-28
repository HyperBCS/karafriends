// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { QueueItem } from "../common/api";
import {
  adhocLyricsKey,
  createStateStore,
  currentSongSecondsLeft,
  type DownloadQueueItem,
  FAILED_DOWNLOAD_KEPT_MS,
  failDownload,
  isDownloading,
  loadState,
  removeDownload,
  removeExpiredDownloads,
  startDownload,
  type State,
} from "./state";

const song = (n: number, overrides: Partial<QueueItem> = {}): QueueItem =>
  ({
    kind: "youtube",
    songId: `video${n}`,
    name: `Song ${n}`,
    artistName: "Artist",
    playtime: 60,
    timestamp: String(1_700_000_000_000 + n),
    user: { deviceId: `device${n}`, nickname: `singer${n}` },
    hasAdhocLyrics: false,
    hasCaptions: false,
    gainValue: 1,
    ...overrides,
  }) as QueueItem;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-state-test-"));
  file = path.join(dir, "karafriends_tmp", "queue.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const saved = () => JSON.parse(fs.readFileSync(file, "utf-8"));

describe("createStateStore", () => {
  test("starts empty when there is no queue.json", () => {
    const store = createStateStore(file);
    assert.deepEqual(store.getState().songQueue, []);
    assert.equal(store.getState().currentSong, null);
    assert.equal(store.getState().playbackState, "WAITING");
  });

  test("saves on update and loads it back", () => {
    const store = createStateStore(file);
    const withLyrics = song(1, { hasAdhocLyrics: true });
    store.update((state) => {
      state.songQueue.push(withLyrics, song(2));
      state.songHistory.unshift({ song: song(0) });
      state.idToAdhocLyrics[adhocLyricsKey(withLyrics)] = ["la", "la"];
    });

    const loaded = createStateStore(file).getState();
    assert.deepEqual(loaded.songQueue, [withLyrics, song(2)]);
    assert.deepEqual(loaded.songHistory, [{ song: song(0) }]);
    assert.deepEqual(loaded.idToAdhocLyrics, {
      [adhocLyricsKey(withLyrics)]: ["la", "la"],
    });
  });

  test("returns what the mutator returns and tells listeners", () => {
    const store = createStateStore(file);
    const seen: number[] = [];
    store.onChange((state) => seen.push(state.songQueue.length));
    const stop = store.onChange(() => {
      throw new Error("a broken listener doesn't stop the others");
    });

    const result = store.update((state) => {
      state.songQueue.push(song(1));
      return "done";
    });
    stop();
    store.update((state) => state.songQueue.push(song(2)));

    assert.equal(result, "done");
    assert.deepEqual(seen, [1, 2]);
  });

  test("saves the current song at the head of the queue, and resets pitch and downloads", () => {
    const store = createStateStore(file);
    store.update((state) => {
      state.currentSong = song(1);
      state.songQueue.push(song(2));
      state.pitchShiftSemis = 3;
      state.currentSongAdhocLyrics.push({ lyric: "la", lyricIndex: 0 });
      startDownload(state.downloadQueue, {
        kind: "youtube",
        userIdentity: song(3).user,
        songId: "video3",
        suffix: null,
      });
      state.toolsProblem = { message: "Update the tools", since: 1 };
      state.currentSongStartedAt = 1000;
      state.currentSongPausedMs = 200;
      state.currentSongPausedSince = 1500;
    });

    const file_ = saved();
    assert.equal(file_.currentSong, null);
    assert.deepEqual(file_.songQueue, [song(1), song(2)]);
    assert.equal(file_.pitchShiftSemis, 0);
    assert.deepEqual(file_.currentSongAdhocLyrics, []);
    assert.deepEqual(file_.downloadQueue, []);
    assert.equal("toolsProblem" in file_, false);
    assert.equal(createStateStore(file).getState().toolsProblem, null);
    for (const key of [
      "currentSongStartedAt",
      "currentSongPausedMs",
      "currentSongPausedSince",
    ]) {
      assert.equal(key in file_, false, key);
    }
  });

  test("keeps the guide melody level across a restart", () => {
    const store = createStateStore(file);
    store.update((state) => {
      state.guideMelodyLevel = 0.6;
    });
    assert.equal(saved().guideMelodyLevel, 0.6);
    assert.equal(createStateStore(file).getState().guideMelodyLevel, 0.6);
  });

  test("doesn't save a null current song into the queue", () => {
    const store = createStateStore(file);
    store.update((state) => state.songQueue.push(song(1)));
    assert.deepEqual(saved().songQueue, [song(1)]);

    store.update((state) => {
      state.songQueue = [];
    });
    assert.deepEqual(saved().songQueue, []);
  });

  test("doesn't rewrite queue.json when nothing saved changed", () => {
    const store = createStateStore(file);
    store.update((state) => state.songQueue.push(song(1)));
    fs.rmSync(file);
    // Pitch isn't saved, so this leaves the file as it was.
    store.update((state) => {
      state.pitchShiftSemis = 2;
    });
    assert.equal(fs.existsSync(file), false);
    store.update((state) => state.songQueue.push(song(2)));
    assert.deepEqual(saved().songQueue, [song(1), song(2)]);
  });

  test("leaves no temp file behind", () => {
    const store = createStateStore(file);
    store.update((state) => state.songQueue.push(song(1)));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["queue.json"]);
  });
});

describe("currentSongSecondsLeft", () => {
  // Song 1 is 60 s long.
  const timing = (
    currentSongStartedAt: number | null,
    currentSongPausedMs = 0,
    currentSongPausedSince: number | null = null,
  ) => ({
    currentSong: song(1),
    currentSongStartedAt,
    currentSongPausedMs,
    currentSongPausedSince,
  });

  test("is all of it before the song starts, and 0 with none", () => {
    assert.equal(currentSongSecondsLeft(timing(null), 99_000), 60);
    assert.equal(
      currentSongSecondsLeft({ ...timing(null), currentSong: null }, 99_000),
      0,
    );
  });

  test("counts down while it plays, never below 0", () => {
    assert.equal(currentSongSecondsLeft(timing(1000), 1000), 60);
    assert.equal(currentSongSecondsLeft(timing(1000), 21_400), 40);
    assert.equal(currentSongSecondsLeft(timing(1000), 200_000), 0);
  });

  test("leaves out the pauses, and stops while paused", () => {
    // 10 s of earlier pauses.
    assert.equal(currentSongSecondsLeft(timing(1000, 10_000), 21_000), 50);
    // Paused since 21 s: 20 s played, however long the pause.
    assert.equal(currentSongSecondsLeft(timing(1000, 0, 21_000), 90_000), 40);
  });
});

describe("loadState", () => {
  const write = (contents: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  };

  test("drops the [null] that older versions saved when nothing was playing", () => {
    write({ currentSong: null, songQueue: [null], songHistory: [] });
    assert.deepEqual(loadState(file).songQueue, []);

    write({ songQueue: [null, song(1)] });
    assert.deepEqual(loadState(file).songQueue, [song(1)]);
  });

  test("reads the GraphQL-shaped items older versions saved", () => {
    write({
      songQueue: [
        {
          __typename: "DamQueueItem",
          songId: "1234-56",
          name: "DAM song",
          artistName: "Artist",
          playtime: 200,
          timestamp: "1",
          userIdentity: { deviceId: "d", nickname: "n" },
          streamingUrlIdx: "1",
        },
        {
          __typename: "JoysoundQueueItem",
          songId: "123456",
          name: "Joysound song",
          artistName: "Artist",
          timestamp: "2",
          userIdentity: { deviceId: "d", nickname: "n" },
          isRomaji: true,
          youtubeVideoId: null,
        },
        {
          __typename: "NicoQueueItem",
          songId: "sm9",
          name: "Nico video",
          artistName: "",
          playtime: null,
          timestamp: "3",
          userIdentity: { deviceId: "d", nickname: "n" },
        },
      ],
    });
    const user = { deviceId: "d", nickname: "n" };
    assert.deepEqual(loadState(file).songQueue, [
      {
        kind: "dam",
        songId: "1234-56",
        name: "DAM song",
        artistName: "Artist",
        playtime: 200,
        timestamp: "1",
        user,
        streamingUrlIdx: 1,
      },
      {
        kind: "joysound",
        songId: "123456",
        name: "Joysound song",
        artistName: "Artist",
        playtime: null,
        timestamp: "2",
        user,
        lyricsMode: "romaji",
        youtubeVideoId: null,
      },
      {
        kind: "nico",
        songId: "sm9",
        name: "Nico video",
        artistName: "",
        playtime: null,
        timestamp: "3",
        user,
      },
    ]);
  });

  test("reads a Joysound song's isRomaji, saved before the lyrics modes, as its mode", () => {
    const joysound = (n: number, fields: object) => ({
      kind: "joysound",
      songId: String(n),
      name: `Song ${n}`,
      artistName: "Artist",
      timestamp: String(n),
      user: { deviceId: "d", nickname: "n" },
      youtubeVideoId: null,
      ...fields,
    });
    write({
      songQueue: [
        joysound(1, { isRomaji: true }),
        joysound(2, { isRomaji: false }),
        joysound(3, {}),
        joysound(4, { lyricsMode: "both" }),
        joysound(5, { lyricsMode: "romaji" }),
        joysound(6, { lyricsMode: "furigana", isRomaji: true }),
      ],
    });
    assert.deepEqual(
      loadState(file).songQueue.map(
        (item) => item.kind === "joysound" && item.lyricsMode,
      ),
      ["romaji", "kana", "kana", "both", "romaji", "romaji"],
    );
  });

  test("keeps a DAM song's readings, which older items don't have", () => {
    const old = {
      kind: "dam",
      songId: "1234-56",
      name: "恋",
      artistName: "星野源",
      playtime: 252,
      timestamp: "1",
      user: { deviceId: "d", nickname: "n" },
      streamingUrlIdx: 0,
    };
    const dam = { ...old, nameYomi: "コイ", artistNameYomi: "ホシノゲン" };
    write({ songQueue: [dam, old, { ...old, nameYomi: 1 }] });
    assert.deepEqual(loadState(file).songQueue, [dam, old, old]);
  });

  test("keeps a known readings mode, which older items don't have", () => {
    const old = song(1);
    const romaji = { ...old, readingsMode: "romaji" };
    write({
      songQueue: [romaji, old, { ...old, readingsMode: "both" }],
      songHistory: [{ song: { ...old, readingsMode: "kana" } }],
    });
    const state = loadState(file);
    assert.deepEqual(state.songQueue, [romaji, old, old]);
    assert.equal(state.songHistory[0].song.readingsMode, "kana");
  });

  test("drops entries it can't read and keeps the rest", () => {
    write({
      songQueue: [{ kind: "karaoke-cassette" }, song(1), "junk"],
      songHistory: [{ song: null }, { song: song(2) }],
      playbackState: "DANCING",
      pitchShiftSemis: "high",
      guideMelodyLevel: 7,
    });
    const state: State = loadState(file);
    assert.deepEqual(state.songQueue, [song(1)]);
    assert.deepEqual(state.songHistory, [{ song: song(2) }]);
    assert.equal(state.playbackState, "WAITING");
    assert.equal(state.pitchShiftSemis, 0);
    assert.equal(state.guideMelodyLevel, 0);
  });

  test("keeps only the adhoc lyrics of queued songs, and moves older ones' to their song", () => {
    const keyed = song(1, { hasAdhocLyrics: true });
    // Saved by video ID, as older versions did.
    const old = song(2, { hasAdhocLyrics: true });
    write({
      songQueue: [keyed, old, song(3)],
      idToAdhocLyrics: {
        [adhocLyricsKey(keyed)]: ["one", 1, "two"],
        video2: ["old"],
        // Songs that aren't queued (a failed download, say).
        video3: ["not queued with lyrics"],
        video4: ["never queued"],
        "video5@1": ["gone"],
      },
    });
    assert.deepEqual(loadState(file).idToAdhocLyrics, {
      [adhocLyricsKey(keyed)]: ["one", "two"],
      [adhocLyricsKey(old)]: ["old"],
    });
  });

  test("sets a corrupt queue.json aside and starts empty", () => {
    write("{ not json");
    const state = loadState(file);
    assert.deepEqual(state.songQueue, []);
    assert.equal(fs.existsSync(`${file}.corrupt`), true);
    assert.equal(fs.existsSync(file), false);
  });
});

describe("the download queue", () => {
  const alice = { deviceId: "alice-device", nickname: "alice" };
  const video = {
    kind: "youtube" as const,
    songId: "jNQXAC9IVRw",
    suffix: null,
  };
  const T = 1_700_000_000_000;

  test("a download starts, then fails with a reason", () => {
    const queue: DownloadQueueItem[] = [];
    const item = startDownload(queue, { ...video, userIdentity: alice }, T);
    assert.deepEqual(queue, [item]);
    assert.equal(item.status, "downloading");
    assert.equal(item.reason, null);
    assert.equal(isDownloading(queue, video), true);

    assert.equal(failDownload(queue, item, "Video unavailable", T + 1), true);
    assert.equal(item.status, "failed");
    assert.equal(item.reason, "Video unavailable");
    assert.equal(item.failedAt, T + 1);
    // Still shown, but not in progress.
    assert.deepEqual(queue, [item]);
    assert.equal(isDownloading(queue, video), false);

    // Only once.
    assert.equal(failDownload(queue, item, "Download timed out", T + 2), false);
    assert.equal(item.reason, "Video unavailable");
  });

  test("a download that's gone can't fail", () => {
    const queue: DownloadQueueItem[] = [];
    const item = startDownload(queue, { ...video, userIdentity: alice }, T);
    removeDownload(queue, item);
    assert.deepEqual(queue, []);
    assert.equal(failDownload(queue, item, "Video unavailable", T), false);
    assert.equal(item.status, "downloading");
  });

  test("removing one that's gone leaves the others", () => {
    const queue: DownloadQueueItem[] = [];
    const a = startDownload(queue, { ...video, userIdentity: alice }, T);
    const b = startDownload(
      queue,
      { ...video, songId: "other", userIdentity: alice },
      T,
    );
    removeDownload(queue, a);
    removeDownload(queue, a);
    assert.deepEqual(queue, [b]);
  });

  test("a failure goes after FAILED_DOWNLOAD_KEPT_MS", () => {
    const queue: DownloadQueueItem[] = [];
    const failed = startDownload(queue, { ...video, userIdentity: alice }, T);
    failDownload(queue, failed, "Video unavailable", T);
    const running = startDownload(
      queue,
      { ...video, songId: "other", userIdentity: alice },
      T,
    );
    assert.equal(
      removeExpiredDownloads(queue, T + FAILED_DOWNLOAD_KEPT_MS - 1),
      false,
    );
    assert.deepEqual(queue, [failed, running]);
    assert.equal(
      removeExpiredDownloads(queue, T + FAILED_DOWNLOAD_KEPT_MS),
      true,
    );
    // A download in progress stays, however long it takes.
    assert.deepEqual(queue, [running]);
  });

  test("starting any download clears out expired failures", () => {
    const queue: DownloadQueueItem[] = [];
    const failed = startDownload(queue, { ...video, userIdentity: alice }, T);
    failDownload(queue, failed, "Video unavailable", T);
    const next = startDownload(
      queue,
      { ...video, songId: "other", userIdentity: alice },
      T + FAILED_DOWNLOAD_KEPT_MS,
    );
    assert.deepEqual(queue, [next]);
  });

  test("trying a failed download again replaces the failure", () => {
    const queue: DownloadQueueItem[] = [];
    const first = startDownload(queue, { ...video, userIdentity: alice }, T);
    failDownload(queue, first, "Video unavailable", T);
    const again = startDownload(
      queue,
      { ...video, userIdentity: { deviceId: "bob", nickname: "bob" } },
      T + 1,
    );
    assert.deepEqual(queue, [again]);
    assert.notEqual(again.id, first.id);
    assert.equal(again.status, "downloading");
    assert.equal(isDownloading(queue, video), true);
    // The old failure's timer finds nothing to remove.
    removeDownload(queue, first);
    assert.deepEqual(queue, [again]);
  });

  test("a Joysound song's backgrounds are separate downloads", () => {
    const queue: DownloadQueueItem[] = [];
    const song = { kind: "joysound" as const, songId: "123" };
    startDownload(queue, { ...song, suffix: "abc", userIdentity: alice }, T);
    assert.equal(isDownloading(queue, { ...song, suffix: "abc" }), true);
    assert.equal(isDownloading(queue, { ...song, suffix: null }), false);
    assert.equal(
      isDownloading(queue, { kind: "youtube", songId: "123", suffix: "abc" }),
      false,
    );
  });
});
