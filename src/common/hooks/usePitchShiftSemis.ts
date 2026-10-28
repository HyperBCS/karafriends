import { call, useLiveState } from "../apiClient";
import useLiveSetter from "./useLiveSetter";

// The key change in semitones, live, and a setter for it that names the
// song it is for (its songKey).
export default function usePitchShiftSemis() {
  const live = useLiveState((state) => state?.pitchShiftSemis ?? 0);
  const [pitchShiftSemis, setPitchShiftSemis] = useLiveSetter(
    live,
    (semis: number, song: string) =>
      call("setPitchShiftSemis", { semis, song }),
    "change the key",
  );
  return { pitchShiftSemis, setPitchShiftSemis };
}
