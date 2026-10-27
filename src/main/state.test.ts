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
  loadState,
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
      state.downloadQueue.push({
        downloadType: 1,
        userIdentity: song(3).user,
        songId: "video3",
        suffix: null,
        progress: 0.5,
      });
    });

    const file_ = saved();
    assert.equal(file_.currentSong, null);
    assert.deepEqual(file_.songQueue, [song(1), song(2)]);
    assert.equal(file_.pitchShiftSemis, 0);
    assert.deepEqual(file_.currentSongAdhocLyrics, []);
    assert.deepEqual(file_.downloadQueue, []);
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
        isRomaji: true,
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

  test("drops entries it can't read and keeps the rest", () => {
    write({
      songQueue: [{ kind: "karaoke-cassette" }, song(1), "junk"],
      songHistory: [{ song: null }, { song: song(2) }],
      playbackState: "DANCING",
      pitchShiftSemis: "high",
    });
    const state: State = loadState(file);
    assert.deepEqual(state.songQueue, [song(1)]);
    assert.deepEqual(state.songHistory, [{ song: song(2) }]);
    assert.equal(state.playbackState, "WAITING");
    assert.equal(state.pitchShiftSemis, 0);
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
