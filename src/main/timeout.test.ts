// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  test("passes on the outcome in time", async () => {
    assert.equal(await withTimeout(Promise.resolve(1), 1000, "one"), 1);
    await assert.rejects(
      withTimeout(Promise.reject(new Error("no")), 1000, "one"),
      /^Error: no$/,
    );
  });

  test("rejects with a TimeoutError naming what it waited for", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 10, "DAM's scoring data"),
      (err) =>
        err instanceof TimeoutError &&
        err.message === "DAM's scoring data timed out after 10ms",
    );
  });
});
