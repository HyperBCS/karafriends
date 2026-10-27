// Runs on Node's test runner through tsx (yarn test:unit). The logins are
// fakes; the config store is real, in a temp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createConfigStore, type ConfigStore } from "../common/configStore";
import { createCredentialProviders, memoizeSuccess } from "./credentials";

describe("memoizeSuccess", () => {
  test("keeps a success, retries after a failure, and forgets on request", async () => {
    let calls = 0;
    let fail = true;
    const login = memoizeSuccess(async () => {
      calls++;
      if (fail) throw new Error("no");
      return calls;
    });
    await assert.rejects(login(), /no/);
    fail = false;
    assert.equal(await login(), 2);
    assert.equal(await login(), 2);
    login.forget();
    assert.equal(await login(), 3);
  });

  test("a failure that comes in after forget() leaves the newer login be", async () => {
    let rejectFirst: (err: Error) => void = () => {};
    let calls = 0;
    const login = memoizeSuccess(() => {
      calls++;
      return calls === 1
        ? new Promise<number>((_, reject) => (rejectFirst = reject))
        : Promise.resolve(calls);
    });
    const first = login();
    login.forget();
    assert.equal(await login(), 2);
    rejectFirst(new Error("old login failed"));
    await assert.rejects(first, /old login failed/);
    // Still the second login's answer, not a third login.
    assert.equal(await login(), 2);
    assert.equal(calls, 2);
  });
});

describe("createCredentialProviders", () => {
  let dir: string;
  let store: ConfigStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-creds-test-"));
    store = createConfigStore(path.join(dir, "config.yaml"));
    store.update({
      damUsername: "dam-user",
      damPassword: "dam-pw",
      joysoundEmail: "joy@example.com",
      joysoundPassword: "joy-pw",
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("log in with the current login, and again after it changes", async () => {
    const damLogins: string[] = [];
    const joysoundLogins: string[] = [];
    const providers = createCredentialProviders({
      store,
      damLogin: async (user, password) => {
        damLogins.push(`${user}:${password}`);
        return `dam session ${damLogins.length}`;
      },
      joysoundLogin: async (email, password) => {
        joysoundLogins.push(`${email}:${password}`);
        return `joysound session ${joysoundLogins.length}`;
      },
    });

    assert.equal(await providers.dam(), "dam session 1");
    assert.equal(await providers.dam(), "dam session 1");
    assert.equal(await providers.joysound(), "joysound session 1");

    // Another setting: both sessions stay.
    store.update({ supervisedMode: true });
    assert.equal(await providers.dam(), "dam session 1");

    // A new DAM password: DAM signs in again, Joysound doesn't.
    store.update({ damPassword: "new-pw" });
    assert.equal(await providers.dam(), "dam session 2");
    assert.equal(await providers.joysound(), "joysound session 1");
    assert.deepEqual(damLogins, ["dam-user:dam-pw", "dam-user:new-pw"]);

    store.update({ joysoundEmail: "other@example.com" });
    assert.equal(await providers.joysound(), "joysound session 2");
    assert.deepEqual(joysoundLogins, [
      "joy@example.com:joy-pw",
      "other@example.com:joy-pw",
    ]);
  });
});
