// Who is calling the API over HTTP, from the request headers
// (IDENTITY_HEADERS and ADMIN_TOKEN_HEADER in src/common/api.ts). Only phones
// use HTTP. They say who they are; nothing proves it. A device ID is a random
// secret that never leaves the server, so api.ts lets it decide whose a song
// is. A nickname is shown to every phone, so it only names the singer. Only
// an admin token, which the phone got by signing in with the admin password,
// makes it an admin. The display uses IPC instead (ipc.ts), so nothing that
// comes over HTTP is the display.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { IncomingHttpHeaders } from "http";

import { ADMIN_TOKEN_HEADER, IDENTITY_HEADERS } from "../common/api";
import type { Caller } from "./api";

export function callerFromHeaders(headers: IncomingHttpHeaders): Caller {
  return {
    deviceId: decodeHeader(headers, IDENTITY_HEADERS.deviceId),
    nickname: decodeHeader(headers, IDENTITY_HEADERS.nickname),
    adminToken: decodeHeader(headers, ADMIN_TOKEN_HEADER),
    isDisplay: false,
  };
}

// GET /api/events?deviceId=...: the phone watching, so it can tell its own
// songs. Express has already percent-decoded it.
export function deviceIdFromQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= 200 ? trimmed : null;
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
