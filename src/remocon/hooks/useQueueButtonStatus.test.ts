// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  nextStatus,
  RESULT_MS,
  START_GRACE_MS,
  statusLabel,
  type QueueButtonStatus,
  type Seen,
} from "./useQueueButtonStatus";

const seen = (overrides: Partial<Seen> = {}): Seen => ({
  progress: null,
  failure: null,
  queued: false,
  ...overrides,
});
const downloading = (progress: number | null): QueueButtonStatus => ({
  is: "downloading",
  progress,
  eta: 252,
});

describe("nextStatus", () => {
  test("does nothing until the server answers", () => {
    for (const status of [{ is: "idle" }, { is: "waiting" }] as const) {
      assert.equal(nextStatus(status, seen()), null);
      assert.equal(nextStatus(status, seen({ progress: 0.5 })), null);
      assert.equal(nextStatus(status, seen({ queued: true })), null);
      assert.equal(
        nextStatus(status, seen({ failure: "Video unavailable" })),
        null,
      );
    }
  });

  test("follows the download's progress", () => {
    assert.deepEqual(nextStatus(downloading(null), seen({ progress: 0 })), {
      status: downloading(0),
      afterMs: 0,
    });
    assert.deepEqual(nextStatus(downloading(0), seen({ progress: 0.4256 })), {
      status: downloading(0.4256),
      afterMs: 0,
    });
    // The same progress: nothing to do (no render loop).
    assert.equal(
      nextStatus(downloading(0.4256), seen({ progress: 0.4256 })),
      null,
    );
  });

  test("at 100% it's still downloading until the download is gone", () => {
    // yt-dlp's video stream reaches 100% before the audio and the merge.
    assert.deepEqual(nextStatus(downloading(0.9), seen({ progress: 1 })), {
      status: downloading(1),
      afterMs: 0,
    });
    assert.deepEqual(nextStatus(downloading(1), seen()), {
      status: { is: "finished" },
      afterMs: 0,
    });
    assert.deepEqual(nextStatus(downloading(0.99), seen({ queued: true })), {
      status: { is: "finished" },
      afterMs: 0,
    });
  });

  test("a song queued without a download (downloaded before) says it's queued", () => {
    assert.deepEqual(nextStatus(downloading(null), seen({ queued: true })), {
      status: { is: "queued", eta: 252 },
      afterMs: 0,
    });
  });

  test("gives a download that never shows up a few seconds", () => {
    assert.deepEqual(nextStatus(downloading(null), seen()), {
      status: { is: "finished" },
      afterMs: START_GRACE_MS,
    });
  });

  test("says why a download failed", () => {
    for (const progress of [null, 0.426]) {
      assert.deepEqual(
        nextStatus(
          downloading(progress),
          seen({ failure: "Video unavailable" }),
        ),
        { status: { is: "failed", reason: "Video unavailable" }, afterMs: 0 },
      );
    }
  });

  test("shows the result for a while, then idle again", () => {
    const results: QueueButtonStatus[] = [
      { is: "finished" },
      { is: "error", reason: "e2e already has 1 song(s)" },
      { is: "failed", reason: "Video unavailable" },
      { is: "queued", eta: 252 },
    ];
    for (const status of results) {
      for (const now of [
        seen(),
        // A failure stays listed for a while; it doesn't hold the result.
        seen({ failure: "Video unavailable" }),
        seen({ queued: true }),
      ]) {
        assert.deepEqual(nextStatus(status, now), {
          status: { is: "idle" },
          afterMs: RESULT_MS,
        });
      }
    }
  });
});

describe("statusLabel", () => {
  test("says each status in words", () => {
    const label = (status: QueueButtonStatus) =>
      statusLabel(status, "Queue video");
    assert.equal(label({ is: "idle" }), "Queue video");
    assert.equal(label({ is: "waiting" }), "Waiting for server");
    assert.equal(label(downloading(null)), "Downloading");
    assert.equal(label(downloading(0.4256)), "Downloading 42.6%");
    assert.equal(label(downloading(1)), "Downloading 100.0%");
    assert.equal(label({ is: "finished" }), "Downloaded");
    assert.equal(
      label({ is: "failed", reason: "Video unavailable" }),
      "Couldn't download: Video unavailable",
    );
    assert.equal(
      label({ is: "error", reason: "Invalid song ID" }),
      "Couldn't queue: Invalid song ID",
    );
    assert.equal(label({ is: "queued", eta: 252 }), "Queued, up in 4:12");
  });
});
