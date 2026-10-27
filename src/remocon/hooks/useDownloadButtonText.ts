import { useEffect, useState } from "react";

import type { DownloadProgress } from "../../common/api";
import { useLiveState } from "../../common/apiClient";

export const WAITING_FOR_SERVER = "Waiting for server...";
export const DOWNLOADING = "Downloading";
export const FINISHED = "Finished Downloading";

// How long a queued song may take to show up in the downloads before the
// button stops waiting for it (it may have been downloaded already).
export const START_GRACE_MS = 5_000;
// How long "Finished Downloading" or an error shows.
export const RESULT_MS = 2_500;

// What a queue button shows next, given what it shows now and the progress
// of its download (null when it isn't downloading): a text, now or after a
// while. Null: nothing to do.
export function nextDownloadText(
  text: string,
  progress: number | null,
  defaultText: string,
): { text: string; afterMs: number } | null {
  if (text === FINISHED || text.includes("Error")) {
    return { text: defaultText, afterMs: RESULT_MS };
  }
  if (!text.startsWith(DOWNLOADING)) return null;
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
// in the live state, and goes back to defaultText (calling onReset) when it's
// done.
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
  const progress = useLiveState(
    (state) =>
      state?.downloads.find(
        (entry) =>
          entry.kind === download.kind &&
          entry.songId === download.songId &&
          entry.suffix === download.suffix,
      )?.progress ?? null,
  );

  useEffect(() => {
    const next = nextDownloadText(text, progress, defaultText);
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
  }, [text, progress, defaultText]);

  return [text, setText];
}
