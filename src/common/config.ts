import { app } from "electron";
import fs from "fs";
import path from "path";
import { parse, stringify } from "yaml";

import {
  configFromFile,
  DEFAULT_CONFIG,
  type KarafriendsConfig,
} from "./configSchema";

export type { KarafriendsConfig } from "./configSchema";

app.setName("karafriends");

function applyEnvironmentOverrides(config: KarafriendsConfig) {
  if (process.env.KARAFRIENDS_REMOCON_PORT)
    config.remoconPort = parseInt(process.env.KARAFRIENDS_REMOCON_PORT, 10);
  return config;
}

// Refer to https://www.electronjs.org/docs/latest/api/app#appgetpathname
// for where the config file should be placed. On Windows, it should be %APPDATA%/karafriends/config.yaml
function configFilePath(): string {
  return path.join(app.getPath("userData"), "config.yaml");
}

// Writes config to config.yaml through a temp file, so an interrupted write
// can't leave half a file.
function writeConfigFile(config: KarafriendsConfig) {
  const configFilepath = configFilePath();
  fs.mkdirSync(path.dirname(configFilepath), { recursive: true });
  const tmpPath = `${configFilepath}.tmp`;
  fs.writeFileSync(tmpPath, stringify(config));
  fs.renameSync(tmpPath, configFilepath);
}

// What config.yaml says, with the defaults for anything it leaves out. Throws
// if it isn't valid YAML.
function readConfigFile(): KarafriendsConfig {
  const configFilepath = configFilePath();
  if (!fs.existsSync(configFilepath)) return { ...DEFAULT_CONFIG };
  const { config, problems } = configFromFile(
    parse(fs.readFileSync(configFilepath, { encoding: "utf8", flag: "r" })),
  );
  for (const problem of problems) console.warn(problem);
  return config;
}

function getConfig(): KarafriendsConfig {
  const configFilepath = configFilePath();
  console.log(`Checking ${configFilepath} for configs`);

  let config: KarafriendsConfig;
  try {
    config = readConfigFile();
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

  // write back defaults (persists any newly-added config fields, and drops
  // the obsolete ones); best-effort so an unwritable userData directory
  // doesn't crash startup.
  try {
    writeConfigFile(config);
  } catch (err) {
    console.error(`Failed to write config to ${configFilepath}:`, err);
  }

  return applyEnvironmentOverrides(config);
}

const karafriendsConfig: KarafriendsConfig = getConfig();

// Changes some settings, in config.yaml and in the running app. The rest of
// the file stays as it is (environment overrides aren't written). Throws if
// config.yaml can't be read or written.
export function updateConfig(values: Partial<KarafriendsConfig>) {
  writeConfigFile({ ...readConfigFile(), ...values });
  Object.assign(karafriendsConfig, values);
}

// KARAFRIENDS_LOCAL_ONLY=1 keeps the app off the network: the server listens
// on 127.0.0.1 only and mDNS is skipped, so phones can't connect. Tests and
// automated checks use it so each new Electron copy (one per worktree) doesn't
// raise a Windows Firewall prompt.
export const LOCAL_ONLY = process.env.KARAFRIENDS_LOCAL_ONLY === "1";

// KARAFRIENDS_HIDE_WINDOW=1 creates the display window hidden (and not full
// screen), so tests and automated checks don't take over the user's screen.
export const HIDE_WINDOW = process.env.KARAFRIENDS_HIDE_WINDOW === "1";

export default karafriendsConfig;
