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

import { adminPasswordConfig, displayCall, expect, test } from "./fixtures";

const MASK = "••••••";

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
      // No Joysound password, so nothing to mask.
      joysoundPassword: "",
      adminPasswordSet: false,
    });
    expect(settings).not.toHaveProperty("adminPasswordHash");
    expect(settings).not.toHaveProperty("proxyPass");
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
    everyoneIsAdmin: false,
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
    everyoneIsAdmin: false,
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
    everyoneIsAdmin: false,
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
  // A fresh config.yaml has no logins: both fields are empty.
  const dam = settings.getByRole("region", { name: "DAM login" });
  await expect(dam.getByLabel("Username")).toHaveValue("");
  await expect(dam.getByLabel("Password")).toHaveValue("");

  const queue = settings.getByRole("region", { name: "Queue" });
  await queue.getByLabel("Supervised mode", { exact: false }).check();
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  expect((await output(display, "getSettings")).settings.supervisedMode).toBe(
    true,
  );
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: true,
    everyoneIsAdmin: false,
  });
  await queue.getByLabel("Everyone is an admin", { exact: false }).check();
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  expect((await output(display, "getSettings")).settings.everyoneIsAdmin).toBe(
    true,
  );
  expect((await phoneLiveState(karafriends.remoconUrl)).config).toEqual({
    supervisedMode: true,
    everyoneIsAdmin: true,
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
  const network = settings.getByRole("region", { name: "Remote port" });
  await expect(network.getByLabel(/proxy/i)).toHaveCount(0);
  await expect(network.getByRole("button", { name: "Restart" })).toHaveCount(0);
  // Not listened on until a restart, so any free-looking port will do.
  await network.getByLabel("Port for phones").fill("18765");
  await network.getByLabel("Port for phones").press("Enter");
  await expect(network.getByRole("button", { name: "Restart" })).toBeVisible();

  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
});

test("the display's offset and UI scale save on the display, and the scale sizes its text", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const section = settings.getByRole("region", { name: "Display" });
  const offset = section.getByLabel("Audio/video offset");
  const scale = section.getByLabel("UI scale");
  await expect(offset).toHaveValue("0");
  await expect(scale).toHaveValue("100");
  await expect(section).toContainText(/Measured audio output latency: \d+ ms/);
  const rootFontSize = () =>
    display.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
  const unscaled = await rootFontSize();

  await offset.selectOption("-40");
  await scale.selectOption("150");
  await expect.poll(rootFontSize).toBeCloseTo(unscaled * 1.5, 1);
  expect(
    await display.evaluate(() => [
      localStorage.getItem("avOffsetMs"),
      localStorage.getItem("uiScale"),
    ]),
  ).toEqual(["-40", "150"]);

  // Kept on the display, not in config.yaml: a reload brings them back.
  await display.reload();
  await expect(offset).toHaveValue("-40");
  await expect(scale).toHaveValue("150");
  await expect.poll(rootFontSize).toBeCloseTo(unscaled * 1.5, 1);
});

// The fixture's fake mics and outputs (KARAFRIENDS_FAKE_AUDIO in
// src/preload/index.ts): what the display asked of them so far.
function fakeAudioCalls(display: Page): Promise<unknown[][]> {
  return display.evaluate(() =>
    (
      window as unknown as {
        karafriendsFakeAudio: { calls(): unknown[][] };
      }
    ).karafriendsFakeAudio.calls(),
  );
}

test.describe("the microphones", () => {
  const ADMIN_PASSWORD = "e2e mics";
  test.use({ appConfig: adminPasswordConfig(ADMIN_PASSWORD) });

  // The fake inputs' ids (what is saved, opened and sent) and labels (what
  // shows), as on Windows: an endpoint id, and the device's name.
  const MIC_DEVICE = "{0.0.1.00000000}.{e2e-mic} (USB)";
  const INTERFACE_DEVICE = "{0.0.1.00000000}.{e2e-interface} (USB)";
  const MIC = {
    id: `${MIC_DEVICE}#0`,
    label: "E2E Mic (USB), channel 1",
  };
  const INTERFACE = {
    id: `${INTERFACE_DEVICE}#1`,
    label: "E2E Interface (USB), channel 2",
  };

  // An admin's phone: signs in, then calls setMicLevels with each body.
  async function adminSetsMicLevels(remoconUrl: string, ...bodies: object[]) {
    const login = await fetch(new URL("api/adminLogin", remoconUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const { token } = await login.json();
    return Promise.all(
      bodies.map(async (body) => {
        const res = await fetch(new URL("api/setMicLevels", remoconUrl), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Karafriends-Admin-Token": token,
          },
          body: JSON.stringify(body),
        });
        return res.json();
      }),
    );
  }

  test("the phones see the mics and their levels; one is removed; the output and an admin's levels reach the device", async ({
    karafriends,
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const section = settings.getByRole("region", { name: "Microphones" });
    const phoneMics = async () =>
      (await phoneLiveState(karafriends.remoconUrl)).mics;
    await expect(
      section.getByRole("button", { name: "Clear mics" }),
    ).toHaveCount(0);
    expect(await phoneMics()).toEqual([]);

    // Every channel shows by its device's name, and the ASIO line says
    // what ASIO has.
    const add = section.getByLabel("Add a microphone");
    await expect(add.locator("option")).toHaveText([
      "Select a microphone",
      "E2E Mic (USB), channel 1",
      "E2E Interface (USB), channel 1",
      "E2E Interface (USB), channel 2",
    ]);
    await expect(section.getByText("ASIO: E2E Interface")).toBeVisible();

    // Add the first, and turn it up.
    await add.selectOption(MIC.label);
    const mic = section.getByRole("group", { name: MIC.label });
    await expect(mic.getByLabel("Gain 100%")).toBeVisible();
    await expect(mic.getByLabel("Echo 40%")).toBeVisible();
    await mic.getByLabel("Gain 100%").fill("150");
    await mic.getByLabel("Echo 40%").fill("25");
    await expect(mic.getByLabel("Gain 150%")).toBeVisible();
    await expect.poll(phoneMics).toEqual([{ ...MIC, gain: 150, echo: 25 }]);
    expect(await fakeAudioCalls(display)).toEqual(
      expect.arrayContaining([
        ["inputDevice_new", MIC_DEVICE, 0],
        ["inputDevice_setGain", 0, 1.5],
        ["inputDevice_setEcho", 0, 0.25],
      ]),
    );

    // A second, then the first goes and the second stays.
    await add.selectOption(INTERFACE.label);
    await expect.poll(phoneMics).toEqual([
      { ...MIC, gain: 150, echo: 25 },
      { ...INTERFACE, gain: 100, echo: 40 },
    ]);
    await mic.getByRole("button", { name: "Remove" }).click();
    await expect(mic).toHaveCount(0);
    const second = section.getByRole("group", { name: INTERFACE.label });
    await expect(second).toBeVisible();
    await expect
      .poll(phoneMics)
      .toEqual([{ ...INTERFACE, gain: 100, echo: 40 }]);
    expect(await fakeAudioCalls(display)).toContainEqual([
      "inputDevice_stop",
      0,
    ]);

    // The mic output.
    const output = section.getByLabel("Mic output");
    await expect(output).toHaveValue("");
    await expect(output.locator("option")).toHaveText([
      "System default",
      "E2E Speakers (Windows)",
      "E2E Interface (ASIO)",
    ]);
    await output.selectOption("E2E Interface (ASIO)");
    expect(await fakeAudioCalls(display)).toContainEqual([
      "setOutputDevice",
      "E2E Interface (ASIO)",
      null,
      null,
    ]);
    // The outputs are listed again each time Settings opens.
    const listings = async () =>
      (await fakeAudioCalls(display)).filter(
        ([name]) => name === "outputDevices",
      ).length;
    const listed = await listings();
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await display.keyboard.press("s");
    await expect(settings).toBeVisible();
    expect(await listings()).toBe(listed + 1);

    // An admin's phone changes the mic's levels.
    expect(
      await adminSetsMicLevels(karafriends.remoconUrl, {
        id: INTERFACE.id,
        gain: 50,
        echo: 10,
      }),
    ).toEqual([true]);
    await expect(second.getByLabel("Gain 50%")).toBeVisible();
    await expect(second.getByLabel("Echo 10%")).toBeVisible();
    expect(await fakeAudioCalls(display)).toEqual(
      expect.arrayContaining([
        ["inputDevice_setGain", 1, 0.5],
        ["inputDevice_setEcho", 1, 0.1],
      ]),
    );
    // And it stays so: the display's own list coming back changes nothing.
    await display.waitForTimeout(1_000);
    expect(await phoneMics()).toEqual([{ ...INTERFACE, gain: 50, echo: 10 }]);

    // All of it is kept on the display: a reload opens the mic at its
    // levels, on the output picked.
    expect(
      await display.evaluate(() => [
        JSON.parse(localStorage.getItem("mics")!),
        localStorage.getItem("micOutput"),
      ]),
    ).toEqual([
      [{ name: INTERFACE_DEVICE, channel: 1, gain: 50, echo: 10 }],
      "E2E Interface (ASIO)",
    ]);
    await display.reload();
    await expect(second.getByLabel("Gain 50%")).toBeVisible();
    await expect(output).toHaveValue("E2E Interface (ASIO)");
    const calls = await fakeAudioCalls(display);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["setOutputDevice", "E2E Interface (ASIO)", null, null],
        ["inputDevice_new", INTERFACE_DEVICE, 1],
        ["inputDevice_setGain", 0, 0.5],
      ]),
    );
    // The output before the mic, so the mic opens on it.
    expect(
      calls.findIndex(([name]) => name === "setOutputDevice"),
    ).toBeLessThan(calls.findIndex(([name]) => name === "inputDevice_new"));
  });

  test("an admin's return to an earlier level lands; two mics changed at once both land", async ({
    karafriends,
    display,
  }) => {
    const section = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Microphones" });
    const add = section.getByLabel("Add a microphone");
    await add.selectOption(MIC.label);
    await add.selectOption(INTERFACE.label);
    const mic = section.getByRole("group", { name: MIC.label });
    const second = section.getByRole("group", { name: INTERFACE.label });
    await expect(second).toBeVisible();
    const lastGain = async (deviceId: number) =>
      (await fakeAudioCalls(display))
        .filter(
          ([name, id]) => name === "inputDevice_setGain" && id === deviceId,
        )
        .at(-1)?.[2];

    // 100 → 150 → 100: the display's own list at 100 went out before, and
    // the second change must not be taken for it coming back.
    await adminSetsMicLevels(karafriends.remoconUrl, { id: MIC.id, gain: 150 });
    await expect(mic.getByLabel("Gain 150%")).toBeVisible();
    await adminSetsMicLevels(karafriends.remoconUrl, { id: MIC.id, gain: 100 });
    await expect(mic.getByLabel("Gain 100%")).toBeVisible();
    await expect.poll(() => lastGain(0)).toBe(1);

    // Both mics in one go: both stay, on the devices and in localStorage.
    await adminSetsMicLevels(
      karafriends.remoconUrl,
      { id: MIC.id, gain: 120 },
      { id: INTERFACE.id, gain: 80 },
    );
    await expect(mic.getByLabel("Gain 120%")).toBeVisible();
    await expect(second.getByLabel("Gain 80%")).toBeVisible();
    expect([await lastGain(0), await lastGain(1)]).toEqual([1.2, 0.8]);
    await expect
      .poll(() =>
        display.evaluate(() =>
          JSON.parse(localStorage.getItem("mics")!).map(
            ({ gain }: { gain: number }) => gain,
          ),
        ),
      )
      .toEqual([120, 80]);
  });

  test("a saved mic output that isn't connected says so; System default clears it", async ({
    display,
  }) => {
    await display.evaluate(() =>
      localStorage.setItem("micOutput", "E2E Gone (Windows)"),
    );
    await display.reload();
    const output = display
      .getByRole("region", { name: "Microphones" })
      .getByLabel("Mic output");
    await expect(output).toHaveValue("E2E Gone (Windows)");
    await expect(output.locator("option:checked")).toHaveText(
      "E2E Gone (Windows) (not connected)",
    );
    await output.selectOption("System default");
    await expect(output).toHaveValue("");
    expect(await fakeAudioCalls(display)).toContainEqual([
      "setOutputDevice",
      null,
      null,
      null,
    ]);
    expect(
      await display.evaluate(() => localStorage.getItem("micOutput")),
    ).toBeNull();
  });

  test("an ASIO mic output takes a buffer size and a sample rate, kept on the display; the mics say what they run at", async ({
    display,
  }) => {
    const section = display.getByRole("region", { name: "Microphones" });
    const output = section.getByLabel("Mic output");
    // A Windows output has none: Windows sets them.
    await output.selectOption("E2E Speakers (Windows)");
    await expect(section.getByLabel("Buffer")).toHaveCount(0);
    await expect(section.getByLabel("Sample rate")).toHaveCount(0);

    await output.selectOption("E2E Interface (ASIO)");
    const buffer = section.getByLabel("Buffer");
    const rate = section.getByLabel("Sample rate");
    await expect(buffer).toHaveValue("");
    await expect(buffer.locator("option")).toHaveText([
      "Driver's setting",
      "64 samples",
      "128 samples",
      "256 samples",
      "512 samples",
    ]);
    await expect(rate.locator("option")).toHaveText([
      "Driver's setting",
      "44.1 kHz",
      "48 kHz",
      "96 kHz",
    ]);
    await buffer.selectOption("128 samples");
    await rate.selectOption("96 kHz");
    expect(await fakeAudioCalls(display)).toEqual(
      expect.arrayContaining([
        ["setOutputDevice", "E2E Interface (ASIO)", null, 128],
        ["setOutputDevice", "E2E Interface (ASIO)", 96000, 128],
      ]),
    );

    // What the output and a mic run at.
    await section.getByLabel("Add a microphone").selectOption(MIC.label);
    await expect(
      section.getByText("In use: 48 kHz, 256 samples (5.3 ms)"),
    ).toBeVisible();
    await expect(
      section
        .getByRole("group", { name: MIC.label })
        .getByText("In use: Shared, 48 kHz, 480 samples (10.0 ms)"),
    ).toBeVisible();

    // Kept, and set again at the next launch.
    await display.reload();
    await expect(buffer).toHaveValue("128");
    await expect(rate).toHaveValue("96000");
    expect(await fakeAudioCalls(display)).toContainEqual([
      "setOutputDevice",
      "E2E Interface (ASIO)",
      96000,
      128,
    ]);

    // Another device starts from its driver's settings.
    await output.selectOption("E2E Speakers (Windows)");
    await output.selectOption("E2E Interface (ASIO)");
    await expect(buffer).toHaveValue("");
    await expect(rate).toHaveValue("");
    expect(
      await display.evaluate(() => [
        localStorage.getItem("micOutputRate"),
        localStorage.getItem("micOutputBuffer"),
      ]),
    ).toEqual([null, null]);
  });

  test("the Windows mics go exclusive and back, reopening, kept on the display", async ({
    display,
  }) => {
    const section = display.getByRole("region", { name: "Microphones" });
    await section.getByLabel("Add a microphone").selectOption(MIC.label);
    const mic = section.getByRole("group", { name: MIC.label });
    const mode = section.getByLabel("Windows mics");
    await expect(mode).toHaveValue("shared");
    await expect(section.getByLabel("Mic buffer")).toHaveCount(0);
    await expect(
      mic.getByText("In use: Shared, 48 kHz, 480 samples (10.0 ms)"),
    ).toBeVisible();

    // Exclusive: the mic reopens in it, at its smallest buffer.
    await mode.selectOption("Exclusive");
    await expect(
      mic.getByText("In use: Exclusive, 48 kHz, 144 samples (3.0 ms)"),
    ).toBeVisible();
    const calls = await fakeAudioCalls(display);
    const modeAt = calls.findIndex(
      (call) => JSON.stringify(call) === '["setMicMode",true,null]',
    );
    expect(modeAt).toBeGreaterThan(-1);
    expect(calls.slice(modeAt)).toEqual(
      expect.arrayContaining([
        ["inputDevice_stop", 0],
        ["inputDevice_new", MIC_DEVICE, 0],
      ]),
    );
    const buffer = section.getByLabel("Mic buffer");
    await expect(buffer.locator("option")).toHaveText([
      "Smallest",
      "128 samples",
      "256 samples",
      "512 samples",
    ]);
    await buffer.selectOption("256 samples");
    expect(await fakeAudioCalls(display)).toContainEqual([
      "setMicMode",
      true,
      256,
    ]);

    // Kept: the next launch sets it before the mic opens.
    await display.reload();
    await expect(mode).toHaveValue("exclusive");
    await expect(buffer).toHaveValue("256");
    const relaunched = await fakeAudioCalls(display);
    expect(
      relaunched.findIndex(
        (call) => JSON.stringify(call) === '["setMicMode",true,256]',
      ),
    ).toBeLessThan(
      relaunched.findIndex(([name]) => name === "inputDevice_new"),
    );

    // Shared again forgets the buffer.
    await mode.selectOption("Shared");
    await expect(section.getByLabel("Mic buffer")).toHaveCount(0);
    expect(await fakeAudioCalls(display)).toContainEqual([
      "setMicMode",
      false,
      null,
    ]);
    expect(
      await display.evaluate(() => [
        localStorage.getItem("micMode"),
        localStorage.getItem("micBuffer"),
      ]),
    ).toEqual([null, null]);
  });

  // Saved by the id, as before the labels: it opens and shows its label.
  test("old saved mics get the default levels", async ({ display }) => {
    await display.evaluate(
      (name) =>
        localStorage.setItem("mics", JSON.stringify([{ name, channel: 0 }])),
      MIC_DEVICE,
    );
    await display.reload();
    const mic = display
      .getByRole("region", { name: "Microphones" })
      .getByRole("group", { name: MIC.label });
    await expect(mic.getByLabel("Gain 100%")).toBeVisible();
    await expect(mic.getByLabel("Echo 40%")).toBeVisible();
  });
});

test.describe("the microphones on Linux", () => {
  // The fake as on Linux with PipeWire (src/preload/index.ts).
  test.use({ appEnv: { KARAFRIENDS_FAKE_AUDIO: "linux" } });

  const DEFAULT_MIC = "System default (Linux), channel 1";

  test("the sound system shows instead of ASIO; one buffer for the mics, reopening them, kept on the display; a mic plugged in since shows", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const section = settings.getByRole("region", { name: "Microphones" });
    await expect(
      section.getByText("Sound system: PipeWire 1.6.2"),
    ).toBeVisible();
    await expect(section.getByText("ASIO isn't in this build")).toHaveCount(0);
    await expect(section.getByLabel("Windows mics")).toHaveCount(0);

    // Each channel of each mic, by its name.
    const add = section.getByLabel("Add a microphone");
    await expect(add.locator("option")).toHaveText([
      "Select a microphone",
      DEFAULT_MIC,
      "System default (Linux), channel 2",
    ]);
    await add.selectOption(DEFAULT_MIC);
    const mic = section.getByRole("group", { name: DEFAULT_MIC });
    await expect(
      mic.getByText("In use: PipeWire, 48 kHz, 128 samples"),
    ).toBeVisible();

    // The buffer: the default until one is picked; a new one reopens the
    // mic at it.
    const buffer = section.getByLabel("Mic buffer");
    await expect(buffer).toHaveValue("");
    await expect(buffer.locator("option")).toHaveText([
      "Default (128 samples)",
      "64 samples",
      "128 samples",
      "256 samples",
      "512 samples",
      "1024 samples",
    ]);
    await buffer.selectOption("256 samples");
    await expect(
      mic.getByText("In use: PipeWire, 48 kHz, 256 samples"),
    ).toBeVisible();
    const calls = await fakeAudioCalls(display);
    const modeAt = calls.findIndex(
      (call) => JSON.stringify(call) === '["setMicMode",false,256]',
    );
    expect(modeAt).toBeGreaterThan(-1);
    expect(calls.slice(modeAt)).toEqual(
      expect.arrayContaining([
        ["inputDevice_stop", 0],
        ["inputDevice_new", "pipewire:input_default (Linux)", 0],
      ]),
    );

    // Kept: the next launch sets it before the mic opens.
    await display.reload();
    await expect(buffer).toHaveValue("256");
    const relaunched = await fakeAudioCalls(display);
    expect(
      relaunched.findIndex(
        (call) => JSON.stringify(call) === '["setMicMode",false,256]',
      ),
    ).toBeLessThan(
      relaunched.findIndex(([name]) => name === "inputDevice_new"),
    );

    // Settings lists the mics again as it opens: one plugged in since
    // shows.
    await expect(add.locator("option")).toHaveCount(3);
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await display.keyboard.press("s");
    await expect(settings).toBeVisible();
    await expect(add.locator("option")).toContainText([
      "E2E USB Mic (Linux), channel 1",
    ]);
  });
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
          // No email, so neither tries Joysound either.
          joysoundPassword: "e2e-joysound-pass",
          // Not listened on until a restart.
          remoconPort: 18765,
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
    expect(exportedConfig.joysoundPassword).toBe("e2e-joysound-pass");
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
        "Phones signed in as admins must sign in again.",
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
      joysoundPassword: MASK,
      remoconPort: 18765,
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
      everyoneIsAdmin: false,
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
  });
});

test.describe("the downloads", () => {
  test("Settings shows the downloads and clears them; a phone can do neither", async ({
    karafriends,
    display,
  }) => {
    const folder = path.join(
      await karafriends.app.evaluate(({ app }) => app.getPath("temp")),
      "karafriends_tmp",
    );
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "yt-e2evideo.mp4"), "x".repeat(1.5e6));
    fs.writeFileSync(path.join(folder, "yt-e2evideo.log"), "x".repeat(5e5));

    // Settings opens on first launch; opened again, it counts the files.
    const settings = display.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Close" }).click();
    await display.getByRole("button", { name: "Settings" }).click();
    const section = settings.getByRole("region", { name: "Downloads" });
    await expect(section.getByText("2 files, 2.0 MB")).toBeVisible();

    await section.getByRole("button", { name: "Clear downloads" }).click();
    await expect(section.getByRole("status")).toHaveText("Freed 2.0 MB.");
    await expect(section.getByText("0 files, 0.0 MB")).toBeVisible();
    expect(
      fs.readdirSync(folder).filter((name) => name.startsWith("yt-")),
    ).toEqual([]);

    for (const [method, input] of [
      ["downloadsInfo", {}],
      ["clearDownloads", {}],
      ["clearDownload", { songId: "1234-56", suffix: "0" }],
    ] as const) {
      const res = await fetch(
        new URL(`api/${method}`, karafriends.remoconUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      expect(res.status, method).toBe(403);
    }
  });
});
