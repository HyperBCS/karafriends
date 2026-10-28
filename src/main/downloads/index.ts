// Downloads songs into TEMP_FOLDER before they join the queue (DAM songs
// join at once and stream meanwhile), and looks up Niconico videos. The
// display plays the files from there through karafriends://local/.
import { execFile } from "child_process";
import { app } from "electron";
import { promisify } from "util";

import type {
  JoysoundQueueItem,
  NicoQueueItem,
  YoutubeQueueItem,
} from "../../common/api";
import {
  DownloadFailure,
  failureReason,
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
import type { SongFiles } from "../../common/songFiles";
import type { JoysoundAPI } from "../joysoundApi";
import type { ApiDeps } from "../api";
import { isDownloading, type DownloadQueueItem } from "../state";
import { clearFolder, deleteDamVideo, folderInfo } from "./folder";
import {
  damJob,
  deleteJoysoundTempFiles,
  joysoundJob,
  queueDownloadedJoysoundSong,
  ytdlpVideoJob,
  type JobPaths,
} from "./jobs";
import { runDownload } from "./queue";

export { stopAllTools } from "./run";

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

// What a Joysound download says when the same song and background is
// downloading already. (queueSong refuses it first, with the same words.)
const ALREADY_DOWNLOADING = "Someone is already adding this song";

// The downloads, for the API (ApiDeps["downloads"]): the download queue they
// show their progress in, and the Joysound client their songs come from.
export function createDownloads(
  downloadQueue: () => DownloadQueueItem[],
  joysoundApi: JoysoundAPI,
): ApiDeps["downloads"] {
  // The DAM videos downloading now, by <songId>-<suffix>. They aren't in
  // the download queue, as their songs are queued at once.
  const damDownloads = new Map<string, SongFiles>();

  // A YouTube or Niconico video (and a YouTube video's captions, if
  // captionCode).
  const video = (
    item: YoutubeQueueItem | NicoQueueItem,
    captionCode: string | null,
    onReady: () => void,
    onFailed: (reason: string) => void,
  ) =>
    runDownload(
      downloadQueue(),
      {
        kind: item.kind,
        songId: item.songId,
        suffix: null,
        userIdentity: item.user,
      },
      {
        description: `${item.kind === "youtube" ? "YouTube" : "Niconico"} video ${item.songId}`,
        job: async (download) =>
          ytdlpVideoJob(await jobPaths(), download, captionCode),
        onReady,
        onFailed,
      },
    );

  return {
    // DAM songs join the queue at once and stream until their download is
    // done, so a failure here is only logged; but a sample DAM sent instead
    // of the song (playtime seconds long, if known) goes to onFailed too,
    // for the guest. A second request while one runs returns at once: both
    // would write the same .tmp.
    dam(m3u8Url, songId, suffix, playtime, onFailed) {
      const key = `${songId}-${suffix}`;
      if (damDownloads.has(key)) return;
      damDownloads.set(key, { kind: "dam", songId, suffix });
      jobPaths()
        .then((paths) => damJob(paths, m3u8Url, songId, suffix, playtime))
        .catch((err) => {
          console.error(`Error downloading DAM video with ID ${songId}:`, err);
          if (failureReason(err) === REASONS.damSample) {
            onFailed(REASONS.damSample);
          }
        })
        .finally(() => damDownloads.delete(key));
    },

    // How many files the downloads folder holds, and their bytes.
    info: () => folderInfo(TEMP_FOLDER),

    // Deletes the downloads but inUse's songs' files and the DAM videos
    // downloading now (see clearFolder).
    clear: (inUse) =>
      clearFolder(TEMP_FOLDER, [...inUse, ...damDownloads.values()]),

    // Deletes a DAM song's downloaded video, unless it's downloading now.
    // Whether there was one.
    clearDam(songId, suffix) {
      if (damDownloads.has(`${songId}-${suffix}`)) return false;
      return deleteDamVideo(TEMP_FOLDER, songId, suffix);
    },

    // Downloads a Joysound song and its video, then queues it with onReady;
    // or calls onFailed with the reason for guests.
    joysound(queueItem, pushToHead, onReady, onFailed) {
      const key = {
        kind: "joysound" as const,
        songId: queueItem.songId,
        suffix: queueItem.youtubeVideoId,
      };
      // First: while it downloads, its video is there but half-made, and
      // queueDownloadedJoysoundSong would delete the running download's
      // files.
      if (isDownloading(downloadQueue(), key)) {
        onFailed(ALREADY_DOWNLOADING);
        return;
      }
      const queue = (item: JoysoundQueueItem) => onReady(item, pushToHead);
      // Downloaded before: queue it at once.
      if (queueDownloadedJoysoundSong(TEMP_FOLDER, queueItem, queue)) return;

      runDownload(
        downloadQueue(),
        { ...key, userIdentity: queueItem.user },
        {
          description: `Joysound song ${queueItem.songId}`,
          job: async (item) =>
            joysoundJob(await jobPaths(), item, joysoundApi, queueItem),
          onReady: queue,
          cleanUp: () => deleteJoysoundTempFiles(TEMP_FOLDER, queueItem),
          onFailed,
        },
      );
    },

    youtube: video,
    nico: (item, onReady, onFailed) => video(item, null, onReady, onFailed),
  };
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
