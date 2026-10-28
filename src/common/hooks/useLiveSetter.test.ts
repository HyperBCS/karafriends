// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { createLiveSetter, SETTLE_MS } from "./useLiveSetter";

// The requests sent, each answered when the test says.
let sent: {
  value: number;
  song: string;
  answer: (output: unknown) => void;
  fail: (err: Error) => void;
}[];
let errors: unknown[];

const setter = () =>
  createLiveSetter<number, [song: string]>({
    send: (value, song) =>
      new Promise((resolve, reject) =>
        sent.push({ value, song, answer: resolve, fail: reject }),
      ),
    onError: (err) => errors.push(err),
  });

// Lets the answers' then() callbacks run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  sent = [];
  errors = [];
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => mock.timers.reset());

describe("createLiveSetter", () => {
  test("quick taps build on each other: an earlier tap's echo doesn't undo a later one", async () => {
    const key = setter();
    key.noteLive(0);
    // ♯, ♯ quickly: the second waits for the first's answer.
    key.set(1, "a@1");
    key.set(2, "a@1");
    assert.equal(key.shown(0), 2);
    assert.deepEqual(
      sent.map((r) => r.value),
      [1],
    );
    // The live state's echo of the first tap.
    key.noteLive(1);
    assert.equal(key.shown(1), 2);
    // The first is answered, and the second goes.
    sent[0].answer(true);
    await settle();
    assert.deepEqual(
      sent.map((r) => r.value),
      [1, 2],
    );
    assert.equal(key.shown(1), 2);
    // A third tap builds on 2, not on the echo's 1.
    key.set(key.shown(1) + 1, "a@1");
    sent[1].answer(true);
    await settle();
    assert.deepEqual(
      sent.map((r) => r.value),
      [1, 2, 3],
    );
    key.noteLive(2);
    assert.equal(key.shown(2), 3);
    sent[2].answer(true);
    await settle();
    key.noteLive(3);
    assert.equal(key.pending(), null);
    assert.equal(key.shown(3), 3);
  });

  test("each set goes, in order, once the one before is answered", async () => {
    const queue = setter();
    queue.noteLive(0);
    queue.set(1, "a@1");
    queue.set(2, "a@1");
    queue.set(3, "b@2");
    for (const request of [0, 1]) {
      sent[request].answer(true);
      await settle();
    }
    assert.deepEqual(
      sent.map((r) => [r.value, r.song]),
      [
        [1, "a@1"],
        [2, "a@1"],
        [3, "b@2"],
      ],
    );
    assert.equal(queue.shown(0), 3);
  });

  test("answered, it gives way to the live value once that has it", async () => {
    const key = setter();
    key.noteLive(0);
    key.set(1, "a@1");
    // The echo came before the answer.
    key.noteLive(1);
    sent[0].answer(true);
    await settle();
    assert.equal(key.pending(), null);
  });

  test("answered, the next live change wins, or the live value after a while", async () => {
    const key = setter();
    key.noteLive(0);
    key.set(1, "a@1");
    sent[0].answer(true);
    await settle();
    // Someone else's change, after this page's was answered.
    key.noteLive(-2);
    assert.equal(key.shown(-2), -2);

    // The server went back to the value shown before within one of the
    // hub's 250 ms windows, so no change comes: the live value, in a while.
    key.set(5, "a@1");
    sent[1].answer(true);
    await settle();
    assert.equal(key.shown(-2), 5);
    mock.timers.tick(SETTLE_MS);
    assert.equal(key.shown(-2), -2);
  });

  test("a request the server refuses or that fails gives the live value back", async () => {
    const key = setter();
    key.noteLive(0);
    // For a song that has ended.
    key.set(1, "old@1");
    sent[0].answer(false);
    await settle();
    assert.equal(key.pending(), null);
    assert.deepEqual(errors, []);

    key.set(2, "a@1");
    sent[1].fail(new Error("403"));
    await settle();
    assert.equal(key.pending(), null);
    assert.equal(errors.length, 1);
  });

  test("tells its listener when what it shows changes", async () => {
    const key = setter();
    let calls = 0;
    const stop = key.subscribe(() => calls++);
    key.noteLive(0);
    key.set(1, "a@1");
    assert.equal(calls, 1);
    sent[0].answer(false);
    await settle();
    assert.equal(calls, 2);
    stop();
    key.set(2, "a@1");
    assert.equal(calls, 2);
  });
});
