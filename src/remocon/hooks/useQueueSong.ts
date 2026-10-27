import type { MouseEvent } from "react";

import type { QueueSongInput } from "../../common/api";
import { useApiMutation } from "../../common/apiQueries";

// Queues a song (the queueSong method) for a queue button. The server answers
// with the ETA, or why it won't queue it; show() gets onQueued(eta) or an
// "Error: ..." text for the button.
export default function useQueueSong(
  show: (text: string) => void,
  onQueued: (eta: number) => string,
) {
  const { mutate, isPending } = useApiMutation("queueSong", {
    onSuccess: (result) =>
      show(result.ok ? onQueued(result.eta) : `Error: ${result.reason}`),
    onError: (err) => show(`Error: ${err.message}`),
  });
  return {
    // Holding shift asks to put it next (only an admin's request does).
    queueSong: (input: QueueSongInput, e: MouseEvent) =>
      mutate({ ...input, tryHeadOfQueue: e.shiftKey }),
    isPending,
  };
}
