// One download job per kind of song: the yt-dlp and ffmpeg runs that make
// its files in the temp folder, and the progress they report.
//
// No Electron imports, so unit tests can load this file under plain Node:
// the folder and the tools come in as JobPaths.
import fs from "fs";
import path from "path";

import type { JoysoundQueueItem } from "../../common/api";
import { isCaptionCode } from "../../common/captionCode";
import { envWithoutHttpProxy } from "../../common/childEnv";
import {
  DownloadFailure,
  REASONS,
  ytdlpFailureReason,
} from "../../common/downloadFailure";
import { getSongDuration } from "../../common/joysoundParser";
import type { JoysoundAPI } from "../joysoundApi";
import type { DownloadQueueItem } from "../state";
import { runTool, type ToolRun } from "./run";

// Where the jobs write (TEMP_FOLDER, in the app) and the tools they run.
export interface JobPaths {
  folder: string;
  ffmpeg: string;
  ytdlp: string;
}

interface JoysoundVideoData {
  songId: string;
  songDuration: number;
  songPlaytime: number;
  videoPlaytime: number;
  oggBuffer: Buffer;
}

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

// Deletes one song's files in folder: prefix followed by "-" or ".".
// Not its logs, which say why a download failed.
function deleteTempFiles(folder: string, prefix: string): void {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(folder);
  } catch (err) {
    console.error(`Failed to list ${folder} for cleanup:`, err);
    return;
  }
  for (const filename of filenames) {
    if (
      (filename.startsWith(`${prefix}-`) ||
        filename.startsWith(`${prefix}.`)) &&
      !filename.endsWith(".log")
    ) {
      // NB: readdirSync returns bare names; they must be joined with
      // folder or the unlink targets the wrong (cwd-relative) path.
      safeUnlink(path.join(folder, filename));
    }
  }
}

// Creates tempFilename, which marks a download as started (in case the app
// stops halfway). One left from an earlier run means the files with prefix
// are half-done: they go first.
function prepareTempFile(
  folder: string,
  prefix: string,
  tempFilename: string,
): void {
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);
    deleteTempFiles(folder, prefix);
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

// Downloads a DAM song's video, which streams meanwhile, to
// <songId>-<suffix>.mp4, unless it's there already.
export async function damJob(
  paths: JobPaths,
  m3u8Url: string,
  songId: string,
  suffix: string,
): Promise<void> {
  fs.mkdirSync(paths.folder, { recursive: true });

  const filename = `${paths.folder}/${songId}-${suffix}.mp4`;
  const tempFilename = `${filename}.tmp`;

  if (fs.existsSync(filename)) {
    console.info(`${filename} already exists, not redownloading`);
    return;
  }

  console.info(`Downloading DAM video to ${filename}`);

  try {
    await runTool({
      label: `ffmpeg (DAM ${songId})`,
      bin: paths.ffmpeg,
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
      logFilename: `${paths.folder}/dam-${songId}.log`,
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
  paths: JobPaths,
  songId: string,
  ffmpegArgs: string[],
  ffmpegLogFilename: string,
  options: Pick<ToolRun, "onStderr" | "stdin" | "signal"> &
    Partial<Pick<ToolRun, "reasonForExit">> = {},
): Promise<void> {
  return runTool({
    label: `ffmpeg (Joysound ${songId})`,
    bin: paths.ffmpeg,
    args: ffmpegArgs,
    logFilename: ffmpegLogFilename,
    reasonForExit: processingFailed,
    ...options,
  });
}

function downloadJoysoundVideoPromise(
  paths: JobPaths,
  songId: string,
  videoUrl: string,
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
  ffmpegLogFilename: string,
  signal: AbortSignal,
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
  return runJoysoundFFmpeg(paths, songId, ffmpegArgs, ffmpegLogFilename, {
    onStderr,
    reasonForExit: () => REASONS.joysound,
    signal,
  });
}

async function downloadJoysoundYoutubeVideoPromise(
  paths: JobPaths,
  songId: string,
  youtubeVideoId: string,
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
  signal: AbortSignal,
): Promise<void> {
  await runTool({
    label: `yt-dlp (Joysound ${songId}, background ${youtubeVideoId})`,
    bin: paths.ytdlp,
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
      paths.ffmpeg,
      "-o",
      tempFilename + ".mp4",
      "--",
      youtubeVideoId,
    ],
    logFilename: `${paths.folder}/yt-${youtubeVideoId}.log`,
    freshLog: true,
    env: envWithoutHttpProxy(),
    onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
    reasonForExit: ytdlpFailureReason,
    signal,
  });
  safeUnlink(tempFilename);
  safeRename(tempFilename + ".mp4", tempFilename);
}

async function composeJoysoundVideoPromise(
  paths: JobPaths,
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
    await runJoysoundFFmpeg(paths, songId, ffmpegArgs, ffmpegLogFilename, {
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
  paths: JobPaths,
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
    runJoysoundFFmpeg(paths, data.songId, ffmpegArgs, ffmpegLogFilename);

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

// A Joysound song's files: joysound-<songId>.joy_02 (the lyrics),
// joysound-<songId>-<background or "default">.mp4, and the ffmpeg log.
function joysoundFiles(folder: string, queueItem: JoysoundQueueItem) {
  const videoFilenameSuffix = queueItem.youtubeVideoId
    ? queueItem.youtubeVideoId
    : "default";

  const filenamePrefix = `joysound-${queueItem.songId}`;
  const writeBasePath = `${folder}/${filenamePrefix}`;
  const videoFilename = `${writeBasePath}-${videoFilenameSuffix}.mp4`;

  return {
    filenamePrefix,
    telopFilename: `${writeBasePath}.joy_02`,
    videoFilename,
    ffmpegLogFilename: `${writeBasePath}.log`,
    tempFilename: `${videoFilename}.tmp`,
  };
}

// If the song was downloaded before, queues it with pushSongToQueue and
// returns true. A video without its lyrics, or one that can't be used, goes.
export function queueDownloadedJoysoundSong(
  folder: string,
  queueItem: JoysoundQueueItem,
  pushSongToQueue: (queueItem: JoysoundQueueItem) => void,
): boolean {
  const { telopFilename, videoFilename } = joysoundFiles(folder, queueItem);
  if (!fs.existsSync(videoFilename)) return false;
  if (fs.existsSync(telopFilename)) {
    console.info(`${videoFilename} already exists, not redownloading`);
    try {
      const telopBuffer = fs.readFileSync(telopFilename);
      pushSongToQueue({ ...queueItem, playtime: getSongDuration(telopBuffer) });
      return true;
    } catch (err) {
      console.error(`Couldn't use the downloaded ${videoFilename}:`, err);
    }
  } else {
    console.error(
      `${videoFilename} already exists, but ${telopFilename} does not.`,
    );
  }
  safeUnlink(videoFilename);
  return false;
}

// Deletes what a failed Joysound download of songId left, but its log.
export function deleteJoysoundTempFiles(folder: string, songId: string): void {
  deleteTempFiles(folder, `joysound-${songId}`);
}

// Downloads a Joysound song's lyrics and video (Joysound's, or a YouTube
// background) and puts them together.
export async function joysoundJob(
  paths: JobPaths,
  downloadQueueItem: DownloadQueueItem,
  joysoundApi: Pick<JoysoundAPI, "getSongRawData" | "getMovieUrls">,
  queueItem: JoysoundQueueItem,
): Promise<JoysoundQueueItem> {
  const songId = queueItem.songId;
  const {
    filenamePrefix,
    telopFilename,
    videoFilename,
    ffmpegLogFilename,
    tempFilename,
  } = joysoundFiles(paths.folder, queueItem);

  prepareTempFile(paths.folder, filenamePrefix, tempFilename);

  console.info(`Downloading Joysound video to ${videoFilename}`);

  // Stops the video step's tool when the song data fails.
  const stopVideo = new AbortController();
  // That tool, once it has started.
  let videoTool: Promise<void> = Promise.resolve();
  const songDataPromise = joysoundApi
    .getSongRawData(songId)
    .catch(joysoundFailure);
  const videoDataPromise = queueItem.youtubeVideoId
    ? (videoTool = downloadJoysoundYoutubeVideoPromise(
        paths,
        songId,
        queueItem.youtubeVideoId,
        downloadQueueItem,
        tempFilename,
        stopVideo.signal,
      ))
    : joysoundApi
        .getMovieUrls(songId)
        .catch(joysoundFailure)
        .then((data) => {
          videoTool = downloadJoysoundVideoPromise(
            paths,
            songId,
            data.movie.mov1,
            downloadQueueItem,
            tempFilename,
            ffmpegLogFilename,
            stopVideo.signal,
          );
          return videoTool;
        });

  let joysoundSongRawData;
  try {
    [, joysoundSongRawData] = await Promise.all([
      videoDataPromise,
      songDataPromise,
    ]);
  } catch (err) {
    // One step failed. The video step's tool stops (or never starts, if
    // Joysound's video URL comes later) and, once it has exited, the
    // download fails: runDownload then deletes what both steps left. The
    // requests to Joysound write nothing, so they aren't waited for.
    stopVideo.abort();
    await videoTool.catch(() => {});
    throw err;
  }

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
    paths,
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
    await padJoysoundVideoPromise(
      paths,
      data,
      videoFilename,
      ffmpegLogFilename,
    );
  }

  if (!fs.existsSync(videoFilename)) {
    throw new DownloadFailure(
      REASONS.videoProcessing,
      `ffmpeg left no ${videoFilename}`,
    );
  }

  return { ...queueItem, playtime: Math.floor(data.songPlaytime / 1000) };
}

// Downloads a YouTube video to yt-<videoId>.mp4, and its captions to
// yt-<videoId>.vtt if captionCode.
export async function youtubeJob(
  paths: JobPaths,
  downloadQueueItem: DownloadQueueItem,
  videoId: string,
  captionCode: string | null,
): Promise<void> {
  const filenamePrefix = `yt-${videoId}`;
  const writeBasePath = `${paths.folder}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const vttFilename = `${writeBasePath}.vtt`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  // validate.ts already refuses these; this keeps a bad code off yt-dlp's
  // command line whoever calls.
  if (captionCode !== null && !isCaptionCode(captionCode)) {
    throw new DownloadFailure(
      REASONS.other,
      `${captionCode} is not a valid caption code`,
    );
  }

  prepareTempFile(paths.folder, filenamePrefix, tempFilename);

  console.info(`Downloading YouTube video to ${videoFilename}`);

  const captionArgs = captionCode
    ? ["--write-subs", "--sub-langs", captionCode]
    : [];

  try {
    await runTool({
      label: `yt-dlp (YouTube ${videoId})`,
      bin: paths.ytdlp,
      args: [
        ...captionArgs,
        "-S",
        "res:720,ext:mp4:m4a",
        "--recode",
        "mp4",
        "-N",
        "4",
        "--ffmpeg-location",
        paths.ffmpeg,
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
}

// Downloads a Niconico video to nico-<videoId>.mp4.
export async function nicoJob(
  paths: JobPaths,
  downloadQueueItem: DownloadQueueItem,
  videoId: string,
): Promise<void> {
  const filenamePrefix = `nico-${videoId}`;
  const writeBasePath = `${paths.folder}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  prepareTempFile(paths.folder, filenamePrefix, tempFilename);

  console.info(`Downloading Niconico video to ${videoFilename}`);

  try {
    await runTool({
      label: `yt-dlp (Niconico ${videoId})`,
      bin: paths.ytdlp,
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
}
