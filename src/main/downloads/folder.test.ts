// Runs on Node's test runner through tsx (yarn test:unit), in a temp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { clearFolder, deleteDamVideo, folderInfo } from "./folder";

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

test("counts every file but the saved queue's", () => {
  write(10, "yt-abc.mp4", "yt-abc.log", "1234-56-0.mp4");
  write(1000, "queue.json", "queue.json.tmp");
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

test("clearing keeps the saved queue and the files in use", () => {
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
  write(5, "queue.json");

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
    "queue.json",
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
