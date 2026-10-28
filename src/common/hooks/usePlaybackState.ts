import type { PlaybackCommand } from "../api";
import { useLiveState } from "../apiClient";
import { useApiMutation } from "../apiQueries";
import useOptimisticValue from "./useOptimisticValue";

// The display's playback state, live, and a setter for it that names the
// song it is for (its songKey).
export default function usePlaybackState() {
  const live = useLiveState((state) => state?.playbackState ?? "WAITING");
  const [playbackState, setPending, clearPending] = useOptimisticValue(live);
  const { mutate } = useApiMutation("setPlaybackState", {
    onError: (err) => {
      console.error("Couldn't set the playback state:", err);
      clearPending();
    },
  });

  const setPlaybackState = (next: PlaybackCommand, song: string) => {
    setPending(next);
    mutate({ playbackState: next, song });
  };

  return { playbackState, setPlaybackState };
}
