import { commitMutation, graphql } from "react-relay";

import type { PlaybackState } from "../api";
import { useLiveState } from "../apiClient";
import environment from "../graphqlEnvironment";
import useOptimisticValue from "./useOptimisticValue";
import { usePlaybackStateMutation } from "./__generated__/usePlaybackStateMutation.graphql";

const playbackStateMutation = graphql`
  mutation usePlaybackStateMutation($playbackState: PlaybackState!) {
    setPlaybackState(playbackState: $playbackState)
  }
`;

// The display's playback state, live, and a setter for it.
export default function usePlaybackState() {
  const live = useLiveState()?.playbackState ?? "WAITING";
  const [playbackState, setPending, clearPending] = useOptimisticValue(live);

  const setPlaybackState = (next: PlaybackState) => {
    setPending(next);
    commitMutation<usePlaybackStateMutation>(environment, {
      mutation: playbackStateMutation,
      variables: { playbackState: next },
      onError: (err) => {
        console.error("Couldn't set the playback state:", err);
        clearPending();
      },
    });
  };

  return { playbackState, setPlaybackState };
}
