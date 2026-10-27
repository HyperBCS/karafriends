// Runs one yt-dlp or ffmpeg to the end: its output to the console and a log
// file, a timeout, and the reason for guests when it fails.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { ChildProcess, spawn } from "child_process";
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
  env?: NodeJS.ProcessEnv;
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
// start, exits non-zero, or runs longer than its timeout (then it's
// stopped), or when signal aborts it (once it has exited, so its files can
// go). Never throws: a throw in a spawn callback would crash the app.
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
        env: run.env,
        stdio: [run.stdin ? "pipe" : "ignore", "pipe", "pipe"],
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
    let stopping = false;
    stop = () => {
      stopping = true;
      proc.kill();
    };
    run.signal?.addEventListener("abort", stop, { once: true });
    proc.on("close", (code, signal) => {
      if (stopping) {
        settle(stopped());
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
      // Its last words would come after the log is closed.
      proc.stdout?.unpipe(log);
      proc.stderr?.unpipe(log);
      settle(
        new DownloadFailure(
          REASONS.timedOut,
          `${run.label} took longer than ${timeoutMs / 1000} s; stopped it`,
        ),
      );
      proc.kill();
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
