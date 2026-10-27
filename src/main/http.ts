// A small HTTP client for the DAM and Joysound APIs: a timeout, the optional
// proxy from config.yaml, a form or JSON body, and the response parsed by its
// content type.
import nodeFetch, { Headers, RequestRedirect, Response } from "node-fetch";
import tunnel from "tunnel";

import karafriendsConfig from "../common/config";

// Without a timeout, a hung upstream stalls the resolver (and the phone that
// asked) indefinitely. Aborting surfaces it as an error that the promise-retry
// wrappers can retry.
const TIMEOUT_MS = 30000;

const agent = karafriendsConfig.proxyEnable
  ? tunnel.httpsOverHttp({
      proxy: {
        host: karafriendsConfig.proxyHost,
        port: karafriendsConfig.proxyPort,
        proxyAuth: `${karafriendsConfig.proxyUser}:${karafriendsConfig.proxyPass}`,
      },
    })
  : undefined;

export interface HttpRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  // A string is sent as is (callers join form bodies themselves, since
  // URLSearchParams would re-encode values like DAM's auth key); an object is
  // sent as JSON.
  body?: string | object;
  redirect?: RequestRedirect;
}

// The raw response, whatever its status, for callers that need its headers
// (Set-Cookie) or read the body themselves.
export function httpFetch(url: string, req: HttpRequest = {}) {
  const headers = new Headers(req.headers);
  let body = req.body;
  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return nodeFetch(url, {
    method: req.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    redirect: req.redirect,
    agent,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// The parsed body: JSON, an ArrayBuffer for application/octet-stream, or text.
// Throws on a non-2xx status.
export async function http<T>(url: string, req: HttpRequest = {}): Promise<T> {
  const resp = await httpFetch(url, req);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `${resp.status} ${resp.statusText} from ${url}: ${text
        .replace(/\s+/g, " ")
        .slice(0, 200)}`,
    );
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
