// The settings methods, over the display's IPC: what getSettings shows,
// setSettings reaching the live state, and a config exported from one launch
// imported into another. Phones get 403 for all of them. No network: the
// logins are left unset (or are fakes the app never tries), so no login
// test reaches DAM or Joysound; the @jp test at the end does, with the
// installed app's logins.
import fs from "fs";
import path from "path";

import type { ElectronApplication, Page } from "@playwright/test";
import { parse } from "yaml";

import { expect, test } from "./fixtures";

const MASK = "••••••";

type Answer = { ok: boolean; output?: any; status?: number; error?: string };

// A call from the display, over IPC through its preload.
async function displayCall(
  display: Page,
  method: string,
  input: object,
): Promise<Answer> {
  return display.evaluate(
    ([method, input]) =>
      (
        window as unknown as {
          karafriends: {
            api: { call(method: string, input: object): Promise<Answer> };
          };
        }
      ).karafriends.api.call(method, input),
    [method, input] as const,
  );
}

async function output(display: Page, method: string, input: object = {}) {
  const answer = await displayCall(display, method, input);
  expect(answer, `${method} over IPC`).toMatchObject({ ok: true });
  return answer.output;
}

// The first event of a fresh /api/events stream: the live state, as a
// phone sees it.
async function phoneLiveState(remoconUrl: string) {
  const controller = new AbortController();
  const res = await fetch(new URL("api/events", remoconUrl), {
    signal: controller.signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The stream ended early: ${text}`);
      text += value;
      const data = text.match(/^data: (.*)$/m);
      if (data) return JSON.parse(data[1]).state;
    }
  } finally {
    controller.abort();
  }
}

async function configOnDisk(app: ElectronApplication) {
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  return parse(fs.readFileSync(path.join(userData, "config.yaml"), "utf8"));
}

test.describe("on a profile with logins", () => {
  test.use({
    appConfig: {
      damUsername: "e2e-dam-user",
      damPassword: "e2e-dam-password",
      joysoundEmail: "e2e@example.com",
      joysoundPassword: "",
    },
  });

  test("getSettings masks the passwords", async ({ display }) => {
    const { settings, isFirstRun, needsRestart } = await output(
      display,
      "getSettings",
    );
    expect(settings).toMatchObject({
      damUsername: "e2e-dam-user",
      damPassword: MASK,
      joysoundEmail: "e2e@example.com",
      joysoundPassword: "",
      // config.yaml's placeholder: not empty, so masked too.
      proxyPass: MASK,
      adminPasswordSet: false,
    });
    expect(settings).not.toHaveProperty("adminPasswordHash");
    expect(JSON.stringify(settings)).not.toContain("e2e-dam-password");
    expect(isFirstRun).toBe(false);
    expect(needsRestart).toBe(false);
  });
});

test("setSettings changes supervisedMode, and the live state follows", async ({
  karafriends,
  display,
}) => {
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: false,
  });
  expect(await output(display, "getSettings")).toMatchObject({
    isFirstRun: true,
  });

  expect(
    await output(display, "setSettings", {
      settings: { supervisedMode: true },
    }),
  ).toEqual({ ok: true, needsRestart: false });

  // A phone's new stream, and the display's own live state.
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: true,
  });
  await expect
    .poll(() =>
      display.evaluate(
        () =>
          new Promise((resolve) => {
            const k = (
              window as unknown as {
                karafriends: {
                  api: {
                    onLive(
                      listener: (event: {
                        type: string;
                        state?: { config: { supervisedMode: boolean } };
                      }) => void,
                    ): () => void;
                  };
                };
              }
            ).karafriends;
            const stop = k.api.onLive((event) => {
              if (event.type === "state") {
                resolve(event.state!.config.supervisedMode);
                setTimeout(() => stop());
              }
            });
          }),
      ),
    )
    .toBe(true);
  expect((await configOnDisk(karafriends.app)).supervisedMode).toBe(true);

  // Refused values change nothing.
  expect(
    await output(display, "setSettings", {
      settings: { supervisedMode: false, remoconPort: 0 },
    }),
  ).toEqual({
    ok: false,
    problems: ["remoconPort must be a whole number from 1 to 65535"],
  });
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: true,
  });
});

test("the settings screen opens on first launch, and saves as the host goes", async ({
  karafriends,
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByText("Add your DAM or Joysound login", { exact: false }),
  ).toBeVisible();
  // A fresh config.yaml's placeholder username shows as an empty field;
  // its placeholder password comes masked, like a real one.
  const dam = settings.getByRole("region", { name: "DAM login" });
  await expect(dam.getByLabel("Username")).toHaveValue("");
  await expect(dam.getByLabel("Password")).toHaveValue(MASK);

  const queue = settings.getByRole("region", { name: "Queue" });
  await queue.getByLabel("Supervised mode", { exact: false }).check();
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  expect((await output(display, "getSettings")).settings.supervisedMode).toBe(
    true,
  );
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: true,
  });

  // A field saves when the host leaves it; a refused value says why.
  const limit = queue.getByLabel("Songs each phone", { exact: false });
  await limit.fill("1001");
  await limit.press("Enter");
  await expect(queue.getByRole("status")).toHaveText(
    "paxSongQueueLimit must be a whole number from 0 to 1000",
  );
  await limit.fill("3");
  await limit.blur();
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  expect(
    (await output(display, "getSettings")).settings.paxSongQueueLimit,
  ).toBe(3);

  // The port takes a restart, which the screen offers.
  const network = settings.getByRole("region", {
    name: "Remote port and proxy",
  });
  await expect(network.getByRole("button", { name: "Restart" })).toHaveCount(0);
  await network.getByLabel("Proxy host").fill("proxy.e2e.example");
  await network.getByLabel("Proxy host").press("Enter");
  await expect(network.getByRole("button", { name: "Restart" })).toBeVisible();

  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
});

test("a phone gets 403 for getSettings, even signed in as nobody special", async ({
  karafriends,
}) => {
  for (const method of ["getSettings", "exportConfig", "setSettings"]) {
    const res = await fetch(new URL(`api/${method}`, karafriends.remoconUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status, method).toBe(403);
  }
});

// The first test exports from one launch; the second imports it into a
// fresh one.
test.describe("export, then import on a second launch", () => {
  test.describe.configure({ mode: "serial" });
  let exported = "";

  test("exportConfig gives the whole config.yaml", async ({
    karafriends,
    display,
  }) => {
    expect(
      await output(display, "setSettings", {
        settings: {
          supervisedMode: true,
          paxSongQueueLimit: 3,
          useLowBitrateUrl: true,
          // No password, so neither launch tries to sign in to DAM.
          damUsername: "e2e-exported-user",
          proxyHost: "proxy.e2e.example",
          proxyPass: "e2e-proxy-pass",
        },
      }),
    ).toEqual({ ok: true, needsRestart: true });
    expect(
      await output(display, "setAdminPassword", { password: "e2e" }),
    ).toEqual({});

    const { yaml } = await output(display, "exportConfig");
    expect(yaml).toMatch(/^karafriendsConfigVersion: 1\n/);
    const { karafriendsConfigVersion, ...exportedConfig } = parse(yaml);
    expect(karafriendsConfigVersion).toBe(1);
    expect(exportedConfig).toEqual(await configOnDisk(karafriends.app));
    // Passwords travel as they are.
    expect(exportedConfig.proxyPass).toBe("e2e-proxy-pass");
    expect(exportedConfig.adminPasswordHash).toMatch(/^[0-9a-f]{128}$/);
    exported = yaml;
  });

  test("importConfig restores it", async ({ karafriends, display }) => {
    expect(exported).not.toBe("");
    const before = await output(display, "getSettings");
    expect(before.settings).toMatchObject({
      supervisedMode: false,
      adminPasswordSet: false,
    });

    const result = await output(display, "importConfig", { yaml: exported });
    expect(result).toEqual({
      ok: true,
      problems: [
        "No DAM login is set: enter the username and password first.",
        "No Joysound login is set: enter the email and password first.",
      ],
    });

    const after = await output(display, "getSettings");
    expect(after.settings).toMatchObject({
      supervisedMode: true,
      paxSongQueueLimit: 3,
      useLowBitrateUrl: true,
      damUsername: "e2e-exported-user",
      proxyHost: "proxy.e2e.example",
      proxyPass: MASK,
      adminPasswordSet: true,
    });
    expect(after.needsRestart).toBe(true);
    const { karafriendsConfigVersion: _, ...exportedConfig } = parse(exported);
    const onDisk = await configOnDisk(karafriends.app);
    // Everything but the port, which each test launch picks for itself.
    expect({ ...onDisk, remoconPort: 0 }).toEqual({
      ...exportedConfig,
      remoconPort: 0,
    });
    expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
      supervisedMode: true,
    });

    // The imported admin password works on a phone.
    const login = await fetch(
      new URL("api/adminLogin", karafriends.remoconUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "e2e" }),
      },
    );
    expect(login.status).toBe(200);
  });
});

test.describe("@jp with the installed app's logins", () => {
  test.use({ realCredentials: true });

  test("testLogin signs in to DAM and Joysound @jp", async ({ display }) => {
    expect(await output(display, "testLogin", { service: "dam" })).toEqual({
      ok: true,
    });
    expect(await output(display, "testLogin", { service: "joysound" })).toEqual(
      { ok: true },
    );
    // A wrong password is a plain no.
    const wrong = await output(display, "testLogin", {
      service: "joysound",
      credentials: { username: "nobody@example.com", password: "wrong" },
    });
    expect(wrong.ok).toBe(false);
  });
});
