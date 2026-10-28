// Runs on Node's test runner through tsx (yarn test:unit), in a temp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  clearFolder,
  deleteDamVideo,
  folderInfo,
  moveOldQueue,
  moveOldSongFiles,
  sweepHalfDone,
} from "./folder";

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-folder-"));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

// Writes the files, each `bytes` long.
function write(bytes: number, ...names: string[]) {
  for (const name of names) {
    fs.writeFileSync(path.join(folder, name), "x".repeat(bytes));
  }
}

const files = () => fs.readdirSync(folder).sort();

test("counts every file, not folders", () => {
  write(10, "yt-abc.mp4", "yt-abc.log", "1234-56-0.mp4");
  fs.mkdirSync(path.join(folder, "a folder"));
  assert.deepEqual(folderInfo(folder), { files: 3, bytes: 30 });
});

test("a folder that isn't there holds nothing", () => {
  assert.deepEqual(folderInfo(path.join(folder, "missing")), {
    files: 0,
    bytes: 0,
  });
  assert.deepEqual(clearFolder(path.join(folder, "missing"), []), {
    deleted: 0,
    bytes: 0,
    kept: 0,
  });
});

test("clearing keeps the files in use", () => {
  write(
    10,
    // A DAM song playing, and its log.
    "1234-56-0.mp4",
    "dam-1234-56-0.log",
    // The same song at another streaming URL, which isn't.
    "1234-56-1.mp4",
    "dam-1234-56-1.log",
    // A Joysound song downloading with a YouTube background.
    "joysound-777.joy_02",
    "joysound-777-bg.log",
    "joysound-777-bg.mp4.tmp",
    "joysound-777-bg-no-sound.mp4",
    // Another Joysound song, and the same one's own video.
    "joysound-7770-default.mp4",
    "joysound-777-default.mp4",
    // YouTube and Niconico videos.
    "yt-abc.mp4",
    "yt-abc.vtt",
    "yt-abcd.mp4",
    "nico-sm9.mp4",
  );

  const result = clearFolder(folder, [
    { kind: "dam", songId: "1234-56", suffix: "0" },
    { kind: "joysound", songId: "777", suffix: "bg" },
    { kind: "youtube", songId: "abc", suffix: null },
  ]);

  assert.deepEqual(result, { deleted: 6, bytes: 60, kept: 8 });
  assert.deepEqual(files(), [
    "1234-56-0.mp4",
    "dam-1234-56-0.log",
    "joysound-777-bg-no-sound.mp4",
    "joysound-777-bg.log",
    "joysound-777-bg.mp4.tmp",
    "joysound-777.joy_02",
    "yt-abc.mp4",
    "yt-abc.vtt",
  ]);
});

test("deleteDamVideo deletes one DAM song's video", () => {
  write(10, "1234-56-0.mp4", "1234-56-1.mp4", "dam-1234-56-0.log");
  assert.equal(deleteDamVideo(folder, "1234-56", "0"), true);
  assert.equal(deleteDamVideo(folder, "1234-56", "0"), false);
  assert.deepEqual(files(), ["1234-56-1.mp4", "dam-1234-56-0.log"]);
});

test("an older version's saved queue moves once, with its songs' files", () => {
  const old = path.join(folder, "karafriends_tmp");
  const userData = path.join(folder, "userData");
  const queueFile = path.join(userData, "queue.json");
  const downloads = path.join(userData, "downloads");
  fs.mkdirSync(old);
  for (const name of [
    "queue.json",
    "yt-abc.mp4",
    "yt-abc.vtt",
    "yt-abc.log",
    "1234-56-0.mp4",
    // Not a queued song's.
    "yt-old.mp4",
  ]) {
    fs.writeFileSync(path.join(old, name), name);
  }

  assert.equal(moveOldQueue(old, queueFile), true);
  assert.equal(fs.readFileSync(queueFile, "utf8"), "queue.json");
  moveOldSongFiles(old, downloads, [
    { kind: "youtube", songId: "abc", suffix: null },
    { kind: "dam", songId: "1234-56", suffix: "0" },
  ]);
  assert.deepEqual(fs.readdirSync(downloads).sort(), [
    "1234-56-0.mp4",
    "yt-abc.log",
    "yt-abc.mp4",
    "yt-abc.vtt",
  ]);
  assert.deepEqual(fs.readdirSync(old), ["yt-old.mp4"]);

  // Once: a queue saved since stays.
  fs.writeFileSync(path.join(old, "queue.json"), "an older one");
  fs.writeFileSync(queueFile, "saved since");
  assert.equal(moveOldQueue(old, queueFile), false);
  assert.equal(fs.readFileSync(queueFile, "utf8"), "saved since");
  // And none to move is fine.
  assert.equal(moveOldQueue(path.join(folder, "missing"), queueFile), false);
});

test("sweepHalfDone deletes what unfinished downloads left, and keeps the rest", () => {
  write(
    10,
    // Finished: videos, captions, lyrics and logs.
    "1234-56-0.mp4",
    "dam-1234-56-0.log",
    "yt-abc.mp4",
    "yt-abc.vtt",
    "yt-abc.log",
    "nico-sm9.mp4",
    "joysound-777.joy_02",
    "joysound-777-default.mp4",
    "joysound-777-bg.yt.log",
    // A DAM copy stopped halfway.
    "1234-56-1.mp4.tmp",
    // yt-dlp's parts, of a download that failed or timed out.
    "yt-def.mp4.part",
    "yt-def.f137.mp4",
    "yt-def.mp4.ytdl",
    "nico-sm10.f1.mp4",
    // A Joysound background stopped while padding: its video is there but
    // not whole.
    "joysound-777-bg.mp4.tmp",
    "joysound-777-bg.mp4",
    "joysound-777-bg-pad.mp4",
    "joysound-777-bg.source.mp4",
  );

  assert.equal(sweepHalfDone(folder), 9);
  assert.deepEqual(files(), [
    "1234-56-0.mp4",
    "dam-1234-56-0.log",
    "joysound-777-bg.yt.log",
    "joysound-777-default.mp4",
    "joysound-777.joy_02",
    "nico-sm9.mp4",
    "yt-abc.log",
    "yt-abc.mp4",
    "yt-abc.vtt",
  ]);
  assert.equal(sweepHalfDone(path.join(folder, "missing")), 0);
});
