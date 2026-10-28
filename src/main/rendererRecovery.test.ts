// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCrashReloads } from "./rendererRecovery";

test("a crash on every load stops reloading after the third", () => {
  let now = 0;
  const reloads = createCrashReloads(() => now);
  // Each reload crashes again a moment after its wait.
  assert.equal(reloads.crashed(), 1_000);
  now += 1_500;
  assert.equal(reloads.crashed(), 3_000);
  now += 3_500;
  assert.equal(reloads.crashed(), null);
  now += 500;
  assert.equal(reloads.crashed(), null);
});

test("crashes far apart each reload after a second", () => {
  let now = 0;
  const reloads = createCrashReloads(() => now);
  for (let i = 0; i < 5; i++) {
    assert.equal(reloads.crashed(), 1_000);
    now += 61_000;
  }
});

test("a reload the host asks for counts afresh", () => {
  let now = 0;
  const reloads = createCrashReloads(() => now);
  reloads.crashed();
  reloads.crashed();
  assert.equal(reloads.crashed(), null);
  reloads.reset();
  now += 100;
  assert.equal(reloads.crashed(), 1_000);
});
