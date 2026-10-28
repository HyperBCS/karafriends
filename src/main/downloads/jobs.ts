// One download job per kind of song: the yt-dlp and ffmpeg runs that make
// its files in the temp folder, and the progress they report.
//
// No Electron imports, so unit tests can load this file under plain Node:
// the folder and the tools come in as JobPaths.
import fs from "fs";
import path from "path";

import type { JoysoundQueueItem } from "../../common/api";
import { isCaptionCode } from "../../common/captionCode";
import {
  DownloadFailure,
  isDamSample,
  REASONS,
  ytdlpFailureReason,
} from "../../common/downloadFailure";
import { getSongDuration } from "../../common/joysoundParser";
import { nicoWatchUrl } from "../../common/nicoVideoInfo";
import { songFileNames } from "../../common/songFiles";
import type { JoysoundAPI } from "../joysoundApi";
import type { DownloadQueueItem } from "../state";
import { withDamSlot, withYtdlpSlot } from "./queue";
import { parseDuration, probeDuration, runTool, type ToolRun } from "./run";

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

// The names in folder, or none if it can't be listed.
function listFolder(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch (err) {
    console.error(`Failed to list ${folder} for cleanup:`, err);
    return [];
  }
}

// Deletes one video's files in folder: prefix, then ".". Not its logs,
// which say why a download failed. (IDs have no ".", so another video's
// files never match.)
function deleteTempFiles(folder: string, prefix: string): void {
  for (const filename of listFolder(folder)) {
    if (filename.startsWith(`${prefix}.`) && !filename.endsWith(".log")) {
      // NB: readdirSync returns bare names; they must be joined with
      // folder or the unlink targets the wrong (cwd-relative) path.
      safeUnlink(path.join(folder, filename));
    }
  }
}

// Creates tempFilename, which marks a download as started (in case the app
// stops halfway). One left from an earlier run means the files are
// half-done: deleteHalfDone deletes them first.
function prepareTempFile(
  folder: string,
  tempFilename: string,
  deleteHalfDone: () => void,
): void {
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);
    deleteHalfDone();
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

// The song's length in ms, from the "playtime=<ms>" comment in Joysound's
// ogg (a Vorbis comment: its length, 4 bytes little-endian, then the text).
// NaN if it has none.
export function getJoysoundOggPlaytime(oggBuffer: Buffer): number {
  const tag = "playtime=";
  const at = oggBuffer.indexOf(tag);
  if (at < 4) return NaN;
  const end = at + oggBuffer.readUInt32LE(at - 4);
  return parseInt(oggBuffer.toString("latin1", at + tag.length, end), 10);
}

// Downloads a DAM song's video, which streams meanwhile, to
// <songId>-<suffix>.mp4, unless it's there already. DAM sometimes sends a
// sample instead of the song: with the song's playtime (seconds) known, a
// video much shorter than it (isDamSample) is deleted and the download
// fails, so the song streams, and the next time it's queued it downloads
// again.
export async function damJob(
  paths: JobPaths,
  m3u8Url: string,
  songId: string,
  suffix: string,
  playtime: number | null,
): Promise<void> {
  fs.mkdirSync(paths.folder, { recursive: true });

  const names = songFileNames({ kind: "dam", songId, suffix });
  const filename = path.join(paths.folder, names.video);
  const tempFilename = `${filename}.tmp`;

  if (fs.existsSync(filename)) {
    console.info(`${filename} already exists, not redownloading`);
    return;
  }

  console.info(`Downloading DAM video to ${filename}`);

  try {
    await withDamSlot(() =>
      runTool({
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
        logFilename: path.join(paths.folder, names.log),
        freshLog: true,
        reasonForExit: () => REASONS.other,
      }),
    );
  } catch (err) {
    safeUnlink(tempFilename);
    throw err;
  }
  if (playtime) {
    const duration = await probeDuration(paths.ffmpeg, tempFilename);
    if (duration !== null && isDamSample(duration, playtime)) {
      safeUnlink(tempFilename);
      throw new DownloadFailure(
        REASONS.damSample,
        `DAM's video for ${songId} is ${duration} s long, the song ${playtime} s`,
      );
    }
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
  sourceFilename: string,
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
    sourceFilename,
  ];

  const onStderr = (line: string) => {
    const duration = parseDuration(line);
    if (duration !== null) songFrames = duration * 30;
    // Not before the length is known: progress would be NaN, then stick.
    if (songFrames > 0) {
      handleFFmpegDownloadLog(line, songFrames, downloadQueueItem);
    }
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
  sourceFilename: string,
  ytdlpLogFilename: string,
  signal: AbortSignal,
): Promise<void> {
  await withYtdlpSlot(
    () =>
      runTool({
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
          sourceFilename,
          "--",
          youtubeVideoId,
        ],
        logFilename: ytdlpLogFilename,
        freshLog: true,
        onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
        reasonForExit: ytdlpFailureReason,
        signal,
      }),
    signal,
  );
}

async function composeJoysoundVideoPromise(
  paths: JobPaths,
  songId: string,
  telopBuffer: Buffer,
  oggBuffer: Buffer,
  sourceFilename: string,
  videoFilename: string,
  ffmpegLogFilename: string,
): Promise<JoysoundVideoData> {
  let videoPlaytime = 0;

  const ffmpegArgs = [
    "-stream_loop",
    "-1",
    "-i",
    sourceFilename,
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

  const onStderr = (line: string) => {
    // The video's Duration comes first, as it's the first input. (The ogg
    // on stdin says "Duration: N/A", which parseDuration skips.)
    if (videoPlaytime !== 0) return;
    const duration = parseDuration(line);
    if (duration !== null) videoPlaytime = Math.round(duration * 1000);
  };

  try {
    await runJoysoundFFmpeg(paths, songId, ffmpegArgs, ffmpegLogFilename, {
      onStderr,
      stdin: oggBuffer,
    });
  } finally {
    safeUnlink(sourceFilename);
  }

  return {
    songDuration: getSongDuration(telopBuffer) * 1000,
    songPlaytime: getJoysoundOggPlaytime(oggBuffer),
    songId,
    oggBuffer,
    videoPlaytime,
  };
}

// What padJoysoundVideoPromise names its files: the video's name without
// ".mp4", then one of these.
const PAD_FILE_ENDINGS = [
  "-no-sound.mp4",
  "-pad-1f.mp4",
  "-pad.mp4",
  "-concat.mp4",
  "-temp.mp4",
  "-out.mp4",
  "-list.txt",
];

// Pads the start of a YouTube background with its first frame, so it lines
// up with the song.
async function padJoysoundVideoPromise(
  paths: JobPaths,
  data: JoysoundVideoData,
  videoFilename: string,
  ffmpegLogFilename: string,
): Promise<void> {
  const videoBaseFilename = videoFilename.substr(0, videoFilename.length - 4);

  const [
    videoNoSoundFilename,
    videoPadFrameFilename,
    videoPadFilename,
    videoConcatFilename,
    videoTempFilename,
    videoOutFilename,
    videoListFilename,
  ] = PAD_FILE_ENDINGS.map((ending) => videoBaseFilename + ending);

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
  safeUnlink(videoListFilename);
}

// A Joysound song's files in folder (songFileNames), and what the download
// names the rest, after its video, <base>.mp4: <base>.mp4.tmp, which marks
// it started until the video is whole, and <base>.source.mp4, the video
// (Joysound's or the background) before the song's sound is put in.
function joysoundFiles(
  folder: string,
  queueItem: Pick<JoysoundQueueItem, "songId" | "youtubeVideoId">,
) {
  const names = songFileNames({
    kind: "joysound",
    songId: queueItem.songId,
    suffix: queueItem.youtubeVideoId,
  });
  const videoBaseName = names.video.slice(0, -".mp4".length);
  const videoFilename = path.join(folder, names.video);
  return {
    filenamePrefix: `joysound-${queueItem.songId}`,
    videoBaseName,
    telopFilename: path.join(folder, names.telop ?? ""),
    videoFilename,
    ffmpegLogFilename: path.join(folder, names.log),
    ytdlpLogFilename: path.join(folder, names.backgroundLog ?? names.log),
    tempFilename: `${videoFilename}.tmp`,
    sourceFilename: path.join(folder, `${videoBaseName}.source.mp4`),
  };
}

// If the song was downloaded before, queues it with pushSongToQueue and
// returns true. A video without its lyrics, one half-written when the app
// stopped, or one that can't be used, goes.
export function queueDownloadedJoysoundSong(
  folder: string,
  queueItem: JoysoundQueueItem,
  pushSongToQueue: (queueItem: JoysoundQueueItem) => void,
): boolean {
  const { telopFilename, videoFilename, tempFilename } = joysoundFiles(
    folder,
    queueItem,
  );
  if (!fs.existsSync(videoFilename)) return false;
  // The marker of a download that never finished. (None is running: queueSong
  // and the downloads' joysound check first.)
  if (fs.existsSync(tempFilename)) {
    console.error(`${videoFilename} is half-done; downloading it again`);
    deleteJoysoundTempFiles(folder, queueItem);
    return false;
  }
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

// Deletes what a failed Joysound download left, but its log: the files of
// its background only, not another background's finished video of the same
// song. The lyrics go too once no other background's files are left.
export function deleteJoysoundTempFiles(
  folder: string,
  queueItem: Pick<JoysoundQueueItem, "songId" | "youtubeVideoId">,
): void {
  const { filenamePrefix, videoBaseName, telopFilename } = joysoundFiles(
    folder,
    queueItem,
  );
  deleteTempFiles(folder, videoBaseName);
  for (const ending of PAD_FILE_ENDINGS) {
    safeUnlink(path.join(folder, videoBaseName + ending));
  }
  const otherBackground = (name: string) =>
    name.startsWith(`${filenamePrefix}-`) && !name.endsWith(".log");
  if (!listFolder(folder).some(otherBackground)) safeUnlink(telopFilename);
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
    telopFilename,
    videoFilename,
    ffmpegLogFilename,
    ytdlpLogFilename,
    tempFilename,
    sourceFilename,
  } = joysoundFiles(paths.folder, queueItem);

  prepareTempFile(paths.folder, tempFilename, () =>
    deleteJoysoundTempFiles(paths.folder, queueItem),
  );

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
        sourceFilename,
        ytdlpLogFilename,
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
            sourceFilename,
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
    sourceFilename,
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
  // Done: the video is whole.
  safeUnlink(tempFilename);

  return { ...queueItem, playtime: Math.floor(data.songPlaytime / 1000) };
}

// Downloads a YouTube or Niconico video (item's kind and songId) with
// yt-dlp to yt-<videoId>.mp4 or nico-<videoId>.mp4, and a YouTube video's
// captions to yt-<videoId>.vtt if captionCode. yt-dlp is always told where
// the app's ffmpeg is: it isn't on PATH, and without it yt-dlp can't merge
// a video with its audio (every Niconico video needs that), leaves the
// parts, and still exits 0.
export async function ytdlpVideoJob(
  paths: JobPaths,
  downloadQueueItem: DownloadQueueItem,
  captionCode: string | null,
): Promise<void> {
  const { kind, songId: videoId } = downloadQueueItem;
  if (kind !== "youtube" && kind !== "nico") {
    throw new DownloadFailure(REASONS.other, `yt-dlp doesn't download ${kind}`);
  }
  const youtube = kind === "youtube";
  const site = youtube ? "YouTube" : "Niconico";
  const names = songFileNames({ kind, songId: videoId, suffix: null });
  // yt-<videoId> or nico-<videoId>: yt-dlp names the captions after it.
  const filenamePrefix = names.video.slice(0, -".mp4".length);
  const writeBasePath = path.join(paths.folder, filenamePrefix);

  const videoFilename = path.join(paths.folder, names.video);
  const vttFilename = path.join(paths.folder, names.captions ?? "");
  const ytdlpLogFilename = path.join(paths.folder, names.log);

  const tempFilename = `${videoFilename}.tmp`;

  // validate.ts already refuses these; this keeps a bad code off yt-dlp's
  // command line whoever calls.
  if (captionCode !== null && !(youtube && isCaptionCode(captionCode))) {
    throw new DownloadFailure(
      REASONS.other,
      `${captionCode} is not a valid caption code`,
    );
  }

  prepareTempFile(paths.folder, tempFilename, () =>
    deleteTempFiles(paths.folder, filenamePrefix),
  );

  console.info(`Downloading ${site} video to ${videoFilename}`);

  const captionArgs = captionCode
    ? ["--write-subs", "--sub-langs", captionCode]
    : [];
  const formatArgs = youtube
    ? ["-S", "res:720,ext:mp4:m4a", "--recode", "mp4"]
    : [];

  try {
    await withYtdlpSlot(() =>
      runTool({
        label: `yt-dlp (${site} ${videoId})`,
        bin: paths.ytdlp,
        args: [
          ...captionArgs,
          ...formatArgs,
          "-N",
          "4",
          "--ffmpeg-location",
          paths.ffmpeg,
          "-o",
          videoFilename,
          "--",
          youtube ? videoId : nicoWatchUrl(videoId),
        ],
        logFilename: ytdlpLogFilename,
        freshLog: true,
        onStdout: (text) => handleYoutubeDownloadLog(text, downloadQueueItem),
        reasonForExit: ytdlpFailureReason,
      }),
    );
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
