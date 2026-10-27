// Runs on Node's test runner through tsx (yarn test:unit). The "tool" that
// hangs is Node itself, run with a script that never ends.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { REASONS } from "../../common/downloadFailure";
import type { DownloadQueueItem } from "../state";
import { runDownload } from "./queue";
import { runTool, type ToolRun } from "./run";

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-run-"));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const hangs = (): ToolRun => ({
  label: "node (hangs)",
  bin: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  logFilename: path.join(folder, "hangs.log"),
  reasonForExit: () => REASONS.other,
});

test("a tool that runs too long fails its download as timed out", async () => {
  const queue: DownloadQueueItem[] = [];
  const reason = await new Promise<string>((resolve, reject) =>
    runDownload(
      queue,
      {
        kind: "youtube",
        songId: "jNQXAC9IVRw",
        suffix: null,
        userIdentity: { nickname: "test", deviceId: "test-device" },
      },
      "test download",
      () => runTool({ ...hangs(), timeoutMs: 300 }),
      () => reject(new Error("it finished")),
      () => {},
      resolve,
    ),
  );

  assert.equal(reason, REASONS.timedOut);
  assert.equal(queue[0].status, "failed");
  assert.equal(queue[0].reason, REASONS.timedOut);
  assert.match(
    fs.readFileSync(path.join(folder, "hangs.log"), "utf8"),
    /took longer than 0.3 s/,
  );
});

test("an aborted tool is stopped, and fails once it has exited", async () => {
  const stop = new AbortController();
  const run = runTool({ ...hangs(), signal: stop.signal });
  setTimeout(() => stop.abort(), 300);
  await assert.rejects(run, /was stopped/);
});

test("a tool aborted before it starts doesn't start", async () => {
  await assert.rejects(
    runTool({ ...hangs(), signal: AbortSignal.abort() }),
    /was stopped/,
  );
});
