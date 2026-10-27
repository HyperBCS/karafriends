import { commitMutation, graphql } from "react-relay";

import { useLiveState } from "../apiClient";
import environment from "../graphqlEnvironment";
import useOptimisticValue from "./useOptimisticValue";
import { usePitchShiftSemisMutation } from "./__generated__/usePitchShiftSemisMutation.graphql";

const pitchShiftSemisMutation = graphql`
  mutation usePitchShiftSemisMutation($semis: Int!) {
    setPitchShiftSemis(semis: $semis)
  }
`;

// The key change in semitones, live, and a setter for it.
export default function usePitchShiftSemis() {
  const live = useLiveState()?.pitchShiftSemis ?? 0;
  const [pitchShiftSemis, setPending, clearPending] = useOptimisticValue(live);

  const setPitchShiftSemis = (semis: number) => {
    setPending(semis);
    commitMutation<usePitchShiftSemisMutation>(environment, {
      mutation: pitchShiftSemisMutation,
      variables: { semis },
      onError: (err) => {
        console.error("Couldn't change the key:", err);
        clearPending();
      },
    });
  };

  return { pitchShiftSemis, setPitchShiftSemis };
}
