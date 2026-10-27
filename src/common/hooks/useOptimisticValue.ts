import { useCallback, useEffect, useState } from "react";

// A live value this page can also set. What it sets shows at once, until the
// server's next change to the value arrives (or the request fails), so quick
// taps build on each other instead of on a stale value.
export default function useOptimisticValue<T>(
  live: T,
): [value: T, setPending: (value: T) => void, clearPending: () => void] {
  const [pending, setPendingState] = useState<{ value: T } | null>(null);

  // Whatever the server says next wins.
  useEffect(() => setPendingState(null), [live]);

  const setPending = useCallback((value: T) => setPendingState({ value }), []);
  const clearPending = useCallback(() => setPendingState(null), []);

  return [pending ? pending.value : live, setPending, clearPending];
}
