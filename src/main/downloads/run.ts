// Runs one yt-dlp or ffmpeg to the end: its output to the console and a log
// file, a timeout, and the reason for guests when it fails. And how long a
// video is.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { ChildProcess, execFile, spawn } from "child_process";
import fs from "fs";
import process from "process";

import invariant from "ts-invariant";

import {
  DownloadFailure,
  REASONS,
  toolCommand,
} from "../../common/downloadFailure";

// A log write stream can emit "error" (bad path, disk full); unhandled, it
// crashes the app. Logging is best-effort, so swallow it.
function attachLogStreamErrorHandler(
  stream: fs.WriteStream,
  label: string,
): void {
  stream.on("error", (err) => {
    console.error(`${label} log stream error:`, err);
  });
}

// Stops a tool and what it started: on Windows the yt-dlp a .cmd wrapper
// runs, and yt-dlp's own ffmpeg. (On POSIX, runTool starts each tool as its
// own process group.)
function killTree(proc: ChildProcess, label: string): void {
  if (proc.pid === undefined) return;
  if (process.platform === "win32") {
    execFile(
      "taskkill",
      ["/T", "/F", "/PID", String(proc.pid)],
      { windowsHide: true },
      (err) => {
        if (err) console.error(`Couldn't stop ${label}:`, err);
      },
    );
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (err) {
      console.error(`Couldn't stop ${label}:`, err);
    }
  }
}

// The longest one yt-dlp or ffmpeg run may take before it's stopped. A song
// downloads in a minute or two; this is for one that hangs.
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;

// How much of a tool's output to keep for working out why it failed.
const OUTPUT_TAIL_CHARS = 8192;

export interface ToolRun {
  // For the console and the log: "yt-dlp (YouTube <id>)".
  label: string;
  bin: string;
  args: string[];
  // Gets the tool's output. Appended to, unless freshLog.
  logFilename: string;
  freshLog?: boolean;
  stdin?: Buffer | string | null;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  // The reason for guests when the tool exits non-zero, from the end of
  // its output.
  reasonForExit: (output: string) => string;
  // TOOL_TIMEOUT_MS, unless a test wants less.
  timeoutMs?: number;
  // Stops the tool when aborted (the other step of the download failed).
  signal?: AbortSignal;
}

// Runs a tool to the end, its output going to the console and the log.
// Resolves when it exits 0. Rejects with a DownloadFailure when it can't
// start, exits non-zero, or runs longer than its timeout or signal aborts
// it (then it and what it started are stopped, and it fails once it has
// exited, so its files can go). Never throws: a throw in a spawn callback
// would crash the app.
export function runTool(run: ToolRun): Promise<void> {
  const timeoutMs = run.timeoutMs ?? TOOL_TIMEOUT_MS;
  const stopped = () =>
    new DownloadFailure(REASONS.other, `${run.label} was stopped`);
  if (run.signal?.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(run.logFilename, {
      flags: run.freshLog ? "w" : "a",
    });
    attachLogStreamErrorHandler(log, run.label);

    let output = "";
    const keep = (text: string) => {
      output = (output + text).slice(-OUTPUT_TAIL_CHARS);
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const settle = (failure: DownloadFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stop) run.signal?.removeEventListener("abort", stop);
      if (failure) log.write(`\nkarafriends: ${failure.detail}\n`);
      // Settles once the log is written, so it says why. The callback
      // comes even when the log can't be written (with its error).
      log.end(() => (failure ? reject(failure) : resolve()));
    };
    const failedToStart = (err: unknown) =>
      settle(
        new DownloadFailure(
          REASONS.toolFailedToStart,
          `${run.label} failed to run (${run.bin}): ${err}`,
        ),
      );

    const command = toolCommand(run.bin, run.args);
    let proc: ChildProcess;
    try {
      proc = spawn(command.file, command.args, {
        stdio: [run.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        // Its own process group, for killTree. (On Windows it would open a
        // console.)
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
    } catch (err) {
      // Node refuses some paths outright (on Windows, a .bat it can't run).
      failedToStart(err);
      return;
    }

    invariant(proc.stdout);
    invariant(proc.stderr);
    proc.stdout.pipe(process.stdout);
    proc.stdout.pipe(log, { end: false });
    proc.stderr.pipe(process.stderr);
    proc.stderr.pipe(log, { end: false });
    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      keep(text);
      run.onStdout?.(text);
    });
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      keep(text);
      run.onStderr?.(text);
    });

    // Emitted when the tool can't be launched (missing, not executable).
    // Unhandled, an "error" event crashes the app.
    proc.on("error", failedToStart);
    // Why it was stopped, if it was: it fails with this once it has exited,
    // so its files can go.
    let stoppedFor: DownloadFailure | null = null;
    stop = () => {
      stoppedFor ??= stopped();
      killTree(proc, run.label);
    };
    run.signal?.addEventListener("abort", stop, { once: true });
    proc.on("close", (code, signal) => {
      if (stoppedFor) {
        settle(stoppedFor);
      } else if (code === 0) {
        settle(null);
      } else {
        settle(
          new DownloadFailure(
            run.reasonForExit(output),
            `${run.label} exited with code=${code}, signal=${signal}, log=${run.logFilename}`,
          ),
        );
      }
    });
    timer = setTimeout(() => {
      stoppedFor = new DownloadFailure(
        REASONS.timedOut,
        `${run.label} took longer than ${timeoutMs / 1000} s; stopped it`,
      );
      stop?.();
    }, timeoutMs);

    if (run.stdin && proc.stdin) {
      // The tool may exit before reading it all (EPIPE).
      proc.stdin.on("error", (err) =>
        console.error(`${run.label} stdin error:`, err),
      );
      proc.stdin.end(run.stdin);
    }
  });
}

// The seconds in ffmpeg's "Duration: 00:04:01.52" line, or null if output
// has none (or says "Duration: N/A").
export function parseDuration(output: string): number | null {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// How long a video file is, in seconds, from what `ffmpeg -i` prints, or
// null if it doesn't say. (The tools come without ffprobe. With no output
// file named, ffmpeg exits 1 after printing it.) Never rejects.
export function probeDuration(
  ffmpeg: string,
  filename: string,
): Promise<number | null> {
  const command = toolCommand(ffmpeg, ["-hide_banner", "-i", filename]);
  return new Promise((resolve) => {
    try {
      execFile(
        command.file,
        command.args,
        {
          timeout: 60_000,
          windowsHide: true,
          windowsVerbatimArguments: command.windowsVerbatimArguments,
        },
        (_err, _stdout, stderr) => resolve(parseDuration(String(stderr))),
      );
    } catch (err) {
      // Node refuses some paths outright.
      console.error(`Couldn't run ${ffmpeg} to probe ${filename}:`, err);
      resolve(null);
    }
  });
}
