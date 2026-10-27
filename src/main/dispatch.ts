// Running one API method, for both transports: POST /api/<method> for phones
// (server.ts) and Electron IPC for the display (ipc.ts). The same validators
// and handlers either way, and the same error statuses and messages.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { ApiMethod } from "../common/api";
import { ApiError, type ApiHandlers, type Caller } from "./api";
import { validators } from "./validate";

export function isMethod(name: unknown): name is ApiMethod {
  return (
    typeof name === "string" &&
    Object.prototype.hasOwnProperty.call(validators, name)
  );
}

// Checks the input and runs the method. Throws an ApiError (400) for bad
// input, and whatever the handler throws.
export async function runMethod(
  handlers: ApiHandlers,
  method: ApiMethod,
  rawInput: unknown,
  caller: Caller,
): Promise<unknown> {
  // No input means {}.
  const input = validators[method](rawInput ?? {});
  const handler = handlers[method] as (
    input: unknown,
    caller: Caller,
  ) => Promise<unknown>;
  // undefined isn't JSON.
  return (await handler(input, caller)) ?? null;
}

// The status and message to answer a failed method with: an ApiError's own,
// any other client error's (express.json's for malformed JSON, say), or 500
// for a bug or an upstream failure, which is logged.
export function errorAnswer(
  err: unknown,
  label: string,
): { status: number; error: string } {
  if (err instanceof ApiError) {
    return { status: err.status, error: err.message };
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return { status, error: (err as Error).message };
  }
  console.error(`${label} failed:`, err);
  return { status: 500, error: String((err as Error)?.message ?? err) };
}
