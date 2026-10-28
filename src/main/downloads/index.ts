// Downloads songs into TEMP_FOLDER before they join the queue (DAM songs
// join at once and stream meanwhile), and looks up Niconico videos. The
// display plays the files from there through karafriends://local/.
import { execFile } from "child_process";
import { app } from "electron";
import { promisify } from "util";

import type { JoysoundQueueItem, UserIdentity } from "../../common/api";
import { envWithoutHttpProxy } from "../../common/childEnv";
import {
  DownloadFailure,
  REASONS,
  toolCommand,
} from "../../common/downloadFailure";
import {
  ensureExternalResources,
  getResourcePaths,
} from "../../common/externalResources";
import {
  isNicoVideoId,
  limitLookups,
  NicoVideoMetadata,
  nicoWatchUrl,
  parseNicoVideoInfo,
} from "../../common/nicoVideoInfo";
import type { JoysoundAPI } from "../joysoundApi";
import type { DownloadQueueItem } from "../state";
import {
  damJob,
  deleteJoysoundTempFiles,
  joysoundJob,
  nicoJob,
  queueDownloadedJoysoundSong,
  youtubeJob,
  type JobPaths,
} from "./jobs";
import { alreadyDownloading, runDownload } from "./queue";

const execFileAsync = promisify(execFile);

export const TEMP_FOLDER: string = `${app.getPath("temp")}/karafriends_tmp`;

// The folder and the tools, once the tools are there. A failure to get
// them is a DownloadFailure, for guests.
async function jobPaths(): Promise<JobPaths> {
  try {
    await ensureExternalResources();
  } catch (err) {
    throw new DownloadFailure(
      REASONS.noTools,
      `couldn't get ffmpeg and yt-dlp: ${err}`,
    );
  }
  return { folder: TEMP_FOLDER, ...getResourcePaths() };
}

// The DAM videos downloading now, as <songId>-<suffix>. They aren't in the
// download queue, as their songs are queued at once.
const damDownloads = new Set<string>();

// DAM songs join the queue at once and stream until their download is
// done, so a failure here is only logged. A second request while one runs
// returns at once: both would write the same .tmp.
export function downloadDamVideo(
  m3u8Url: string,
  songId: string,
  suffix: string,
): void {
  const key = `${songId}-${suffix}`;
  if (damDownloads.has(key)) return;
  damDownloads.add(key);
  jobPaths()
    .then((paths) => damJob(paths, m3u8Url, songId, suffix))
    .catch((err) =>
      console.error(`Error downloading DAM video with ID ${songId}:`, err),
    )
    .finally(() => damDownloads.delete(key));
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
  const key = {
    kind: "joysound" as const,
    songId,
    suffix: queueItem.youtubeVideoId,
  };
  const description = `Joysound song ${songId}`;
  // First: while it downloads, its video is there but half-made.
  if (alreadyDownloading(downloadQueue, key, description)) return;

  // Downloaded before: queue it at once.
  if (
    queueDownloadedJoysoundSong(TEMP_FOLDER, queueItem, (item) =>
      pushSongToQueue(item, pushToHead),
    )
  ) {
    return;
  }

  runDownload(
    downloadQueue,
    { ...key, userIdentity },
    description,
    async (item) => joysoundJob(await jobPaths(), item, joysoundApi, queueItem),
    (item) => pushSongToQueue(item, pushToHead),
    () => deleteJoysoundTempFiles(TEMP_FOLDER, queueItem),
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
  const key = { kind: "youtube" as const, songId: videoId, suffix: null };
  const description = `YouTube video ${videoId}`;
  if (alreadyDownloading(downloadQueue, key, description)) return;

  runDownload(
    downloadQueue,
    { ...key, userIdentity },
    description,
    async (item) => youtubeJob(await jobPaths(), item, videoId, captionCode),
    onComplete,
    () => {},
    onFailed,
  );
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
  const key = { kind: "nico" as const, songId: videoId, suffix: null };
  const description = `Niconico video ${videoId}`;
  if (alreadyDownloading(downloadQueue, key, description)) return;

  runDownload(
    downloadQueue,
    { ...key, userIdentity },
    description,
    async (item) => nicoJob(await jobPaths(), item, videoId),
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
  const command = toolCommand(getResourcePaths().ytdlp, [
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
