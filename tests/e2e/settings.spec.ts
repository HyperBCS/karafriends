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

import {
  adminPasswordConfig,
  currentSongKey,
  displayCall,
  downloadsFolder,
  expect,
  sliderFill,
  test,
} from "./fixtures";

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

test("on first launch, the save that completes a login leaves the banner up, so Test login stays where it was", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const banner = settings.getByText("Add your DAM or Joysound login", {
    exact: false,
  });
  const dam = settings.getByRole("region", { name: "DAM login" });
  const testLogin = dam.getByRole("button", { name: "Test login" });
  await expect(banner).toBeVisible();
  const before = await testLogin.boundingBox();

  await dam.getByLabel("Username").fill("e2e-first-user");
  await dam.getByLabel("Username").press("Enter");
  await expect(dam.getByRole("status")).toHaveText("Saved.");
  await dam.getByLabel("Password").fill("e2e-first-password");
  await dam.getByLabel("Password").press("Enter");
  // Saved, and loaded again: the password shows masked.
  await expect
    .poll(async () => (await output(display, "getSettings")).isFirstRun)
    .toBe(false);
  await openTab(display, "Party");
  await openTab(display, "Accounts");
  await expect(dam.getByLabel("Password")).toHaveValue(MASK);
  await expect(banner).toBeVisible();
  expect(await testLogin.boundingBox()).toEqual(before);

  // Gone the next time Settings opens.
  await display.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await display.keyboard.press("s");
  await expect(dam.getByLabel("Username")).toHaveValue("e2e-first-user");
  await expect(banner).toHaveCount(0);
});

test("leaving Settings saves the field being edited: Escape keeps it, and Close stays open to say why one was refused", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const close = settings.getByRole("button", { name: "Close" });
  const joysound = settings.getByRole("region", { name: "Joysound login" });
  await joysound.getByLabel("Email").fill("e2e-escape@example.com");
  await display.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect
    .poll(
      async () => (await output(display, "getSettings")).settings.joysoundEmail,
    )
    .toBe("e2e-escape@example.com");
  await display.keyboard.press("s");
  await expect(joysound.getByLabel("Email")).toHaveValue(
    "e2e-escape@example.com",
  );

  // A refused port, left with Close: it stays open, saying why.
  await openTab(display, "Party");
  const network = settings.getByRole("region", { name: "Phones", exact: true });
  await network.getByLabel("Port").fill("80800");
  await close.click();
  await expect(network.getByRole("status")).toHaveText(
    "Port must be a whole number from 1 to 65535",
  );
  await expect(settings).toBeVisible();
  // Seen: Close closes.
  await close.click();
  await expect(settings).toHaveCount(0);

  // The same from Escape.
  await display.keyboard.press("s");
  await network.getByLabel("Port").fill("80801");
  await display.keyboard.press("Escape");
  await expect(network.getByRole("status")).toHaveText(
    "Port must be a whole number from 1 to 65535",
  );
  await display.keyboard.press("Escape");
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
  // Kept, to be used once it's listed, and said where the songs play
  // meanwhile.
  const sound = display.getByRole("region", { name: "Sound", exact: true });
  await expect(
    sound.getByText(
      "The songs play on System default until E2E Gone is connected.",
    ),
  ).toBeVisible();
  await output.selectOption("System default");
  await expect(output).toHaveValue("");
  await expect(sound.getByText(/until E2E Gone/)).toHaveCount(0);
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

test("the Address pick is kept on the display; one this computer no longer has goes back to karafriends.local", async ({
  display,
}) => {
  const address = display
    .getByRole("dialog", { name: "Settings" })
    .getByRole("region", { name: "Phones", exact: true })
    .getByLabel("Address");
  const port = await display.evaluate(() =>
    (
      window as unknown as { karafriends: { remoconPort(): number } }
    ).karafriends.remoconPort(),
  );
  await openTab(display, "Party");
  await expect(address).toHaveValue(`karafriends.local:${port}`);

  // This computer's LAN addresses, if it has one here.
  const names = await address.locator("option").allTextContents();
  if (names.length > 1) {
    await address.selectOption(names[1]);
    await display.reload();
    await openTab(display, "Party");
    await expect(address).toHaveValue(`${names[1]}:${port}`);
    await address.selectOption("karafriends.local");
    expect(
      await display.evaluate(() => localStorage.getItem("hostname")),
    ).toBeNull();
  }

  // An address from another network.
  await display.evaluate(() => localStorage.setItem("hostname", "203.0.113.9"));
  await display.reload();
  await openTab(display, "Party");
  await expect(address).toHaveValue(`karafriends.local:${port}`);
  await expect(address.locator("option")).toHaveText(names);
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
  // Put back to the saved value: that clears it too.
  const saved = String(
    (await output(display, "getSettings")).settings.paxSongQueueLimit,
  );
  await queue.getByLabel("Songs per phone").fill(saved);
  await queue.getByLabel("Songs per phone").press("Enter");
  await expect(queue.getByRole("status")).toHaveText("Saved.");
  await openTab(display, "Sound");
  await expect(party).not.toHaveAccessibleDescription("Needs a look");

  // And a refused value put right with another.
  await openTab(display, "Party");
  await queue.getByLabel("Songs per phone").fill("1001");
  await queue.getByLabel("Songs per phone").press("Enter");
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
  test("a DAM song without scoring data shows none, and no error", async ({
    karafriends,
    display,
  }) => {
    // The song "downloaded" as a minute of black video, as long as the song,
    // so it plays. Queued from a phone; without a DAM login, popSong brings
    // no scoring data: no notes, so no bars (not an empty band).
    const folder = await downloadsFolder(karafriends.app);
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

    await expect
      .poll(
        () =>
          display
            .locator("video")
            .evaluate(
              (video: HTMLVideoElement) =>
                video.currentSrc.endsWith("2345-67-0.mp4") &&
                video.currentTime > 1,
            ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(display.locator("canvas.pianoRollRoll")).toHaveCount(0);
    // The switch is on all the same.
    await openTab(display, "Display");
    await expect(
      display
        .getByRole("region", { name: "Display" })
        .getByLabel("Pitch bars", { exact: true }),
    ).toBeChecked();
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
    const folder = await downloadsFolder(karafriends.app);
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
        song: await currentSongKey(remoconUrl),
      }),
    ).toBe(true);
    await expect(roll).toHaveCount(1, { timeout: 20_000 });
    expect((await playing()).file).toBe("joysound-e2e-guide-default.mp4");
    expect(
      await phoneCall(remoconUrl, "e2e-phone", "setPlaybackState", {
        playbackState: "PAUSED",
        song: await currentSongKey(remoconUrl),
      }),
    ).toBe(true);
    await expect(video).toHaveJSProperty("paused", true);

    // The switch takes them off and back, at once: the melody is kept.
    // Kept on the display.
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
    expect(karafriends.displayErrors).toEqual([]);

    // Off, it stays off after a reload.
    await pitchBars.uncheck();
    await display.reload();
    await openTab(display, "Display");
    await expect(pitchBars).not.toBeChecked();
    await expect(roll).toHaveCount(0);
  });

  // Queues the guide melody's song and waits for it to start.
  async function playGuideSong(
    karafriends: { app: ElectronApplication; remoconUrl: string },
    display: Page,
  ) {
    const folder = await downloadsFolder(karafriends.app);
    fs.mkdirSync(folder, { recursive: true });
    fakeJoysoundDownload(folder, "e2e-guide", "joysound-guide.mp4", 12);
    expect(
      await phoneCall(karafriends.remoconUrl, "e2e-phone", "queueSong", {
        kind: "joysound",
        songId: "e2e-guide",
        name: "E2E guide",
        artistName: "E2E artist",
        lyricsMode: "kana",
        youtubeVideoId: null,
      }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(
        () =>
          display
            .locator("video")
            .evaluate((v: HTMLVideoElement) =>
              v.currentSrc.endsWith("joysound-e2e-guide-default.mp4"),
            ),
        { timeout: 20_000 },
      )
      .toBe(true);
  }

  // Whether the roll drew anything: read in the next frame, just after the
  // roll's own draw (its drawing buffer is cleared once shown).
  function rollDrew(display: Page) {
    return display.evaluate(
      () =>
        new Promise<boolean>((resolve) =>
          requestAnimationFrame(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
              "canvas.pianoRollRoll",
            );
            const gl = canvas?.getContext("webgl2");
            if (!canvas || !gl || gl.isContextLost()) return resolve(false);
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(
              0,
              0,
              canvas.width,
              canvas.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            resolve(pixels.some((value) => value !== 0));
          }),
        ),
    );
  }

  const crashed = (display: Page) =>
    display.getByRole("heading", { name: "Something went wrong" });

  test("a lost WebGL context leaves the song playing, and the bars come back when it's restored", async ({
    karafriends,
    display,
  }) => {
    await playGuideSong(karafriends, display);
    const roll = display.locator("canvas.pianoRollRoll");
    await expect(roll).toHaveCount(1, { timeout: 20_000 });
    expect(
      await phoneCall(karafriends.remoconUrl, "e2e-phone", "setPlaybackState", {
        playbackState: "PAUSED",
        song: await currentSongKey(karafriends.remoconUrl),
      }),
    ).toBe(true);
    await expect.poll(() => rollDrew(display)).toBe(true);

    // As when the GPU process goes: the context is lost. A key change after
    // it (which used to rebuild the roll's GL) leaves the display up.
    await display.evaluate(() => {
      const gl = document
        .querySelector<HTMLCanvasElement>("canvas.pianoRollRoll")!
        .getContext("webgl2")!;
      const lose = gl.getExtension("WEBGL_lose_context")!;
      (window as unknown as { e2eLose: WEBGL_lose_context }).e2eLose = lose;
      lose.loseContext();
    });
    await expect(roll).toBeHidden();
    expect(
      await phoneCall(
        karafriends.remoconUrl,
        "e2e-phone",
        "setPitchShiftSemis",
        { semis: 2, song: await currentSongKey(karafriends.remoconUrl) },
      ),
    ).toBe(true);
    // The live state reaches the display.
    await display.waitForTimeout(1_000);
    await expect(display.locator("video")).toHaveCount(1);
    await expect(crashed(display)).toHaveCount(0);
    await expect(roll).toHaveCount(1);

    // Restored: drawn again, on the same canvas.
    await display.evaluate(() =>
      (
        window as unknown as { e2eLose: WEBGL_lose_context }
      ).e2eLose.restoreContext(),
    );
    await expect(roll).toBeVisible();
    await expect.poll(() => rollDrew(display)).toBe(true);
    await expect(crashed(display)).toHaveCount(0);
    expect(karafriends.displayErrors).toEqual([]);
  });

  test("without WebGL2 the bars don't show, and the song plays on", async ({
    karafriends,
    display,
  }) => {
    // As on a machine whose GPU Chromium blocklists: the roll's canvas gets
    // no context. Counted, so the test knows the roll tried.
    await display.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      const counter = window as unknown as { e2eRollContexts: number };
      counter.e2eRollContexts = 0;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: Parameters<HTMLCanvasElement["getContext"]>
      ) {
        if (this.classList.contains("pianoRollRoll") && args[0] === "webgl2") {
          counter.e2eRollContexts++;
          return null;
        }
        return getContext.apply(this, args);
      } as HTMLCanvasElement["getContext"];
    });
    await playGuideSong(karafriends, display);
    await expect
      .poll(
        () =>
          display.evaluate(
            () =>
              (window as unknown as { e2eRollContexts: number })
                .e2eRollContexts,
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect(crashed(display)).toHaveCount(0);
    expect(karafriends.displayErrors).toEqual([]);
    await expect(display.locator("canvas.pianoRollRoll")).toHaveCount(0);
    await expect
      .poll(() =>
        display
          .locator("video")
          .evaluate((v: HTMLVideoElement) => v.currentTime > 2),
      )
      .toBe(true);
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

// The fake inputs and outputs that won't open from now on, by id; kept
// through a reload.
function failOpen(display: Page, names: string[]) {
  return display.evaluate(
    (names) =>
      (
        window as unknown as {
          karafriendsFakeAudio: { failOpen(names: string[]): void };
        }
      ).karafriendsFakeAudio.failOpen(names),
    names,
  );
}

// The open fake mics of these inputs stop, as a stream that stops calling
// back does; they open again as usual.
function stopMics(display: Page, names: string[]) {
  return display.evaluate(
    (names) =>
      (
        window as unknown as {
          karafriendsFakeAudio: { stopMics(names: string[]): void };
        }
      ).karafriendsFakeAudio.stopMics(names),
    names,
  );
}

// From now on, and through a reload, listing the fake inputs and outputs
// throws (on) or works again (off).
function failListing(display: Page, on: boolean) {
  return display.evaluate(
    (on) =>
      (
        window as unknown as {
          karafriendsFakeAudio: { failListing(on: boolean): void };
        }
      ).karafriendsFakeAudio.failListing(on),
    on,
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
    // Each slider's track is filled to its value: gain out of 200 %, echo
    // out of 100 %.
    expect(await sliderFill(mic.getByLabel("Gain 100%"))).toBe(50);
    expect(await sliderFill(mic.getByLabel("Echo 40%"))).toBe(40);
    await mic.getByLabel("Gain 100%").fill("150");
    await mic.getByLabel("Echo 40%").fill("25");
    await expect(mic.getByLabel("Gain 150%")).toBeVisible();
    expect(await sliderFill(mic.getByLabel("Gain 150%"))).toBe(75);
    expect(await sliderFill(mic.getByLabel("Echo 25%"))).toBe(25);
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
    // The outputs are listed again each time the Sound tab opens.
    const listings = async () =>
      (await fakeAudioCalls(display)).filter(
        ([name]) => name === "outputDevices",
      ).length;
    const listed = await listings();
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await display.keyboard.press("s");
    // On Sound still.
    await expect(section).toBeVisible();
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

  test("a saved mic that won't open at launch starts down and opens by itself; it and one not plugged in stay saved", async ({
    display,
  }) => {
    const GONE = { name: "{0.0.1.00000000}.{e2e-gone} (USB)", channel: 0 };
    await failOpen(display, [MIC_DEVICE]);
    await display.evaluate(
      (mics) => localStorage.setItem("mics", JSON.stringify(mics)),
      [
        { name: MIC_DEVICE, channel: 0, gain: 150, echo: 40 },
        { ...GONE, gain: 70, echo: 10 },
      ],
    );
    await display.reload();
    await openTab(display, "Sound");
    const mic = display
      .getByRole("region", { name: "Microphones" })
      .getByRole("group", { name: MIC.label });
    await expect(
      mic.getByText("Error: The device is busy (fake)"),
    ).toBeVisible();

    // A level change saves every mic, the one down and the one not
    // plugged in too.
    await mic.getByLabel("Gain 150%").fill("120");
    await expect
      .poll(() =>
        display.evaluate(() => JSON.parse(localStorage.getItem("mics")!)),
      )
      .toEqual([
        { name: MIC_DEVICE, channel: 0, gain: 120, echo: 40 },
        { ...GONE, gain: 70, echo: 10 },
      ]);

    // The watchdog opens it once it can, at its levels.
    await failOpen(display, []);
    await expect(
      mic.getByText("Reopened after: Error: The device is busy (fake)"),
    ).toBeVisible();
    await expect(mic.getByText(/device is busy/)).toHaveCount(1);
    expect(
      (await fakeAudioCalls(display)).filter(
        ([call]) => call === "inputDevice_setGain",
      ),
    ).toContainEqual(["inputDevice_setGain", expect.any(Number), 1.2]);
  });

  test("a mic that stops reopens by itself; one unplugged is down until it is back", async ({
    display,
  }) => {
    const section = display.getByRole("region", { name: "Microphones" });
    await section.getByLabel("Add a microphone").selectOption(MIC.label);
    const mic = section.getByRole("group", { name: MIC.label });
    await expect(mic.getByText(/^In use:/)).toBeVisible();

    await stopMics(display, [MIC_DEVICE]);
    await expect(
      mic.getByText("Reopened after: The mic stopped sending sound (fake)"),
    ).toBeVisible();

    await failOpen(display, [MIC_DEVICE]);
    await expect(
      mic.getByText("Error: The device is busy (fake)"),
    ).toBeVisible();
    await expect(mic.getByText(/^In use:/)).toHaveCount(0);

    await failOpen(display, []);
    await expect(
      mic.getByText("Reopened after: Error: The device is busy (fake)"),
    ).toBeVisible();
    await expect(mic.getByText(/^In use:/)).toBeVisible();
  });
});

test.describe("devices that won't open", () => {
  const MIC_DEVICE = "{0.0.1.00000000}.{e2e-mic} (USB)";
  const INTERFACE_DEVICE = "{0.0.1.00000000}.{e2e-interface} (USB)";

  test.beforeEach(async ({ display }) => {
    await openTab(display, "Sound");
  });

  test("Settings says why a mic or the mic output didn't open; a new mic that won't is added down, a row keeps its mic", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const section = settings.getByRole("region", { name: "Microphones" });
    const problem = section.locator(".settingsMessage.problem").last();
    await failOpen(display, [INTERFACE_DEVICE, "E2E Speakers (Windows)"]);

    // The mic output: the choice isn't kept.
    const output = section.getByLabel("Mic output");
    await output.selectOption("E2E Speakers (Windows)");
    await expect(
      section.getByText(
        "Couldn't switch the mic output to E2E Speakers (Windows): E2E Speakers (Windows) won't open (fake)",
      ),
    ).toBeVisible();
    await expect(output).toHaveValue("");
    expect(
      await display.evaluate(() => localStorage.getItem("micOutput")),
    ).toBeNull();
    // Seen from another tab, Sound has something to look at.
    await openTab(display, "Display");
    await expect(
      settings.getByRole("tab", { name: "Sound" }).locator(".settingsTabDot"),
    ).toHaveCount(1);
    await openTab(display, "Sound");

    // A new mic that won't open: its row says why.
    const add = section.getByLabel("Add a microphone");
    await add.selectOption("E2E Interface (USB), channel 2");
    const down = section.getByRole("group", {
      name: "E2E Interface (USB), channel 2",
    });
    await expect(
      down.getByText("Error: The device is busy (fake)"),
    ).toBeVisible();
    await down.getByRole("button", { name: "Remove" }).click();
    await expect(down).toHaveCount(0);

    // A row keeps its mic rather than change to one that won't open.
    await add.selectOption("E2E Mic (USB), channel 1");
    const mic = section.getByRole("group", {
      name: "E2E Mic (USB), channel 1",
    });
    await mic
      .getByLabel("Microphone")
      .selectOption("E2E Interface (USB), channel 1");
    await expect(problem).toHaveText(
      "Couldn't open E2E Interface (USB), channel 1: Error: The device is busy (fake)",
    );
    await expect(mic).toBeVisible();
    await expect(mic.getByLabel("Microphone")).toHaveValue(`${MIC_DEVICE}_0`);
    expect(
      await display.evaluate(() => JSON.parse(localStorage.getItem("mics")!)),
    ).toEqual([{ name: MIC_DEVICE, channel: 0, gain: 100, echo: 40 }]);

    // One that opens clears the message.
    await failOpen(display, []);
    await output.selectOption("E2E Speakers (Windows)");
    await expect(output).toHaveValue("E2E Speakers (Windows)");
    await expect(section.locator(".settingsMessage.problem")).toHaveCount(0);
  });

  test("the mic output's note follows the output going away and coming back while Settings is open", async ({
    display,
  }) => {
    const section = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Microphones" });
    await section
      .getByLabel("Add a microphone")
      .selectOption("E2E Mic (USB), channel 1");
    await section
      .getByLabel("Mic output")
      .selectOption("E2E Speakers (Windows)");
    const note = section.getByText(
      "E2E Speakers (Windows) isn't connected; the mics play through the default output",
    );
    await expect(section.getByText("In use:").first()).toBeVisible();
    await expect(note).toHaveCount(0);
    // Nothing else changes on the screen: the tick finds it.
    await failOpen(display, ["E2E Speakers (Windows)"]);
    await expect(note).toBeVisible();
    await failOpen(display, []);
    await expect(note).toHaveCount(0);
  });

  test("a device list that won't read leaves the display up: Settings says why, a mic keeps its row, and a launch opens with the saved mics kept", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const section = settings.getByRole("region", { name: "Microphones" });
    const crashed = display.getByRole("heading", {
      name: "Something went wrong",
    });
    const MIC = "E2E Mic (USB), channel 1";
    await section.getByLabel("Add a microphone").selectOption(MIC);
    const mic = section.getByRole("group", { name: MIC });
    await expect(mic).toBeVisible();

    // Settings lists the devices again as it opens.
    await failListing(display, true);
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await display.keyboard.press("s");
    await expect(
      section.getByText(
        "Couldn't list the sound devices: A device won't give its name (fake)",
      ),
    ).toBeVisible();
    await expect(crashed).toHaveCount(0);
    // The mic's own device still shows in its row.
    await expect(mic.getByLabel("Microphone")).toHaveValue(`${MIC_DEVICE}_0`);
    await expect(section.getByLabel("Mic output")).toHaveValue("");

    // A launch while the list won't read opens no mic, and keeps it saved.
    await display.reload();
    await expect(settings).toBeVisible();
    await expect(crashed).toHaveCount(0);
    expect(
      await display.evaluate(() => JSON.parse(localStorage.getItem("mics")!)),
    ).toEqual([{ name: MIC_DEVICE, channel: 0, gain: 100, echo: 40 }]);

    // Once it reads again, the next launch opens it.
    await failListing(display, false);
    await display.reload();
    await openTab(display, "Sound");
    await expect(mic).toBeVisible();
    await expect(
      section.getByText("Couldn't list the sound devices", { exact: false }),
    ).toHaveCount(0);
  });
});

test.describe("the microphones on Linux", () => {
  // The fake as on Linux with PipeWire (src/preload/index.ts).
  test.use({ appEnv: { KARAFRIENDS_FAKE_AUDIO: "linux" } });

  const DEFAULT_MIC = "System default (Linux), channel 1";

  test.beforeEach(async ({ display }) => {
    await openTab(display, "Sound");
  });

  test("the sound system shows instead of ASIO; one buffer for the mics, reopening them, kept on the display; a mic plugged in since shows", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const section = settings.getByRole("region", { name: "Microphones" });
    await expect(
      section.getByText("Sound system: PipeWire 1.6.2"),
    ).toBeVisible();
    await expect(section.getByText("ASIO isn't in this build")).toHaveCount(0);
    await expect(section.getByLabel("Mic mode")).toHaveCount(0);

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
    await openTab(display, "Sound");
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
    await openTab(display, "Sound");
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
    const folder = await downloadsFolder(karafriends.app);
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

test.describe("a queue an older version saved in the temp folder", () => {
  // Niconico songs, whose videos (a minute of black) are next to it.
  const song = (n: number) => ({
    kind: "nico",
    songId: `sm7100${n}`,
    name: `E2E old song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-someone", nickname: "someone" },
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [song(1), song(2)],
      songHistory: [],
      playbackState: "WAITING",
    },
    seedQueueInTempFolder: true,
  });

  test("comes over to the user data folder with its songs' videos", async ({
    karafriends,
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Close" }).click();
    // Song 1 plays from its moved video, with song 2 up next.
    await expect(
      display.getByRole("region", { name: "Up next" }).getByRole("listitem"),
    ).toHaveText([/E2E old song 2/]);

    const [userData, temp] = await karafriends.app.evaluate(({ app }) => [
      app.getPath("userData"),
      app.getPath("temp"),
    ]);
    const downloads = await downloadsFolder(karafriends.app);
    expect(fs.readdirSync(downloads).sort()).toEqual([
      "nico-sm71001.mp4",
      "nico-sm71002.mp4",
    ]);
    expect(fs.existsSync(path.join(userData, "queue.json"))).toBe(true);
    expect(fs.readdirSync(path.join(temp, "karafriends_tmp"))).toEqual([]);
  });
});
