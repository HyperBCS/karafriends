// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DOWNLOADING,
  FINISHED,
  nextDownloadText,
  RESULT_MS,
  START_GRACE_MS,
  WAITING_FOR_SERVER,
} from "./useDownloadButtonText";

const DEFAULT = "Queue video";
const next = (text: string, progress: number | null) =>
  nextDownloadText(text, progress, DEFAULT);

describe("nextDownloadText", () => {
  test("does nothing until the server says it's downloading", () => {
    assert.equal(next(DEFAULT, null), null);
    assert.equal(next(DEFAULT, 0.5), null);
    assert.equal(next(WAITING_FOR_SERVER, 0.5), null);
  });

  test("follows the download's progress", () => {
    assert.deepEqual(next(DOWNLOADING, 0), {
      text: "Downloading -- 0.0%",
      afterMs: 0,
    });
    assert.deepEqual(next("Downloading -- 0.0%", 0.4256), {
      text: "Downloading -- 42.6%",
      afterMs: 0,
    });
    assert.deepEqual(next("Downloading -- 42.6%", 1), {
      text: FINISHED,
      afterMs: 0,
    });
  });

  test("finishes when the download is gone", () => {
    assert.deepEqual(next("Downloading -- 99.0%", null), {
      text: FINISHED,
      afterMs: 0,
    });
  });

  test("gives a download that never shows up a few seconds", () => {
    assert.deepEqual(next(DOWNLOADING, null), {
      text: FINISHED,
      afterMs: START_GRACE_MS,
    });
  });

  test("shows the result for a while, then the default text", () => {
    for (const text of [FINISHED, "Error: e2e already has 1 song(s)"]) {
      assert.deepEqual(next(text, null), {
        text: DEFAULT,
        afterMs: RESULT_MS,
      });
    }
  });
});
