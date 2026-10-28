import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// How long a value this page set keeps showing after its last request is
// answered, should the live state not change meanwhile: the hub merges
// changes 250 ms apart, so the server's value may come back to the one
// shown before without a word.
export const SETTLE_MS = 1000;

// A value this page sets, over the live one, until the server has it: the
// state behind useLiveSetter, outside React so it can be tested alone.
//
// Each set shows at once. Its request goes when the one before has been
// answered, so they reach the server in order (a queue move is a change, not
// a value: each must go). The live state's changes don't wipe out what was
// set while this page's requests are out: the echo of an earlier tap would
// undo a later one. Once all are answered, the next change to the
// live value wins, or the live value itself after SETTLE_MS. A request that
// fails, or that the server answers false (it was for a song that has
// ended, say), gives the live value back at once.
export function createLiveSetter<T, A extends unknown[]>({
  send,
  onError,
  settleMs = SETTLE_MS,
}: {
  send: (value: T, ...args: A) => Promise<unknown>;
  onError: (err: unknown) => void;
  settleMs?: number;
}) {
  let pending: { value: T } | null = null;
  let live: { value: T } | null = null;
  // A request is out, and the sets made since, to send in turn.
  let inFlight = false;
  const queued: { value: T; args: A }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const clear = () => {
    stopTimer();
    if (pending === null) return;
    pending = null;
    for (const listener of listeners) listener();
  };
  const same = (a: T, b: T) =>
    Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

  const answered = (applied: boolean) => {
    inFlight = false;
    const next = queued.shift();
    if (next) {
      request(next);
    } else if (
      !applied ||
      (pending && live && same(live.value, pending.value))
    ) {
      clear();
    } else {
      stopTimer();
      timer = setTimeout(clear, settleMs);
    }
  };

  const request = ({ value, args }: { value: T; args: A }) => {
    inFlight = true;
    let result: Promise<unknown>;
    try {
      result = send(value, ...args);
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (output) => answered(output !== false),
      (err) => {
        onError(err);
        answered(false);
      },
    );
  };

  return {
    // What to show: what this page set, or else live.
    shown: (liveValue: T): T => (pending ? pending.value : liveValue),
    pending: () => pending,
    set(value: T, ...args: A) {
      stopTimer();
      pending = { value };
      for (const listener of listeners) listener();
      if (inFlight) {
        queued.push({ value, args });
      } else {
        request({ value, args });
      }
    },
    // The live value, each time it changes.
    noteLive(value: T) {
      const changed = live !== null && !same(live.value, value);
      live = { value };
      if (changed && pending && !inFlight) clear();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: stopTimer,
  };
}

// A live value this page can also set, through send (an API call, which
// resolves false when the server didn't take it). Returns the value to show
// and the setter: see createLiveSetter for how the two meet. what says what
// failed, for the log.
export default function useLiveSetter<T, A extends unknown[]>(
  live: T,
  send: (value: T, ...args: A) => Promise<unknown>,
  what: string,
): [value: T, set: (value: T, ...args: A) => void] {
  // send and what may be new each render; the setter uses the latest.
  const latest = useRef({ send, what });
  useEffect(() => {
    latest.current = { send, what };
  });
  const [setter] = useState(() =>
    createLiveSetter<T, A>({
      send: (value, ...args) => latest.current.send(value, ...args),
      onError: (err) => console.error(`Couldn't ${latest.current.what}:`, err),
    }),
  );
  useSyncExternalStore(setter.subscribe, setter.pending);
  useEffect(() => setter.noteLive(live), [setter, live]);
  useEffect(() => setter.dispose, [setter]);
  return [setter.shown(live), setter.set];
}
