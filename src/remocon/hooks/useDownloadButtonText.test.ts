// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  downloadButtonLabel,
  DOWNLOADING,
  FAILED,
  FINISHED,
  nextDownloadText,
  QUEUED,
  RESULT_MS,
  START_GRACE_MS,
  WAITING_FOR_SERVER,
} from "./useDownloadButtonText";

const DEFAULT = "Queue video";
const next = (
  text: string,
  progress: number | null,
  failure: string | null = null,
) => nextDownloadText(text, progress, DEFAULT, failure);

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

  test("says why a download failed", () => {
    for (const text of [DOWNLOADING, "Downloading -- 42.6%"]) {
      assert.deepEqual(next(text, null, "Video unavailable"), {
        text: `${FAILED}: Video unavailable`,
        afterMs: 0,
      });
    }
    assert.equal(FAILED, "Couldn't download");
  });

  test("ignores a failure it isn't waiting on", () => {
    assert.equal(next(DEFAULT, null, "Video unavailable"), null);
    assert.equal(next(WAITING_FOR_SERVER, null, "Video unavailable"), null);
  });

  test("shows the result for a while, then the default text", () => {
    for (const text of [
      FINISHED,
      "Error: e2e already has 1 song(s)",
      `${FAILED}: Video unavailable`,
      `${QUEUED}: 4:12`,
    ]) {
      assert.deepEqual(next(text, null), {
        text: DEFAULT,
        afterMs: RESULT_MS,
      });
      // A failure stays listed for a while; it doesn't hold the text.
      assert.deepEqual(next(text, null, "Video unavailable"), {
        text: DEFAULT,
        afterMs: RESULT_MS,
      });
    }
  });
});

describe("downloadButtonLabel", () => {
  test("says each state in words", () => {
    assert.equal(downloadButtonLabel(WAITING_FOR_SERVER), "Waiting for server");
    assert.equal(downloadButtonLabel(DOWNLOADING), "Downloading");
    assert.equal(
      downloadButtonLabel("Downloading -- 42.6%"),
      "Downloading 42.6%",
    );
    assert.equal(downloadButtonLabel(FINISHED), "Downloaded");
    assert.equal(
      downloadButtonLabel(`${FAILED}: Video unavailable`),
      "Couldn't download: Video unavailable",
    );
    assert.equal(
      downloadButtonLabel("Error: e2e already has 1 song(s)"),
      "Not queued: e2e already has 1 song(s)",
    );
    assert.equal(downloadButtonLabel(`${QUEUED}: 4:12`), "Queued, up in 4:12");
  });

  test("leaves the button's own label alone", () => {
    assert.equal(downloadButtonLabel("Queue song"), "Queue song");
  });
});
