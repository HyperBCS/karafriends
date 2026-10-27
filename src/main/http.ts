// A small HTTP client for the DAM and Joysound APIs: timeouts, the optional
// proxy from config.yaml, a form or JSON body, and the response parsed by its
// content type.
//
// No Electron imports (services.ts passes in the proxy settings), so unit
// tests can load this file under plain Node.
import type { Agent } from "http";
import { pipeline, Transform } from "stream";

import nodeFetch, {
  Headers,
  RequestRedirect,
  Response,
  ResponseInit,
} from "node-fetch";
import tunnel from "tunnel";

import type { KarafriendsConfig } from "../common/config";

// Without a timeout, a hung upstream stalls the resolver (and the phone that
// asked) indefinitely. Aborting surfaces it as an error that the promise-retry
// wrappers can retry. The limit is on silence, not on the whole request: the
// headers must arrive within it, and then the body may take as long as it
// needs (Joysound's getFME sends a song's audio, several MB, which can take
// minutes through the proxy) as long as no gap between chunks reaches it.
const TIMEOUT_MS = 30000;

let agent: Agent | undefined;

// An error status without the service's own answer. From DAM or Joysound,
// 403 usually means the request didn't come from a Japanese IP address.
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${status} from ${url}`);
    this.name = "HttpStatusError";
  }
}

// Sends every later request through config.yaml's proxy, if it enables one.
export function setProxy(
  config: Pick<
    KarafriendsConfig,
    "proxyEnable" | "proxyHost" | "proxyPort" | "proxyUser" | "proxyPass"
  >,
) {
  agent = config.proxyEnable
    ? tunnel.httpsOverHttp({
        proxy: {
          host: config.proxyHost,
          port: config.proxyPort,
          proxyAuth: `${config.proxyUser}:${config.proxyPass}`,
        },
      })
    : undefined;
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
      agent,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new Error(`No answer from ${url} within ${timeoutMs}ms`);
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
      new Error(`${url} sent nothing for ${timeoutMs}ms mid-response`),
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
// Throws on a non-2xx status. The error page's start is only logged: the
// error's message can reach the phone that asked.
export async function http<T>(url: string, req: HttpRequest = {}): Promise<T> {
  const resp = await httpFetch(url, req);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `${resp.status} from ${url}: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    throw new Error(`${resp.status} ${resp.statusText} from ${url}`);
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
