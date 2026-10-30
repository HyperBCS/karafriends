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
import {
  LINUX_CERTIFICATES,
  MAC_CERTIFICATES,
  parseDuration,
  runTool,
  stopAllTools,
  useSystemCertificates,
  type ToolRun,
} from "./run";

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
      {
        description: "test download",
        job: () => runTool({ ...hangs(), timeoutMs: 300 }),
        onReady: () => reject(new Error("it finished")),
        onFailed: resolve,
      },
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

test("a timeout stops what the tool started too", async () => {
  // A script that waits in a process it started, as a .cmd wrapper waits
  // in yt-dlp. That process holds the output open, so the run can't end
  // until it's stopped as well; it would wait 60 s.
  const started = Date.now();
  const run = runTool({
    ...hangs(),
    label: "hangs",
    bin: path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "tests",
      "fixtures",
      "bin",
      process.platform === "win32" ? "hangs.cmd" : "hangs",
    ),
    args: [],
    timeoutMs: 500,
  });
  await assert.rejects(run, /took longer than 0.5 s/);
  assert.ok(Date.now() - started < 20_000);
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

test("a tool's output reaches onStdout and onStderr a line at a time", async () => {
  // As ffmpeg writes its Duration line: in pieces. Progress lines end in
  // "\r", and the last line in nothing.
  const script = `
    process.stderr.write("  Duration: ");
    setTimeout(() => {
      process.stderr.write("00:04:01.52, start: 0.000000\\n");
      process.stderr.write("frame=   30\\rframe=   60\\r");
      process.stdout.write("[download]  50.0%\\n[download] 100.0%");
    }, 200);
  `;
  const stderr: string[] = [];
  const stdout: string[] = [];
  await runTool({
    ...hangs(),
    label: "node (writes lines)",
    args: ["-e", script],
    onStderr: (line) => stderr.push(line),
    onStdout: (line) => stdout.push(line),
  });
  assert.deepEqual(stderr, [
    "  Duration: 00:04:01.52, start: 0.000000",
    "frame=   30",
    "frame=   60",
  ]);
  assert.deepEqual(stdout, ["[download]  50.0%", "[download] 100.0%"]);
  assert.equal(parseDuration(stderr[0]), 241.52);
});

test("stopAllTools stops every tool running", async () => {
  const runs = [
    runTool({ ...hangs(), label: "first" }),
    runTool({ ...hangs(), label: "second", logFilename: `${folder}/2.log` }),
  ];
  // Started, so there are processes to stop.
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopAllTools();
  await Promise.all(runs.map((run) => assert.rejects(run, /was stopped/)));
  // None left to stop: a tool that ran to the end isn't stopped later.
  await runTool({ ...hangs(), args: ["-e", ""] });
  stopAllTools();
});

test("on macOS the tools get the system's certificates, unless SSL_CERT_FILE is set", () => {
  const there = () => true;
  const env: NodeJS.ProcessEnv = {};
  useSystemCertificates(env, "darwin", there);
  assert.equal(env.SSL_CERT_FILE, MAC_CERTIFICATES);

  const own: NodeJS.ProcessEnv = { SSL_CERT_FILE: "/my/cert.pem" };
  useSystemCertificates(own, "darwin", there);
  assert.equal(own.SSL_CERT_FILE, "/my/cert.pem");

  for (const [platform, exists] of [
    ["win32", there],
    ["darwin", () => false],
  ] as const) {
    const left: NodeJS.ProcessEnv = {};
    useSystemCertificates(left, platform, exists);
    assert.equal(left.SSL_CERT_FILE, undefined, platform);
  }
});

test("on Linux the tools get the first of the system's certificate bundles, unless SSL_CERT_FILE is set", () => {
  const only =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file);

  // Debian and Ubuntu.
  const debian: NodeJS.ProcessEnv = {};
  useSystemCertificates(
    debian,
    "linux",
    only("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"),
  );
  assert.equal(debian.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt");

  // Fedora.
  const fedora: NodeJS.ProcessEnv = {};
  useSystemCertificates(
    fedora,
    "linux",
    only(
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    ),
  );
  assert.equal(fedora.SSL_CERT_FILE, "/etc/pki/tls/certs/ca-bundle.crt");

  for (const file of LINUX_CERTIFICATES) {
    const env: NodeJS.ProcessEnv = {};
    useSystemCertificates(env, "linux", only(file));
    assert.equal(env.SSL_CERT_FILE, file);
  }

  const own: NodeJS.ProcessEnv = { SSL_CERT_FILE: "/my/cert.pem" };
  useSystemCertificates(own, "linux", () => true);
  assert.equal(own.SSL_CERT_FILE, "/my/cert.pem");

  const none: NodeJS.ProcessEnv = {};
  useSystemCertificates(none, "linux", () => false);
  assert.equal(none.SSL_CERT_FILE, undefined);
});
