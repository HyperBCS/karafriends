// Who is calling the API over HTTP, from the request headers
// (IDENTITY_HEADERS in src/common/api.ts). Only phones use HTTP. They say who
// they are; nothing proves it, so this only keeps honest phones in their
// lane. The display uses IPC instead (ipc.ts), so nothing that comes over
// HTTP is the display.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { IncomingHttpHeaders } from "http";

import { IDENTITY_HEADERS } from "../common/api";
import type { Caller } from "./api";

export function callerFromHeaders(headers: IncomingHttpHeaders): Caller {
  return {
    deviceId: decodeHeader(headers, IDENTITY_HEADERS.deviceId),
    nickname: decodeHeader(headers, IDENTITY_HEADERS.nickname),
    isDisplay: false,
  };
}

// GET /api/events?deviceId=...: the phone watching, so it can tell its own
// songs. Express has already percent-decoded it.
export function deviceIdFromQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const deviceId = value.trim();
  return deviceId !== "" && deviceId.length <= 200 ? deviceId : null;
}

// The values are percent-encoded, since a nickname may not be ASCII.
function decodeHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()];
  if (typeof raw !== "string") return null;
  try {
    const value = decodeURIComponent(raw).trim();
    return value !== "" && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}
