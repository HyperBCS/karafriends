// Admin sign-in: the sessions phones get from adminLogin, and ending them
// when the admin password changes.
//
// A session is a random token the phone keeps and sends back in the
// X-Karafriends-Admin-Token header. The sessions are saved (as SHA-256
// hashes of the tokens) in adminSessions.json in userData, so a restart
// mid-party doesn't sign the admins out. Changing the password ends them
// all (endSessionsOnPasswordChange).
//
// No Electron imports, so unit tests can load this file under plain Node.
import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { ConfigStore } from "../common/configStore";

export interface AdminSessions {
  // Whether token is a live session.
  has(token: string | null): boolean;
  // A new session's token: 32 random bytes as hex.
  create(): string;
  // Ends token's session, if it is one.
  remove(token: string | null): void;
  // Ends every session.
  clear(): void;
}

// The most sessions kept. Each sign-in makes one, and phones that never sign
// out leave theirs, so the oldest go first past this.
export const MAX_ADMIN_SESSIONS = 500;

const TOKEN = /^[0-9a-f]{64}$/;

const digest = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

export function createAdminSessions(filePath: string): AdminSessions {
  // Token hashes, oldest first.
  const sessions = new Set<string>(loadSessions(filePath));

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ sessions: [...sessions] }));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // The sessions still work until the app stops.
      console.error(`Failed to save the admin sessions to ${filePath}:`, err);
    }
  };

  return {
    has: (token) =>
      token !== null && TOKEN.test(token) && sessions.has(digest(token)),
    create() {
      const token = crypto.randomBytes(32).toString("hex");
      sessions.add(digest(token));
      for (const oldest of sessions) {
        if (sessions.size <= MAX_ADMIN_SESSIONS) break;
        sessions.delete(oldest);
      }
      save();
      return token;
    },
    remove(token) {
      if (token !== null && sessions.delete(digest(token))) save();
    },
    clear() {
      sessions.clear();
      save();
    },
  };
}

// The saved token hashes. A missing or unreadable file means none.
function loadSessions(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"))?.sessions;
    if (!Array.isArray(saved)) throw new Error("no sessions list");
    return saved
      .filter(
        (hash): hash is string => typeof hash === "string" && TOKEN.test(hash),
      )
      .slice(-MAX_ADMIN_SESSIONS);
  } catch (err) {
    console.error(
      `Failed to read the admin sessions from ${filePath}; every phone has to sign in again:`,
      err,
    );
    return [];
  }
}

// Ends every session when config.yaml's admin password changes: from
// setAdminPassword (which always makes a new salt, so the same password
// again counts) or importConfig. Then calls onEnded, which tells the phones
// to ask whoami again.
export function endSessionsOnPasswordChange(
  store: Pick<ConfigStore, "onChange">,
  sessions: AdminSessions,
  onEnded: () => void = () => {},
): void {
  store.onChange(({ keys }) => {
    if (
      keys.includes("adminPasswordHash") ||
      keys.includes("adminPasswordSalt")
    ) {
      sessions.clear();
      onEnded();
    }
  });
}
