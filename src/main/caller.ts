// Who is calling the API, from the request headers (IDENTITY_HEADERS in
// src/common/api.ts). Phones say who they are; nothing proves it, so this only
// keeps honest phones in their lane. The display proves itself with a secret
// that only it can get, through the preload.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { randomBytes, timingSafeEqual } from "crypto";
import type { IncomingHttpHeaders } from "http";

import { IDENTITY_HEADERS } from "../common/api";
import type { Caller } from "./api";

// A new one each launch. The display gets it over IPC (see index.ts).
export const displayToken = randomBytes(32).toString("hex");

export function callerFromHeaders(
  headers: IncomingHttpHeaders,
  token: string = displayToken,
): Caller {
  return {
    deviceId: decodeHeader(headers, IDENTITY_HEADERS.deviceId),
    nickname: decodeHeader(headers, IDENTITY_HEADERS.nickname),
    isDisplay: sameSecret(
      headerValue(headers, IDENTITY_HEADERS.displayToken),
      token,
    ),
  };
}

// GET /api/events?deviceId=...: the phone watching, so it can tell its own
// songs. Express has already percent-decoded it.
export function deviceIdFromQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const deviceId = value.trim();
  return deviceId !== "" && deviceId.length <= 200 ? deviceId : null;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

// The values are percent-encoded, since a nickname may not be ASCII.
function decodeHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const raw = headerValue(headers, name);
  if (raw === null) return null;
  try {
    const value = decodeURIComponent(raw).trim();
    return value !== "" && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
