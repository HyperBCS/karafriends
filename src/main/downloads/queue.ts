// A download's place in the download queue: it starts once per song, shows
// its progress while it runs, goes when it's done, and stays a while as
// failed when it fails, so the phone that asked can say why. And the limits
// on how many tools run at once.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { failureReason } from "../../common/downloadFailure";
import {
  FAILED_DOWNLOAD_KEPT_MS,
  failDownload,
  removeDownload,
  startDownload,
  type DownloadQueueItem,
} from "../state";

// Runs at most slots of what it's given at once; the rest wait their turn,
// first come first served. One whose signal aborts while it waits rejects
// at once, and never runs.
export type Limiter = <T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export function createLimiter(slots: number): Limiter {
  let running = 0;
  const waiting: (() => void)[] = [];
  const stopped = () => new Error("stopped while waiting for its turn");
  const take = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(stopped());
    if (running < slots) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(stopped());
      };
      const turn = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiting.push(turn);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  // The next one waiting gets the slot.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return async (run, signal) => {
    await take(signal);
    try {
      return await run();
    } finally {
      release();
    }
  };
}

// How many yt-dlp runs (YouTube, Niconico, and a Joysound song's YouTube
// background) go at once. Each is heavy (on Windows, an exe that unpacks
// itself, then four connections and a recode), so the rest wait their
// turn, shown as downloading at 0%. A job holds a slot only while its
// yt-dlp runs, not while it waits for Joysound or puts the video together.
export const YTDLP_SLOTS = 2;
export const withYtdlpSlot = createLimiter(YTDLP_SLOTS);

// How many DAM videos download at once. Each is an ffmpeg copying an HLS
// stream, which shares the line with the song the TV streams meanwhile.
export const DAM_SLOTS = 2;
export const withDamSlot = createLimiter(DAM_SLOTS);

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
  // (Unref'd: it needn't keep a test's process alive.)
  setTimeout(
    () => removeDownload(downloadQueue, item),
    FAILED_DOWNLOAD_KEPT_MS,
  ).unref();
  try {
    onFailed(reason);
  } catch (callbackErr) {
    console.error(
      `Reporting the failure of ${description} failed:`,
      callbackErr,
    );
  }
}

export interface Download<T> {
  // For the log: "YouTube video <id>".
  description: string;
  job: (item: DownloadQueueItem) => Promise<T>;
  onReady: (result: T) => void;
  // Deletes what a failed job left.
  cleanUp?: () => void;
  onFailed: (reason: string) => void;
}

// Adds download to the download queue, runs its job, and takes it out of the
// download queue when it's done, then calls onReady with its result. If the
// job fails, cleanUp runs and the item is marked failed (failDownloadItem).
// Fire and forget: nothing it does can throw to the caller or go unhandled.
export function runDownload<T>(
  downloadQueue: DownloadQueueItem[],
  key: Pick<DownloadQueueItem, "kind" | "songId" | "suffix" | "userIdentity">,
  { description, job, onReady, cleanUp, onFailed }: Download<T>,
): void {
  const item = startDownload(downloadQueue, key);
  Promise.resolve()
    .then(() => job(item))
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
          cleanUp?.();
        } catch (cleanupErr) {
          console.error(`Cleaning up after ${description} failed:`, cleanupErr);
        }
        failDownloadItem(downloadQueue, item, description, err, onFailed);
      },
    );
}
