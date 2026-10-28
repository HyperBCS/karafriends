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
import { REASONS } from "../../common/downloadFailure";
import type { DownloadQueueItem } from "../state";
import {
  deleteJoysoundTempFiles,
  joysoundJob,
  nicoJob,
  youtubeJob,
  type JobPaths,
} from "./jobs";
import { runDownload } from "./queue";

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
// failed. cleanUp is what services.ts passes for its kind.
function download<T>(
  queue: DownloadQueueItem[],
  kind: DownloadQueueItem["kind"],
  job: (item: DownloadQueueItem) => Promise<T>,
  cleanUp: () => void = () => {},
): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    let item!: DownloadQueueItem;
    runDownload(
      queue,
      { kind, songId: "song", suffix: null, userIdentity: USER },
      `test ${kind} download`,
      (started) => {
        item = started;
        return job(started);
      },
      (result) => resolve({ ok: true, result, item }),
      cleanUp,
      (reason) => resolve({ ok: false, reason, item }),
    );
  });
}

const files = () => fs.readdirSync(folder).sort();

test("a YouTube download reports its progress and leaves its video", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, "youtube", (item) =>
    youtubeJob(paths, item, "jNQXAC9IVRw", null),
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.item.progress, 1);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), ["yt-jNQXAC9IVRw.log", "yt-jNQXAC9IVRw.mp4"]);
});

test("a Niconico download leaves its video", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, "nico", (item) =>
    nicoJob(paths, item, "sm9"),
  );

  assert.equal(outcome.ok, true);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), ["nico-sm9.log", "nico-sm9.mp4"]);
});

// Joysound's getFME answer: base64 with its last 30 characters moved to
// the front.
function scrambled(data: Buffer): string {
  const base64 = data.toString("base64");
  return base64.slice(-30) + base64.slice(0, -30);
}

// A JOY-02 file with only what getSongDuration reads: the metadata offset
// at byte 6, and the duration in seconds 18 bytes into the metadata.
function telop(durationSeconds: number): Buffer {
  const data = Buffer.alloc(32);
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

const movieUrls = async () => ({
  movie: { mov1: "https://example.invalid/mov1.mp4" },
});

const joysoundApi = (
  songData: () => Promise<{ telop: string; ogg: string }>,
  getMovieUrls = movieUrls,
) => ({ getSongRawData: songData, getMovieUrls });

const getFmeFails = async (): Promise<never> => {
  throw new Error("getFME failed");
};

const songData = async () => ({
  telop: scrambled(telop(183)),
  ogg: scrambled(ogg(183_456)),
});

const joysoundItem = (youtubeVideoId: string | null): JoysoundQueueItem => ({
  kind: "joysound",
  songId: "123456",
  name: "Song",
  artistName: "Artist",
  playtime: null,
  timestamp: "1",
  user: USER,
  isRomaji: false,
  youtubeVideoId,
});

test("a Joysound download without a background leaves its video and lyrics", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, "joysound", (item) =>
    joysoundJob(paths, item, joysoundApi(songData), joysoundItem(null)),
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.result.playtime, 183);
  assert.ok(outcome.item.progress > 0);
  assert.deepEqual(queue, []);
  assert.deepEqual(files(), [
    "joysound-123456-default.mp4",
    "joysound-123456.joy_02",
    "joysound-123456.log",
  ]);
});

test("a Joysound download with a YouTube background pads it and leaves only the song's files", async () => {
  // ffmpeg-ok says every video is 2 s long. A 5 s song is within 10 s of
  // that, so the background gets 3 s of its first frame in front.
  const shortSong = async () => ({
    telop: scrambled(telop(5)),
    ogg: scrambled(ogg(5_000)),
  });
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(queue, "joysound", (item) =>
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
    "joysound-123456-bgVideo0001.mp4",
    "joysound-123456.joy_02",
    "joysound-123456.log",
    "yt-bgVideo0001.log",
  ]);
});

test("a Joysound download that fails putting the video together leaves only its logs", async () => {
  paths.ffmpeg = fake("ffmpeg-fails");
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    "joysound",
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
  assert.deepEqual(files(), ["joysound-123456.log", "yt-bgVideo0001.log"]);
  assert.match(
    fs.readFileSync(path.join(folder, "joysound-123456.log"), "utf8"),
    /Invalid data found when processing input/,
  );
});

test("a failed Joysound background leaves the song's other backgrounds and lyrics", async () => {
  // The song with Joysound's own video, downloaded before.
  const done = await download([], "joysound", (item) =>
    joysoundJob(paths, item, joysoundApi(songData), joysoundItem(null)),
  );
  assert.ok(done.ok);

  paths.ffmpeg = fake("ffmpeg-fails");
  const outcome = await download(
    [],
    "joysound",
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
    "joysound-123456-default.mp4",
    "joysound-123456.joy_02",
    "joysound-123456.log",
    "yt-bgVideo0001.log",
  ]);
});

test("a Joysound background left half-done by a crash goes before it's downloaded again", async () => {
  const other = path.join(folder, "joysound-123456-default.mp4");
  fs.writeFileSync(other, "another background's video");
  fs.writeFileSync(path.join(folder, "joysound-123456.joy_02"), "lyrics");
  for (const name of [
    "joysound-123456-bgVideo0001.mp4",
    "joysound-123456-bgVideo0001.mp4.tmp",
    "joysound-123456-bgVideo0001-pad.mp4",
  ]) {
    fs.writeFileSync(path.join(folder, name), "half-done");
  }

  const outcome = await download([], "joysound", (item) =>
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
    "joysound-123456-bgVideo0001.mp4",
    "joysound-123456-default.mp4",
    "joysound-123456.joy_02",
    "joysound-123456.log",
    "yt-bgVideo0001.log",
  ]);
  assert.notEqual(
    fs.readFileSync(
      path.join(folder, "joysound-123456-bgVideo0001.mp4"),
      "utf8",
    ),
    "half-done",
  );
});

test("a Joysound download whose song data fails stops its background download", async () => {
  const queue: DownloadQueueItem[] = [];
  const outcome = await download(
    queue,
    "joysound",
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
  assert.deepEqual(files(), ["yt-bgVideo0001.log"]);
  assert.match(
    fs.readFileSync(path.join(folder, "yt-bgVideo0001.log"), "utf8"),
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
    "joysound",
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
