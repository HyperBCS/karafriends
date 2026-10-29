// Runs on Node's test runner through tsx (yarn test:unit). The jobs run fake
// tools from tests/fixtures/bin (yt-dlp-downloads, ffmpeg-ok, ffmpeg-fails),
// the ones KARAFRIENDS_YTDLP_PATH and KARAFRIENDS_FFMPEG_PATH would name, and
// a fake Joysound API, so nothing goes to the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { JoysoundQueueItem, UserIdentity } from "../../common/api";
import type { JoysoundAPI, JoysoundSongData } from "../joysoundApi";
import { failureReason, REASONS } from "../../common/downloadFailure";
import { songFileNames, type SongFiles } from "../../common/songFiles";
import type { DownloadQueueItem } from "../state";
import {
  damJob,
  deleteJoysoundTempFiles,
  getJoysoundOggPlaytime,
  joysoundJob,
  queueDownloadedJoysoundSong,
  ytdlpVideoJob,
  type JobPaths,
} from "./jobs";
import { createLimiter, DAM_SLOTS, runDownload, YTDLP_SLOTS } from "./queue";
import { parseDuration } from "./run";

const fake = (name: string) =>
  path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "tests",
    "fixtures",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );

const USER: UserIdentity = { nickname: "test", deviceId: "test-device" };

let folder: string;
let paths: JobPaths;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-downloads-"));
  paths = {
    folder,
    ytdlp: fake("yt-dlp-downloads"),
    ffmpeg: fake("ffmpeg-ok"),
  };
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

type Outcome<T> =
  | { ok: true; result: T; item: DownloadQueueItem }
  | { ok: false; reason: string; item: DownloadQueueItem };

// Runs job through the download queue as the app does, until it's ready or
// failed. cleanUp is what downloads/index.ts passes for its kind.
function download<T>(
  queue: DownloadQueueItem[],
  key: Pick<DownloadQueueItem, "kind"> &
    Partial<Pick<DownloadQueueItem, "songId" | "suffix">>,
  job: (item: DownloadQueueItem) => Promise<T>,
  cleanUp: () => void = () => {},
): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    let item!: DownloadQueueItem;
    runDownload(
      queue,
      { songId: "song", suffix: null, ...key, userIdentity: USER },
      {
        description: `test ${key.kind} download`,
        job: (started) => {
          item = started;
          return job(started);
        },
        onReady: (result) => resolve({ ok: true, result, item }),
        cleanUp,
        onFailed: (reason) => resolve({ ok: false, reason, item }),
      },
    );
  });
}

// Waits until done() says so, checking every 10 ms.
async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
}

const files = () => fs.readdirSync(folder).sort();

// The folder holds song's video, and only files named as songFileNames says
// (with the files of others, songs downloaded before): the files the
// downloads folder keeps with the song, and the display plays.
function assertFilesOf(song: SongFiles, ...others: SongFiles[]) {
  assert.ok(files().includes(songFileNames(song).video));
  const prefixes = [song, ...others].flatMap((s) => songFileNames(s).prefixes);
  for (const name of files()) {
    assert.ok(
      prefixes.some((prefix) => name.startsWith(prefix)),
      `${name} isn't named after ${JSON.stringify(song)}`,
    );
  }
}

test("a YouTube download reports its progress and leaves its video", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    { kind: "youtube", songId: "jNQXAC9IVRw" },
    (item) => ytdlpVideoJob(paths, item, null),
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.item.progress, 1);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), ["yt-jNQXAC9IVRw.log", "yt-jNQXAC9IVRw.mp4"]);
  assertFilesOf({ kind: "youtube", songId: "jNQXAC9IVRw", suffix: null });
});

test("a limiter runs two at once; a third waits for one to finish", async () => {
  assert.equal(YTDLP_SLOTS, 2);
  assert.equal(DAM_SLOTS, 2);
  // Its own, so nothing here can keep the app's slots taken.
  const limit = createLimiter(2);
  const started: string[] = [];
  // Each runs until finish(name).
  const finishers = new Map<string, () => void>();
  const finish = (name: string) => finishers.get(name)?.();
  const run = (name: string) =>
    limit(() => {
      started.push(name);
      return new Promise<void>((resolve) => finishers.set(name, resolve));
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const runs = [run("first"), run("second"), run("third")];
  await settle();
  assert.deepEqual(started, ["first", "second"]);

  finish("second");
  await settle();
  assert.deepEqual(started, ["first", "second", "third"]);

  finish("first");
  finish("third");
  await Promise.all(runs);
});

test("a limited run stopped while it waits never runs, and doesn't take a turn", async () => {
  const limit = createLimiter(1);
  let finishFirst!: () => void;
  const first = limit(
    () => new Promise<void>((resolve) => (finishFirst = resolve)),
  );
  const stop = new AbortController();
  let stoppedRan = false;
  const stopped = limit(async () => {
    stoppedRan = true;
  }, stop.signal);
  const next = limit(async () => "next");

  stop.abort();
  await assert.rejects(stopped, /stopped while waiting/);
  finishFirst();
  await first;
  assert.equal(await next, "next");
  assert.equal(stoppedRan, false);
  await assert.rejects(
    limit(async () => {}, AbortSignal.abort()),
    /stopped while waiting/,
  );
});

test("a Joysound background holds a yt-dlp slot only while yt-dlp runs", async (t) => {
  // Joysound's song data comes once released, as over a slow VPN, or after
  // its retries when Joysound is down.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const slowSongData = async () => {
    await released;
    return songData();
  };
  const queue: DownloadQueueItem[] = [];
  // One for each slot.
  const joysounds = ["bgVideo0001", "bgVideo0002"].map((background) =>
    download(
      queue,
      { kind: "joysound", songId: "123456", suffix: background },
      (item) =>
        joysoundJob(
          paths,
          item,
          joysoundApi(slowSongData),
          joysoundItem(background),
        ),
    ),
  );
  // Both backgrounds have downloaded, and wait for the song data...
  await until(() => queue.length === 2 && queue.every((i) => i.progress === 1));

  // ...while a YouTube video downloads.
  const youtube = await download(
    queue,
    { kind: "youtube", songId: "jNQXAC9IVRw" },
    (item) => ytdlpVideoJob(paths, item, null),
  );
  assert.equal(youtube.ok, true);

  release();
  for (const outcome of await Promise.all(joysounds)) {
    assert.equal(outcome.ok, true);
  }
});

test("a Niconico download leaves its video", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    { kind: "nico", songId: "sm9" },
    (item) => ytdlpVideoJob(paths, item, null),
  );

  assert.equal(outcome.ok, true);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), ["nico-sm9.log", "nico-sm9.mp4"]);
  assertFilesOf({ kind: "nico", songId: "sm9", suffix: null });
});

// A JOY-02 file with only what getSongDuration reads: the metadata offset
// at byte 6, and the duration in seconds 18 bytes into the metadata.
function telop(durationSeconds: number): Buffer {
  const data = Buffer.alloc(32);
  data.write("JOY-02", 0, "latin1");
  data.writeUInt32LE(10, 6);
  data.writeUInt16LE(durationSeconds, 28);
  return data;
}

// An Ogg comment with only what getJoysoundOggPlaytime reads: a field's
// length, then "playtime=<ms>".
function ogg(playtimeMs: number): Buffer {
  const field = Buffer.from(`playtime=${playtimeMs}`);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(field.length);
  return Buffer.concat([Buffer.from("OggS fake header "), length, field]);
}

test("getJoysoundOggPlaytime reads the ogg's playtime comment", () => {
  assert.equal(getJoysoundOggPlaytime(ogg(183_456)), 183_456);
  // What follows the comment isn't part of it.
  assert.equal(
    getJoysoundOggPlaytime(Buffer.concat([ogg(5_000), Buffer.from("999")])),
    5_000,
  );
  assert.ok(Number.isNaN(getJoysoundOggPlaytime(Buffer.from("OggS no tag"))));
  // No room for the length before it.
  assert.ok(Number.isNaN(getJoysoundOggPlaytime(Buffer.from("playtime=1"))));
});

type FakeJoysoundApi = Pick<JoysoundAPI, "getSongData" | "getMovieUrls">;

const movieUrls = async () => ({
  slc: "",
  movie: { mov1: "https://example.invalid/mov1.mp4" },
});

// The song as JoysoundAPI.getSongData gives it: decoded, its audio fetched.
const joysoundApi = (
  songData: () => Promise<JoysoundSongData>,
  getMovieUrls: FakeJoysoundApi["getMovieUrls"] = movieUrls,
): FakeJoysoundApi => ({
  getSongData: () => songData(),
  getMovieUrls,
});

const getFmeFails = async (): Promise<never> => {
  throw new Error("getFME failed");
};

const songData = async (): Promise<JoysoundSongData> => ({
  telop: telop(183),
  ogg: ogg(183_456),
});

const joysoundItem = (youtubeVideoId: string | null): JoysoundQueueItem => ({
  kind: "joysound",
  songId: "123456",
  name: "Song",
  artistName: "Artist",
  playtime: null,
  timestamp: "1",
  user: USER,
  lyricsMode: "kana",
  youtubeVideoId,
  guideVocal: false,
});

test("a Joysound download without a background leaves its video and lyrics", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, { kind: "joysound" }, (item) =>
    joysoundJob(paths, item, joysoundApi(songData), joysoundItem(null)),
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.result.playtime, 183);
  assert.ok(outcome.item.progress > 0);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), [
    "joysound-123456-default-opus.mp4",
    "joysound-123456-default.log",
    "joysound-123456.joy_02",
  ]);
  assertFilesOf({ kind: "joysound", songId: "123456", suffix: null });
});

test("a Joysound song's guide-vocal version downloads as itself, beside its melody version", async () => {
  const asked: unknown[] = [];
  const api: FakeJoysoundApi = {
    getSongData: async (id, guideVocal) => {
      asked.push(["getSongData", id, guideVocal]);
      return songData();
    },
    getMovieUrls: async (id, guideVocal) => {
      asked.push(["getMovieUrls", id, guideVocal]);
      return movieUrls();
    },
  };
  const vocalItem = { ...joysoundItem(null), guideVocal: true };
  const melody = await download([], { kind: "joysound" }, (item) =>
    joysoundJob(paths, item, api, joysoundItem(null)),
  );
  const vocal = await download([], { kind: "joysound" }, (item) =>
    joysoundJob(paths, item, api, vocalItem),
  );
  assert.ok(melody.ok && vocal.ok);
  assert.deepEqual(asked, [
    ["getSongData", "123456", false],
    ["getMovieUrls", "123456", false],
    ["getSongData", "123456", true],
    ["getMovieUrls", "123456", true],
  ]);
  // Its own lyrics and video, the melody version's kept.
  assert.deepEqual(files(), [
    "joysound-123456-default-opus.mp4",
    "joysound-123456-default.log",
    "joysound-123456.joy_02",
    "joysound-123456v-default-opus.mp4",
    "joysound-123456v-default.log",
    "joysound-123456v.joy_02",
  ]);
  // Queued again, each finds its own.
  const queued: JoysoundQueueItem[] = [];
  assert.ok(
    queueDownloadedJoysoundSong(folder, vocalItem, (item) => queued.push(item)),
  );
  assert.equal(queued[0].guideVocal, true);
});

test("a Joysound song whose ogg doesn't give its playtime takes the lyrics' length", async () => {
  const noPlaytime = async (): Promise<JoysoundSongData> => ({
    telop: telop(183),
    ogg: Buffer.from("OggS without a playtime comment"),
  });
  const outcome = await download([], { kind: "joysound" }, (item) =>
    joysoundJob(paths, item, joysoundApi(noPlaytime), joysoundItem(null)),
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.result.playtime, 183);
});

test("a Joysound download without a background video fails, leaving nothing", async () => {
  const noMovies = async () => ({ slc: "123456", movie: { mov1: "" } });
  const outcome = await download(
    [],
    { kind: "joysound" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(songData, noMovies),
        joysoundItem(null),
      ),
    () => deleteJoysoundTempFiles(folder, joysoundItem(null)),
  );
  assert.equal(!outcome.ok && outcome.reason, REASONS.joysound);
  assert.deepEqual(files(), []);
});

test("a Joysound download with a YouTube background pads it and leaves only the song's files", async () => {
  // ffmpeg-ok says every video is 2 s long. A 5 s song is within 10 s of
  // that, so the background gets 3 s of its first frame in front.
  const shortSong = async (): Promise<JoysoundSongData> => ({
    telop: telop(5),
    ogg: ogg(5_000),
  });
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, { kind: "joysound" }, (item) =>
    joysoundJob(
      paths,
      item,
      joysoundApi(shortSong),
      joysoundItem("bgVideo0001"),
    ),
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.result.playtime, 5);
  assert.equal(outcome.item.progress, 1);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), [
    "joysound-123456-bgVideo0001-opus.mp4",
    "joysound-123456-bgVideo0001.log",
    "joysound-123456-bgVideo0001.yt.log",
    "joysound-123456.joy_02",
  ]);
  assertFilesOf({ kind: "joysound", songId: "123456", suffix: "bgVideo0001" });
});

test("a Joysound download is marked started until its padding is done", async () => {
  // Every ffmpeg step adds what the folder holds to listing.txt. A song
  // within 10 s of the background's 2 s gets padded.
  paths.ffmpeg = fake("ffmpeg-lists-folder");
  const shortSong = async (): Promise<JoysoundSongData> => ({
    telop: telop(5),
    ogg: ogg(5_000),
  });
  const outcome = await download(
    [],
    { kind: "joysound", songId: "123456", suffix: "bgVideo0001" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(shortSong),
        joysoundItem("bgVideo0001"),
      ),
  );
  assert.ok(outcome.ok);

  const listing = path.join(folder, "listing.txt");
  // One per step: "--- <output>", then the names.
  const steps = fs
    .readFileSync(listing, "utf8")
    .split("--- ")
    .slice(1)
    .map((step) => step.split(/\r?\n/));
  fs.rmSync(listing);
  // Composing, then the five padding steps. Had the app stopped during
  // any of them, the marker would say the video is half-made.
  assert.equal(steps.length, 6);
  for (const [output, ...names] of steps) {
    assert.ok(
      names.includes("joysound-123456-bgVideo0001-opus.mp4.tmp"),
      `no marker while ffmpeg made ${output}`,
    );
  }
  // And once it's done, it goes.
  assertFilesOf({ kind: "joysound", songId: "123456", suffix: "bgVideo0001" });
  assert.ok(!files().includes("joysound-123456-bgVideo0001-opus.mp4.tmp"));
});

test("a Joysound download that fails putting the video together leaves only its logs", async () => {
  paths.ffmpeg = fake("ffmpeg-fails");
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    { kind: "joysound" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(songData),
        joysoundItem("bgVideo0001"),
      ),
    () => deleteJoysoundTempFiles(folder, joysoundItem("bgVideo0001")),
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, REASONS.videoProcessing);
  assert.equal(queue[0].status, "failed");
  assert.equal(queue[0].reason, REASONS.videoProcessing);
  assert.deepEqual(files(), [
    "joysound-123456-bgVideo0001.log",
    "joysound-123456-bgVideo0001.yt.log",
  ]);
  assert.match(
    fs.readFileSync(
      path.join(folder, "joysound-123456-bgVideo0001.log"),
      "utf8",
    ),
    /Invalid data found when processing input/,
  );
});

test("a failed Joysound background leaves the song's other backgrounds and lyrics", async () => {
  // The song with Joysound's own video, downloaded before.
  const done = await download([], { kind: "joysound" }, (item) =>
    joysoundJob(paths, item, joysoundApi(songData), joysoundItem(null)),
  );
  assert.ok(done.ok);

  paths.ffmpeg = fake("ffmpeg-fails");
  const outcome = await download(
    [],
    { kind: "joysound" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(songData),
        joysoundItem("bgVideo0001"),
      ),
    () => deleteJoysoundTempFiles(folder, joysoundItem("bgVideo0001")),
  );

  assert.equal(outcome.ok, false);
  assert.deepEqual(files(), [
    "joysound-123456-bgVideo0001.log",
    "joysound-123456-bgVideo0001.yt.log",
    "joysound-123456-default-opus.mp4",
    "joysound-123456-default.log",
    "joysound-123456.joy_02",
  ]);
});

test("a Joysound background left half-done by a crash goes before it's downloaded again", async () => {
  const other = path.join(folder, "joysound-123456-default-opus.mp4");
  fs.writeFileSync(other, "another background's video");
  fs.writeFileSync(path.join(folder, "joysound-123456.joy_02"), "lyrics");
  for (const name of [
    "joysound-123456-bgVideo0001-opus.mp4",
    "joysound-123456-bgVideo0001-opus.mp4.tmp",
    "joysound-123456-bgVideo0001-opus-pad.mp4",
  ]) {
    fs.writeFileSync(path.join(folder, name), "half-done");
  }

  const outcome = await download([], { kind: "joysound" }, (item) =>
    joysoundJob(
      paths,
      item,
      joysoundApi(songData),
      joysoundItem("bgVideo0001"),
    ),
  );

  assert.ok(outcome.ok);
  assert.equal(fs.readFileSync(other, "utf8"), "another background's video");
  assert.deepEqual(files(), [
    "joysound-123456-bgVideo0001-opus.mp4",
    "joysound-123456-bgVideo0001.log",
    "joysound-123456-bgVideo0001.yt.log",
    "joysound-123456-default-opus.mp4",
    "joysound-123456.joy_02",
  ]);
  assert.notEqual(
    fs.readFileSync(
      path.join(folder, "joysound-123456-bgVideo0001-opus.mp4"),
      "utf8",
    ),
    "half-done",
  );
});

test("a Joysound video left half-written isn't queued", () => {
  for (const name of [
    "joysound-123456-default-opus.mp4",
    "joysound-123456-default-opus.mp4.tmp",
    "joysound-123456.joy_02",
  ]) {
    fs.writeFileSync(path.join(folder, name), "x");
  }
  const queued: JoysoundQueueItem[] = [];
  assert.equal(
    queueDownloadedJoysoundSong(folder, joysoundItem(null), (item) =>
      queued.push(item),
    ),
    false,
  );
  assert.deepEqual(queued, []);
  assert.deepEqual(files(), []);
});

test("a Joysound video from before the Opus sound isn't queued again", () => {
  // Joysound's Vorbis, which Chromium decodes wrong, under the old name.
  for (const name of [
    "joysound-123456-default.mp4",
    "joysound-123456.joy_02",
  ]) {
    fs.writeFileSync(path.join(folder, name), "x");
  }
  const queued: JoysoundQueueItem[] = [];
  assert.equal(
    queueDownloadedJoysoundSong(folder, joysoundItem(null), (item) =>
      queued.push(item),
    ),
    false,
  );
  assert.deepEqual(queued, []);
});

test("a Joysound download whose song data fails stops its background download", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    { kind: "joysound" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(getFmeFails),
        joysoundItem("bgVideo0001"),
      ),
    () => deleteJoysoundTempFiles(folder, joysoundItem("bgVideo0001")),
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, REASONS.joysound);
  // Cleaned up after yt-dlp stopped: had it gone on, it would have left
  // its video behind.
  assert.deepEqual(files(), ["joysound-123456-bgVideo0001.yt.log"]);
  assert.match(
    fs.readFileSync(
      path.join(folder, "joysound-123456-bgVideo0001.yt.log"),
      "utf8",
    ),
    /was stopped/,
  );
});

test("a Joysound download whose song data fails doesn't wait for the video's URL", async () => {
  let urlAsked = false;
  let urlSent = false;
  const slowUrls = async () => {
    urlAsked = true;
    // Long enough that the download would still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    urlSent = true;
    return movieUrls();
  };
  const outcome = await download(
    [],
    { kind: "joysound" },
    (item) =>
      joysoundJob(
        paths,
        item,
        joysoundApi(getFmeFails, slowUrls),
        joysoundItem(null),
      ),
    () => deleteJoysoundTempFiles(folder, joysoundItem(null)),
  );

  assert.equal(!outcome.ok && outcome.reason, REASONS.joysound);
  assert.ok(urlAsked && !urlSent);
  assert.deepEqual(files(), []);
  // When the URL comes, ffmpeg doesn't start.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(files(), []);
});

// ffmpeg-ok says every video is 2 seconds long, so a DAM song longer than
// 2 / 0.6 seconds gets a sample.
test("a DAM video much shorter than the song is deleted, and its download fails", async () => {
  await assert.rejects(
    damJob(paths, "https://dam/song.m3u8", "1234-56", "0", 240),
    (err) => failureReason(err) === REASONS.damSample,
  );
  assert.deepEqual(files(), ["dam-1234-56-0.log"]);
});

test("a DAM video about as long as the song stays", async () => {
  await damJob(paths, "https://dam/song.m3u8", "1234-56", "0", 3);
  assert.deepEqual(files(), ["1234-56-0.mp4", "dam-1234-56-0.log"]);
  assertFilesOf({ kind: "dam", songId: "1234-56", suffix: "0" });
});

test("a DAM video stays when the song's playtime isn't known", async () => {
  await damJob(paths, "https://dam/song.m3u8", "1234-56", "0", null);
  assert.deepEqual(files(), ["1234-56-0.mp4", "dam-1234-56-0.log"]);
});

test("parseDuration reads ffmpeg's Duration line", () => {
  assert.equal(
    parseDuration(
      "Input #0, mov,mp4\n  Duration: 00:04:01.52, start: 0.000000, bitrate: 1 kb/s",
    ),
    241.52,
  );
  assert.equal(parseDuration("  Duration: 01:00:00.00,"), 3600);
  assert.equal(parseDuration("  Duration: N/A, bitrate: N/A"), null);
  assert.equal(parseDuration("No such file or directory"), null);
});
