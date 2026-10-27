// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

import {
  hashAdminPassword,
  isAdminPassword,
  newAdminSalt,
} from "./adminPassword";

describe("the admin password", () => {
  const salt = "0123456789abcdef0123456789abcdef";

  test("hashes with scrypt's defaults, 64 bytes, the salt as text", () => {
    const hash = hashAdminPassword("sing-it-loud", salt);
    assert.match(hash, /^[0-9a-f]{128}$/);
    // What README's node -e snippet computes.
    assert.equal(
      hash,
      crypto
        .scryptSync("sing-it-loud", salt, 64, { N: 16384, r: 8, p: 1 })
        .toString("hex"),
    );
    assert.equal(
      hash,
      crypto.scryptSync("sing-it-loud", salt, 64).toString("hex"),
    );
    assert.notEqual(hashAdminPassword("sing-it-loud", `${salt}0`), hash);
  });

  test("a new salt is 16 random bytes as hex", () => {
    const a = newAdminSalt();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(newAdminSalt(), a);
  });

  test("isAdminPassword: only the password, and never while none is set", () => {
    const config = {
      adminPasswordSalt: salt,
      adminPasswordHash: hashAdminPassword("パスワード", salt),
    };
    assert.equal(isAdminPassword("パスワード", config), true);
    assert.equal(isAdminPassword("パスワード ", config), false);
    assert.equal(isAdminPassword("", config), false);
    assert.equal(
      isAdminPassword("パスワード", { ...config, adminPasswordHash: "" }),
      false,
    );
    assert.equal(
      isAdminPassword("パスワード", { ...config, adminPasswordSalt: "" }),
      false,
    );
    // A hand-edited hash that isn't one.
    assert.equal(
      isAdminPassword("パスワード", { ...config, adminPasswordHash: "zz" }),
      false,
    );
    assert.equal(
      isAdminPassword("パスワード", {
        ...config,
        adminPasswordHash: config.adminPasswordHash.slice(2),
      }),
      false,
    );
  });
});
