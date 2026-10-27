// The running config and config.yaml, kept together: read once at launch,
// changed only through update(), which checks the values, writes the file
// and tells every listener. config.ts makes the app's one store.
//
// No Electron imports, so unit tests can load this file under plain Node.
import fs from "fs";
import path from "path";
import { parse, stringify } from "yaml";

import {
  configFromFile,
  configProblems,
  DEFAULT_CONFIG,
  type ConfigKey,
  type KarafriendsConfig,
} from "./configSchema";

export interface ConfigStore {
  // The running config: config.yaml's values with the environment's
  // overrides on top. Always the same object, changed in place, so code
  // holding it sees every update.
  get(): Readonly<KarafriendsConfig>;
  // What config.yaml holds (no environment overrides), as a copy.
  saved(): KarafriendsConfig;
  // What config.yaml held when the app started.
  readonly atLaunch: Readonly<KarafriendsConfig>;
  // Changes some settings in config.yaml (written through a temp file) and
  // in the running config, then calls the listeners with the keys whose
  // value changed. Throws, changing nothing, if a value is the wrong type or
  // out of range (see CONFIG_RULES) or the file can't be written.
  update(values: Partial<KarafriendsConfig>): void;
  // Returns a function that stops it.
  onChange(listener: (change: { keys: ConfigKey[] }) => void): () => void;
}

// Writes config to filePath through a temp file, so an interrupted write
// can't leave half a file.
function writeConfigFile(filePath: string, config: KarafriendsConfig) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, stringify(config));
  fs.renameSync(tmpPath, filePath);
}

// The saved config at launch: the file's values over the defaults, written
// back so the file lists every setting.
function loadAtLaunch(filePath: string): KarafriendsConfig {
  console.log(`Checking ${filePath} for configs`);
  let config: KarafriendsConfig = { ...DEFAULT_CONFIG };
  if (fs.existsSync(filePath)) {
    try {
      const result = configFromFile(
        parse(fs.readFileSync(filePath, { encoding: "utf8" })),
      );
      for (const problem of result.problems) console.warn(problem);
      config = result.config;
    } catch (err) {
      // config.yaml is often hand-edited, so a YAML typo must not crash the
      // app. Use the defaults for this session, and keep a copy of the file:
      // a change on the settings screen writes config.yaml, and the copy
      // keeps the logins in it.
      const copy = `${filePath}.broken`;
      try {
        fs.copyFileSync(filePath, copy);
      } catch (copyErr) {
        console.error(`Failed to copy ${filePath} to ${copy}:`, copyErr);
      }
      console.error(
        `Failed to parse ${filePath}; using defaults for this session. ` +
          `A copy is in ${copy}. Fix the YAML and relaunch to restore your ` +
          "settings:",
        err,
      );
      return config;
    }
  }

  // Write back the defaults for any new settings, without the obsolete
  // ones. Best-effort, so an unwritable userData folder doesn't stop the
  // app.
  try {
    writeConfigFile(filePath, config);
  } catch (err) {
    console.error(`Failed to write config to ${filePath}:`, err);
  }
  return config;
}

export function createConfigStore(
  filePath: string,
  env: Record<string, string | undefined> = {},
): ConfigStore {
  let saved = loadAtLaunch(filePath);
  const atLaunch: Readonly<KarafriendsConfig> = Object.freeze({ ...saved });
  // The environment's overrides, which the file never gets.
  const overrides: Partial<KarafriendsConfig> = {};
  if (env.KARAFRIENDS_REMOCON_PORT) {
    overrides.remoconPort = parseInt(env.KARAFRIENDS_REMOCON_PORT, 10);
  }
  const live: KarafriendsConfig = { ...saved, ...overrides };
  const listeners = new Set<(change: { keys: ConfigKey[] }) => void>();

  return {
    get: () => live,
    saved: () => ({ ...saved }),
    atLaunch,

    update(values) {
      const problems = configProblems(values);
      if (problems.length > 0) throw new Error(problems.join("; "));

      const keys = (Object.keys(values) as ConfigKey[]).filter(
        (key) => values[key] !== saved[key],
      );
      if (keys.length === 0) return;

      const next = { ...saved, ...values };
      writeConfigFile(filePath, next);
      saved = next;
      for (const key of keys) {
        if (!Object.hasOwn(overrides, key)) {
          (live as unknown as Record<string, unknown>)[key] = next[key];
        }
      }

      for (const listener of listeners) {
        try {
          listener({ keys });
        } catch (err) {
          console.error("A config listener failed:", err);
        }
      }
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
