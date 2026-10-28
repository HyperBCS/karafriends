// Runs on Node's test runner through tsx (yarn test:unit). The config store
// is real, in a temp folder; DAM and Joysound are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { parse } from "yaml";

import { MASKED_PASSWORD, type LoginService } from "../common/api";
import { DEFAULT_CONFIG } from "../common/configSchema";
import { createConfigStore } from "../common/configStore";
import { ApiError, type Caller } from "./api";
import { HttpStatusError } from "./http";
import { createSettingsHandlers, loginFailureReason } from "./settings";
import { validators } from "./validate";

const display: Caller = {
  deviceId: null,
  nickname: null,
  adminToken: null,
  isDisplay: true,
};
const phone: Caller = { ...display, deviceId: "p", isDisplay: false };

const LOGINS = {
  damUsername: "dam-user",
  damPassword: "dam-pw",
  joysoundEmail: "joy@example.com",
  joysoundPassword: "joy-pw",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-settings-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const TOOLS_STATUS = {
  ffmpeg: { version: "7.1", updatedAt: 1, overridden: false },
  ytdlp: { version: null, updatedAt: null, overridden: true },
  lastCheck: 2,
  problem: null,
  problemSince: null,
};

type LoginFake = (username: string, password: string) => Promise<unknown>;

function setup(
  options: {
    logins?: Partial<Record<LoginService, LoginFake>>;
    name?: string;
    updateTools?: () => Promise<void>;
  } = {},
) {
  const filePath = path.join(dir, options.name ?? "config.yaml");
  const store = createConfigStore(filePath);
  const tried: string[] = [];
  const restarts: number[] = [];
  const recording =
    (service: LoginService): LoginFake =>
    async (username, password) => {
      tried.push(`${service} ${username}:${password}`);
      return options.logins?.[service]?.(username, password);
    };
  const api = createSettingsHandlers({
    store,
    setAdminPassword: (password) =>
      store.update({
        adminPasswordSalt: "00ff",
        adminPasswordHash: password ? `hash of ${password}` : "",
      }),
    logins: { dam: recording("dam"), joysound: recording("joysound") },
    restart: () => restarts.push(Date.now()),
    tools: {
      status: () => TOOLS_STATUS,
      update: options.updateTools ?? (async () => {}),
    },
  });
  const onDisk = () => parse(fs.readFileSync(filePath, "utf8"));
  return { api, store, onDisk, tried, restarts };
}

const rejectsWith = (promise: Promise<unknown>, status: number) =>
  assert.rejects(
    promise,
    (err: unknown) => err instanceof ApiError && err.status === status,
  );

describe("getSettings", () => {
  test("masks the passwords that are set and hides the admin hash", async () => {
    const { api, store } = setup();
    store.update({
      ...LOGINS,
      proxyPass: "",
      adminPasswordSalt: "00ff",
      adminPasswordHash: "abcd",
    });
    const { settings } = await api.getSettings({}, display);
    assert.equal(settings.damUsername, "dam-user");
    assert.equal(settings.damPassword, MASKED_PASSWORD);
    assert.equal(settings.joysoundEmail, "joy@example.com");
    assert.equal(settings.joysoundPassword, MASKED_PASSWORD);
    // Empty stays empty.
    assert.equal(settings.proxyPass, "");
    assert.equal(settings.adminPasswordSet, true);
    assert.equal("adminPasswordHash" in settings, false);
    assert.equal("adminPasswordSalt" in settings, false);
    assert.doesNotMatch(JSON.stringify(settings), /dam-pw|joy-pw|abcd|00ff/);
  });

  test("isFirstRun until one login is filled in", async () => {
    const { api, store } = setup();
    const first = await api.getSettings({}, display);
    assert.equal(first.isFirstRun, true);
    assert.equal(first.needsRestart, false);
    assert.equal(first.settings.adminPasswordSet, false);
    store.update({ damUsername: "dam-user" });
    assert.equal((await api.getSettings({}, display)).isFirstRun, true);
    store.update({ joysoundEmail: "a@b", joysoundPassword: "pw" });
    assert.equal((await api.getSettings({}, display)).isFirstRun, false);
  });

  test("needsRestart once the port or a proxy setting changed", async () => {
    const { api } = setup();
    assert.deepEqual(
      await api.setSettings({ settings: { supervisedMode: true } }, display),
      { ok: true, needsRestart: false },
    );
    assert.deepEqual(
      await api.setSettings(
        { settings: { proxyHost: "proxy.example.jp" } },
        display,
      ),
      { ok: true, needsRestart: true },
    );
    assert.equal((await api.getSettings({}, display)).needsRestart, true);
  });

  test("every settings method is for the display only", async () => {
    const { api } = setup();
    await rejectsWith(api.getSettings({}, phone), 403);
    await rejectsWith(api.setSettings({ settings: {} }, phone), 403);
    await rejectsWith(api.setAdminPassword({ password: "x" }, phone), 403);
    await rejectsWith(api.testLogin({ service: "dam" }, phone), 403);
    await rejectsWith(api.exportConfig({}, phone), 403);
    await rejectsWith(api.importConfig({ yaml: "" }, phone), 403);
    await rejectsWith(api.restartApp({}, phone), 403);
    await rejectsWith(api.getToolsStatus({}, phone), 403);
    await rejectsWith(api.updateTools({}, phone), 403);
  });
});

describe("setSettings", () => {
  test("changes what it's given and saves it", async () => {
    const { api, store, onDisk } = setup();
    assert.deepEqual(
      await api.setSettings(
        { settings: { supervisedMode: true, paxSongQueueLimit: 0, ...LOGINS } },
        display,
      ),
      { ok: true, needsRestart: false },
    );
    assert.equal(store.get().supervisedMode, true);
    assert.equal(onDisk().paxSongQueueLimit, 0);
    assert.equal(onDisk().damPassword, "dam-pw");
  });

  test("a masked password means unchanged", async () => {
    const { api, store } = setup();
    store.update(LOGINS);
    const { settings } = await api.getSettings({}, display);
    const { adminPasswordSet: _, ...changes } = settings;
    assert.deepEqual(
      await api.setSettings(
        { settings: { ...changes, damUsername: "new-user" } },
        display,
      ),
      { ok: true, needsRestart: false },
    );
    assert.equal(store.get().damUsername, "new-user");
    assert.equal(store.get().damPassword, "dam-pw");
    assert.equal(store.get().joysoundPassword, "joy-pw");
    assert.equal(store.get().proxyPass, DEFAULT_CONFIG.proxyPass);
  });

  test("refuses bad values, all or none", async () => {
    const { api, store } = setup();
    assert.deepEqual(
      await api.setSettings(
        {
          settings: {
            supervisedMode: true,
            remoconPort: 0,
            proxyPort: 65536,
            paxSongQueueLimit: -1,
            useLowBitrateUrl: "yes" as never,
          },
        },
        display,
      ),
      {
        ok: false,
        problems: [
          "remoconPort must be a whole number from 1 to 65535",
          "proxyPort must be a whole number from 1 to 65535",
          "paxSongQueueLimit must be a whole number from 0 to 1000",
          "useLowBitrateUrl must be true or false",
        ],
      },
    );
    assert.equal(store.get().supervisedMode, false);
  });

  test("its validator refuses unknown settings and the admin hash", () => {
    const invalid = (settings: unknown) =>
      assert.throws(
        () => validators.setSettings({ settings }),
        (err: unknown) => err instanceof ApiError && err.status === 400,
      );
    invalid({ adminPasswordHash: "" });
    invalid({ adminPasswordSet: true });
    invalid({ futureSetting: 1 });
    invalid([]);
    invalid(undefined);
    assert.deepEqual(validators.setSettings({ settings: { proxyPort: 1 } }), {
      settings: { proxyPort: 1 },
    });
  });
});

describe("setAdminPassword", () => {
  test("calls services' setAdminPassword", async () => {
    const { api } = setup();
    assert.deepEqual(
      await api.setAdminPassword({ password: "pw" }, display),
      {},
    );
    const isSet = async () =>
      (await api.getSettings({}, display)).settings.adminPasswordSet;
    assert.equal(await isSet(), true);
    await api.setAdminPassword({ password: "" }, display);
    assert.equal(await isSet(), false);
  });
});

describe("testLogin", () => {
  test("uses the saved login, or the given one", async () => {
    const { api, store, tried } = setup();
    store.update(LOGINS);
    assert.deepEqual(await api.testLogin({ service: "dam" }, display), {
      ok: true,
    });
    await api.testLogin(
      {
        service: "joysound",
        credentials: { username: "new@example.com", password: "new-pw" },
      },
      display,
    );
    assert.deepEqual(tried, [
      "dam dam-user:dam-pw",
      "joysound new@example.com:new-pw",
    ]);
    // A test doesn't change the saved login.
    assert.equal(store.get().joysoundEmail, "joy@example.com");
  });

  test("says when no login is set, without asking", async () => {
    const { api, tried } = setup();
    assert.deepEqual(await api.testLogin({ service: "joysound" }, display), {
      ok: false,
      reason: "No Joysound login is set: enter the email and password first.",
    });
    assert.deepEqual(tried, []);
  });

  test("explains a 403, and passes on anything else", async () => {
    const { api, store } = setup({
      logins: {
        joysound: async () => {
          throw new HttpStatusError(403, "https://www.sound-cafe.jp/login");
        },
        dam: async () => {
          throw new Error("1001: wrong password");
        },
      },
    });
    store.update(LOGINS);
    assert.deepEqual(await api.testLogin({ service: "joysound" }, display), {
      ok: false,
      reason:
        "Joysound answered 403: this usually means no Japanese IP address. " +
        "Connect through a VPN or proxy in Japan.",
    });
    assert.deepEqual(await api.testLogin({ service: "dam" }, display), {
      ok: false,
      reason: "Couldn't sign in to DAM: 1001: wrong password",
    });
    assert.equal(
      loginFailureReason("dam", new HttpStatusError(500, "u")),
      "Couldn't sign in to DAM: 500 from u",
    );
  });
});

describe("exportConfig and importConfig", () => {
  test("export is config.yaml with the version line first, logins included", async () => {
    const { api, store } = setup();
    store.update({
      ...LOGINS,
      adminPasswordSalt: "00ff",
      adminPasswordHash: "abcd",
    });
    const { yaml } = await api.exportConfig({}, display);
    assert.match(yaml, /^karafriendsConfigVersion: 1\n/);
    const { karafriendsConfigVersion, ...exported } = parse(yaml);
    assert.equal(karafriendsConfigVersion, 1);
    assert.deepEqual(exported, store.saved());
    assert.equal(exported.damPassword, "dam-pw");
  });

  test("an export imports on another profile as it was", async () => {
    const first = setup();
    first.store.update({
      ...LOGINS,
      supervisedMode: true,
      paxSongQueueLimit: 4,
      remoconPort: 9090,
      adminPasswordSalt: "00ff",
      adminPasswordHash: "abcd",
    });
    const { yaml } = await first.api.exportConfig({}, display);

    const second = setup({ name: "second.yaml" });
    assert.deepEqual(await second.api.importConfig({ yaml }, display), {
      ok: true,
      problems: ["DAM login works.", "Joysound login works."],
    });
    assert.deepEqual(second.store.saved(), first.store.saved());
    assert.deepEqual(second.onDisk(), first.onDisk());
    // It tested the imported logins.
    assert.deepEqual(second.tried.sort(), [
      "dam dam-user:dam-pw",
      "joysound joy@example.com:joy-pw",
    ]);
    assert.equal(
      (await second.api.getSettings({}, display)).needsRestart,
      true,
    );
  });

  test("an old config.yaml: no version line, admin lists dropped and listed", async () => {
    const { api, store } = setup();
    const result = await api.importConfig(
      {
        yaml:
          "damUsername: dam-user\ndamPassword: dam-pw\nsupervisedMode: true\n" +
          "adminDeviceIds:\n  - 4f1c\nadminNicks:\n  - host\n",
      },
      display,
    );
    assert.deepEqual(result, {
      ok: true,
      problems: [
        "Dropped adminDeviceIds: it no longer does anything. Phones become admins with the admin password.",
        "Dropped adminNicks: it no longer does anything. Phones become admins with the admin password.",
        "DAM login works.",
        "No Joysound login is set: enter the email and password first.",
      ],
    });
    assert.equal(store.get().damUsername, "dam-user");
    assert.equal(store.get().supervisedMode, true);
    // What the file leaves out stays as it was.
    assert.equal(store.get().remoconPort, DEFAULT_CONFIG.remoconPort);
  });

  test("a 0.1.0 config.yaml's placeholders are imported as empty", async () => {
    const { api, store } = setup();
    const result = await api.importConfig(
      {
        yaml:
          "damUsername: YOUR_USERNAME_HERE\ndamPassword: YOUR_PASSWORD_HERE\n" +
          "joysoundEmail: YOUR_EMAIL_HERE\njoysoundPassword: YOUR_PASSWORD_HERE\n" +
          "proxyHost: PROXY_HOST_HERE\nproxyUser: PROXY_USER_HERE\n" +
          "proxyPass: PROXY_PASS_HERE\nsupervisedMode: true\n",
      },
      display,
    );
    assert.deepEqual(result, {
      ok: true,
      problems: [
        "No DAM login is set: enter the username and password first.",
        "No Joysound login is set: enter the email and password first.",
      ],
    });
    const saved = store.saved();
    for (const key of [
      "damUsername",
      "damPassword",
      "joysoundEmail",
      "joysoundPassword",
      "proxyHost",
      "proxyUser",
      "proxyPass",
    ] as const) {
      assert.equal(saved[key], "", key);
    }
    assert.equal(saved.supervisedMode, true);
    const { settings, isFirstRun } = await api.getSettings({}, display);
    assert.equal(settings.damPassword, "");
    assert.equal(isFirstRun, true);
  });

  test("unknown keys are dropped and listed", async () => {
    const { api, onDisk } = setup();
    const result = await api.importConfig(
      { yaml: "futureSetting: 1\nuseLowBitrateUrl: true\n" },
      display,
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.problems[0],
      "Dropped futureSetting: karafriends has no such setting.",
    );
    assert.equal(onDisk().useLowBitrateUrl, true);
    assert.equal("futureSetting" in onDisk(), false);
  });

  test("a failed login test doesn't undo the import", async () => {
    const { api, store } = setup({
      logins: {
        dam: async () => {
          throw new HttpStatusError(403, "u");
        },
      },
    });
    const result = await api.importConfig(
      { yaml: "damUsername: dam-user\ndamPassword: dam-pw\n" },
      display,
    );
    assert.equal(result.ok, true);
    assert.match(result.problems[0], /^DAM answered 403/);
    assert.equal(store.get().damUsername, "dam-user");
  });

  test("refuses a bad file and changes nothing", async () => {
    const { api, store, onDisk } = setup();
    const before = onDisk();
    for (const [yaml, problem] of [
      ["damUsername: [unclosed\n", /^The file isn't valid YAML \(line \d+\)/],
      ["- a list\n", /^The file has no settings in it/],
      ["", /^The file has no settings in it/],
      [
        "supervisedMode: true\nremoconPort: 99999\n",
        /^remoconPort must be a whole number from 1 to 65535$/,
      ],
    ] as const) {
      const result = await api.importConfig({ yaml }, display);
      assert.equal(result.ok, false, yaml);
      assert.match(result.problems[0], problem);
    }
    assert.deepEqual(onDisk(), before);
    assert.equal(store.get().supervisedMode, false);
  });

  test("a YAML error doesn't quote the file", async () => {
    const { api } = setup();
    const result = await api.importConfig(
      { yaml: "damPassword: secret-pw\n  bad: [\n" },
      display,
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.problems.join(" "), /secret-pw/);
  });

  test("a YAML warning isn't printed: it would quote the line", async (t) => {
    const warned = t.mock.method(process, "emitWarning", () => {});
    const { api } = setup();
    await api.importConfig({ yaml: "damPassword: !foo secret-pw\n" }, display);
    assert.equal(warned.mock.callCount(), 0);
  });
});

describe("getToolsStatus and updateTools", () => {
  test("getToolsStatus answers with the tools' status", async () => {
    const { api } = setup();
    assert.deepEqual(await api.getToolsStatus({}, display), TOOLS_STATUS);
  });

  test("updateTools answers ok, or why not, instead of throwing", async () => {
    assert.deepEqual(await setup().api.updateTools({}, display), { ok: true });
    const { api } = setup({
      updateTools: async () => {
        throw new Error("503");
      },
    });
    assert.deepEqual(await api.updateTools({}, display), {
      ok: false,
      reason: "Couldn't update the tools: 503",
    });
  });
});

describe("restartApp", () => {
  test("restarts after answering", async () => {
    const { api, restarts } = setup();
    assert.deepEqual(await api.restartApp({}, display), {});
    assert.equal(restarts.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(restarts.length, 1);
  });
});
