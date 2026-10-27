// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parse, stringify } from "yaml";

import {
  configFromFile,
  configProblems,
  DEFAULT_CONFIG,
  hasLogin,
} from "./configSchema";

describe("configFromFile", () => {
  test("fills in the defaults", () => {
    assert.deepEqual(configFromFile(null), {
      config: DEFAULT_CONFIG,
      problems: [],
    });
    const { config, problems } = configFromFile({
      supervisedMode: true,
      adminPasswordSalt: "abc",
      adminPasswordHash: "def",
    });
    assert.deepEqual(problems, []);
    assert.equal(config.supervisedMode, true);
    assert.equal(config.adminPasswordSalt, "abc");
    assert.equal(config.adminPasswordHash, "def");
    assert.equal(config.remoconPort, 8080);
    // No admin password by default.
    assert.equal(DEFAULT_CONFIG.adminPasswordHash, "");
  });

  test("ignores the old admin lists, says so once, and drops them", () => {
    const { config, problems } = configFromFile(
      parse(
        "damUsername: me\nadminDeviceIds:\n  - 4f1c\nadminNicks:\n  - host\n",
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Ignoring adminDeviceIds and adminNicks/);
    assert.equal(config.damUsername, "me");
    assert.equal("adminDeviceIds" in config, false);
    assert.equal("adminNicks" in config, false);
    // So the write-back leaves them out.
    assert.doesNotMatch(stringify(config), /adminDeviceIds|adminNicks/);

    assert.match(
      configFromFile({ adminNicks: [] }).problems[0],
      /Ignoring adminNicks/,
    );
  });

  test("keeps other keys it doesn't know", () => {
    const { config } = configFromFile({ futureSetting: 1 });
    assert.equal(
      (config as unknown as Record<string, unknown>).futureSetting,
      1,
    );
  });

  test("clears an admin password YAML didn't read as text", () => {
    // An all-digit salt, unquoted, is a number to YAML.
    const { config, problems } = configFromFile(
      parse("adminPasswordSalt: 12345678\nadminPasswordHash: abcdef\n"),
    );
    assert.equal(config.adminPasswordHash, "");
    assert.equal(config.adminPasswordSalt, "");
    assert.match(problems[0], /adminPasswordSalt .* must be text in quotes/);
  });

  test("uses the defaults for a file that isn't a mapping", () => {
    for (const parsed of [["a"], "text", 5]) {
      const { config, problems } = configFromFile(parsed);
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(problems.length, 1);
    }
  });
});

describe("configProblems", () => {
  test("accepts good values", () => {
    assert.deepEqual(
      configProblems({
        remoconPort: 1,
        proxyPort: 65535,
        paxSongQueueLimit: 0,
        supervisedMode: true,
        damUsername: "me",
        adminPasswordHash: "",
        adminPasswordSalt: "00ff",
      }),
      [],
    );
  });

  test("names each bad value", () => {
    assert.deepEqual(
      configProblems({
        remoconPort: 0,
        proxyPort: 65536,
        paxSongQueueLimit: 1.5,
        supervisedMode: "yes",
        damUsername: 42,
        futureSetting: 1,
      }),
      [
        "remoconPort must be a whole number from 1 to 65535",
        "proxyPort must be a whole number from 1 to 65535",
        "paxSongQueueLimit must be a whole number from 0 to 1000",
        "supervisedMode must be true or false",
        "damUsername must be text of at most 1000 characters",
        "futureSetting is not a setting",
      ],
    );
  });
});

describe("hasLogin", () => {
  test("needs both fields, neither the placeholder", () => {
    const dam = (damUsername: string, damPassword: string) =>
      hasLogin({ ...DEFAULT_CONFIG, damUsername, damPassword }, "dam");
    assert.equal(hasLogin(DEFAULT_CONFIG, "dam"), false);
    assert.equal(dam("me", DEFAULT_CONFIG.damPassword), false);
    assert.equal(dam("me", ""), false);
    assert.equal(dam("me", "pw"), true);
    assert.equal(
      hasLogin(
        { ...DEFAULT_CONFIG, joysoundEmail: "a@b", joysoundPassword: "pw" },
        "joysound",
      ),
      true,
    );
  });
});
