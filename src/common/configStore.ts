// The running config and config.yaml, kept together: read once at launch,
// changed only through update(), which checks the values, writes the file
// and tells every listener. config.ts makes the app's one store.
//
// No Electron imports, so unit tests can load this file under plain Node.
import fs from "fs";
import { isMap, isScalar, parse, parseDocument, stringify } from "yaml";

import {
  configFromFile,
  configProblems,
  DEFAULT_CONFIG,
  type ConfigKey,
  type KarafriendsConfig,
} from "./configSchema";
import { writeFileAtomic } from "./writeFileAtomic";

export interface ConfigStore {
  // The running config: config.yaml's values with the environment's
  // overrides on top. Always the same object, changed in place, so code
  // holding it sees every update.
  get(): Readonly<KarafriendsConfig>;
  // What config.yaml holds (no environment overrides), as a copy.
  saved(): KarafriendsConfig;
  // What config.yaml held when the app started.
  readonly atLaunch: Readonly<KarafriendsConfig>;
  // Why config.yaml couldn't be read at launch, so the defaults are in use,
  // in a sentence for the host; null if it was read (or there was none).
  readonly loadProblem: string | null;
  // Whether there was no config.yaml at launch (a first start, or a deleted
  // file): the display then opens its setup screen.
  readonly createdAtLaunch: boolean;
  // Changes some settings in config.yaml (written through a temp file) and
  // in the running config, then calls the listeners with the keys whose
  // value changed. Throws, changing nothing, if a value is the wrong type or
  // out of range (see CONFIG_RULES) or the file can't be written.
  update(values: Partial<KarafriendsConfig>): void;
  // Returns a function that stops it.
  onChange(listener: (change: { keys: ConfigKey[] }) => void): () => void;
}

// Writes config to filePath through a flushed temp file, so an interrupted
// write or a power cut can't leave half a file. It holds the logins, so
// only this user may read it.
function writeConfigFile(filePath: string, config: KarafriendsConfig) {
  writeFileAtomic(filePath, stringify(config), { private: true });
}

// A config.yaml (or a copy of one) that older versions left readable by
// everyone on the computer: only this user, from now on. Not on Windows,
// whose user folders are their user's anyway.
function makePrivate(filePath: string) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn(`Couldn't make ${filePath} private:`, err);
  }
}

// Why a file can't be read as settings. Not the parser's message: it quotes
// the line, which may hold a password.
class UnreadableConfig extends Error {}

// config.yaml read as settings: the values YAML gives, and every value as
// text (see configFromFile). A key given twice isn't fatal, though YAML
// says it is: the last one wins, and a warning says so. That's the likeliest
// hand-edit mistake (a line added, the old one left in).
function readSettings(text: string): {
  parsed: object | null;
  asText: Record<string, unknown> | null;
} {
  // No warnings: the parser prints them with the line they're about, which
  // may hold a password.
  const options = { logLevel: "error", uniqueKeys: false } as const;
  const doc = parseDocument(text, options);
  if (doc.errors.length > 0) {
    const line = doc.errors[0].linePos?.[0]?.line;
    throw new UnreadableConfig(`line ${line ?? "?"} isn't valid YAML`);
  }
  const parsed: unknown = doc.toJS();
  // A file of comments only parses as null.
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new UnreadableConfig("it isn't a list of settings");
  }
  if (isMap(doc.contents)) {
    const seen = new Set<unknown>();
    for (const { key } of doc.contents.items) {
      const name = isScalar(key) ? key.value : key;
      if (seen.has(name)) {
        console.warn(
          `${String(name)} is in config.yaml twice; using the last one`,
        );
      }
      seen.add(name);
    }
  }
  const asText: unknown = parse(text, { ...options, schema: "failsafe" });
  return {
    parsed: parsed as object | null,
    asText:
      asText && typeof asText === "object"
        ? (asText as Record<string, unknown>)
        : null,
  };
}

// The saved config at launch: the file's values over the defaults, written
// back so the file lists every setting. And why the file couldn't be read,
// if it couldn't.
function loadAtLaunch(filePath: string): {
  config: KarafriendsConfig;
  loadProblem: string | null;
  created: boolean;
} {
  console.log(`Checking ${filePath} for configs`);
  let config: KarafriendsConfig = { ...DEFAULT_CONFIG };
  let loadProblem: string | null = null;
  let text: string | null = null;
  const created = !fs.existsSync(filePath);
  if (!created) {
    makePrivate(filePath);
    try {
      text = fs.readFileSync(filePath, { encoding: "utf8" });
    } catch (err) {
      console.error(`Failed to read ${filePath}:`, err);
      return {
        config,
        loadProblem:
          `config.yaml couldn't be read (${(err as Error).message}), so ` +
          "karafriends started with the default settings.",
        created,
      };
    }
  }

  if (text !== null && /^[\s\0]*$/.test(text)) {
    // Empty, or zeros: karafriends never writes that, so the file was cut
    // short (a power cut as it was saved, say). Nothing in it to keep.
    loadProblem =
      "config.yaml was empty, so karafriends started with the default " +
      "settings. If you had settings, enter them again, or use Import " +
      "config with a file from Export config.";
    console.error(`${filePath} was empty; using the defaults.`);
  } else if (text !== null) {
    try {
      const { parsed, asText } = readSettings(text);
      const result = configFromFile(parsed, asText);
      for (const problem of result.problems) console.warn(problem);
      config = result.config;
    } catch (err) {
      // config.yaml is often hand-edited, so a YAML typo (or a file that
      // isn't settings at all) must not crash the app. Use the defaults
      // for this session, and keep a copy of the file: a change on the
      // settings screen writes config.yaml, and the copy keeps the logins
      // in it.
      const copy = `${filePath}.broken`;
      try {
        fs.copyFileSync(filePath, copy);
        makePrivate(copy);
      } catch (copyErr) {
        console.error(`Failed to copy ${filePath} to ${copy}:`, copyErr);
      }
      const why =
        err instanceof UnreadableConfig ? err.message : "it couldn't be read";
      console.error(
        `Failed to parse ${filePath} (${why}); using defaults for this ` +
          `session. A copy is in ${copy}. Fix the YAML and relaunch to ` +
          "restore your settings.",
      );
      return {
        config,
        loadProblem:
          `Couldn't read config.yaml (${why}), so default settings are in ` +
          `use. A backup is at ${copy}. Fix config.yaml and restart ` +
          "karafriends.",
        created,
      };
    }
  }

  // Write back the defaults for any new settings, without the obsolete
  // ones, unless the file has them all already. Best-effort, so an
  // unwritable userData folder doesn't stop the app.
  if (text !== stringify(config)) {
    try {
      writeConfigFile(filePath, config);
    } catch (err) {
      console.error(`Failed to write config to ${filePath}:`, err);
    }
  }
  return { config, loadProblem, created };
}

export function createConfigStore(
  filePath: string,
  env: Record<string, string | undefined> = {},
): ConfigStore {
  const launch = loadAtLaunch(filePath);
  let saved = launch.config;
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
    loadProblem: launch.loadProblem,
    createdAtLaunch: launch.created,

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
