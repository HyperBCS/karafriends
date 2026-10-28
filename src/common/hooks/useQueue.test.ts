// Runs on Node's test runner through tsx (yarn test:unit). The countdown's
// own sums are secondsPlayed's (src/common/currentSong.test.ts).
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
});
