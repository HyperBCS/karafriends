// What config.yaml holds, its defaults, and how a parsed file becomes the
// config. config.ts reads and writes the file.
//
// No Electron imports, so unit tests can load this file under plain Node.

export interface KarafriendsConfig {
  // Whether to use the low bitrate URLs for DAM songs
  useLowBitrateUrl: boolean;
  // How many songs each phone may have queued or downloading (0: no limit)
  paxSongQueueLimit: number;
  // Which port to listen on for the remocon server
  remoconPort: number;
  // DAM username for DAM creds
  damUsername: string;
  // DAM password for DAM creds
  damPassword: string;
  // Joysound email for joysound creds
  joysoundEmail: string;
  // Joysound password for joysound creds
  joysoundPassword: string;
  // The admin password's scrypt hash (src/common/adminPassword.ts). Empty:
  // no phone can become an admin. The display always is one.
  adminPasswordHash: string;
  // Random, one per install, written when the password is first set.
  adminPasswordSalt: string;
  // Whether to enable supervised mode
  supervisedMode: boolean;
  // Whether to use a HTTP proxy (for outgoing connections)
  proxyEnable: boolean;
  // hostname or address of the HTTP proxy to use
  proxyHost: string;
  // port of the HTTP proxy to use
  proxyPort: number;
  // HTTP Basic username of the HTTP proxy to use
  proxyUser: string;
  // HTTP Basic password of the HTTP proxy to use
  proxyPass: string;
}

export const DEFAULT_CONFIG: Readonly<KarafriendsConfig> = {
  useLowBitrateUrl: false,
  paxSongQueueLimit: 1,
  remoconPort: 8080,
  damUsername: "YOUR_USERNAME_HERE",
  damPassword: "YOUR_PASSWORD_HERE",
  joysoundEmail: "YOUR_EMAIL_HERE",
  joysoundPassword: "YOUR_PASSWORD_HERE",
  adminPasswordHash: "",
  adminPasswordSalt: "",
  supervisedMode: false,
  proxyEnable: false,
  proxyHost: "PROXY_HOST_HERE",
  proxyPort: 1234,
  proxyUser: "PROXY_USER_HERE",
  proxyPass: "PROXY_PASS_HERE",
};

// Keys older versions read, which no longer do anything. The admin password
// replaced both: anyone can take a nickname, and device IDs were awkward to
// collect.
export const OBSOLETE_KEYS = ["adminDeviceIds", "adminNicks"] as const;

// The config from a parsed config.yaml (anything YAML can hold): the
// defaults, with the file's values over them. Obsolete keys are dropped, so
// the write-back removes them, and named in `problems` with anything else
// worth a log line.
export function configFromFile(parsed: unknown): {
  config: KarafriendsConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const isMapping =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  // An empty file parses as null.
  if (!isMapping && parsed !== null && parsed !== undefined) {
    problems.push("config.yaml isn't a list of settings; using the defaults");
  }
  const local: Record<string, unknown> = isMapping ? { ...parsed } : {};

  const obsolete = OBSOLETE_KEYS.filter((key) => Object.hasOwn(local, key));
  for (const key of obsolete) delete local[key];
  if (obsolete.length > 0) {
    problems.push(
      `Ignoring ${obsolete.join(" and ")} in config.yaml: they no longer make ` +
        "anyone an admin, and are removed from the file. Phones become admins " +
        "with the admin password instead (adminPasswordHash; see README).",
    );
  }

  // A hand-written hash or salt that YAML read as a number (all digits, say)
  // could never match. Clear the password and say so.
  for (const key of ["adminPasswordHash", "adminPasswordSalt"] as const) {
    if (local[key] !== undefined && typeof local[key] !== "string") {
      problems.push(
        `${key} in config.yaml must be text in quotes. The admin password ` +
          "is cleared: set it again.",
      );
      local.adminPasswordHash = "";
      local.adminPasswordSalt = "";
    }
  }

  return {
    config: { ...DEFAULT_CONFIG, ...local } as KarafriendsConfig,
    problems,
  };
}
