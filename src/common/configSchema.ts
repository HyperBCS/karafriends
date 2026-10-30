// What config.yaml holds, its defaults, and how a parsed file becomes the
// config. config.ts reads and writes the file.
//
// No Electron imports, so unit tests can load this file under plain Node.

export interface KarafriendsConfig {
  // Whether guests may find and sing DAM's songs, and Joysound's: the host
  // can turn a catalog off whatever its login (catalogs.ts).
  damEnabled: boolean;
  joysoundEnabled: boolean;
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
  damEnabled: true,
  joysoundEnabled: true,
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
const ADMIN_LISTS_GONE = "admin lists were replaced by the admin password.";
const PROXY_GONE = "proxy support was removed. Use a VPN in Japan instead.";
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
// reason: the keys it dropped for it ("a, b, c"), and why.
export function dropObsoleteKeys(
  values: Record<string, unknown>,
): { keys: string; why: string }[] {
  const notes: { keys: string; why: string }[] = [];
  for (const why of new Set(Object.values(OBSOLETE_KEYS))) {
    const keys = Object.keys(values).filter(
      (key) => OBSOLETE_KEYS[key] === why,
    );
    for (const key of keys) delete values[key];
    if (keys.length > 0) notes.push({ keys: keys.join(", "), why });
  }
  return notes;
}

// YAML 1.1's words for true and false, which YAML 1.2 (the parser's) reads
// as text. An old or hand-written config.yaml may use them.
const YAML11_TRUE = /^(y|yes|on|true)$/i;
const YAML11_FALSE = /^(n|no|off|false)$/i;

// The config from a parsed config.yaml (a mapping, or null for an empty
// file; configStore.ts sets anything else aside): the defaults, with the
// file's values over them. Obsolete keys are dropped, so the write-back
// removes them, and named in `problems` with anything else worth a log line.
//
// Each setting is checked against CONFIG_RULES. asText is the same file
// read with every value as text (YAML's failsafe schema): a text setting
// that YAML read as a number or true/false (damPassword: 01234567) takes
// its text from there, so no digit is lost. yes/no/on/off are read as
// true/false. A value that still doesn't fit is the default, and a
// problem. A key that isn't a setting is kept, and a problem.
export function configFromFile(
  parsed: object | null | undefined,
  asText?: Record<string, unknown> | null,
): {
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

  for (const key of Object.keys(local)) {
    if (!isConfigKey(key)) {
      problems.push(
        `${key} in config.yaml isn't a setting karafriends has, so it does nothing`,
      );
      continue;
    }
    let value = local[key];
    const text = asText?.[key];
    switch (CONFIG_RULES[key].type) {
      case "string":
        // An empty value ("damPassword:") is null to YAML.
        if (value === null) value = "";
        else if (typeof value !== "string" && typeof text === "string") {
          value = text;
        }
        break;
      case "boolean":
        if (typeof value === "string" && YAML11_TRUE.test(value)) value = true;
        if (typeof value === "string" && YAML11_FALSE.test(value)) {
          value = false;
        }
        break;
      case "integer":
        if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
          value = Number(value);
        }
        break;
    }
    local[key] = value;
    if (configProblems({ [key]: value }).length === 0) continue;

    // A hand-written hash or salt that isn't text could never match. Clear
    // the password and say so.
    if (key === "adminPasswordHash" || key === "adminPasswordSalt") {
      problems.push(
        `${key} in config.yaml must be text in quotes. The admin password ` +
          "is cleared: set it again.",
      );
      local.adminPasswordHash = "";
      local.adminPasswordSalt = "";
      continue;
    }
    problems.push(
      `${configProblems({ [key]: value })[0]}, in config.yaml; using ` +
        `${JSON.stringify(DEFAULT_CONFIG[key])}, the default`,
    );
    local[key] = DEFAULT_CONFIG[key];
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
  damEnabled: { type: "boolean" },
  joysoundEnabled: { type: "boolean" },
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
