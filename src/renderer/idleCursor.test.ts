// Runs on Node's test runner through tsx (yarn test:unit), with mock timers.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HIDE_AFTER_MS, watchIdleCursor } from "./idleCursor";

function watch() {
  const target = new EventTarget();
  const calls: boolean[] = [];
  const stop = watchIdleCursor(target, (hidden) => calls.push(hidden));
  const move = (type = "mousemove") => target.dispatchEvent(new Event(type));
  return { calls, stop, move };
}

describe("the display's mouse pointer", () => {
  test("hides once the mouse has been still, and shows when it moves", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, move } = watch();
    t.mock.timers.tick(HIDE_AFTER_MS - 1);
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    assert.deepEqual(calls, [true]);
    move();
    assert.deepEqual(calls, [true, false]);
    t.mock.timers.tick(HIDE_AFTER_MS);
    assert.deepEqual(calls, [true, false, true]);
  });

  test("each move, click or scroll waits again from then", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, move } = watch();
    for (const type of ["mousemove", "mousedown", "wheel"]) {
      t.mock.timers.tick(HIDE_AFTER_MS - 100);
      move(type);
    }
    t.mock.timers.tick(HIDE_AFTER_MS - 100);
    // Shown all along: nothing to say.
    assert.deepEqual(calls, []);
    t.mock.timers.tick(100);
    assert.deepEqual(calls, [true]);
  });

  test("stopping shows it, and nothing after", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, stop, move } = watch();
    t.mock.timers.tick(HIDE_AFTER_MS);
    stop();
    assert.deepEqual(calls, [true, false]);
    move();
    t.mock.timers.tick(HIDE_AFTER_MS * 2);
    assert.deepEqual(calls, [true, false]);
  });
});
