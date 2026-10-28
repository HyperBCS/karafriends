// The guide melodies read so far (useGuideMelody.ts), by song: each read
// once and shared, and stopped when nobody wants it any more (the song was
// skipped, or the bars turned off, before it was read). Pure (the read
// itself is passed in), so the unit tests reach it.

interface Entry<T> {
  result: Promise<T>;
  controller: AbortController;
  // Callers that haven't released it.
  users: number;
  settled: boolean;
  // A pending abort, once the last user released it.
  abortTimer?: ReturnType<typeof setTimeout>;
}

export class SharedReads<T> {
  private readonly entries = new Map<string, Entry<T>>();

  // kept: how many finished reads are kept, for a song sung again.
  constructor(private readonly kept: number) {}

  // The result of read() for `key`, started now or shared with a read
  // already going or done. Call release() once it's no longer wanted: a
  // read that every caller released before it finished is aborted (its
  // signal) and forgotten, so the next use starts it again. The abort waits
  // a moment, so a release and a use straight after (React's StrictMode
  // runs effects twice) share one read. A failed read isn't kept.
  use(
    key: string,
    read: (signal: AbortSignal) => Promise<T>,
  ): { result: Promise<T>; release: () => void } {
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const started: Entry<T> = {
        result: read(controller.signal),
        controller,
        users: 0,
        settled: false,
      };
      started.result.then(
        () => {
          started.settled = true;
          this.trim();
        },
        () => {
          started.settled = true;
          this.forget(key, started);
        },
      );
      this.entries.set(key, started);
      entry = started;
    }
    const used = entry;
    used.users++;
    clearTimeout(used.abortTimer);
    let released = false;
    return {
      result: used.result,
      release: () => {
        if (released) return;
        released = true;
        used.users--;
        if (used.users > 0 || used.settled) return;
        used.abortTimer = setTimeout(() => {
          if (used.users > 0 || used.settled) return;
          used.controller.abort();
          this.forget(key, used);
        });
      },
    };
  }

  private forget(key: string, entry: Entry<T>) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  // Forgets the oldest finished reads past `kept`.
  private trim() {
    const finished = [...this.entries].filter(([, entry]) => entry.settled);
    const extra = Math.max(0, finished.length - this.kept);
    for (const [key, entry] of finished.slice(0, extra)) {
      this.forget(key, entry);
    }
  }
}
