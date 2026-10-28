import { useLiveState } from "../apiClient";
import { useApiMutation } from "../apiQueries";
import useOptimisticValue from "./useOptimisticValue";

// How loud Joysound's guide melody plays (0 to 1), live, and a setter for it
// (admins only).
export default function useGuideMelodyLevel() {
  const live = useLiveState((state) => state?.guideMelodyLevel ?? 0);
  const [guideMelodyLevel, setPending, clearPending] = useOptimisticValue(live);
  const { mutate } = useApiMutation("setGuideMelodyLevel", {
    onError: (err) => {
      console.error("Couldn't change the guide melody level:", err);
      clearPending();
    },
  });

  const setGuideMelodyLevel = (level: number) => {
    setPending(level);
    mutate({ level });
  };

  return { guideMelodyLevel, setGuideMelodyLevel };
}
