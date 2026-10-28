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

// Opens one of Settings' tabs, and waits for it.
async function openTab(display: Page, name: string) {
  const tab = display
    .getByRole("dialog", { name: "Settings" })
    .getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
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
  // On Accounts, with the banner.
  await expect(settings.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    settings.getByText("Add your DAM or Joysound login", { exact: false }),
  ).toBeVisible();
  // A fresh config.yaml has no logins: both fields are empty.
  const dam = settings.getByRole("region", { name: "DAM login" });
  await expect(dam.getByLabel("Username")).toHaveValue("");
  await expect(dam.getByLabel("Password")).toHaveValue("");

  await openTab(display, "Party");
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
  const limit = queue.getByLabel("Songs per phone");
  await limit.fill("1001");
  await limit.press("Enter");
  await expect(queue.getByRole("status")).toHaveText(
    "Songs per phone must be a whole number from 0 to 1000",
  );
  await limit.fill("3");
  await limit.blur();
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  expect(
    (await output(display, "getSettings")).settings.paxSongQueueLimit,
  ).toBe(3);

  // The port takes a restart, which the screen offers.
  const network = settings.getByRole("region", { name: "Phones", exact: true });
  await expect(network.getByLabel(/proxy/i)).toHaveCount(0);
  // The dev server's port shows only under yarn dev.
  await expect(network.getByText(/yarn dev/)).toHaveCount(0);
  await expect(network.getByRole("button", { name: "Restart" })).toHaveCount(0);
  // Not listened on until a restart, so any free-looking port will do.
  await network.getByLabel("Port").fill("18765");
  await network.getByLabel("Port").press("Enter");
  await expect(network.getByRole("button", { name: "Restart" })).toBeVisible();

  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
});

test("the songs' output can be picked; a saved one that isn't connected says so", async ({
  display,
}) => {
  await display.evaluate(() =>
    localStorage.setItem(
      "songOutput",
      JSON.stringify({ id: "e2e-gone", label: "E2E Gone" }),
    ),
  );
  await display.reload();
  await openTab(display, "Sound");
  const output = display
    .getByRole("region", { name: "Sound", exact: true })
    .getByLabel("Song output");
  await expect(output).toHaveValue("e2e-gone");
  await expect(output.locator("option").first()).toHaveText("System default");
  await expect(output.locator("option:checked")).toHaveText(
    "E2E Gone (not connected)",
  );
  await output.selectOption("System default");
  await expect(output).toHaveValue("");
  await expect
    .poll(() => display.evaluate(() => localStorage.getItem("songOutput")))
    .toBeNull();
});

test("the display's offset and UI scale save on the display, and the scale sizes its text", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const sound = settings.getByRole("region", { name: "Sound", exact: true });
  const offset = sound.getByLabel("Audio/video offset");
  const scale = settings
    .getByRole("region", { name: "Display" })
    .getByLabel("UI scale");
  await openTab(display, "Sound");
  await expect(offset).toHaveValue("0");
  await expect(sound).toContainText(/Output latency: \d+ ms/);
  await offset.selectOption("-40");

  await openTab(display, "Display");
  await expect(scale).toHaveValue("100");
  const rootFontSize = () =>
    display.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
  const unscaled = await rootFontSize();
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
  await openTab(display, "Display");
  await expect(scale).toHaveValue("150");
  await expect.poll(rootFontSize).toBeCloseTo(unscaled * 1.5, 1);
  await openTab(display, "Sound");
  await expect(offset).toHaveValue("-40");
});

test("Settings is in tabs: the arrows, Home and End move through them, the panel follows, and the last one opens again", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const tablist = settings.getByRole("tablist", { name: "Sections" });
  const tabs = tablist.getByRole("tab");
  const tab = (name: string) => tablist.getByRole("tab", { name });
  const panel = settings.getByRole("tabpanel");
  await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
  await expect(tabs).toHaveText([
    "Accounts",
    "Party",
    "Sound",
    "Display",
    "Advanced",
  ]);

  // A first launch opens on Accounts, focused, so the keys work at once.
  // Only the open tab is in the Tab order.
  const tabStops = () =>
    tabs.evaluateAll((all) => all.map((t) => t.getAttribute("tabindex")));
  await expect(tab("Accounts")).toBeFocused();
  await expect(tab("Accounts")).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAccessibleName("Accounts");
  await expect(panel.getByRole("region", { name: "DAM login" })).toBeVisible();
  expect(await tabStops()).toEqual(["0", "-1", "-1", "-1", "-1"]);

  // Each key opens the tab it moves to.
  for (const [key, name, region] of [
    ["ArrowDown", "Party", "Queue"],
    ["End", "Advanced", "Tools"],
    ["ArrowDown", "Accounts", "Joysound login"],
    ["ArrowUp", "Advanced", "Config file"],
    ["Home", "Accounts", "DAM login"],
    ["ArrowUp", "Advanced", "Downloads"],
    ["ArrowUp", "Display", "Display"],
  ]) {
    await display.keyboard.press(key);
    await expect(tab(name)).toBeFocused();
    await expect(tab(name)).toHaveAttribute("aria-selected", "true");
    await expect(panel).toHaveAccessibleName(name);
    await expect(panel.getByRole("region", { name: region })).toBeVisible();
  }
  expect(await tabStops()).toEqual(["-1", "-1", "-1", "0", "-1"]);
  await expect(settings.getByRole("region", { name: "DAM login" })).toHaveCount(
    0,
  );
  // Tab goes on into the panel.
  await display.keyboard.press("Tab");
  await expect(panel.getByLabel("UI scale")).toBeFocused();

  // Closed, Settings opens again on the same tab, and keeps it on the
  // display.
  await display.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await display.keyboard.press("s");
  await expect(tab("Display")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Display")).toBeFocused();
  expect(
    await display.evaluate(() => localStorage.getItem("settingsTab")),
  ).toBe("display");
  await settings.getByRole("button", { name: "Close" }).click();
  await display.getByRole("button", { name: "Settings" }).click();
  await expect(tab("Display")).toHaveAttribute("aria-selected", "true");

  // But a launch with no login opens on Accounts.
  await display.reload();
  await expect(tab("Accounts")).toHaveAttribute("aria-selected", "true");
  await expect(
    settings.getByText("Add your DAM or Joysound login", { exact: false }),
  ).toBeVisible();
});

test.describe("on a profile with a login", () => {
  // Never tried unless asked, so Settings doesn't open by itself.
  test.use({
    appConfig: { damUsername: "e2e-dam-user", damPassword: "e2e-password" },
  });

  test("Settings opens on the tab it was last on, after a reload too", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    await expect(display.getByText("Scan to join")).toBeVisible();
    await expect(settings).toHaveCount(0);
    await display.keyboard.press("s");
    await openTab(display, "Sound");
    await display.reload();
    await expect(display.getByText("Scan to join")).toBeVisible();
    await display.keyboard.press("s");
    await expect(settings.getByRole("tab", { name: "Sound" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      settings.getByRole("region", { name: "Microphones" }),
    ).toBeVisible();
  });
});

test("a tab with something to look at gets a dot, until it's put right", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const party = settings.getByRole("tab", { name: "Party" });
  const queue = settings.getByRole("region", { name: "Queue" });
  await openTab(display, "Party");
  await expect(party).not.toHaveAccessibleDescription("Needs a look");

  // A refused value, saved as the host leaves for another tab.
  await queue.getByLabel("Songs per phone").fill("1001");
  await openTab(display, "Sound");
  await expect(party).toHaveAccessibleDescription("Needs a look");
  await expect(party.locator(".settingsTabDot")).toBeVisible();
  // The open tab has none, and the message waits under its field.
  await openTab(display, "Party");
  await expect(party).not.toHaveAccessibleDescription("Needs a look");
  await expect(party.locator(".settingsTabDot")).toHaveCount(0);
  await expect(queue.getByRole("status")).toHaveText(
    "Songs per phone must be a whole number from 0 to 1000",
  );
  await queue.getByLabel("Songs per phone").fill("2");
  await queue.getByLabel("Songs per phone").press("Enter");
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  await openTab(display, "Sound");
  await expect(party).not.toHaveAccessibleDescription("Needs a look");

  // A new port waits for a restart.
  await openTab(display, "Party");
  const port = settings
    .getByRole("region", { name: "Phones", exact: true })
    .getByLabel("Port");
  await port.fill("18766");
  await port.press("Enter");
  await expect(settings.getByRole("button", { name: "Restart" })).toBeVisible();
  await openTab(display, "Advanced");
  await expect(party).toHaveAccessibleDescription("Needs a look");
  for (const name of ["Accounts", "Sound", "Display", "Advanced"]) {
    await expect(
      settings.getByRole("tab", { name }),
    ).not.toHaveAccessibleDescription("Needs a look");
  }
});

test.describe("the pitch bars", () => {
  test("a DAM song shows them; the switch in Display takes them off and back at once, kept on the display", async ({
    karafriends,
    display,
  }) => {
    // The song "downloaded" as a minute of black video, as long as the song,
    // so it plays. Queued from a phone; without a DAM login, popSong brings
    // no scoring data, and the roll is empty but there.
    const folder = path.join(
      await karafriends.app.evaluate(({ app }) => app.getPath("temp")),
      "karafriends_tmp",
    );
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, "..", "fixtures", "black.mp4"),
      path.join(folder, "2345-67-0.mp4"),
    );
    const res = await fetch(new URL("api/queueSong", karafriends.remoconUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Karafriends-Device-Id": "e2e-pitch-bars",
        "X-Karafriends-Nickname": "e2e",
      },
      body: JSON.stringify({
        kind: "dam",
        songId: "2345-67",
        name: "E2E DAM song",
        artistName: "E2E artist",
        playtime: 60,
        streamingUrlIdx: 0,
      }),
    });
    expect(await res.json()).toMatchObject({ ok: true });

    const roll = display.locator("canvas.pianoRollRoll");
    await expect(roll).toHaveCount(1, { timeout: 20_000 });
    await expect
      .poll(() =>
        display
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime > 0),
      )
      .toBe(true);

    // Settings opened on the first launch, over the song.
    await openTab(display, "Display");
    const pitchBars = display
      .getByRole("region", { name: "Display" })
      .getByLabel("Pitch bars", { exact: true });
    await expect(pitchBars).toBeChecked();
    await expect(pitchBars).toHaveAccessibleDescription(
      "On DAM and Joysound songs: the melody as bars along the top, with the mics' pitch over them.",
    );
    await pitchBars.uncheck();
    await expect(roll).toHaveCount(0);
    expect(
      await display.evaluate(() => localStorage.getItem("pitchBars")),
    ).toBe("off");
    await pitchBars.check();
    await expect(roll).toHaveCount(1);
    expect(
      await display.evaluate(() => localStorage.getItem("pitchBars")),
    ).toBeNull();

    // Off, it stays off after a reload.
    await pitchBars.uncheck();
    await display.reload();
    await openTab(display, "Display");
    await expect(pitchBars).not.toBeChecked();
    await expect(roll).toHaveCount(0);
  });

  // A Joysound song that looks downloaded before: its video, from
  // tests/fixtures, and lyrics without lines that the display reads without
  // an error (empty names, a palette, no timing events).
  function fakeJoysoundDownload(
    folder: string,
    songId: string,
    video: string,
    seconds: number,
  ) {
    const telop = Buffer.alloc(68);
    telop.writeUInt32LE(18, 6); // where the names start
    telop.writeUInt32LE(38, 10); // the lyrics: 15 colours, no lines
    telop.writeUInt32LE(68, 14); // the timing: no events
    for (let i = 1; i <= 7; i++) telop.writeUInt16LE(20, 18 + i * 2);
    telop.writeUInt16LE(seconds, 18 + 18); // the playtime
    fs.writeFileSync(path.join(folder, `joysound-${songId}.joy_02`), telop);
    fs.copyFileSync(
      path.resolve(__dirname, "..", "fixtures", video),
      path.join(folder, `joysound-${songId}-default.mp4`),
    );
  }

  // A call from a phone (one song in the queue each, by default).
  async function phoneCall(
    remoconUrl: string,
    deviceId: string,
    method: string,
    input: object,
  ) {
    const res = await fetch(new URL(`api/${method}`, remoconUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Karafriends-Device-Id": deviceId,
        "X-Karafriends-Nickname": "e2e",
      },
      body: JSON.stringify(input),
    });
    return res.json();
  }

  test("a Joysound song shows them from its guide melody, and one without a guide shows none", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    const folder = path.join(
      await karafriends.app.evaluate(({ app }) => app.getPath("temp")),
      "karafriends_tmp",
    );
    fs.mkdirSync(folder, { recursive: true });
    // A minute of black video without sound: no guide channel.
    fakeJoysoundDownload(folder, "e2e-no-guide", "black.mp4", 60);
    // 12 s of black video whose sound is 3-channel Vorbis, as Joysound's
    // ogg: silent left and right, so the bars can only come from the third
    // channel, and nine sine notes there (C5 E5 G5 E5, D5 F5 A5 F5, C5, 0.9
    // s each, from 0.5 s). Made with the app's ffmpeg:
    //   ffmpeg -f lavfi -i "aevalsrc=exprs=0|0|0.3*sin(2*PI*t*(<each note's between(t,start,end)*Hz, summed>))*(<the same betweens, summed>):s=44100:c=3.0:d=12" -c:a libvorbis -q:a 0 guide.ogg
    //   ffmpeg -f lavfi -i color=black:s=320x180:r=10:d=12 -i guide.ogg -c:v libx264 -pix_fmt yuv420p -c:a copy -shortest -movflags faststart joysound-guide.mp4
    fakeJoysoundDownload(folder, "e2e-guide", "joysound-guide.mp4", 12);
    for (const songId of ["e2e-no-guide", "e2e-guide"]) {
      expect(
        await phoneCall(remoconUrl, `e2e-phone-${songId}`, "queueSong", {
          kind: "joysound",
          songId,
          name: `E2E ${songId}`,
          artistName: "E2E artist",
          lyricsMode: "kana",
          youtubeVideoId: null,
        }),
      ).toMatchObject({ ok: true });
    }

    const video = display.locator("video");
    // The song's file, and whether it has played for a while.
    const playing = () =>
      video.evaluate((v: HTMLVideoElement) => ({
        file: v.currentSrc.split("/").at(-1),
        started: v.currentTime > 2,
      }));
    const roll = display.locator("canvas.pianoRollRoll");

    // No guide channel: no bars, and no error.
    await expect
      .poll(playing, { timeout: 20_000 })
      .toEqual({ file: "joysound-e2e-no-guide-default.mp4", started: true });
    await expect(roll).toHaveCount(0);

    // The guide melody's: the bars come once it's read, and stay while the
    // song is paused.
    expect(
      await phoneCall(remoconUrl, "e2e-phone", "setPlaybackState", {
        playbackState: "SKIPPING",
      }),
    ).toBe(true);
    await expect(roll).toHaveCount(1, { timeout: 20_000 });
    expect((await playing()).file).toBe("joysound-e2e-guide-default.mp4");
    expect(
      await phoneCall(remoconUrl, "e2e-phone", "setPlaybackState", {
        playbackState: "PAUSED",
      }),
    ).toBe(true);
    await expect(video).toHaveJSProperty("paused", true);

    // The switch takes them off and back, at once: the melody is kept.
    await openTab(display, "Display");
    const pitchBars = display
      .getByRole("region", { name: "Display" })
      .getByLabel("Pitch bars", { exact: true });
    await pitchBars.uncheck();
    await expect(roll).toHaveCount(0);
    await pitchBars.check();
    await expect(roll).toHaveCount(1);

    expect(karafriends.displayErrors).toEqual([]);
  });
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

  // Settings opens on Accounts on a launch with no login; the mics are on
  // Sound.
  test.beforeEach(async ({ display }) => {
    await openTab(display, "Sound");
  });

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

    // Every channel shows by its device's name. The ASIO line shows only a
    // driver that won't load.
    const add = section.getByLabel("Add a microphone");
    await expect(add.locator("option")).toHaveText([
      "Select a microphone",
      "E2E Mic (USB), channel 1",
      "E2E Interface (USB), channel 1",
      "E2E Interface (USB), channel 2",
    ]);
    await expect(section.getByText("ASIO: E2E Interface")).toHaveCount(0);

    // Add the first, and turn it up. Its meter shows its level (the fake's
    // 0.25 is -12 dB: 0.8 of the meter's 60 dB).
    await add.selectOption(MIC.label);
    const mic = section.getByRole("group", { name: MIC.label });
    await expect(mic.getByRole("meter", { name: "Level" })).toHaveAttribute(
      "aria-valuenow",
      "0.80",
    );
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
    // On Sound still.
    await expect(section).toBeVisible();

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
    await openTab(display, "Sound");
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
    await openTab(display, "Sound");
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
      "Default",
      "64 samples",
      "128 samples",
      "256 samples",
      "512 samples",
    ]);
    await expect(rate.locator("option")).toHaveText([
      "Default",
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
    await openTab(display, "Sound");
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
    const mode = section.getByLabel("Mic mode");
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
    await openTab(display, "Sound");
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
    await openTab(display, "Sound");
    const mic = display
      .getByRole("region", { name: "Microphones" })
      .getByRole("group", { name: MIC.label });
    await expect(mic.getByLabel("Gain 100%")).toBeVisible();
    await expect(mic.getByLabel("Echo 40%")).toBeVisible();
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
    await openTab(display, "Advanced");
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
