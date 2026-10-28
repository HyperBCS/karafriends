// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { SharedReads } from "./guideMelodyReads";

// A read that finishes when told to, and records its signal.
function controlledRead() {
  const reads: {
    signal: AbortSignal;
    resolve: (value: string) => void;
    reject: (err: Error) => void;
  }[] = [];
  const read = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      reads.push({ signal, resolve, reject });
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  return { reads, read };
}

describe("the guide melodies' reads", () => {
  test("a song's melody is read once, and kept for the next time", async () => {
    const cache = new SharedReads<string>(8);
    const { reads, read } = controlledRead();
    const first = cache.use("song", read);
    const second = cache.use("song", read);
    assert.equal(reads.length, 1);
    reads[0].resolve("notes");
    assert.equal(await first.result, "notes");
    assert.equal(await second.result, "notes");
    first.release();
    second.release();
    await sleep(5);
    // Sung again.
    const again = cache.use("song", read);
    assert.equal(reads.length, 1);
    assert.equal(await again.result, "notes");
    assert.equal(reads[0].signal.aborted, false);
  });

  test("a skip before it's read cancels it, and the next use reads again", async () => {
    const cache = new SharedReads<string>(8);
    const { reads, read } = controlledRead();
    const skipped = cache.use("song", read);
    skipped.result.catch(() => {});
    skipped.release();
    await sleep(5);
    assert.equal(reads[0].signal.aborted, true);
    await assert.rejects(skipped.result);

    const later = cache.use("song", read);
    assert.equal(reads.length, 2);
    reads[1].resolve("notes");
    assert.equal(await later.result, "notes");
  });

  test("released and used again at once (StrictMode), it's one read", async () => {
    const cache = new SharedReads<string>(8);
    const { reads, read } = controlledRead();
    cache.use("song", read).release();
    const used = cache.use("song", read);
    await sleep(5);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].signal.aborted, false);
    reads[0].resolve("notes");
    assert.equal(await used.result, "notes");
  });

  test("it's cancelled only when nobody wants it; a second release does nothing", async () => {
    const cache = new SharedReads<string>(8);
    const { reads, read } = controlledRead();
    const one = cache.use("song", read);
    const two = cache.use("song", read);
    one.release();
    one.release();
    await sleep(5);
    assert.equal(reads[0].signal.aborted, false);
    two.release();
    await sleep(5);
    assert.equal(reads[0].signal.aborted, true);
  });

  test("a failed read isn't kept", async () => {
    const cache = new SharedReads<string>(8);
    const { reads, read } = controlledRead();
    const failed = cache.use("song", read);
    reads[0].reject(new Error("can't decode"));
    await assert.rejects(failed.result, /can't decode/);
    cache.use("song", read);
    assert.equal(reads.length, 2);
  });

  test("only the last few finished reads are kept", async () => {
    const cache = new SharedReads<string>(2);
    const { reads, read } = controlledRead();
    for (const song of ["a", "b", "c"]) {
      const used = cache.use(song, read);
      reads.at(-1)!.resolve(song);
      await used.result;
      used.release();
    }
    assert.equal(reads.length, 3);
    // "a" was forgotten; "b" and "c" are kept.
    void cache.use("c", read).result;
    void cache.use("b", read).result;
    assert.equal(reads.length, 3);
    cache.use("a", read);
    assert.equal(reads.length, 4);
  });
});
