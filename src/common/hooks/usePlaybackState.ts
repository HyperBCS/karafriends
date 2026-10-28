import type { PlaybackCommand, PlaybackState } from "../api";
import { call, useLiveState } from "../apiClient";
import useLiveSetter from "./useLiveSetter";

// The display's playback state, live, and a setter for it that names the
// song it is for (its songKey).
export default function usePlaybackState() {
  const live = useLiveState((state) => state?.playbackState ?? "WAITING");
  const [playbackState, set] = useLiveSetter(
    live,
    (next: PlaybackState, song: string) =>
      next === "WAITING"
        ? Promise.resolve(false)
        : call("setPlaybackState", { playbackState: next, song }),
    "set the playback state",
  );
  const setPlaybackState: (next: PlaybackCommand, song: string) => void = set;
  return { playbackState, setPlaybackState };
}
