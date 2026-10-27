import { ChildProcess, execFile, spawn } from "child_process";
import { app } from "electron";
import fs from "fs";
import path from "path";
import process from "process";
import { promisify } from "util";

import invariant from "ts-invariant";

import type { JoysoundAPI } from "../main/joysoundApi";
import {
  FAILED_DOWNLOAD_KEPT_MS,
  failDownload,
  isDownloading,
  removeDownload,
  startDownload,
  type DownloadQueueItem,
} from "../main/state";
import type { JoysoundQueueItem, UserIdentity } from "./api";

import { isCaptionCode } from "./captionCode";
import { envWithoutHttpProxy } from "./childEnv";
import {
  DownloadFailure,
  failureReason,
  REASONS,
  toolCommand,
  ytdlpFailureReason,
} from "./downloadFailure";
import { ensureExternalResources, getResourcePaths } from "./externalResources";
import { getSongDuration } from "./joysoundParser";
import {
  isNicoVideoId,
  limitLookups,
  NicoVideoMetadata,
  nicoWatchUrl,
  parseNicoVideoInfo,
} from "./nicoVideoInfo";

const execFileAsync = promisify(execFile);

export const TEMP_FOLDER: string = `${app.getPath("temp")}/karafriends_tmp`;

interface JoysoundVideoData {
  songId: string;
  songDuration: number;
  songPlaytime: number;
  videoPlaytime: number;
  oggBuffer: Buffer;
}

const resourcePaths = getResourcePaths();

// Filesystem cleanup helpers. These run inside async spawn/exit callbacks where
// an uncaught throw would crash the whole app, so they must never throw: a
// missing or already-removed file during cleanup is not fatal.
function safeUnlink(filename: string): void {
  try {
    fs.rmSync(filename, { force: true });
  } catch (err) {
    console.error(`Failed to remove ${filename}:`, err);
  }
}

function safeRename(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    console.error(`Failed to rename ${from} -> ${to}:`, err);
  }
}

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

// Deletes one song's files in TEMP_FOLDER: prefix followed by "-" or ".".
// Not its logs, which say why a download failed.
function deleteTempFiles(prefix: string): void {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(TEMP_FOLDER);
  } catch (err) {
    console.error(`Failed to list ${TEMP_FOLDER} for cleanup:`, err);
    return;
  }
  for (const filename of filenames) {
    if (
      (filename.startsWith(`${prefix}-`) ||
        filename.startsWith(`${prefix}.`)) &&
      !filename.endsWith(".log")
    ) {
      // NB: readdirSync returns bare names; they must be joined with
      // TEMP_FOLDER or the unlink targets the wrong (cwd-relative) path.
      safeUnlink(path.join(TEMP_FOLDER, filename));
    }
  }
}

// Creates tempFilename, which marks a download as started (in case the app
// stops halfway). One left from an earlier run means the files with prefix
// are half-done: they go first.
function prepareTempFile(prefix: string, tempFilename: string): void {
  fs.mkdirSync(TEMP_FOLDER, { recursive: true });
  if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);
    deleteTempFiles(prefix);
  }
  fs.closeSync(fs.openSync(tempFilename, "w"));
}

function handleFFmpegDownloadLog(
  log: string,
  songFrames: number,
  downloadQueueItem: DownloadQueueItem,
): void {
  const frameMatchData = log.match(/frame=\s*(\d+)\s*/);

  if (frameMatchData) {
    const rawProgress = parseInt(frameMatchData[1], 10) / songFrames;
    const progress = Math.min(rawProgress, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

function handleYoutubeDownloadLog(
  log: string,
  downloadQueueItem: DownloadQueueItem,
): void {
  const matchData = log.match(/\[download\]\s*(\d+\.\d)%/);

  if (matchData) {
    const progress = Math.min(parseFloat(matchData[1]) / 100.0, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

// The longest one yt-dlp or ffmpeg run may take before it's stopped. A song
// downloads in a minute or two; this is for one that hangs.
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;

// How much of a tool's output to keep for working out why it failed.
const OUTPUT_TAIL_CHARS = 8192;

interface ToolRun {
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
}

// Runs a tool to the end, its output going to the console and the log.
// Resolves when it exits 0. Rejects with a DownloadFailure when it can't
// start, exits non-zero, or runs longer than TOOL_TIMEOUT_MS (then it's
// stopped). Never throws: a throw in a spawn callback would crash the app.
function runTool(run: ToolRun): Promise<void> {
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
    const settle = (failure: DownloadFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        log.write(`\nkarafriends: ${failure.detail}\n`);
        reject(failure);
      } else {
        resolve();
      }
      log.end();
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
    proc.on("close", (code, signal) => {
      if (code === 0) {
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
          `${run.label} took longer than ${TOOL_TIMEOUT_MS / 1000} s; stopped it`,
        ),
      );
      proc.kill();
    }, TOOL_TIMEOUT_MS);

    if (run.stdin && proc.stdin) {
      // The tool may exit before reading it all (EPIPE).
      proc.stdin.on("error", (err) =>
        console.error(`${run.label} stdin error:`, err),
      );
      proc.stdin.end(run.stdin);
    }
  });
}

// Marks item failed with the reason for err, tells onFailed, and takes item
// out of the download queue FAILED_DOWNLOAD_KEPT_MS later, so the phone that
// asked for it can show why in the meantime. Never throws.
function failDownloadItem(
  downloadQueue: DownloadQueueItem[],
  item: DownloadQueueItem,
  description: string,
  err: unknown,
  onFailed: (reason: string) => void,
): void {
  const reason = failureReason(err);
  console.error(`Error downloading ${description} (${reason}):`, err);
  if (!failDownload(downloadQueue, item, reason)) return;
  // startDownload also removes failures this old, should the timer be late.
  setTimeout(
    () => removeDownload(downloadQueue, item),
    FAILED_DOWNLOAD_KEPT_MS,
  );
  try {
    onFailed(reason);
  } catch (callbackErr) {
    console.error(
      `Reporting the failure of ${description} failed:`,
      callbackErr,
    );
  }
}

// Gets the tools, runs download for item, and takes item out of the
// download queue when it's done, then calls onReady with its result. If any
// of that fails, cleanUp runs and item is marked failed (failDownloadItem).
// Fire and forget: nothing it does can throw to the caller or go unhandled.
function runDownload<T>(
  downloadQueue: DownloadQueueItem[],
  item: DownloadQueueItem,
  description: string,
  download: () => Promise<T>,
  onReady: (result: T) => void,
  cleanUp: () => void,
  onFailed: (reason: string) => void,
): void {
  ensureExternalResources()
    .catch((err) => {
      throw new DownloadFailure(
        REASONS.noTools,
        `couldn't get ffmpeg and yt-dlp: ${err}`,
      );
    })
    .then(download)
    .then(
      (result) => {
        removeDownload(downloadQueue, item);
        try {
          onReady(result);
        } catch (err) {
          console.error(`Queueing ${description} failed:`, err);
        }
      },
      (err) => {
        try {
          cleanUp();
        } catch (cleanupErr) {
          console.error(`Cleaning up after ${description} failed:`, cleanupErr);
        }
        failDownloadItem(downloadQueue, item, description, err, onFailed);
      },
    );
}

// A failed Joysound API call, for guests.
function joysoundFailure(err: unknown): never {
  throw new DownloadFailure(REASONS.joysound, String(err));
}

// A tool exited non-zero while making the video out of downloaded files.
const processingFailed = () => REASONS.videoProcessing;

function getJoysoundOggPlaytime(oggBuffer: Buffer): number {
  const FIELD_TAG = new Uint8Array([
    0x70, 0x6c, 0x61, 0x79, 0x74, 0x69, 0x6d, 0x65, 0x3d,
  ]);

  let fieldOffset = 0;
  let fieldLength = 0;

  for (let i = 0; i < oggBuffer.length; i++) {
    const oggSlice = oggBuffer.subarray(i, i + FIELD_TAG.length);

    let isFieldTag = true;

    for (let j = 0; j < oggSlice.length; j++) {
      if (oggSlice[j] !== FIELD_TAG[j]) {
        isFieldTag = false;
        break;
      }
    }

    if (!isFieldTag) {
      continue;
    }

    fieldOffset = i + FIELD_TAG.length;

    const fieldLengthView = new DataView(
      oggBuffer.buffer,
      oggBuffer.byteOffset + i - 4,
      4,
    );
    fieldLength = fieldLengthView.getUint32(0, true) - FIELD_TAG.length;

    break;
  }

  const playtimeBuffer = oggBuffer.subarray(
    fieldOffset,
    fieldOffset + fieldLength,
  );

  let playtimeString = "";

  for (const char of playtimeBuffer) {
    playtimeString += String.fromCharCode(char);
  }

  return parseInt(playtimeString, 10);
}

// DAM songs join the queue at once and stream until their download is
// done, so a failure here is only logged.
export function downloadDamVideo(
  m3u8Url: string,
  songId: string,
  suffix: string,
): void {
  ensureExternalResources()
    .then(() => downloadDamVideoImpl(m3u8Url, songId, suffix))
    .catch((err) =>
      console.error(`Error downloading DAM video with ID ${songId}:`, err),
    );
}

async function downloadDamVideoImpl(
  m3u8Url: string,
  songId: string,
  suffix: string,
): Promise<void> {
  fs.mkdirSync(TEMP_FOLDER, { recursive: true });

  const filename = `${TEMP_FOLDER}/${songId}-${suffix}.mp4`;
  const tempFilename = `${filename}.tmp`;

  if (fs.existsSync(filename)) {
    console.info(`${filename} already exists, not redownloading`);
    return;
  }

  console.info(`Downloading DAM video to ${filename}`);

  try {
    await runTool({
      label: `ffmpeg (DAM ${songId})`,
      bin: resourcePaths.ffmpeg,
      args: [
        "-y",
        "-i",
        m3u8Url,
        "-c",
        "copy",
        "-movflags",
        "faststart",
        "-f",
        "mp4",
        tempFilename,
      ],
      logFilename: `${TEMP_FOLDER}/dam-${songId}.log`,
      freshLog: true,
      reasonForExit: () => REASONS.other,
    });
  } catch (err) {
    safeUnlink(tempFilename);
    throw err;
  }
  safeRename(tempFilename, filename);
}

function runJoysoundFFmpeg(
  songId: string,
  ffmpegArgs: string[],
  ffmpegLogFilename: string,
  options: Pick<ToolRun, "onStderr" | "stdin"> &
    Partial<Pick<ToolRun, "reasonForExit">> = {},
): Promise<void> {
  return runTool({
    label: `ffmpeg (Joysound ${songId})`,
    bin: resourcePaths.ffmpeg,
    args: ffmpegArgs,
    logFilename: ffmpegLogFilename,
    reasonForExit: processingFailed,
    ...options,
  });
}

function downloadJoysoundVideoPromise(
  songId: string,
  videoUrl: string,
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
  ffmpegLogFilename: string,
): Promise<void> {
  let songFrames = 0;

  const ffmpegArgs = [
    "-i",
    videoUrl,
    "-c",
    "copy",
    "-movflags",
    "faststart",
    "-f",
    "mp4",
    "-y",
    tempFilename,
  ];

  const onStderr = (ffmpegLog: string) => {
    const durationMatchData = ffmpegLog.match(/Duration:\s*(\d+):(\d+):(\d+)/);

    if (durationMatchData) {
      let songDuration = 0;

      songDuration += parseInt(durationMatchData[1], 10) * 3600;
      songDuration += parseInt(durationMatchData[2], 10) * 60;
      songDuration += parseInt(durationMatchData[3], 10);

      songFrames = songDuration * 30;
    }

    handleFFmpegDownloadLog(ffmpegLog, songFrames, downloadQueueItem);
  };

  // ffmpeg fetches the video from Joysound's servers.
  return runJoysoundFFmpeg(songId, ffmpegArgs, ffmpegLogFilename, {
    onStderr,
    reasonForExit: () => REASONS.joysound,
  });
}

async function downloadJoysoundYoutubeVideoPromise(
  songId: string,
  youtubeVideoId: string,
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
): Promise<void> {
  await runTool({
    label: `yt-dlp (Joysound ${songId}, background ${youtubeVideoId})`,
    bin: resourcePaths.ytdlp,
    args: [
      "-S",
      "res:720,ext:mp4",
      "-f",
      "bv",
      "--recode",
      "mp4",
      "-N",
      "4",
      "--ffmpeg-location",
      resourcePaths.ffmpeg,
      "-o",
      tempFilename + ".mp4",
      "--",
      youtubeVideoId,
    ],
    logFilename: `${TEMP_FOLDER}/yt-${youtubeVideoId}.log`,
    freshLog: true,
    env: envWithoutHttpProxy(),
    onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
    reasonForExit: ytdlpFailureReason,
  });
  safeUnlink(tempFilename);
  safeRename(tempFilename + ".mp4", tempFilename);
}

async function composeJoysoundVideoPromise(
  songId: string,
  telopBuffer: Buffer,
  oggBuffer: Buffer,
  tempFilename: string,
  videoFilename: string,
  ffmpegLogFilename: string,
): Promise<JoysoundVideoData> {
  let videoPlaytime = 0;

  const ffmpegArgs = [
    "-stream_loop",
    "-1",
    "-i",
    tempFilename,
    "-i",
    "-",
    "-c",
    "copy",
    "-shortest",
    "-movflags",
    "faststart",
    "-f",
    "mp4",
    videoFilename,
  ];

  const onStderr = (ffmpegLog: string) => {
    const durationMatchData = ffmpegLog.match(
      /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/,
    );

    // XXX: We assume that the video duration always comes first
    if (durationMatchData && videoPlaytime === 0) {
      videoPlaytime += parseInt(durationMatchData[1], 10) * 3600;
      videoPlaytime += parseInt(durationMatchData[2], 10) * 60;
      videoPlaytime += parseInt(durationMatchData[3], 10);
      videoPlaytime =
        videoPlaytime * 1000 + parseInt(durationMatchData[4], 10) * 10;
    }
  };

  try {
    await runJoysoundFFmpeg(songId, ffmpegArgs, ffmpegLogFilename, {
      onStderr,
      stdin: oggBuffer,
    });
  } finally {
    safeUnlink(tempFilename);
  }

  return {
    songDuration: getSongDuration(telopBuffer) * 1000,
    songPlaytime: getJoysoundOggPlaytime(oggBuffer),
    songId,
    oggBuffer,
    videoPlaytime,
  };
}

// Pads the start of a YouTube background with its first frame, so it lines
// up with the song.
async function padJoysoundVideoPromise(
  data: JoysoundVideoData,
  videoFilename: string,
  ffmpegLogFilename: string,
): Promise<void> {
  const videoBaseFilename = videoFilename.substr(0, videoFilename.length - 4);

  const videoNoSoundFilename = videoBaseFilename + "-no-sound.mp4";
  const videoPadFrameFilename = videoBaseFilename + "-pad-1f.mp4";
  const videoPadFilename = videoBaseFilename + "-pad.mp4";
  const videoConcatFilename = videoBaseFilename + "-concat.mp4";
  const videoTempFilename = videoBaseFilename + "-temp.mp4";
  const videoOutFilename = videoBaseFilename + "-out.mp4";
  const videoListFilename = videoBaseFilename + "-list.txt";

  const ffmpeg = (ffmpegArgs: string[]) =>
    runJoysoundFFmpeg(data.songId, ffmpegArgs, ffmpegLogFilename);

  await ffmpeg([
    "-i",
    videoFilename,
    "-c",
    "copy",
    "-an",
    "-y",
    videoNoSoundFilename,
  ]);

  await ffmpeg([
    "-i",
    videoNoSoundFilename,
    "-frames:v",
    "1",
    "-c:v",
    "copy",
    "-an",
    "-y",
    videoPadFrameFilename,
  ]);

  const offset = Math.max(data.songPlaytime - data.videoPlaytime, 0);
  await ffmpeg([
    "-stream_loop",
    "-1",
    "-i",
    videoPadFrameFilename,
    "-c",
    "copy",
    "-t",
    `${offset}ms`,
    "-y",
    videoPadFilename,
  ]);

  let listFile = "";
  listFile += `file '${videoPadFilename.replace(/\\/g, "/")}'`;
  listFile += "\n";
  listFile += `file '${videoNoSoundFilename.replace(/\\/g, "/")}'`;
  fs.writeFileSync(videoListFilename, listFile);

  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    videoListFilename,
    "-c",
    "copy",
    "-y",
    videoConcatFilename,
  ]);

  await ffmpeg([
    "-i",
    videoFilename,
    "-i",
    videoConcatFilename,
    "-map",
    "0:a",
    "-map",
    "1:v",
    "-c",
    "copy",
    "-shortest",
    "-y",
    videoOutFilename,
  ]);

  safeRename(videoFilename, videoTempFilename);
  safeRename(videoOutFilename, videoFilename);

  safeUnlink(videoNoSoundFilename);
  safeUnlink(videoPadFrameFilename);
  safeUnlink(videoPadFilename);
  safeUnlink(videoTempFilename);
  safeUnlink(videoConcatFilename);
}

// Downloads a Joysound song and its video, then queues it with
// pushSongToQueue; or calls onFailed with the reason for guests.
export function downloadJoysoundData(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  joysoundApi: JoysoundAPI,
  queueItem: JoysoundQueueItem,
  pushToHead: boolean,
  pushSongToQueue: (queueItem: JoysoundQueueItem, pushToHead: boolean) => void,
  onFailed: (reason: string) => void,
): void {
  const songId = queueItem.songId;

  const videoFilenameSuffix = queueItem.youtubeVideoId
    ? queueItem.youtubeVideoId
    : "default";

  const filenamePrefix = `joysound-${songId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const telopFilename = `${writeBasePath}.joy_02`;
  const videoFilename = `${writeBasePath}-${videoFilenameSuffix}.mp4`;
  const ffmpegLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  const key = {
    kind: "joysound" as const,
    songId,
    suffix: queueItem.youtubeVideoId,
  };
  if (isDownloading(downloadQueue, key)) {
    console.error(`${videoFilename} was already queued, not redownloading`);
    return;
  }

  // Downloaded before: queue it at once.
  if (fs.existsSync(videoFilename)) {
    if (fs.existsSync(telopFilename)) {
      console.info(`${videoFilename} already exists, not redownloading`);
      try {
        const telopBuffer = fs.readFileSync(telopFilename);
        pushSongToQueue(
          { ...queueItem, playtime: getSongDuration(telopBuffer) },
          pushToHead,
        );
        return;
      } catch (err) {
        console.error(`Couldn't use the downloaded ${videoFilename}:`, err);
      }
    } else {
      console.error(
        `${videoFilename} already exists, but ${telopFilename} does not.`,
      );
    }
    safeUnlink(videoFilename);
  }

  const downloadQueueItem = startDownload(downloadQueue, {
    ...key,
    userIdentity,
  });

  const download = async (): Promise<JoysoundQueueItem> => {
    prepareTempFile(filenamePrefix, tempFilename);

    console.info(`Downloading Joysound video to ${videoFilename}`);

    const songDataPromise = joysoundApi
      .getSongRawData(songId)
      .catch(joysoundFailure);
    const videoDataPromise = queueItem.youtubeVideoId
      ? downloadJoysoundYoutubeVideoPromise(
          songId,
          queueItem.youtubeVideoId,
          downloadQueueItem,
          tempFilename,
        )
      : joysoundApi
          .getMovieUrls(songId)
          .catch(joysoundFailure)
          .then((data) =>
            downloadJoysoundVideoPromise(
              songId,
              data.movie.mov1,
              downloadQueueItem,
              tempFilename,
              ffmpegLogFilename,
            ),
          );

    const [, joysoundSongRawData] = await Promise.all([
      videoDataPromise,
      songDataPromise,
    ]);

    const telopBase64 = joysoundSongRawData.telop;
    const oggBase64 = joysoundSongRawData.ogg;

    const telopBuffer = Buffer.from(
      telopBase64.slice(30) + telopBase64.slice(0, 30),
      "base64",
    );

    const oggBuffer = Buffer.from(
      oggBase64.slice(30) + oggBase64.slice(0, 30),
      "base64",
    );

    if (!fs.existsSync(telopFilename)) {
      fs.writeFileSync(telopFilename, telopBuffer);
    }

    const data = await composeJoysoundVideoPromise(
      songId,
      telopBuffer,
      oggBuffer,
      tempFilename,
      videoFilename,
      ffmpegLogFilename,
    );

    if (
      queueItem.youtubeVideoId &&
      Math.abs(data.songDuration - data.videoPlaytime) < 10000
    ) {
      await padJoysoundVideoPromise(data, videoFilename, ffmpegLogFilename);
    }

    if (!fs.existsSync(videoFilename)) {
      throw new DownloadFailure(
        REASONS.videoProcessing,
        `ffmpeg left no ${videoFilename}`,
      );
    }

    return { ...queueItem, playtime: Math.floor(data.songPlaytime / 1000) };
  };

  runDownload(
    downloadQueue,
    downloadQueueItem,
    `Joysound song ${songId}`,
    download,
    (item) => pushSongToQueue(item, pushToHead),
    () => deleteTempFiles(filenamePrefix),
    onFailed,
  );
}

// Downloads a YouTube video (and its captions, if captionCode), then calls
// onComplete; or onFailed with the reason for guests.
export function downloadYoutubeVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  captionCode: string | null,
  onComplete: () => void,
  onFailed: (reason: string) => void,
): void {
  const filenamePrefix = `yt-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const vttFilename = `${writeBasePath}.vtt`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  const key = { kind: "youtube" as const, songId: videoId, suffix: null };
  if (isDownloading(downloadQueue, key)) {
    console.error(`${videoFilename} was already queued, not redownloading`);
    return;
  }

  const downloadQueueItem = startDownload(downloadQueue, {
    ...key,
    userIdentity,
  });

  const download = async () => {
    // validate.ts already refuses these; this keeps a bad code off yt-dlp's
    // command line whoever calls.
    if (captionCode !== null && !isCaptionCode(captionCode)) {
      throw new DownloadFailure(
        REASONS.other,
        `${captionCode} is not a valid caption code`,
      );
    }

    prepareTempFile(filenamePrefix, tempFilename);

    console.info(`Downloading YouTube video to ${videoFilename}`);

    const captionArgs = captionCode
      ? ["--write-subs", "--sub-langs", captionCode]
      : [];

    try {
      await runTool({
        label: `yt-dlp (YouTube ${videoId})`,
        bin: resourcePaths.ytdlp,
        args: [
          ...captionArgs,
          "-S",
          "res:720,ext:mp4:m4a",
          "--recode",
          "mp4",
          "-N",
          "4",
          "--ffmpeg-location",
          resourcePaths.ffmpeg,
          "-o",
          `${videoFilename}`,
          "--",
          videoId,
        ],
        logFilename: ytdlpLogFilename,
        freshLog: true,
        env: envWithoutHttpProxy(),
        onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
        reasonForExit: ytdlpFailureReason,
      });
    } finally {
      safeUnlink(tempFilename);
    }

    if (!fs.existsSync(videoFilename)) {
      throw new DownloadFailure(
        REASONS.other,
        `yt-dlp exited 0 but left no ${videoFilename}; log=${ytdlpLogFilename}`,
      );
    }

    if (captionCode) {
      try {
        fs.renameSync(`${writeBasePath}.${captionCode}.vtt`, vttFilename);
      } catch (fsError) {
        console.error(
          `Error trying to rename caption file ${writeBasePath}.${captionCode}.vtt to ${writeBasePath}.vtt: ${fsError}`,
        );
      }
    }
  };

  runDownload(
    downloadQueue,
    downloadQueueItem,
    `YouTube video ${videoId}`,
    download,
    onComplete,
    () => {},
    onFailed,
  );
}

// Look up a Niconico video's metadata with yt-dlp, which already downloads
// these videos and keeps up with changes to Niconico's site.
async function lookUpNicoVideoInfo(
  videoId: string,
): Promise<NicoVideoMetadata> {
  await ensureExternalResources();
  const command = toolCommand(resourcePaths.ytdlp, [
    "--dump-single-json",
    "--skip-download",
    "--",
    nicoWatchUrl(videoId),
  ]);
  const { stdout } = await execFileAsync(command.file, command.args, {
    env: envWithoutHttpProxy(),
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  return parseNicoVideoInfo(stdout);
}

// Any phone can ask, and each lookup starts a yt-dlp (on Windows, an exe
// that unpacks itself and starts Python), so a script asking for sm1, sm2,
// ... at once would swamp the karaoke PC. Results are shared and kept for an
// hour, two lookups run at a time, and a few more may wait; past that a
// lookup fails at once.
const limitedNicoVideoInfo = limitLookups(lookUpNicoVideoInfo, {
  concurrency: 2,
  maxWaiting: 8,
  cacheSize: 200,
  cacheMs: 60 * 60 * 1000,
});

export async function getNicoVideoInfo(
  videoId: string,
): Promise<NicoVideoMetadata> {
  if (!isNicoVideoId(videoId)) {
    throw new Error(`Not a Niconico video ID: ${JSON.stringify(videoId)}`);
  }
  return limitedNicoVideoInfo(videoId);
}

// Downloads a Niconico video, then calls onComplete; or onFailed with the
// reason for guests.
export function downloadNicoVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  onComplete: () => void,
  onFailed: (reason: string) => void,
): void {
  const filenamePrefix = `nico-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  const key = { kind: "nico" as const, songId: videoId, suffix: null };
  if (isDownloading(downloadQueue, key)) {
    console.error(`${videoFilename} was already queued, not redownloading`);
    return;
  }

  const downloadQueueItem = startDownload(downloadQueue, {
    ...key,
    userIdentity,
  });

  const download = async () => {
    prepareTempFile(filenamePrefix, tempFilename);

    console.info(`Downloading Niconico video to ${videoFilename}`);

    try {
      await runTool({
        label: `yt-dlp (Niconico ${videoId})`,
        bin: resourcePaths.ytdlp,
        args: [
          "-N",
          "4",
          "-o",
          `${videoFilename}`,
          "--",
          `https://www.nicovideo.jp/watch/${videoId}`,
        ],
        logFilename: ytdlpLogFilename,
        freshLog: true,
        env: envWithoutHttpProxy(),
        onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
        reasonForExit: ytdlpFailureReason,
      });
    } finally {
      safeUnlink(tempFilename);
    }

    if (!fs.existsSync(videoFilename)) {
      throw new DownloadFailure(
        REASONS.other,
        `yt-dlp exited 0 but left no ${videoFilename}; log=${ytdlpLogFilename}`,
      );
    }
  };

  runDownload(
    downloadQueue,
    downloadQueueItem,
    `Niconico video ${videoId}`,
    download,
    onComplete,
    () => {},
    onFailed,
  );
}
