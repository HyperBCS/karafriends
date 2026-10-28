// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dropIndex, slideOf } from "./useDragReorder";

// Four 72px rows from y = 0: middles 36, 108, 180, 252.
const H = 72;
const MIDDLES = [36, 108, 180, 252];

describe("dropIndex", () => {
  test("a row held where it started stays put", () => {
    for (const [from, middle] of MIDDLES.entries()) {
      assert.equal(dropIndex(middle, H, MIDDLES, from), from);
    }
  });

  test("leaves the dragged row's own middle out", () => {
    // The third row (middle 180) nudged down: its bottom edge is past its
    // own old middle, which doesn't count.
    assert.equal(dropIndex(200, H, MIDDLES, 2), 2);
    assert.equal(dropIndex(160, H, MIDDLES, 2), 2);
  });

  test("swaps with a neighbour once it's halfway over it", () => {
    // The third row up: its top edge past the second row's middle (108)
    // after 36px, then past the first's (36).
    assert.equal(dropIndex(145, H, MIDDLES, 2), 2);
    assert.equal(dropIndex(143, H, MIDDLES, 2), 1);
    assert.equal(dropIndex(73, H, MIDDLES, 2), 1);
    assert.equal(dropIndex(71, H, MIDDLES, 2), 0);
    // The first row down: its bottom edge past the second's middle, then
    // the fourth's (252).
    assert.equal(dropIndex(71, H, MIDDLES, 0), 0);
    assert.equal(dropIndex(73, H, MIDDLES, 0), 1);
    assert.equal(dropIndex(215, H, MIDDLES, 0), 2);
    assert.equal(dropIndex(217, H, MIDDLES, 0), 3);
  });

  test("stays within the list past either end", () => {
    assert.equal(dropIndex(-500, H, MIDDLES, 3), 0);
    assert.equal(dropIndex(5000, H, MIDDLES, 0), 3);
  });

  test("a list of one goes nowhere", () => {
    assert.equal(dropIndex(-500, H, [36], 0), 0);
    assert.equal(dropIndex(500, H, [36], 0), 0);
  });
});

describe("slideOf", () => {
  test("rows between move up when a row goes down", () => {
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => slideOf(i, 0, 2, 72)),
      [0, -72, -72, 0],
    );
  });

  test("rows between move down when a row goes up", () => {
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => slideOf(i, 2, 0, 72)),
      [72, 72, 0, 0],
    );
  });

  test("nothing moves while the row is over its own place", () => {
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => slideOf(i, 1, 1, 72)),
      [0, 0, 0, 0],
    );
  });
});
