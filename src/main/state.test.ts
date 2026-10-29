// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { QueueItem, YoutubeQueueItem } from "../common/api";
import { songKey } from "../common/currentSong";
import {
  createStateStore,
  currentSongSecondsLeft,
  type DownloadQueueItem,
  FAILED_DOWNLOAD_KEPT_MS,
  failDownload,
  isDownloading,
  loadState,
  MAX_HISTORY,
  removeDownload,
  removeExpiredDownloads,
  serializeState,
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
      state.songHistory.unshift({ song: song(0), playedAt: 5 });
      state.idToAdhocLyrics[songKey(withLyrics)] = ["la", "la"];
    });

    const loaded = createStateStore(file).getState();
    assert.deepEqual(loaded.songQueue, [withLyrics, song(2)]);
    assert.deepEqual(loaded.songHistory, [{ song: song(0), playedAt: 5 }]);
    assert.deepEqual(loaded.idToAdhocLyrics, {
      [songKey(withLyrics)]: ["la", "la"],
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

  test("saves the current song at the head of the queue, and starts the rest of it over", () => {
    const store = createStateStore(file);
    store.update((state) => {
      state.currentSong = song(1);
      state.songQueue.push(song(2));
      state.pitchShiftSemis = 3;
      state.playbackState = "PLAYING";
      state.currentSongAdhocLyrics.push({ lyric: "la", lyricIndex: 0 });
      startDownload(state.downloadQueue, {
        kind: "youtube",
        userIdentity: song(3).user,
        songId: "video3",
        suffix: null,
      });
      state.toolsProblem = { message: "Update the tools", since: 1 };
      state.remoconProblem = "Phones can't connect: port 8080 is in use.";
      state.currentSongStartedAt = 1000;
      state.currentSongPausedSince = 1500;
      state.currentSongLength = 245;
    });

    const file_ = saved();
    assert.deepEqual(Object.keys(file_).sort(), [
      "guideMelodyLevel",
      "idToAdhocLyrics",
      "pendingSongs",
      "songHistory",
      "songQueue",
    ]);
    assert.deepEqual(file_.songQueue, [song(1), song(2)]);
    // Nothing plays after a restart, until the display takes song 1.
    const loaded = createStateStore(file).getState();
    assert.equal(loaded.currentSong, null);
    assert.equal(loaded.playbackState, "WAITING");
    assert.equal(loaded.pitchShiftSemis, 0);
    assert.deepEqual(loaded.currentSongAdhocLyrics, []);
    assert.deepEqual(loaded.downloadQueue, []);
    assert.equal(loaded.toolsProblem, null);
    assert.equal(loaded.remoconProblem, null);
  });

  test("keeps the songs still downloading, with what came with them", () => {
    const store = createStateStore(file);
    const pending = {
      item: song(1, { hasAdhocLyrics: true }) as YoutubeQueueItem,
      pushToHead: true,
      captionCode: "en",
      adhocLyrics: ["la"],
    };
    store.update((state) => state.pendingSongs.push(pending));
    assert.deepEqual(createStateStore(file).getState().pendingSongs, [pending]);
    // A caption code yt-dlp wouldn't have been given, a DAM song (queued at
    // once, never pending) and junk are dropped.
    fs.writeFileSync(
      file,
      JSON.stringify({
        pendingSongs: [
          { ...pending, captionCode: "--exec=rm" },
          { ...pending, item: { ...song(2), kind: "dam", streamingUrlIdx: 0 } },
          "junk",
        ],
      }),
    );
    assert.deepEqual(createStateStore(file).getState().pendingSongs, [
      { ...pending, captionCode: null },
    ]);
  });

  test("an older file's playback state and pitch are left out, and its current song is queued first", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        currentSong: song(1),
        songQueue: [song(2)],
        playbackState: "PLAYING",
        pitchShiftSemis: 3,
        currentSongAdhocLyrics: [{ lyric: "la", lyricIndex: 0 }],
      }),
    );
    const loaded = createStateStore(file).getState();
    assert.equal(loaded.currentSong, null);
    assert.deepEqual(loaded.songQueue, [song(1), song(2)]);
    assert.equal(loaded.playbackState, "WAITING");
    assert.equal(loaded.pitchShiftSemis, 0);
    assert.deepEqual(loaded.currentSongAdhocLyrics, []);
  });

  test("starts the song volume and the mics over on every launch", () => {
    const store = createStateStore(file);
    store.update((state) => {
      state.songVolume = 30;
      state.mics = [
        { id: "Mic#0", label: "Mic, channel 1", gain: 50, echo: 0, gate: -40 },
      ];
    });
    assert.equal("songVolume" in saved(), false);
    assert.equal("mics" in saved(), false);
    assert.equal(createStateStore(file).getState().songVolume, 100);
    // Nor from a file that has them.
    fs.writeFileSync(file, JSON.stringify({ songVolume: 30, mics: [{}] }));
    assert.equal(createStateStore(file).getState().songVolume, 100);
    assert.deepEqual(createStateStore(file).getState().mics, []);
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

// The counting itself is secondsLeft's (src/common/currentSong.test.ts).
describe("currentSongSecondsLeft", () => {
  // Song 1 was queued as 60 s long, and has played 20 s.
  const state = {
    currentSong: song(1),
    currentSongStartedAt: 1000,
    currentSongPausedSince: null,
    currentSongLength: null,
  };

  test("counts from the video's length once the display knows it, else the playtime", () => {
    assert.equal(currentSongSecondsLeft(state, 21_000), 40);
    assert.equal(
      currentSongSecondsLeft({ ...state, currentSongLength: 75 }, 21_000),
      55,
    );
  });

  test("is 0 with no song", () => {
    assert.equal(
      currentSongSecondsLeft({ ...state, currentSong: null }, 21_000),
      0,
    );
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

  test("drops the GraphQL-shaped items from before 0.1.0, saying so", () => {
    write({
      songQueue: [
        {
          __typename: "NicoQueueItem",
          songId: "sm9",
          name: "Nico video",
          artistName: "",
          playtime: null,
          timestamp: "3",
          userIdentity: { deviceId: "d", nickname: "n" },
        },
        song(1),
      ],
    });
    const warned: unknown[] = [];
    const { warn } = console;
    console.warn = (...args) => warned.push(args.join(" "));
    try {
      assert.deepEqual(loadState(file).songQueue, [song(1)]);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1);
    assert.match(
      String(warned[0]),
      /^Dropping an unreadable saved entry: .*sm9/,
    );
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

  test("keeps a Joysound song's guide-vocal version; older items are the guide-melody one", () => {
    const joysound = (n: number, fields: object) => ({
      kind: "joysound",
      songId: String(n),
      name: `Song ${n}`,
      artistName: "Artist",
      timestamp: String(n),
      user: { deviceId: "d", nickname: "n" },
      lyricsMode: "kana",
      youtubeVideoId: null,
      ...fields,
    });
    write({
      songQueue: [
        joysound(1, { guideVocal: true }),
        joysound(2, {}),
        joysound(3, { guideVocal: "yes" }),
      ],
    });
    assert.deepEqual(
      loadState(file).songQueue.map(
        (item) => item.kind === "joysound" && item.guideVocal,
      ),
      [true, false, false],
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

  test("keeps the newest MAX_HISTORY of the history, saving and loading", () => {
    const history = Array.from({ length: MAX_HISTORY + 5 }, (_, n) => ({
      song: song(n),
      playedAt: n,
    }));
    write({ songHistory: history });
    const state = loadState(file);
    assert.equal(state.songHistory.length, MAX_HISTORY);
    assert.deepEqual(state.songHistory.at(-1), history[MAX_HISTORY - 1]);
    state.songHistory.push(...history.slice(MAX_HISTORY));
    assert.equal(
      JSON.parse(serializeState(state)).songHistory.length,
      MAX_HISTORY,
    );
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
    assert.deepEqual(state.songHistory, [{ song: song(2), playedAt: null }]);
    assert.equal(state.playbackState, "WAITING");
    assert.equal(state.pitchShiftSemis, 0);
    assert.equal(state.guideMelodyLevel, 0);
  });

  test("keeps only the adhoc lyrics of queued songs", () => {
    const keyed = song(1, { hasAdhocLyrics: true });
    write({
      songQueue: [keyed, song(3)],
      idToAdhocLyrics: {
        [songKey(keyed)]: ["one", 1, "two"],
        // Songs that aren't queued (a failed download, say).
        [songKey(song(3))]: ["not queued with lyrics"],
        "video4@1": ["never queued"],
      },
    });
    assert.deepEqual(loadState(file).idToAdhocLyrics, {
      [songKey(keyed)]: ["one", "two"],
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
