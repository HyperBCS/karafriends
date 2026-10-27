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

// Adds download to the download queue, runs job for it, and takes it out of
// the download queue when it's done, then calls onReady with its result. If
// the job fails, cleanUp runs and the item is marked failed
// (failDownloadItem). Fire and forget: nothing it does can throw to the
// caller or go unhandled.
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
          cleanUp();
        } catch (cleanupErr) {
          console.error(`Cleaning up after ${description} failed:`, cleanupErr);
        }
        failDownloadItem(downloadQueue, item, description, err, onFailed);
      },
    );
}
