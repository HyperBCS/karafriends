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
  // Every phone is an admin, no password needed. Overrides supervisedMode.
  everyoneIsAdmin: boolean;
}

export const DEFAULT_CONFIG: Readonly<KarafriendsConfig> = {
  useLowBitrateUrl: false,
  paxSongQueueLimit: 1,
  remoconPort: 8080,
  damUsername: "",
  damPassword: "",
  joysoundEmail: "",
  joysoundPassword: "",
  adminPasswordHash: "",
  adminPasswordSalt: "",
  supervisedMode: false,
  everyoneIsAdmin: false,
};

// What older versions wrote into a fresh config.yaml where nothing was set.
// Read (and imported) as empty, so the settings screen shows an empty field,
// not a fake password.
const PLACEHOLDERS: Partial<Record<keyof KarafriendsConfig, string>> = {
  damUsername: "YOUR_USERNAME_HERE",
  damPassword: "YOUR_PASSWORD_HERE",
  joysoundEmail: "YOUR_EMAIL_HERE",
  joysoundPassword: "YOUR_PASSWORD_HERE",
};

// Empties, in place, each value that is its placeholder.
export function clearPlaceholders(values: Record<string, unknown>): void {
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (values[key] === placeholder) values[key] = "";
  }
}

// Keys older versions read, which no longer do anything, and why. The admin
// password replaced the admin lists: anyone can take a nickname, and device
// IDs were awkward to collect. The proxy went because a VPN on the computer
// does its job for every request, the display's DAM streams included.
const ADMIN_LISTS_GONE =
  "the admin lists are gone. Phones become admins with the admin password.";
const PROXY_GONE =
  "karafriends no longer uses a proxy. Outside Japan, run a VPN to Japan " +
  "on this computer.";
const OBSOLETE_KEYS: Readonly<Record<string, string>> = {
  adminDeviceIds: ADMIN_LISTS_GONE,
  adminNicks: ADMIN_LISTS_GONE,
  proxyEnable: PROXY_GONE,
  proxyHost: PROXY_GONE,
  proxyPort: PROXY_GONE,
  proxyUser: PROXY_GONE,
  proxyPass: PROXY_GONE,
};

// Deletes, in place, each obsolete key in values. Returns one note per
// reason: the keys it dropped for it, as a list ("a, b and c"), and why.
export function dropObsoleteKeys(
  values: Record<string, unknown>,
): { keys: string; why: string }[] {
  const byReason = new Map<string, string[]>();
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(OBSOLETE_KEYS, key)) continue;
    const why = OBSOLETE_KEYS[key];
    byReason.set(why, [...(byReason.get(why) ?? []), key]);
    delete values[key];
  }
  return [...byReason].map(([why, keys]) => ({
    keys:
      keys.length === 1
        ? keys[0]
        : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`,
    why,
  }));
}

// The config from a parsed config.yaml (a mapping, or null for an empty
// file; configStore.ts sets anything else aside): the defaults, with the
// file's values over them. Obsolete keys are dropped, so the write-back
// removes them, and named in `problems` with anything else worth a log line.
export function configFromFile(parsed: object | null | undefined): {
  config: KarafriendsConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const local: Record<string, unknown> = { ...parsed };

  clearPlaceholders(local);

  for (const { keys, why } of dropObsoleteKeys(local)) {
    problems.push(
      `Ignoring ${keys} in config.yaml (removed from the file): ${why}`,
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

// What each setting may hold, for the settings screen and config import:
// a value outside these is refused with a problem naming the setting.
type FieldRule =
  | { type: "boolean" }
  | { type: "integer"; min: number; max: number }
  | { type: "string" };

const TEXT = { type: "string" } as const;
const PORT = { type: "integer", min: 1, max: 65535 } as const;

export const CONFIG_RULES: {
  readonly [K in keyof KarafriendsConfig]: FieldRule;
} = {
  useLowBitrateUrl: { type: "boolean" },
  paxSongQueueLimit: { type: "integer", min: 0, max: 1000 },
  remoconPort: PORT,
  damUsername: TEXT,
  damPassword: TEXT,
  joysoundEmail: TEXT,
  joysoundPassword: TEXT,
  adminPasswordHash: TEXT,
  adminPasswordSalt: TEXT,
  supervisedMode: { type: "boolean" },
  everyoneIsAdmin: { type: "boolean" },
};

export type ConfigKey = keyof KarafriendsConfig;

export const CONFIG_KEYS = Object.keys(CONFIG_RULES) as ConfigKey[];

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_RULES, key);
}

// What's wrong with values, one sentence per setting: a value of the wrong
// type or out of range, or a key that isn't a setting. Empty if nothing.
export function configProblems(values: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!isConfigKey(key)) {
      problems.push(`${key} is not a setting`);
      continue;
    }
    const rule = CONFIG_RULES[key];
    switch (rule.type) {
      case "boolean":
        if (typeof value !== "boolean") {
          problems.push(`${key} must be true or false`);
        }
        break;
      case "integer":
        if (
          !Number.isInteger(value) ||
          (value as number) < rule.min ||
          (value as number) > rule.max
        ) {
          problems.push(
            `${key} must be a whole number from ${rule.min} to ${rule.max}`,
          );
        }
        break;
      case "string":
        if (typeof value !== "string" || value.length > 1000) {
          problems.push(`${key} must be text of at most 1000 characters`);
        }
        break;
    }
  }
  return problems;
}

// The settings that only take effect after a restart: the phones' server
// listens once.
export const RESTART_KEYS: readonly ConfigKey[] = ["remoconPort"];

export const DAM_LOGIN_KEYS = ["damUsername", "damPassword"] as const;
export const JOYSOUND_LOGIN_KEYS = [
  "joysoundEmail",
  "joysoundPassword",
] as const;

// Whether a login is filled in: both fields set. (Placeholders were read as
// empty.)
export function hasLogin(
  config: Pick<KarafriendsConfig, ConfigKey>,
  service: "dam" | "joysound",
): boolean {
  const keys = service === "dam" ? DAM_LOGIN_KEYS : JOYSOUND_LOGIN_KEYS;
  return keys.every((key) => config[key] !== "");
}
