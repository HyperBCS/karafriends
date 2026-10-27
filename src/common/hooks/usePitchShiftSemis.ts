import { useLiveState } from "../apiClient";
import { useApiMutation } from "../apiQueries";
import useOptimisticValue from "./useOptimisticValue";

// The key change in semitones, live, and a setter for it.
export default function usePitchShiftSemis() {
  const live = useLiveState()?.pitchShiftSemis ?? 0;
  const [pitchShiftSemis, setPending, clearPending] = useOptimisticValue(live);
  const { mutate } = useApiMutation("setPitchShiftSemis", {
    onError: (err) => {
      console.error("Couldn't change the key:", err);
      clearPending();
    },
  });

  const setPitchShiftSemis = (semis: number) => {
    setPending(semis);
    mutate({ semis });
  };

  return { pitchShiftSemis, setPitchShiftSemis };
}
