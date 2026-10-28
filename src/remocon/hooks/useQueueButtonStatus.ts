import formatDuration from "format-duration";
import { useEffect, useRef, useState } from "react";

import type { DownloadProgress, LiveState } from "../../common/api";
import { useLiveState } from "../../common/apiClient";
import { t } from "../i18n";
import { reasonText } from "../i18n/reasons";

// What a queue button is doing. It starts idle (its own label), is waiting
// while the server answers, and then shows the wait (queued), why the
// server wouldn't queue it (error), or the download that comes first: its
// progress (null until the download shows up in the live state), then
// finished, or why it failed. Each result shows for RESULT_MS, then it's
// idle again.
export type QueueButtonStatus =
  | { is: "idle" }
  | { is: "waiting" }
  // eta: the server's answer, for a song it queued without downloading
  // (a Joysound song downloaded earlier in the night).
  | { is: "downloading"; progress: number | null; eta: number }
  | { is: "finished" }
  | { is: "failed"; reason: string }
  | { is: "error"; reason: string }
  | { is: "queued"; eta: number };

// How long a queued song may take to show up in the downloads or the queue
// before the button stops waiting for it.
export const START_GRACE_MS = 5_000;
// How long "Downloaded", the wait, a failure or an error shows.
export const RESULT_MS = 2_500;

// What the live state says about the button's song.
export interface Seen {
  // Its download's progress, while it's listed and downloading.
  progress: number | null;
  // Why its download failed, when that's this try's.
  failure: string | null;
  // Whether a new item of this phone's for it is queued (or playing).
  queued: boolean;
}

// What a queue button shows next, given what it shows now and what the live
// state says: a status, now or after a while. Null: nothing to do.
export function nextStatus(
  status: QueueButtonStatus,
  { progress, failure, queued }: Seen,
): { status: QueueButtonStatus; afterMs: number } | null {
  switch (status.is) {
    case "idle":
    case "waiting":
      return null;
    case "finished":
    case "failed":
    case "error":
    case "queued":
      return { status: { is: "idle" }, afterMs: RESULT_MS };
    case "downloading":
      if (failure !== null) {
        return { status: { is: "failed", reason: failure }, afterMs: 0 };
      }
      if (progress !== null) {
        if (progress === status.progress) return null;
        return { status: { ...status, progress }, afterMs: 0 };
      }
      // It was downloading and now it's gone: done. (At 100% it's still
      // being put together; it's gone once it's queued.)
      if (status.progress !== null) {
        return { status: { is: "finished" }, afterMs: 0 };
      }
      // Queued without a download: it was downloaded before.
      if (queued) {
        return { status: { is: "queued", eta: status.eta }, afterMs: 0 };
      }
      // Not started yet; or done before the phone saw it.
      return { status: { is: "finished" }, afterMs: START_GRACE_MS };
  }
}

// What the button says, in the phone's language. idleLabel is the button's
// own ("Queue song").
export function statusLabel(
  status: QueueButtonStatus,
  idleLabel: string,
): string {
  switch (status.is) {
    case "idle":
      return idleLabel;
    case "waiting":
      return t("queueButton.waiting");
    case "downloading":
      return status.progress === null
        ? t("queueButton.downloading")
        : t("queueButton.downloadingPercent", {
            percent: (status.progress * 100).toFixed(1),
          });
    case "finished":
      return t("queueButton.finished");
    case "failed":
      return t("queueButton.failed", { reason: reasonText(status.reason) });
    case "error":
      return t("queueButton.error", { reason: reasonText(status.reason) });
    case "queued":
      return t("queueButton.queued", {
        eta: formatDuration(status.eta * 1000),
      });
  }
}

type Song = {
  kind: DownloadProgress["kind"];
  songId: string;
  // Joysound: the background video's ID, or null.
  suffix: string | null;
};

// The timestamps of this phone's items for the song, queued or playing.
function mineQueued(state: LiveState | null, song: Song): string {
  if (!state) return "";
  return [state.currentSong, ...state.queue]
    .filter(
      (item) =>
        item?.isMine &&
        item.kind === song.kind &&
        item.songId === song.songId &&
        (item.kind !== "joysound" || item.youtubeVideoId === song.suffix),
    )
    .map((item) => item!.timestamp)
    .join(" ");
}

// A queue button's status. Set it to waiting when asking to queue, then to
// what the server answers; from there it follows the download in the live
// state, shows why if it fails, and goes back to idle when it's done.
export default function useQueueButtonStatus(
  song: Song,
): [QueueButtonStatus, (status: QueueButtonStatus) => void] {
  const [status, setStatus] = useState<QueueButtonStatus>({ is: "idle" });
  const find = (state: LiveState | null) =>
    state?.downloads.find(
      (entry) =>
        entry.kind === song.kind &&
        entry.songId === song.songId &&
        entry.suffix === song.suffix,
    );
  // Plain values, so the button updates only when they change.
  const progress = useLiveState((state) => {
    const entry = find(state);
    return entry?.status === "downloading" ? entry.progress : null;
  });
  const failedId = useLiveState((state) => {
    const entry = find(state);
    return entry?.status === "failed" ? entry.id : null;
  });
  const failedReason = useLiveState((state) => find(state)?.reason ?? null);
  const mine = useLiveState((state) => mineQueued(state, song));

  // A failure is shown for a while after the button is idle again. Asked
  // again, the button mustn't take that one for the new try's. Nor an item
  // queued before for this try's.
  const latest = useRef({ failedId, mine });
  latest.current = { failedId, mine };
  const before = useRef<{ failedId: number | null; mine: string[] }>({
    failedId: null,
    mine: [],
  });
  const failure =
    failedId !== null && failedId !== before.current.failedId
      ? failedReason
      : null;
  const queued = mine
    .split(" ")
    .some((timestamp) => timestamp && !before.current.mine.includes(timestamp));

  useEffect(() => {
    const next = nextStatus(status, { progress, failure, queued });
    if (next === null) return;
    if (next.afterMs === 0) {
      setStatus(next.status);
      return;
    }
    const timer = setTimeout(() => setStatus(next.status), next.afterMs);
    return () => clearTimeout(timer);
  }, [status, progress, failure, queued]);

  const show = (next: QueueButtonStatus) => {
    if (next.is === "waiting") {
      before.current = {
        failedId: latest.current.failedId,
        mine: latest.current.mine.split(" "),
      };
    }
    setStatus(next);
  };
  return [status, show];
}
