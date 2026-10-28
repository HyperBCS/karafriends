import type { MouseEvent } from "react";

import type { QueueSongInput } from "../../common/api";
import { useApiMutation } from "../../common/apiQueries";
import { ERROR } from "./useDownloadButtonText";
import useReadings from "./useReadings";

// Queues a song (the queueSong method) for a queue button. The server answers
// with the ETA, or why it won't queue it (already queued, over the limit);
// show() gets onQueued(eta) or "Error: <reason>" for the button.
export default function useQueueSong(
  show: (text: string) => void,
  onQueued: (eta: number) => string,
) {
  const { mutate } = useApiMutation("queueSong", {
    onSuccess: (result) =>
      show(result.ok ? onQueued(result.eta) : `${ERROR}: ${result.reason}`),
    onError: (err) => show(`${ERROR}: ${err.message}`),
  });
  // The song shows on the TV the way this phone reads it.
  const readingsMode = useReadings();
  // Holding shift asks to put it next (only an admin's request does).
  return (input: QueueSongInput, e: MouseEvent) => {
    const song: QueueSongInput = {
      ...input,
      tryHeadOfQueue: e.shiftKey,
      readingsMode,
    };
    mutate(song);
  };
}
