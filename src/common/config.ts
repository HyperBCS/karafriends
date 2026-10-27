import { app } from "electron";
import fs from "fs";
import path from "path";
import { parse, stringify } from "yaml";

app.setName("karafriends");

export interface KarafriendsConfig {
  // Whether to use the low bitrate URLs for DAM songs
  useLowBitrateUrl: boolean;
  // Whether to download DAM songs locally instead of streaming them
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
  // Deprecated, and no longer makes anyone an admin, since anyone can take a
  // nickname. Still read, to warn that it no longer counts (src/main/api.ts).
  adminNicks?: string[];
  // List of admins by deviceId: the only way to make a phone an admin.
  adminDeviceIds: string[];
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

const DEFAULT_CONFIG: KarafriendsConfig = {
  useLowBitrateUrl: false,
  paxSongQueueLimit: 1,
  remoconPort: 8080,
  damUsername: "YOUR_USERNAME_HERE",
  damPassword: "YOUR_PASSWORD_HERE",
  joysoundEmail: "YOUR_EMAIL_HERE",
  joysoundPassword: "YOUR_PASSWORD_HERE",
  adminDeviceIds: [],
  supervisedMode: false,
  proxyEnable: false,
  proxyHost: "PROXY_HOST_HERE",
  proxyPort: 1234,
  proxyUser: "PROXY_USER_HERE",
  proxyPass: "PROXY_PASS_HERE",
};

function applyEnvironmentOverrides(config: KarafriendsConfig) {
  if (process.env.KARAFRIENDS_REMOCON_PORT)
    config.remoconPort = parseInt(process.env.KARAFRIENDS_REMOCON_PORT, 10);
  return config;
}

function getConfig(): KarafriendsConfig {
  // Refer to https://www.electronjs.org/docs/latest/api/app#appgetpathname
  // for where the config file should be placed. On Windows, it should be %APPDATA%/karafriends/config.yaml
  let config = DEFAULT_CONFIG;

  const configFilepath: string = path.join(
    app.getPath("userData"),
    "config.yaml",
  );

  console.log(`Checking ${configFilepath} for configs`);

  if (fs.existsSync(configFilepath)) {
    console.log(`Configs found. Loading them up.`);
    try {
      const localConfig: KarafriendsConfig = parse(
        fs.readFileSync(configFilepath, { encoding: "utf8", flag: "r" }),
      );
      config = { ...DEFAULT_CONFIG, ...localConfig };
    } catch (err) {
      // config.yaml is hand-edited by the user (for DAM/Joysound credentials),
      // so a YAML typo must not crash the app on startup. Fall back to defaults
      // for this session and, crucially, return before the write-back below so
      // the user's (fixable) config -- and their credentials -- are preserved.
      console.error(
        `Failed to parse ${configFilepath}; using defaults for this session. ` +
          "Fix the YAML and relaunch to restore your settings:",
        err,
      );
      return applyEnvironmentOverrides({ ...DEFAULT_CONFIG });
    }
  } else {
    console.log("No local configs found. Using default.");
  }

  // write back defaults (persists any newly-added config fields); best-effort
  // so an unwritable userData directory doesn't crash startup.
  try {
    fs.mkdirSync(path.dirname(configFilepath), { recursive: true });
    fs.writeFileSync(configFilepath, stringify(config));
  } catch (err) {
    console.error(`Failed to write config to ${configFilepath}:`, err);
  }

  return applyEnvironmentOverrides(config);
}

const karafriendsConfig: KarafriendsConfig = getConfig();

// KARAFRIENDS_LOCAL_ONLY=1 keeps the app off the network: the server listens
// on 127.0.0.1 only and mDNS is skipped, so phones can't connect. Tests and
// automated checks use it so each new Electron copy (one per worktree) doesn't
// raise a Windows Firewall prompt.
export const LOCAL_ONLY = process.env.KARAFRIENDS_LOCAL_ONLY === "1";

// KARAFRIENDS_HIDE_WINDOW=1 creates the display window hidden (and not full
// screen), so tests and automated checks don't take over the user's screen.
export const HIDE_WINDOW = process.env.KARAFRIENDS_HIDE_WINDOW === "1";

export default karafriendsConfig;
