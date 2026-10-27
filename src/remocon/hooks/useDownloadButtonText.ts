import { useEffect, useRef, useState } from "react";

import type { DownloadProgress, LiveState } from "../../common/api";
import { useLiveState } from "../../common/apiClient";

export const WAITING_FOR_SERVER = "Waiting for server...";
export const DOWNLOADING = "Downloading";
export const FINISHED = "Finished Downloading";
// Followed by ": <reason>".
export const FAILED = "Couldn't download";

// How long a queued song may take to show up in the downloads before the
// button stops waiting for it (it may have been downloaded already).
export const START_GRACE_MS = 5_000;
// How long "Finished Downloading", a failure or an error shows.
export const RESULT_MS = 2_500;

// What a queue button shows next, given what it shows now, the progress of
// its download (null when it isn't downloading) and why the download failed
// (null unless it did): a text, now or after a while. Null: nothing to do.
export function nextDownloadText(
  text: string,
  progress: number | null,
  defaultText: string,
  failure: string | null = null,
): { text: string; afterMs: number } | null {
  if (text === FINISHED || text.includes("Error") || text.startsWith(FAILED)) {
    return { text: defaultText, afterMs: RESULT_MS };
  }
  if (!text.startsWith(DOWNLOADING)) return null;
  if (failure !== null) return { text: `${FAILED}: ${failure}`, afterMs: 0 };
  if (progress !== null) {
    return {
      text:
        progress >= 1
          ? FINISHED
          : `${DOWNLOADING} -- ${(progress * 100).toFixed(1)}%`,
      afterMs: 0,
    };
  }
  // It was downloading and now it's gone: done.
  if (text !== DOWNLOADING) return { text: FINISHED, afterMs: 0 };
  // Not started yet.
  return { text: FINISHED, afterMs: START_GRACE_MS };
}

// The label of a queue button for a song that downloads before it joins the
// queue. Set it to WAITING_FOR_SERVER when asking to queue, then DOWNLOADING
// (or an error) when the server answers; from there it follows the download
// in the live state, shows why if it fails, and goes back to defaultText
// (calling onReset) when it's done.
export default function useDownloadButtonText(
  defaultText: string,
  download: {
    kind: DownloadProgress["kind"];
    songId: string;
    suffix: string | null;
  },
  onReset?: () => void,
): [string, (text: string) => void] {
  const [text, setText] = useState(defaultText);
  const find = (state: LiveState | null) =>
    state?.downloads.find(
      (entry) =>
        entry.kind === download.kind &&
        entry.songId === download.songId &&
        entry.suffix === download.suffix,
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

  // A failure is shown for a while after the button is back to defaultText.
  // Asked again, the button mustn't take that one for the new try's.
  const latestFailedId = useRef(failedId);
  latestFailedId.current = failedId;
  const staleFailedId = useRef<number | null>(null);
  const failure =
    failedId !== null && failedId !== staleFailedId.current
      ? failedReason
      : null;

  useEffect(() => {
    const next = nextDownloadText(text, progress, defaultText, failure);
    if (next === null) return;
    const show = () => {
      setText(next.text);
      if (next.text === defaultText) onReset?.();
    };
    if (next.afterMs === 0) {
      show();
      return;
    }
    const timer = setTimeout(show, next.afterMs);
    return () => clearTimeout(timer);
  }, [text, progress, failure, defaultText]);

  const show = (next: string) => {
    if (next === WAITING_FOR_SERVER) {
      staleFailedId.current = latestFailedId.current;
    }
    setText(next);
  };
  return [text, show];
}
