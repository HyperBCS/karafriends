// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SharedQueueItem } from "../api";
import { withETAs } from "./useQueue";

const song = (n: number, playtime: number | null = 60): SharedQueueItem => ({
  kind: "nico",
  songId: `sm${n}`,
  name: `Song ${n}`,
  artistName: "Artist",
  playtime,
  timestamp: String(n),
  user: { nickname: "n" },
  isMine: false,
});

describe("withETAs", () => {
  test("adds up the playtimes before each song, from the current one", () => {
    assert.deepEqual(
      withETAs(song(0, 100), [song(1, 60), song(2, null), song(3)]).map(
        ([item, eta]) => [item.songId, eta],
      ),
      [
        ["sm1", 100],
        ["sm2", 160],
        ["sm3", 160],
      ],
    );
    assert.deepEqual(withETAs(null, []), []);
    assert.equal(withETAs(null, [song(1)])[0][1], 0);
  });

  const timing = (
    currentSongStartedAt: number | null,
    currentSongPausedMs = 0,
    currentSongPausedSince: number | null = null,
  ) => ({ currentSongStartedAt, currentSongPausedMs, currentSongPausedSince });
  const etas = (...args: [ReturnType<typeof timing>, number]) =>
    withETAs(song(0, 100), [song(1, 60), song(2)], ...args).map(
      ([, eta]) => eta,
    );

  test("takes off what the current song has played", () => {
    assert.deepEqual(etas(timing(1000), 1000), [100, 160]);
    assert.deepEqual(etas(timing(1000), 31_000), [70, 130]);
    // Less the 10 s it was paused.
    assert.deepEqual(etas(timing(1000, 10_000), 31_000), [80, 140]);
  });

  test("stands still while paused", () => {
    const paused = timing(1000, 10_000, 21_000);
    assert.deepEqual(etas(paused, 21_000), [90, 150]);
    assert.deepEqual(etas(paused, 99_000), [90, 150]);
  });

  test("never goes below 0, or above the playtime", () => {
    // Past its playtime (a long intro, a slow start): next is next.
    assert.deepEqual(etas(timing(1000), 500_000), [0, 60]);
    // A phone whose clock is behind the display's.
    assert.deepEqual(etas(timing(1000), 0), [100, 160]);
  });

  test("with no song playing, or no time, as if it had just started", () => {
    assert.deepEqual(etas(timing(null), 31_000), [100, 160]);
    assert.deepEqual(
      withETAs(song(0, 100), [song(1)], timing(1000)).map(([, eta]) => eta),
      [100],
    );
  });
});
