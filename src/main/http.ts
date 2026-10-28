// A small HTTP client for the DAM and Joysound APIs: timeouts, a form or JSON
// body, the response parsed by its content type, and withSession's retries
// and second login.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { pipeline, Transform } from "stream";
import { setTimeout as sleep } from "timers/promises";

import nodeFetch, {
  FetchError,
  Headers,
  RequestRedirect,
  Response,
  ResponseInit,
} from "node-fetch";

// Without a timeout, a hung upstream stalls the resolver (and the phone that
// asked) indefinitely. Aborting surfaces it as a NoAnswerError, which
// withSession tries again. The limit is on silence, not on the whole request: the
// headers must arrive within it, and then the body may take as long as it
// needs (Joysound's getFME sends a song's audio, several MB, which can take
// minutes over a slow VPN) as long as no gap between chunks reaches it.
const TIMEOUT_MS = 30000;

// An error status without the service's own answer. From DAM or Joysound,
// 403 usually means the request didn't come from a Japanese IP address.
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string,
    statusText = "",
  ) {
    super(`${status}${statusText && ` ${statusText}`} from ${url}`);
    this.name = "HttpStatusError";
  }
}

// The server stayed silent for longer than the request's timeout.
export class NoAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAnswerError";
  }
}

export interface HttpRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  // A string is sent as is (a form body from formBody, say); an object is
  // sent as JSON.
  body?: string | object;
  redirect?: RequestRedirect;
  // How long the server may stay silent: before the headers, or between two
  // chunks of the body. 30 seconds by default.
  timeoutMs?: number;
}

// An application/x-www-form-urlencoded body with each name and value
// percent-encoded, so a search term or password with &, +, = or % stays one
// value. (DAM and Joysound decode it, Japanese included.)
export function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// The raw response, whatever its status, for callers that need its headers
// (Set-Cookie) or read the body themselves.
export async function httpFetch(
  url: string,
  req: HttpRequest = {},
): Promise<Response> {
  const headers = new Headers(req.headers);
  let body = req.body;
  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  const timeoutMs = req.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onTimeout = () => controller.abort();
  // (Re)starts the silence timer.
  const expectMore = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onTimeout(), timeoutMs);
  };

  expectMore();
  let resp: Response;
  try {
    resp = await nodeFetch(url, {
      method: req.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      redirect: req.redirect,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new NoAnswerError(`No answer from ${url} within ${timeoutMs}ms`);
    }
    throw err;
  }

  if (resp.body === null) {
    clearTimeout(timer);
    return resp;
  }

  // The headers are in. From here on, each chunk of the body restarts the
  // timer, and the body only fails if it stalls.
  const watched = new Transform({
    transform(chunk, _encoding, callback) {
      expectMore();
      callback(null, chunk);
    },
  });
  onTimeout = () => {
    watched.destroy(
      new NoAnswerError(`${url} sent nothing for ${timeoutMs}ms mid-response`),
    );
    controller.abort();
  };
  expectMore();
  // Done or failed, the body needs no timer any more.
  pipeline(resp.body, watched, () => clearTimeout(timer));

  // url and counter (for redirected) aren't in node-fetch's types, but its
  // Response keeps them.
  const init: ResponseInit & { url: string; counter: number } = {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
    url: resp.url,
    counter: resp.redirected ? 1 : 0,
  };
  return new Response(watched, init);
}

// The parsed body: JSON, an ArrayBuffer for application/octet-stream, or text.
// Throws an HttpStatusError on a non-2xx status.
export async function http<T>(url: string, req: HttpRequest = {}): Promise<T> {
  return readBody<T>(await httpFetch(url, req), url);
}

// The body of a response from httpFetch, read as http() reads it. The error
// page's start is only logged: the error's message can reach the phone that
// asked.
export async function readBody<T>(resp: Response, url: string): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `${resp.status} from ${url}: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    throw new HttpStatusError(resp.status, url, resp.statusText);
  }
  return parseBody(resp) as Promise<T>;
}

export type HttpResponse = Response;

// Each Set-Cookie header of a response from httpFetch, unjoined.
export function getSetCookies(resp: HttpResponse): string[] {
  return resp.headers.raw()["set-cookie"] ?? [];
}

function parseBody(resp: Response): Promise<unknown> {
  const type = resp.headers.get("Content-Type") ?? "";
  if (type.startsWith("application/octet-stream")) return resp.arrayBuffer();
  if (
    resp.status !== 204 &&
    resp.headers.get("Content-Length") !== "0" &&
    (type.startsWith("application/json") || type.endsWith("+json"))
  ) {
    return resp.json();
  }
  return resp.text();
}

// An answer that says the session has ended, or may have: sound-cafe's login
// page, or a 401 or 403, where data was expected. withSession logs in again
// once.
export class SessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLostError";
  }
}

// Whether trying again soon may work: no connection, no answer in time, or
// the server's own failure (5xx, or 429 for too many requests). Not a 4xx, a
// refused login, or an answer that makes no sense: those fail the same way
// every time.
export function isTransient(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status >= 500 || err.status === 429;
  }
  if (err instanceof NoAnswerError) return true;
  // Only httpFetch's own timeout aborts a request.
  if (err instanceof Error && err.name === "AbortError") return true;
  // "system" for a refused, reset or unresolved connection, or a body that
  // broke off; no type for a connection closed mid-body.
  return (
    err instanceof FetchError &&
    (err.type === "system" || err.type === undefined)
  );
}

export interface RetryPolicy {
  // Tries after the first, for a transient failure.
  retries: number;
  // The wait before the first of them, doubled for each one after, up to
  // maxTimeoutMs.
  minTimeoutMs: number;
  maxTimeoutMs: number;
}

// For a lookup a phone is waiting on: the phone shows the error with a Retry
// button.
export const NO_RETRIES: RetryPolicy = {
  retries: 0,
  minTimeoutMs: 0,
  maxTimeoutMs: 0,
};

// For a download or a popped song: 3 more tries over about 7 seconds, so a
// network blip or a busy server doesn't fail it, and a lasting failure shows
// soon.
export const QUICK_RETRIES: RetryPolicy = {
  retries: 3,
  minTimeoutMs: 1000,
  maxTimeoutMs: 4000,
};

// A shared login (see credentials.ts): its session, and a way to drop that
// session once it has stopped working.
export interface Session<C> {
  (): Promise<C>;
  forget?(stale: C): void;
}

export interface SessionOptions {
  policy?: RetryPolicy;
  // Whether a request's failure means the session may have ended. A
  // SessionLostError by default.
  sessionLost?: (err: unknown) => boolean;
  // For the log, e.g. "getFME 425691".
  label?: string;
}

// request, with the session's credentials. A transient failure, of the login
// or of the request, is tried again up to policy.retries times. A lost
// session is dropped and the request tried once more with a new login.
// Anything else, a refused login included, fails at once.
export async function withSession<C, T>(
  session: Session<C>,
  request: (creds: C) => Promise<T>,
  {
    policy = NO_RETRIES,
    sessionLost = (err) => err instanceof SessionLostError,
    label = "request",
  }: SessionOptions = {},
): Promise<T> {
  let retried = 0;
  let loggedInAgain = false;
  for (;;) {
    let creds: C | undefined;
    try {
      creds = await session();
      return await request(creds);
    } catch (err) {
      const message = (err as Error)?.message ?? err;
      // Only the request's failure, not the login's, can mean a lost
      // session.
      if (
        creds !== undefined &&
        session.forget &&
        !loggedInAgain &&
        sessionLost(err)
      ) {
        console.warn(`${label}: logging in again after:`, message);
        session.forget(creds);
        loggedInAgain = true;
        continue;
      }
      if (retried >= policy.retries || !isTransient(err)) throw err;
      const wait = Math.min(
        policy.minTimeoutMs * 2 ** retried,
        policy.maxTimeoutMs,
      );
      retried++;
      console.warn(`${label}: try ${retried + 1} in ${wait}ms after:`, message);
      await sleep(wait);
    }
  }
}
