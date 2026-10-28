// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { secondsLeft, secondsPlayed, songKey } from "./currentSong";

const timing = (
  currentSongStartedAt: number | null,
  currentSongPausedSince: number | null = null,
) => ({ currentSongStartedAt, currentSongPausedSince });

describe("songKey", () => {
  test("is songId@timestamp", () => {
    assert.equal(songKey({ songId: "sm9", timestamp: "1700" }), "sm9@1700");
  });
});

describe("secondsPlayed", () => {
  test("is 0 until the song starts, then follows the clock in whole seconds", () => {
    assert.equal(secondsPlayed(245, timing(null), 99_000), 0);
    assert.equal(secondsPlayed(245, timing(1000), 1000), 0);
    assert.equal(secondsPlayed(245, timing(1000), 73_400), 72);
    // After the display reports a seek to 2:00 at 80 s.
    assert.equal(secondsPlayed(245, timing(80_000 - 120_000), 81_000), 121);
  });

  test("stands still while paused, and stops at the end", () => {
    assert.equal(secondsPlayed(245, timing(1000, 31_000), 31_000), 30);
    assert.equal(secondsPlayed(245, timing(1000, 31_000), 99_000), 30);
    assert.equal(secondsPlayed(245, timing(1000), 999_000), 245);
  });
});

describe("secondsLeft", () => {
  test("never goes below 0, or above the playtime", () => {
    // Past its playtime (a long intro, a slow start).
    assert.equal(secondsLeft(100, timing(1000), 500_000), 0);
    // A phone whose clock is behind the server's.
    assert.equal(secondsLeft(100, timing(1000), 0), 100);
    assert.equal(secondsLeft(100, timing(1000), 21_400), 80);
  });
});
