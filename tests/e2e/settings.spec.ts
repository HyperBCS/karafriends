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
  anyOf,
  apiCall,
  currentSongKey,
  defaultAddress,
  displayCall,
  displayLiveState,
  downloadsFolder,
  expect,
  fakeJoysoundDownload,
  liveState as phoneLiveState,
  NICKNAME,
  sliderFill,
  test,
} from "./fixtures";

const MASK = "••••••";

async function output(display: Page, method: string, input: object = {}) {
  const answer = await displayCall(display, method, input);
  expect(answer, `${method} over IPC`).toMatchObject({ ok: true });
  return answer.output;
}

async function configOnDisk(app: ElectronApplication) {
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  return parse(fs.readFileSync(path.join(userData, "config.yaml"), "utf8"));
}

// Opens one of Settings' tabs, and waits for it.
// Opens Settings (S) unless it's open. Again until it is: a display that
// is still loading doesn't hear the key yet.
async function openSettings(display: Page) {
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(async () => {
    if ((await settings.count()) === 0) await display.keyboard.press("s");
    await expect(settings).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function openTab(display: Page, name: string) {
  await openSettings(display);
  const tab = display
    .getByRole("dialog", { name: "Settings" })
    .getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

test("Party lists Phones first and the admin password last", async ({
  display,
}) => {
  await openTab(display, "Party");
  await expect(
    display
      .getByRole("dialog", { name: "Settings" })
      .locator("section.settingsSection > h2"),
  ).toHaveText(["Phones", "Queue", "Admin password"]);
});

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
    const { settings, setup, needsRestart } = await output(
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
    expect(setup).toBe(false);
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
    setup: false,
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
    .poll(async () => (await displayLiveState(display)).config.supervisedMode)
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

test("the settings screen saves as the host goes", async ({
  karafriends,
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  // Not open by itself: S opens it, on Accounts.
  await expect(display.getByText("Scan to join")).toBeVisible();
  await expect(settings).toHaveCount(0);
  await display.keyboard.press("s");
  await expect(settings.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
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

test.describe("a first start (no config.yaml)", () => {
  // Both catalogs off whatever is typed: nothing signs in.
  test.use({ noConfigFile: true, catalogs: "" });

  test("the setup screen: logins, then mics and speakers, then an admin password; then the idle screen, for good", async ({
    display,
  }) => {
    const setup = display.getByRole("dialog", { name: "Setup" });
    const steps = setup.getByRole("list", { name: "Steps" });
    const step = (name: string) =>
      steps.getByRole("listitem").filter({ hasText: name });
    await expect(
      setup.getByRole("heading", { name: "Welcome to karafriends" }),
    ).toBeVisible();
    await expect(steps.getByRole("listitem")).toHaveText([
      "1Logins",
      "2Mics and speakers",
      "3Admin password",
    ]);
    await expect(step("Logins")).toHaveAttribute("aria-current", "step");

    // 1: the logins, each saying how its catalog stands, and Import config.
    const dam = setup.getByRole("region", { name: "DAM login" });
    await expect(
      dam.getByText("Off: guests can't find DAM songs until a login is set."),
    ).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "Import config" }),
    ).toBeVisible();
    await expect(setup.getByRole("button", { name: "Back" })).toHaveCount(0);
    await dam.getByLabel("Username").fill("e2e-first-user");
    // Next saves the field being edited.
    await setup.getByRole("button", { name: "Next" }).click();
    await expect(step("Mics and speakers")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect((await output(display, "getSettings")).settings.damUsername).toBe(
      "e2e-first-user",
    );

    // 2: the Sound tab's sections.
    await expect(
      setup.getByRole("region", { name: "Microphones" }),
    ).toBeVisible();
    await setup.getByRole("button", { name: "Next" }).click();

    // 3: an admin password.
    await expect(step("Admin password")).toHaveAttribute(
      "aria-current",
      "step",
    );
    const admin = setup.getByRole("region", { name: "Admin password" });
    await admin.getByLabel("Password").fill("e2e admin");
    await admin.getByRole("button", { name: "Set password" }).click();
    await expect(admin.getByRole("status")).toHaveText(
      "Saved. Phones signed in as admins must sign in again.",
    );
    await setup.getByRole("button", { name: "Finish" }).click();

    // Then the idle screen, and the setup screen doesn't open again, not
    // even after a reload.
    await expect(setup).toHaveCount(0);
    await expect(display.getByText("Scan to join")).toBeVisible();
    expect((await output(display, "getSettings")).setup).toBe(false);
    await display.reload();
    await expect(display.getByText("Scan to join")).toBeVisible();
    await expect(setup).toHaveCount(0);
  });

  test("Back goes a step back, and Skip setup leaves it", async ({
    display,
  }) => {
    const setup = display.getByRole("dialog", { name: "Setup" });
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Back" }).click();
    await expect(
      setup.getByRole("region", { name: "DAM login" }),
    ).toBeVisible();
    await setup.getByRole("button", { name: "Skip setup" }).click();
    await expect(setup).toHaveCount(0);
    expect((await output(display, "getSettings")).setup).toBe(false);
  });
});

test("Use Joysound turns its songs off for the phones, and on again", async ({
  karafriends,
  display,
}) => {
  await openTab(display, "Accounts");
  const joysound = display
    .getByRole("dialog", { name: "Settings" })
    .getByRole("region", { name: "Joysound login" });
  const use = joysound.getByLabel("Use Joysound");
  // On, faked for the tests.
  await expect(use).toBeChecked();
  await expect(
    joysound.getByText("On: guests can find and sing Joysound songs."),
  ).toBeVisible();

  await use.uncheck();
  await expect(
    joysound.getByText("Turned off: guests don't see Joysound songs."),
  ).toBeVisible();
  expect((await configOnDisk(karafriends.app)).joysoundEnabled).toBe(false);
  expect((await phoneLiveState(karafriends.remoconUrl)).catalogs).toEqual({
    dam: { state: "on" },
    joysound: { state: "disabled" },
  });

  await use.check();
  await expect(
    joysound.getByText("On: guests can find and sing Joysound songs."),
  ).toBeVisible();
  expect((await configOnDisk(karafriends.app)).joysoundEnabled).toBe(true);
});

test("leaving Settings saves the field being edited: Escape keeps it, and Close stays open to say why one was refused", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const close = settings.getByRole("button", { name: "Close" });
  const joysound = settings.getByRole("region", { name: "Joysound login" });
  await openSettings(display);
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
  // meanwhile: on the default output, or silently where the machine has no
  // output at all (CI).
  const sound = display.getByRole("region", { name: "Sound", exact: true });
  await expect(
    sound.getByText(
      /^The songs play (on System default|silently) until E2E Gone is connected\.$/,
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

test("a custom URL takes the QR code's place until a LAN address is picked again", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  const phones = settings.getByRole("region", { name: "Phones", exact: true });
  const address = phones.getByLabel("Address");
  const custom = phones.getByRole("textbox", { name: "Custom URL" });
  const shown = display.locator(".joinAddress");
  const first = await defaultAddress(display);
  const closeSettings = async () => {
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(settings).toHaveCount(0);
  };
  const openParty = async () => {
    await display.keyboard.press("s");
    await openTab(display, "Party");
  };
  await openTab(display, "Party");
  await expect(custom).toHaveCount(0);

  // Picked, it opens to type in; what isn't a site's root is refused, and
  // the QR code keeps the LAN address meanwhile.
  await address.selectOption("Custom URL…");
  await expect(custom).toBeFocused();
  for (const [typed, why] of [
    ["ftp://example.com", "Only http:// or https:// addresses."],
    [
      "https://karaoke.example.ts.net/party",
      "the remote has to be at its root",
    ],
  ]) {
    await custom.fill(typed);
    await custom.press("Enter");
    await expect(phones.getByRole("alert")).toContainText(why);
  }
  expect(await display.evaluate(() => localStorage.getItem("customUrl"))).toBe(
    null,
  );

  // An https one, tidied: the idle screen shows it whole.
  await custom.fill(" HTTPS://Karaoke.Example.ts.net/ ");
  await custom.press("Enter");
  await expect(custom).toHaveValue("https://karaoke.example.ts.net");
  await expect(phones.getByRole("alert")).toHaveCount(0);
  await closeSettings();
  await expect(shown).toHaveText("https://karaoke.example.ts.net");

  // Kept across a reload.
  await display.reload();
  await openTab(display, "Party");
  await expect(address).toHaveValue("custom");
  await expect(custom).toHaveValue("https://karaoke.example.ts.net");

  // A port forward's host and port: http, shown without it.
  await custom.fill("203.0.113.5:8080");
  await custom.press("Enter");
  await closeSettings();
  await expect(shown).toHaveText("203.0.113.5:8080");
  expect(await display.evaluate(() => localStorage.getItem("customUrl"))).toBe(
    "http://203.0.113.5:8080",
  );

  // A LAN address again: the custom URL is gone.
  await openParty();
  await address.selectOption(first);
  await expect(custom).toHaveCount(0);
  expect(await display.evaluate(() => localStorage.getItem("customUrl"))).toBe(
    null,
  );
  await closeSettings();
  await expect(shown).toHaveText(first);
});

test("the Address is this computer's first LAN address until another is picked, which is kept while it's here", async ({
  display,
}) => {
  const address = display
    .getByRole("dialog", { name: "Settings" })
    .getByRole("region", { name: "Phones", exact: true })
    .getByLabel("Address");
  const first = await defaultAddress(display);
  const port = first.slice(first.lastIndexOf(":") + 1);
  await openTab(display, "Party");
  await expect(address).toHaveValue(first);
  // The addresses, then the custom URL; no karafriends.local.
  const options = await address.locator("option").allTextContents();
  expect(options.at(-1)).toBe("Custom URL…");
  const names = options.slice(0, -1);
  expect(names).not.toContain("karafriends.local");
  expect(`${names[0]}:${port}`).toBe(first);

  // Another of this computer's addresses, if it has one here.
  if (names.length > 1) {
    await address.selectOption(names[1]);
    await display.reload();
    await openTab(display, "Party");
    await expect(address).toHaveValue(`${names[1]}:${port}`);
    await address.selectOption(names[0]);
    expect(await display.evaluate(() => localStorage.getItem("hostname"))).toBe(
      names[0],
    );
  }

  // An address from another network: back to the first.
  await display.evaluate(() => localStorage.setItem("hostname", "203.0.113.9"));
  await display.reload();
  await openTab(display, "Party");
  await expect(address).toHaveValue(first);
  await expect(address.locator("option")).toHaveText(options);
});

test("Settings is in tabs: the arrows, Home and End move through them, the panel follows, and the last one opens again", async ({
  display,
}) => {
  const settings = display.getByRole("dialog", { name: "Settings" });
  await openSettings(display);
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

  // It opens on Accounts at first, focused, so the keys work at once.
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

  // A launch doesn't open it, even without a login.
  await display.reload();
  await expect(display.getByText("Scan to join")).toBeVisible();
  await expect(settings).toHaveCount(0);
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

test("About says the version, shows the license and the third-party notices, and opens the source", async ({
  karafriends,
  display,
}) => {
  const { app } = karafriends;
  // The source's page goes to a list, not the system's browser: the test
  // checks the list took its place before anything is clicked.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedExternally: opened });
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const openedExternally = () =>
    app.evaluate(
      () => (globalThis as { openedExternally?: string[] }).openedExternally,
    );
  expect(await openedExternally()).toEqual([]);
  expect(
    await app.evaluate(({ shell }) => shell.openExternal.toString()),
  ).toContain("opened.push");

  await openTab(display, "Advanced");
  const about = display.getByRole("region", { name: "About" });
  // What the main process says. (Started on build/prod/main/index.js, as
  // here, Electron gives its own version; a packaged app, its package's.)
  const version = await app.evaluate(({ app }) => app.getVersion());
  await expect(about).toContainText(`karafriends ${version}`);
  await expect(about).toContainText("Free software under the GNU GPL v3");

  // The notices, in a box of their own, as the build wrote them.
  const noticesButton = about.getByRole("button", {
    name: "Third-party notices",
  });
  await expect(noticesButton).toHaveAttribute("aria-expanded", "false");
  await noticesButton.click();
  await expect(noticesButton).toHaveAttribute("aria-expanded", "true");
  const notices = about.getByRole("region", { name: "Third-party notices" });
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  ).version;
  await expect(notices).toContainText(
    `karafriends ${packageVersion}: third-party notices`,
  );
  for (const shipped of [
    /\nreact 19\.[\d.]+\n {2}License: MIT\n/,
    /\ncpal [\d.]+\n {2}License: Apache-2.0\n/,
    /\nNoto Serif JP and Noto Serif KR/,
    /\nFont Awesome Free 5\n {2}License: CC-BY-4.0\n/,
    /\nmecab-ipadic /,
    /LICENSES\.chromium\.html/,
  ]) {
    await expect(notices).toContainText(shipped);
  }
  if (process.platform === "win32") {
    await expect(notices).toContainText(
      "ASIO is a registered trademark of Steinberg Media Technologies GmbH.",
    );
  }
  // It scrolls, and the keys scroll it.
  await notices.focus();
  await display.keyboard.press("End");
  await expect
    .poll(() => notices.evaluate((box) => box.scrollTop))
    .toBeGreaterThan(0);

  // The license takes its place; pressed again, it closes.
  const licenseButton = about.getByRole("button", { name: "License" });
  await licenseButton.click();
  await expect(notices).toHaveCount(0);
  await expect(noticesButton).toHaveAttribute("aria-expanded", "false");
  const license = about.getByRole("region", { name: "License" });
  await expect(license).toContainText("GNU GENERAL PUBLIC LICENSE");
  await expect(license).toContainText("Version 3, 29 June 2007");
  await licenseButton.click();
  await expect(license).toHaveCount(0);

  // Only those two, by name: never a path.
  expect(
    await display.evaluate(() =>
      (
        window as unknown as {
          karafriends: {
            about: { readText(which: string): Promise<string | null> };
          };
        }
      ).karafriends.about.readText("../../package.json"),
    ),
  ).toBeNull();

  await about.getByRole("button", { name: "Source code" }).click();
  await expect
    .poll(openedExternally)
    .toEqual(["https://github.com/HyperBCS/karafriends"]);
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

  // A call from a phone (one song in the queue each, by default): its
  // answer.
  async function phoneCall(
    remoconUrl: string,
    deviceId: string,
    method: string,
    input: object,
  ) {
    return (
      await apiCall(remoconUrl, method, input, { deviceId, nickname: NICKNAME })
    ).body;
  }

  test("a Joysound song shows them from its guide melody, and one without a guide shows none", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    // A minute of black video without sound: no guide channel.
    await fakeJoysoundDownload(karafriends.app, "e2e-no-guide");
    // 12 s of black video whose sound is 3-channel Vorbis, as Joysound's
    // ogg: silent left and right, so the bars can only come from the third
    // channel, and nine sine notes there (C5 E5 G5 E5, D5 F5 A5 F5, C5, 0.9
    // s each, from 0.5 s). Made with the app's ffmpeg:
    //   ffmpeg -f lavfi -i "aevalsrc=exprs=0|0|0.3*sin(2*PI*t*(<each note's between(t,start,end)*Hz, summed>))*(<the same betweens, summed>):s=44100:c=3.0:d=12" -c:a libvorbis -q:a 0 guide.ogg
    //   ffmpeg -f lavfi -i color=black:s=320x180:r=10:d=12 -i guide.ogg -c:v libx264 -pix_fmt yuv420p -c:a copy -shortest -movflags faststart joysound-guide.mp4
    await fakeJoysoundDownload(karafriends.app, "e2e-guide", {
      video: "joysound-guide.mp4",
      seconds: 12,
    });
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
    await expect.poll(playing, { timeout: 20_000 }).toEqual({
      file: "joysound-e2e-no-guide-default-opus.mp4",
      started: true,
    });
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
    expect((await playing()).file).toBe("joysound-e2e-guide-default-opus.mp4");
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
    await fakeJoysoundDownload(karafriends.app, "e2e-guide", {
      video: "joysound-guide.mp4",
      seconds: 12,
    });
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
              v.currentSrc.endsWith("joysound-e2e-guide-default-opus.mp4"),
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

  test("a mic's pitch is read while the song plays, by one poller per mic, and drawn over the bars", async ({
    karafriends,
    display,
  }) => {
    // Every fake mic hears C5, surely.
    await display.evaluate(() =>
      (
        window as unknown as {
          karafriendsFakeAudio: {
            setPitch(midiNumber: number, confidence: number): void;
          };
        }
      ).karafriendsFakeAudio.setPitch(72, 0.95),
    );
    const settings = display.getByRole("dialog", { name: "Settings" });
    await openTab(display, "Sound");
    const section = settings.getByRole("region", { name: "Microphones" });
    await section
      .getByLabel("Add a microphone")
      .selectOption("E2E Mic (USB), channel 1");
    const mic = section.getByRole("group", {
      name: "E2E Mic (USB), channel 1",
    });
    await expect(mic).toBeVisible();
    await settings.getByRole("button", { name: "Close" }).click();

    await playGuideSong(karafriends, display);
    await expect(display.locator("canvas.pianoRollRoll")).toHaveCount(1, {
      timeout: 20_000,
    });
    // The song is 12 s long: each check starts it again from 1 s in.
    const video = display.locator("video");
    const rewind = () =>
      video.evaluate((v: HTMLVideoElement) => {
        v.currentTime = 1;
      });
    const pitchCalls = async () =>
      (await fakeAudioCalls(display)).filter(
        ([name]) => name === "inputDevice_getPitch",
      ).length;
    // How many times the mic was asked in about a second, and in how long.
    const askedInASecond = async () => {
      await rewind();
      const before = await pitchCalls();
      const start = Date.now();
      await display.waitForTimeout(1_000);
      return { calls: (await pitchCalls()) - before, ms: Date.now() - start };
    };
    // One poller asks every 25 ms (PITCH_POLL_MS), and no faster: two would
    // ask about twice as often.
    const onePoller = ({ calls, ms }: { calls: number; ms: number }) =>
      calls > 0 && calls <= ms / 25 + 2;

    await expect
      .poll(async () => onePoller(await askedInASecond()), {
        message: "the mic is asked every 25 ms, by one poller",
      })
      .toBe(true);
    // The trace, in the mic's colour (the only mic: micColor(0, 1), a pale
    // red), is drawn over the bars.
    const tracePixels = () =>
      display.evaluate(
        () =>
          new Promise<number>((resolve) =>
            requestAnimationFrame(() => {
              const canvas = document.querySelector<HTMLCanvasElement>(
                "canvas.pianoRollRoll",
              );
              const gl = canvas?.getContext("webgl2");
              if (!canvas || !gl || gl.isContextLost()) return resolve(0);
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
              let count = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
                if (r > 250 && Math.abs(g - 178) <= 3 && Math.abs(b - 178) <= 3)
                  count++;
              }
              resolve(count);
            }),
          ),
      );
    await rewind();
    await expect.poll(tracePixels).toBeGreaterThan(0);

    // Two key changes leave one poller.
    for (const semis of [1, 2]) {
      expect(
        await phoneCall(
          karafriends.remoconUrl,
          "e2e-phone",
          "setPitchShiftSemis",
          { semis, song: await currentSongKey(karafriends.remoconUrl) },
        ),
      ).toBe(true);
    }
    await expect
      .poll(async () => (await displayLiveState(display)).pitchShiftSemis)
      .toBe(2);
    await expect
      .poll(async () => onePoller(await askedInASecond()), {
        message: "the mic is asked every 25 ms, by one poller",
      })
      .toBe(true);

    // Removed, the mic isn't asked again.
    await display.getByRole("button", { name: "Settings" }).click();
    await openTab(display, "Sound");
    await mic.getByRole("button", { name: "Remove" }).click();
    await expect(mic).toHaveCount(0);
    await expect.poll(async () => (await askedInASecond()).calls).toBe(0);
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

  // The mics are on Sound.
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
    await expect
      .poll(phoneMics)
      .toEqual([{ ...MIC, gain: 150, echo: 25, gate: -60 }]);
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
      { ...MIC, gain: 150, echo: 25, gate: -60 },
      { ...INTERFACE, gain: 100, echo: 40, gate: -60 },
    ]);
    await mic.getByRole("button", { name: "Remove" }).click();
    await expect(mic).toHaveCount(0);
    const second = section.getByRole("group", { name: INTERFACE.label });
    await expect(second).toBeVisible();
    await expect
      .poll(phoneMics)
      .toEqual([{ ...INTERFACE, gain: 100, echo: 40, gate: -60 }]);
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
        gate: -40,
      }),
    ).toEqual([true]);
    await expect(second.getByLabel("Gain 50%")).toBeVisible();
    await expect(second.getByLabel("Echo 10%")).toBeVisible();
    await expect(second.getByLabel("Noise gate \u221240 dB")).toBeVisible();
    expect(await fakeAudioCalls(display)).toEqual(
      expect.arrayContaining([
        ["inputDevice_setGain", 1, 0.5],
        ["inputDevice_setEcho", 1, 0.1],
        ["inputDevice_setGate", 1, 0.01],
      ]),
    );
    // And it stays so: the display's own list coming back changes nothing.
    await display.waitForTimeout(1_000);
    expect(await phoneMics()).toEqual([
      { ...INTERFACE, gain: 50, echo: 10, gate: -40 },
    ]);

    // All of it is kept on the display: a reload opens the mic at its
    // levels, on the output picked.
    expect(
      await display.evaluate(() => [
        JSON.parse(localStorage.getItem("mics")!),
        localStorage.getItem("micOutput"),
      ]),
    ).toEqual([
      [{ name: INTERFACE_DEVICE, channel: 1, gain: 50, echo: 10, gate: -40 }],
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
        ["inputDevice_setGate", 0, 0.01],
      ]),
    );
    // The output before the mic, so the mic opens on it.
    expect(
      calls.findIndex(([name]) => name === "setOutputDevice"),
    ).toBeLessThan(calls.findIndex(([name]) => name === "inputDevice_new"));
  });

  test("a mic plugged in while Sound is open can be added: listed as the system says so, or as Add a microphone opens; a slow listing says it's looking", async ({
    display,
  }) => {
    const section = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Microphones" });
    const options = section.getByLabel("Add a microphone").locator("option");
    const fake = (method: "plugIn" | "slowListing", arg: string | number) =>
      display.evaluate(
        ([method, arg]) =>
          (
            window as unknown as {
              karafriendsFakeAudio: Record<string, (arg: unknown) => void>;
            }
          ).karafriendsFakeAudio[method](arg),
        [method, arg] as const,
      );
    const deviceChange = () =>
      display.evaluate(() =>
        navigator.mediaDevices.dispatchEvent(new Event("devicechange")),
      );
    await expect(options).toHaveText([
      "Select a microphone",
      "E2E Mic (USB), channel 1",
      "E2E Interface (USB), channel 1",
      "E2E Interface (USB), channel 2",
    ]);

    // The system says a device came: listed at once.
    await fake("plugIn", "E2E Headset");
    await deviceChange();
    await expect(options.last()).toHaveText("E2E Headset (USB), channel 1");

    // One it says nothing of: pressing Add a microphone lists it first
    // (not within a second of the last listing).
    await display.waitForTimeout(1_100);
    await fake("plugIn", "E2E Lavalier");
    await section.getByLabel("Add a microphone").dispatchEvent("mousedown");
    await expect(options.last()).toHaveText("E2E Lavalier (USB), channel 1");

    // A listing that holds the page: the next one says it's looking first.
    // (While it lists, the page answers no one, so a watcher notes it.)
    await display.evaluate(() => {
      const seen = window as unknown as { sawLooking: boolean };
      seen.sawLooking = false;
      new MutationObserver(() => {
        if (document.body.textContent?.includes("Looking for microphones…")) {
          seen.sawLooking = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await fake("slowListing", 400);
    await deviceChange();
    await fake("plugIn", "E2E Wireless");
    await deviceChange();
    await expect(options.last()).toHaveText("E2E Wireless (USB), channel 1");
    expect(
      await display.evaluate(
        () => (window as unknown as { sawLooking: boolean }).sawLooking,
      ),
    ).toBe(true);
    await expect(section.getByText("Looking for microphones…")).toHaveCount(0);
    await fake("slowListing", 0);
  });

  test("Sound sets the song volume and the guide melody for every song, as an admin's phone does", async ({
    karafriends,
    display,
  }) => {
    const sound = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Sound", exact: true });
    const live = () => phoneLiveState(karafriends.remoconUrl);
    await sound.getByLabel("Song volume 100%").fill("60");
    await expect(sound.getByLabel("Song volume 60%")).toBeVisible();
    await expect.poll(async () => (await live()).songVolume).toBe(60);
    await sound.getByLabel("Guide melody 0%").fill("35");
    await expect(sound.getByLabel("Guide melody 35%")).toBeVisible();
    await expect.poll(async () => (await live()).guideMelodyLevel).toBe(0.35);

    // An admin's phone's change shows here.
    const login = await fetch(
      new URL("api/adminLogin", karafriends.remoconUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      },
    );
    const { token } = await login.json();
    await fetch(new URL("api/setSongVolume", karafriends.remoconUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Karafriends-Admin-Token": token,
      },
      body: JSON.stringify({ volume: 25 }),
    });
    await expect(sound.getByLabel("Song volume 25%")).toBeVisible();
  });

  test("a mic's noise gate is off until raised, marks the meter, and reaches the device and the phones", async ({
    karafriends,
    display,
  }) => {
    const section = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Microphones" });
    await section.getByLabel("Add a microphone").selectOption(MIC.label);
    const mic = section.getByRole("group", { name: MIC.label });
    const mark = mic.locator(".settingsMeterGate");
    const off = mic.getByLabel("Noise gate Off");
    await expect(off).toHaveValue("-60");
    expect(await sliderFill(off)).toBe(0);
    await expect(mark).toHaveCount(0);
    const gateCalls = async () =>
      (await fakeAudioCalls(display)).filter(
        ([name]) => name === "inputDevice_setGate",
      );
    // Off on the device: 0, every time the mic opens or its levels change.
    const gateCalls0 = await gateCalls();
    expect(gateCalls0.length).toBeGreaterThan(0);
    expect(gateCalls0).toEqual(
      gateCalls0.map(() => ["inputDevice_setGate", 0, 0]),
    );

    await off.fill("-40");
    const raised = mic.getByLabel("Noise gate \u221240 dB");
    await expect(raised).toBeVisible();
    expect(await sliderFill(raised)).toBe(50);
    // -40 dB is a third of the way along the meter's 60 dB.
    const meter = (await mic
      .getByRole("meter", { name: "Level" })
      .boundingBox())!;
    const at = (await mark.boundingBox())!;
    expect(
      Math.abs(at.x + at.width / 2 - (meter.x + meter.width / 3)),
    ).toBeLessThan(2);
    // The fake mic's level, -12 dB, is over it: the bar isn't grey.
    await expect(mic.locator(".settingsMeterBar")).not.toHaveClass(/gated/);
    await expect
      .poll(async () => (await gateCalls()).at(-1))
      .toEqual(["inputDevice_setGate", 0, 0.01]);
    await expect
      .poll(async () => (await phoneLiveState(karafriends.remoconUrl)).mics)
      .toEqual([{ ...MIC, gain: 100, echo: 40, gate: -40 }]);

    // Back to Off.
    await raised.fill("-60");
    await expect(mic.getByLabel("Noise gate Off")).toBeVisible();
    await expect(mark).toHaveCount(0);
    await expect
      .poll(async () => (await gateCalls()).at(-1))
      .toEqual(["inputDevice_setGate", 0, 0]);
  });

  test("an admin's levels reach the display as given: back to an earlier level, two mics at once, one level of two", async ({
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

    // 100 → 150 → 100: each one lands.
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

    // The host turns the mic's echo down here as an admin sets its gain:
    // the admin's gain lands, and the host's echo stays.
    await mic.getByLabel("Echo 40%").fill("15");
    await adminSetsMicLevels(karafriends.remoconUrl, { id: MIC.id, gain: 90 });
    await expect(mic.getByLabel("Gain 90%")).toBeVisible();
    await expect(mic.getByLabel("Echo 15%")).toBeVisible();
    await expect
      .poll(async () => (await phoneLiveState(karafriends.remoconUrl)).mics)
      .toEqual([
        { ...MIC, gain: 90, echo: 15, gate: -60 },
        { ...INTERFACE, gain: 80, echo: 40, gate: -60 },
      ]);
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
        { name: MIC_DEVICE, channel: 0, gain: 120, echo: 40, gate: -60 },
        { ...GONE, gain: 70, echo: 10, gate: -60 },
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
  // What the display logs of the fakes that fail.
  test.use({
    allowDisplayErrors: anyOf(
      /^Couldn't switch the mic output to E2E Speakers \(Windows\): Error: E2E Speakers \(Windows\) won't open \(fake\)/,
      /^Couldn't list the (inputs|outputs): Error: A device won't give its name \(fake\)/,
    ),
  });
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
    ).toEqual([
      { name: MIC_DEVICE, channel: 0, gain: 100, echo: 40, gate: -60 },
    ]);

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

  test("at a big UI scale, a mic's device gets a line of its own", async ({
    display,
  }) => {
    // A 1080p TV at 200%.
    await display.setViewportSize({ width: 1920, height: 1080 });
    await display.evaluate(() => localStorage.setItem("uiScale", "200"));
    await display.reload();
    await openTab(display, "Sound");
    const section = display
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "Microphones" });
    await section
      .getByLabel("Add a microphone")
      .selectOption("E2E Mic (USB), channel 1");
    const mic = section.getByRole("group", {
      name: "E2E Mic (USB), channel 1",
    });
    const row = (await mic.locator(".settingsMicRow").boundingBox())!;
    const device = (await mic.getByLabel("Microphone").boundingBox())!;
    expect(device.width).toBeGreaterThan(row.width * 0.9);
    // The levels and Remove share the line under it.
    const gain = (await mic.getByLabel(/^Gain/).boundingBox())!;
    const remove = (await mic
      .getByRole("button", { name: "Remove" })
      .boundingBox())!;
    expect(gain.y).toBeGreaterThan(device.y + device.height);
    expect(remove.y + remove.height).toBeCloseTo(gain.y + gain.height, -1);
    const add = (await section.getByLabel("Add a microphone").boundingBox())!;
    expect(add.width).toBeGreaterThan(row.width * 0.9);
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
    await openSettings(display);
    await expect(crashed).toHaveCount(0);
    expect(
      await display.evaluate(() => JSON.parse(localStorage.getItem("mics")!)),
    ).toEqual([
      { name: MIC_DEVICE, channel: 0, gain: 100, echo: 40, gate: -60 },
    ]);

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

// Not at the same time as jp.spec.ts's tests, which sign in to the same
// accounts.
test.describe(
  "@jp with the installed app's logins",
  { tag: "@jp", lock: "jp-accounts" },
  () => {
    test.use({ realCredentials: true });

    test("testLogin signs in to DAM and Joysound @jp", async ({ display }) => {
      expect(await output(display, "testLogin", { service: "dam" })).toEqual({
        ok: true,
      });
      // With a note on karafriends' link to the account.
      expect(
        await output(display, "testLogin", { service: "joysound" }),
      ).toMatchObject({ ok: true });
    });
  },
);

test.describe("the downloads", () => {
  test("Settings shows the downloads and clears them; a phone can do neither", async ({
    karafriends,
    display,
  }) => {
    const folder = await downloadsFolder(karafriends.app);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "yt-e2evideo.mp4"), "x".repeat(1.5e6));
    fs.writeFileSync(path.join(folder, "yt-e2evideo.log"), "x".repeat(5e5));

    // Opened, Settings counts the files.
    const settings = display.getByRole("dialog", { name: "Settings" });
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

// Quit karafriends, in Settings' header, asks first: Cancel leaves it be,
// Quit quits. The main process's dialog is swapped for one that answers as
// the test says, so nothing pops up.
test("Quit karafriends asks first, and quits only when told to", async ({
  karafriends,
  display,
}) => {
  const { app } = karafriends;
  await app.evaluate(({ dialog }) => {
    const asked: Electron.MessageBoxOptions[] = [];
    const answers = { response: 1 };
    Object.assign(globalThis, { quitAsked: asked, quitAnswers: answers });
    dialog.showMessageBox = (async (
      ...args:
        [Electron.MessageBoxOptions] | [unknown, Electron.MessageBoxOptions]
    ) => {
      asked.push(args[args.length - 1] as Electron.MessageBoxOptions);
      return { response: answers.response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const asked = () =>
    app.evaluate(
      () =>
        (globalThis as { quitAsked?: { message: string }[] }).quitAsked ?? [],
    );

  await openSettings(display);
  const settings = display.getByRole("dialog", { name: "Settings" });
  const quit = settings.getByRole("button", { name: "Quit karafriends" });

  // Cancel: asked, and still here.
  await quit.click();
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({
    message: "Quit karafriends?",
    buttons: ["Quit", "Cancel"],
    cancelId: 1,
  });
  await expect(settings).toBeVisible();
  expect(app.process().exitCode).toBeNull();

  // Quit: the app goes.
  await app.evaluate(() => {
    (
      globalThis as { quitAnswers?: { response: number } }
    ).quitAnswers!.response = 0;
  });
  const closed = app.waitForEvent("close");
  await quit.click();
  await closed;
});
