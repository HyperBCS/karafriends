// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { marqueeTiming } from "./useMarquee";

describe("marqueeTiming", () => {
  test("a line that fits stays still", () => {
    assert.equal(marqueeTiming(0, 32), null);
    assert.equal(marqueeTiming(-120, 32), null);
    // Less than a pixel over is rounding, not text cut off.
    assert.equal(marqueeTiming(0.5, 32), null);
    assert.equal(marqueeTiming(Number.NaN, 32), null);
  });

  test("slides the whole overflow, then holds a second at each end", () => {
    // 64 px at 32 px a second: 2 s sliding and 2 s still, a second at
    // each end of the one way (alternate makes it 2 s at each end).
    assert.deepEqual(marqueeTiming(64, 32), {
      shift: 64,
      duration: 4,
      hold: 25,
    });
    // A part of a pixel over rounds up, so the end shows whole.
    assert.equal(marqueeTiming(63.2, 32)?.shift, 64);
  });

  test("the time grows with the distance, the pause doesn't", () => {
    const short = marqueeTiming(32, 32)!;
    const long = marqueeTiming(320, 32)!;
    assert.equal(short.duration, 3);
    assert.equal(long.duration, 12);
    // Still for a second at each end, whatever the length.
    for (const { hold, duration } of [short, long]) {
      assert.equal(Math.round(hold * duration), 100);
    }
  });

  test("goes at the speed it's given (the display's 4K is twice 1080p)", () => {
    assert.equal(marqueeTiming(128, 64)!.duration, 4);
    assert.equal(marqueeTiming(128, 32)!.duration, 6);
  });

  test("keeps the running duration for a change of a pixel or two", () => {
    const running = marqueeTiming(320, 32)!;
    // A countdown beside it grew: 2 px more to slide.
    assert.deepEqual(marqueeTiming(322, 32, running), {
      ...running,
      shift: 322,
    });
    // Twice as far is a new timing.
    assert.deepEqual(
      marqueeTiming(640, 32, running),
      marqueeTiming(640, 32, null),
    );
    // And one that fits again stops.
    assert.equal(marqueeTiming(0, 32, running), null);
  });

  test("durations and holds are rounded to hundredths", () => {
    const timing = marqueeTiming(100, 32)!;
    assert.equal(timing.duration, 5.13);
    assert.equal(timing.hold, 19.49);
  });
});
