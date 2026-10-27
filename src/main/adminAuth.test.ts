// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  hashAdminPassword,
  isAdminPassword,
  type AdminPasswordConfig,
} from "../common/adminPassword";
import {
  createAdminSessions,
  createSetAdminPassword,
  MAX_ADMIN_SESSIONS,
} from "./adminAuth";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-admin-test-"));
  file = path.join(dir, "adminSessions.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("admin sessions", () => {
  test("a new token is 32 random bytes as hex, and a live session", () => {
    const sessions = createAdminSessions(file);
    const a = sessions.create();
    const b = sessions.create();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.equal(sessions.has(a), true);
    assert.equal(sessions.has(b), true);
    assert.equal(sessions.has(null), false);
    assert.equal(sessions.has(""), false);
    assert.equal(sessions.has("0".repeat(64)), false);
    assert.equal(sessions.has(a.toUpperCase()), false);
  });

  test("survive a restart, kept as hashes", () => {
    const first = createAdminSessions(file);
    const token = first.create();
    const ended = first.create();
    first.remove(ended);
    assert.doesNotMatch(fs.readFileSync(file, "utf-8"), new RegExp(token));

    const second = createAdminSessions(file);
    assert.equal(second.has(token), true);
    assert.equal(second.has(ended), false);
  });

  test("remove ends one, clear ends all, and both are saved", () => {
    const sessions = createAdminSessions(file);
    const tokens = [sessions.create(), sessions.create(), sessions.create()];
    sessions.remove(tokens[0]);
    sessions.remove(null);
    sessions.remove("not a token");
    assert.deepEqual(tokens.map(sessions.has), [false, true, true]);
    sessions.clear();
    assert.deepEqual(tokens.map(sessions.has), [false, false, false]);
    const reloaded = createAdminSessions(file);
    assert.deepEqual(tokens.map(reloaded.has), [false, false, false]);
  });

  test("keep the newest MAX_ADMIN_SESSIONS", () => {
    const sessions = createAdminSessions(file);
    const first = sessions.create();
    const second = sessions.create();
    let last = "";
    for (let i = 2; i <= MAX_ADMIN_SESSIONS; i++) last = sessions.create();
    assert.equal(sessions.has(first), false);
    assert.equal(sessions.has(second), true);
    assert.equal(sessions.has(last), true);
  });

  test("a missing or broken file means none, without throwing", (t) => {
    t.mock.method(console, "error", () => {});
    const missing = createAdminSessions(path.join(dir, "nested", "s.json"));
    assert.equal(missing.has("0".repeat(64)), false);
    // It makes the folder when it saves.
    assert.equal(missing.has(missing.create()), true);

    for (const text of ["{", '{"sessions": 5}', "null"]) {
      fs.writeFileSync(file, text);
      const sessions = createAdminSessions(file);
      assert.equal(sessions.has(sessions.create()), true);
    }
    // Junk entries are dropped.
    fs.writeFileSync(file, JSON.stringify({ sessions: [1, "x", null] }));
    createAdminSessions(file).clear();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), {
      sessions: [],
    });
  });
});

describe("setAdminPassword", () => {
  const setup = (config: AdminPasswordConfig) => {
    const sessions = createAdminSessions(file);
    const saved: AdminPasswordConfig[] = [];
    const setAdminPassword = createSetAdminPassword({
      config,
      saveConfig(values) {
        saved.push(values);
        Object.assign(config, values);
      },
      sessions,
    });
    return { sessions, saved, setAdminPassword };
  };

  test("makes a salt the first time, then keeps it", () => {
    const config = { adminPasswordHash: "", adminPasswordSalt: "" };
    const { saved, setAdminPassword } = setup(config);
    setAdminPassword("first");
    const salt = config.adminPasswordSalt;
    assert.match(salt, /^[0-9a-f]{32}$/);
    assert.equal(config.adminPasswordHash, hashAdminPassword("first", salt));
    assert.equal(isAdminPassword("first", config), true);

    setAdminPassword("second");
    assert.equal(config.adminPasswordSalt, salt);
    assert.equal(isAdminPassword("first", config), false);
    assert.equal(isAdminPassword("second", config), true);
    assert.equal(saved.length, 2);
  });

  test("signs every phone out", () => {
    const config = { adminPasswordHash: "", adminPasswordSalt: "" };
    const { sessions, setAdminPassword } = setup(config);
    setAdminPassword("first");
    const tokens = [sessions.create(), sessions.create()];
    setAdminPassword("second");
    assert.deepEqual(tokens.map(sessions.has), [false, false]);
    // Saved that way too.
    assert.deepEqual(tokens.map(createAdminSessions(file).has), [false, false]);
  });

  test("an empty password means none", () => {
    const config = { adminPasswordHash: "", adminPasswordSalt: "" };
    const { setAdminPassword } = setup(config);
    setAdminPassword("first");
    setAdminPassword("");
    assert.equal(config.adminPasswordHash, "");
    assert.equal(isAdminPassword("first", config), false);
    assert.equal(isAdminPassword("", config), false);
  });
});
