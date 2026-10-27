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

  test("reads the file, drops the old admin lists and writes it back", () => {
    fs.writeFileSync(
      filePath,
      "damUsername: me\nadminDeviceIds:\n  - abc\nsupervisedMode: true\n",
    );
    const store = open();
    assert.equal(store.get().damUsername, "me");
    assert.equal(store.get().supervisedMode, true);
    assert.equal("adminDeviceIds" in onDisk(), false);
    assert.equal(onDisk().remoconPort, 8080);
  });

  test("keeps a broken file aside and uses the defaults", () => {
    const broken = "damUsername: me\n  bad: [\n";
    fs.writeFileSync(filePath, broken);
    const store = open();
    assert.deepEqual(store.get(), DEFAULT_CONFIG);
    // Not overwritten at launch, and copied for when a setting changes.
    assert.equal(fs.readFileSync(filePath, "utf8"), broken);
    assert.equal(fs.readFileSync(`${filePath}.broken`, "utf8"), broken);
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

describe("ConfigStore.update", () => {
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
