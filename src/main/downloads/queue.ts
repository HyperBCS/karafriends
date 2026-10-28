// A download's place in the download queue: it starts once per song, shows
// its progress while it runs, goes when it's done, and stays a while as
// failed when it fails, so the phone that asked can say why.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { failureReason } from "../../common/downloadFailure";
import {
  FAILED_DOWNLOAD_KEPT_MS,
  failDownload,
  isDownloading,
  removeDownload,
  startDownload,
  type DownloadQueueItem,
} from "../state";

type DownloadKey = Pick<DownloadQueueItem, "kind" | "songId" | "suffix">;

// Whether key is downloading already, in which case it isn't started again.
export function alreadyDownloading(
  downloadQueue: DownloadQueueItem[],
  key: DownloadKey,
  description: string,
): boolean {
  if (!isDownloading(downloadQueue, key)) return false;
  console.error(`${description} was already queued, not redownloading`);
  return true;
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

// How many downloads that run yt-dlp (YouTube, Niconico, and a Joysound
// song's YouTube background) run at once. Each is heavy (on Windows, an exe
// that unpacks itself, then four connections and a recode), so the rest
// wait their turn, shown as downloading at 0%.
export const YTDLP_SLOTS = 2;

let ytdlpRunning = 0;
const ytdlpWaiting: (() => void)[] = [];

function takeYtdlpSlot(): Promise<void> {
  if (ytdlpRunning < YTDLP_SLOTS) {
    ytdlpRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => ytdlpWaiting.push(resolve));
}

// The next waiting download gets the slot.
function releaseYtdlpSlot(): void {
  const next = ytdlpWaiting.shift();
  if (next) next();
  else ytdlpRunning--;
}

const runsYtdlp = ({ kind, suffix }: DownloadKey) =>
  kind === "youtube" ||
  kind === "nico" ||
  (kind === "joysound" && suffix !== null);

// Adds download to the download queue, runs job for it (once a yt-dlp slot
// is free, if it needs one), and takes it out of the download queue when
// it's done, then calls onReady with its result. If the job fails, cleanUp
// runs and the item is marked failed (failDownloadItem). Fire and forget:
// nothing it does can throw to the caller or go unhandled.
export function runDownload<T>(
  downloadQueue: DownloadQueueItem[],
  download: DownloadKey & Pick<DownloadQueueItem, "userIdentity">,
  description: string,
  job: (item: DownloadQueueItem) => Promise<T>,
  onReady: (result: T) => void,
  cleanUp: () => void,
  onFailed: (reason: string) => void,
): void {
  const item = startDownload(downloadQueue, download);
  const run = async () => {
    if (!runsYtdlp(download)) return job(item);
    await takeYtdlpSlot();
    try {
      return await job(item);
    } finally {
      releaseYtdlpSlot();
    }
  };
  Promise.resolve()
    .then(run)
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
