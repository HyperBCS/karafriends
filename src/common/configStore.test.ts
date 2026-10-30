// Runs on Node's test runner through tsx (yarn test:unit), with config.yaml
// in a temp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { parse } from "yaml";

import { DEFAULT_CONFIG } from "./configSchema";
import { createConfigStore } from "./configStore";

type ConfigChange = { keys: string[] };

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-config-test-"));
  filePath = path.join(dir, "config.yaml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = (env: Record<string, string> = {}) =>
  createConfigStore(filePath, env);
const onDisk = () => parse(fs.readFileSync(filePath, "utf8"));

describe("createConfigStore at launch", () => {
  test("writes the defaults when there's no config.yaml", () => {
    const store = open();
    assert.deepEqual(store.get(), DEFAULT_CONFIG);
    assert.deepEqual(onDisk(), DEFAULT_CONFIG);
    assert.deepEqual(store.atLaunch, DEFAULT_CONFIG);
  });

  test("reads the file, drops the old admin lists and proxy and writes it back", () => {
    fs.writeFileSync(
      filePath,
      "damUsername: me\nadminDeviceIds:\n  - abc\nsupervisedMode: true\n" +
        "proxyEnable: true\nproxyHost: proxy.example.jp\nproxyPass: secret\n",
    );
    const store = open();
    assert.equal(store.get().damUsername, "me");
    assert.equal(store.get().supervisedMode, true);
    assert.equal("adminDeviceIds" in onDisk(), false);
    assert.equal(onDisk().remoconPort, 8080);
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /proxy|secret/);
  });

  test("keeps a broken file aside and uses the defaults", () => {
    const broken = "damUsername: me\n  bad: [\n";
    fs.writeFileSync(filePath, broken);
    const store = open();
    assert.deepEqual(store.get(), DEFAULT_CONFIG);
    // Not overwritten at launch, and copied for when a setting changes.
    assert.equal(fs.readFileSync(filePath, "utf8"), broken);
    assert.equal(fs.readFileSync(`${filePath}.broken`, "utf8"), broken);
    // The settings screen says so: which line, and where the copy is.
    assert.match(
      store.loadProblem ?? "",
      /couldn't be read \(line 1 isn't valid YAML\)/,
    );
    assert.ok(store.loadProblem?.includes(`${filePath}.broken`));
    // A save writes config.yaml; the copy stays.
    store.update({ damUsername: "you" });
    assert.equal(fs.readFileSync(`${filePath}.broken`, "utf8"), broken);
  });

  test("a readable file has no load problem", () => {
    fs.writeFileSync(filePath, "damUsername: me\n");
    assert.equal(open().loadProblem, null);
  });

  test("says whether there was no config.yaml at launch (a first start)", () => {
    assert.equal(open().createdAtLaunch, true);
    // Written with the defaults: the next launch finds it.
    assert.equal(open().createdAtLaunch, false);
  });

  test("a duplicated key isn't fatal: the last one wins, with a warning", (t) => {
    const warned = t.mock.method(console, "warn", () => {});
    fs.writeFileSync(
      filePath,
      "damUsername: me\nsupervisedMode: false\njoysoundEmail: j@example.jp\n" +
        "supervisedMode: true\n",
    );
    const store = open();
    assert.equal(store.loadProblem, null);
    assert.equal(store.get().supervisedMode, true);
    assert.equal(store.get().joysoundEmail, "j@example.jp");
    assert.equal(fs.existsSync(`${filePath}.broken`), false);
    assert.match(
      warned.mock.calls.map((call) => String(call.arguments[0])).join("\n"),
      /supervisedMode is in config.yaml twice/,
    );
  });

  test("sets aside a file that isn't a list of settings too", () => {
    for (const text of ["- damUsername: me\n", "just text\n"]) {
      fs.writeFileSync(filePath, text);
      const store = open();
      assert.deepEqual(store.get(), DEFAULT_CONFIG);
      assert.equal(fs.readFileSync(filePath, "utf8"), text);
      assert.equal(fs.readFileSync(`${filePath}.broken`, "utf8"), text);
    }
  });

  test("an empty or zeroed file (cut short) is the defaults, and says so", () => {
    for (const text of ["", "\0\0\0\0", "\n  \n"]) {
      fs.writeFileSync(filePath, text);
      const store = open();
      assert.deepEqual(store.get(), DEFAULT_CONFIG);
      assert.match(store.loadProblem ?? "", /config.yaml was empty/);
      // Nothing in it to keep.
      assert.deepEqual(onDisk(), DEFAULT_CONFIG);
      assert.equal(fs.existsSync(`${filePath}.broken`), false);
    }
  });

  test("a file of comments only is a valid empty file", () => {
    fs.writeFileSync(filePath, "# my settings\n");
    const store = open();
    assert.equal(store.loadProblem, null);
    assert.deepEqual(store.get(), DEFAULT_CONFIG);
  });

  test("checks the values: YAML 1.1 words, digit-only text, bad values", (t) => {
    const warned = t.mock.method(console, "warn", () => {});
    fs.writeFileSync(
      filePath,
      "damUsername: 0042\ndamPassword: 01234567\njoysoundPassword: 123456789012345678901\n" +
        "supervisedMode: no\neveryoneIsAdmin: off\nuseLowBitrateUrl: Yes\n" +
        "paxSongQueueLimit: lots\nremoconPort: 99999\njoysoundEmail:\n" +
        "damUserName: typo\n",
    );
    const store = open();
    const config = store.get();
    // Text keeps its digits.
    assert.equal(config.damUsername, "0042");
    assert.equal(config.damPassword, "01234567");
    assert.equal(config.joysoundPassword, "123456789012345678901");
    assert.equal(config.joysoundEmail, "");
    // off and no are false, not a truthy string.
    assert.equal(config.supervisedMode, false);
    assert.equal(config.everyoneIsAdmin, false);
    assert.equal(config.useLowBitrateUrl, true);
    // A value that can't be read is the default, with a warning.
    assert.equal(config.paxSongQueueLimit, 1);
    assert.equal(config.remoconPort, 8080);
    const warnings = warned.mock.calls
      .map((call) => String(call.arguments[0]))
      .join("\n");
    assert.match(warnings, /paxSongQueueLimit .*using 1/);
    assert.match(warnings, /remoconPort .*using 8080/);
    assert.match(warnings, /damUserName in config.yaml isn't a setting/);
    // The write-back keeps the text as text.
    assert.equal(onDisk().damPassword, "01234567");
    assert.equal(onDisk().everyoneIsAdmin, false);
  });

  test("doesn't write config.yaml back when it lists every setting already", (t) => {
    open();
    const renamed = t.mock.method(fs, "renameSync");
    open();
    assert.equal(renamed.mock.callCount(), 0);
  });

  test("logs a parse error's line number, never the line", (t) => {
    fs.writeFileSync(filePath, "damPassword: secret-pw\n  bad: [\n");
    const logged: string[] = [];
    for (const level of ["error", "warn", "log"] as const) {
      t.mock.method(console, level, (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const warned = t.mock.method(process, "emitWarning", () => {});
    open();
    assert.match(logged.join("\n"), /\(line 1 isn't valid YAML\)/);
    assert.doesNotMatch(logged.join("\n"), /secret-pw/);
    assert.equal(warned.mock.callCount(), 0);
  });

  test("KARAFRIENDS_REMOCON_PORT overrides the running port, not the file", () => {
    fs.writeFileSync(filePath, "remoconPort: 9000\n");
    const store = open({ KARAFRIENDS_REMOCON_PORT: "9123" });
    assert.equal(store.get().remoconPort, 9123);
    assert.equal(store.saved().remoconPort, 9000);
    store.update({ remoconPort: 9001 });
    assert.equal(store.saved().remoconPort, 9001);
    assert.equal(onDisk().remoconPort, 9001);
    // The override still wins while the app runs.
    assert.equal(store.get().remoconPort, 9123);
    assert.equal(store.atLaunch.remoconPort, 9000);
  });
});

// It holds the logins. (Windows has no such modes: its user folders are
// their user's.)
describe("config.yaml is readable only by its user", () => {
  const skip = process.platform === "win32";
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  test("a new one, and once it's written again", { skip }, () => {
    const store = open();
    assert.equal(mode(filePath), 0o600);
    store.update({ remoconPort: 8081 });
    assert.equal(mode(filePath), 0o600);
  });

  test(
    "one an older version left readable by everyone, at launch",
    { skip },
    () => {
      fs.writeFileSync(filePath, "remoconPort: 8080\n", { mode: 0o644 });
      fs.chmodSync(filePath, 0o644);
      open();
      assert.equal(mode(filePath), 0o600);
    },
  );

  test("the copy of a broken one", { skip }, (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    fs.writeFileSync(filePath, "damPassword: [unclosed\n");
    fs.chmodSync(filePath, 0o644);
    open();
    assert.equal(mode(`${filePath}.broken`), 0o600);
  });
});

describe("ConfigStore.update", () => {
  test("flushes the temp file to disk before renaming it into place", (t) => {
    const store = open();
    const calls: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      calls.push("fsync");
      return fsync(fd);
    });
    t.mock.method(fs, "renameSync", (from: string, to: string) => {
      calls.push("rename");
      return rename(from, to);
    });
    store.update({ damUsername: "me" });
    assert.equal(calls.indexOf("fsync") >= 0, true);
    assert.ok(calls.indexOf("fsync") < calls.indexOf("rename"), calls.join());
    assert.equal(onDisk().damUsername, "me");
  });

  test("writes the file, changes the running config in place and tells listeners", () => {
    const store = open();
    const running = store.get();
    const changes: ConfigChange[] = [];
    store.onChange((change) => changes.push(change));

    store.update({ supervisedMode: true, paxSongQueueLimit: 3 });
    assert.equal(running.supervisedMode, true);
    assert.equal(store.get(), running);
    assert.equal(onDisk().supervisedMode, true);
    assert.equal(onDisk().paxSongQueueLimit, 3);
    assert.equal(fs.existsSync(`${filePath}.tmp`), false);

    assert.deepEqual(changes, [
      { keys: ["supervisedMode", "paxSongQueueLimit"] },
    ]);
  });

  test("only the keys that changed, and nothing for no change", () => {
    const store = open();
    const changes: ConfigChange[] = [];
    store.onChange((change) => changes.push(change));
    store.update({ supervisedMode: false, damUsername: "me" });
    store.update({ damUsername: "me" });
    assert.deepEqual(
      changes.map((change) => change.keys),
      [["damUsername"]],
    );
  });

  test("refuses bad values and changes nothing", () => {
    const store = open();
    const before = fs.readFileSync(filePath, "utf8");
    const changes: ConfigChange[] = [];
    store.onChange((change) => changes.push(change));
    assert.throws(
      () =>
        store.update({
          supervisedMode: true,
          remoconPort: 70000,
          paxSongQueueLimit: -1,
        }),
      /remoconPort must be a whole number from 1 to 65535; paxSongQueueLimit/,
    );
    assert.equal(store.get().supervisedMode, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), before);
    assert.deepEqual(changes, []);
  });

  test("a failing listener doesn't stop the others, and stop() works", () => {
    const store = open();
    let heard = 0;
    store.onChange(() => {
      throw new Error("boom");
    });
    const stop = store.onChange(() => heard++);
    store.update({ supervisedMode: true });
    stop();
    store.update({ supervisedMode: false });
    assert.equal(heard, 1);
  });
});
