// Waiting on a promise for so long, and no longer.
//
// No Electron imports, so unit tests can load this file under plain Node.

// What withTimeout rejects with: label is what was waited for.
export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// promise's outcome, or a TimeoutError after ms. (promise carries on, but
// its outcome is ignored.)
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
