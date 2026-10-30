import fs from "fs";
import path from "path";

import type { Locator, Page, Route } from "@playwright/test";

import {
  adminPasswordConfig,
  currentSongKey,
  displayCall,
  expect,
  fakeJoysoundDownload,
  isApiRequest,
  liveState,
  MAIN_ENTRY,
  NICKNAME,
  sheetSettled,
  showQueue,
  test,
} from "./fixtures";

// The remote's build is for phones back to iOS 15 (REMOCON_TARGET in
// electron.vite.config.ts), read from build/prod without starting the app:
// its CSS keeps the -webkit-user-select iOS Safari needs (Chromium doesn't,
// so a Chromium target drops it), and no JS it loads has a class static
// block, which Safari only runs from 16.4.
test("the remote's build is for iOS 15", () => {
  const web = path.join(path.dirname(MAIN_ENTRY), "..", "web");
  const page = fs.readFileSync(path.join(web, "remocon", "index.html"), "utf8");
  const assets = (pattern: RegExp, text: string) =>
    [...text.matchAll(pattern)].map((match) => path.basename(match[1]));
  const css = assets(/href="\.\.\/assets\/([^"]+\.css)"/g, page);
  expect(css).toHaveLength(1);
  const cssText = fs.readFileSync(path.join(web, "assets", css[0]), "utf8");
  expect(
    cssText.match(/-webkit-user-select:none/g)?.length ?? 0,
    "-webkit-user-select in the remote's CSS",
  ).toBeGreaterThan(0);
  // The entry, and every chunk it imports.
  const scripts = assets(/src="\.\.\/assets\/([^"]+\.js)"/g, page);
  expect(scripts).toHaveLength(1);
  for (let i = 0; i < scripts.length; i++) {
    const js = fs.readFileSync(path.join(web, "assets", scripts[i]), "utf8");
    expect(js, scripts[i]).not.toMatch(/\bstatic\s*\{/);
    for (const chunk of assets(/["']\.\/([\w.-]+\.js)["']/g, js)) {
      if (!scripts.includes(chunk)) scripts.push(chunk);
    }
  }
});

test("the remote opens on the search screen", async ({ remote }) => {
  await expect(
    remote.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  const field = remote.getByRole("searchbox", { name: "Search" });
  await expect(field).toBeVisible();
  // Under the field, one short row: Title or Artist, and at its end the
  // source's button, on All.
  const by = remote.getByRole("radiogroup", { name: "Search by" });
  await expect(by.getByRole("radio")).toHaveText(["Title", "Artist"]);
  await expect(by.getByRole("radio", { name: "Title" })).toBeChecked();
  const source = remote.getByRole("combobox", { name: "Source" });
  await expect(source).toHaveValue("all");
  const [main, fieldBox, byBox, sourceBox] = await Promise.all(
    [remote.getByRole("main"), field, by, source].map(
      async (locator) => (await locator.boundingBox())!,
    ),
  );
  const middle = (box: typeof byBox) => box.y + box.height / 2;
  expect(Math.abs(middle(byBox) - middle(sourceBox))).toBeLessThan(1);
  expect(byBox.y).toBeGreaterThan(fieldBox.y + fieldBox.height);
  expect(
    Math.abs(sourceBox.x + sourceBox.width - (fieldBox.x + fieldBox.width)),
  ).toBeLessThanOrEqual(2);
  // So the results start close under it (they started 170px down with
  // the two rows of tabs).
  expect(sourceBox.y + sourceBox.height - main.y).toBeLessThan(120);
  // The empty search screen has no History row: the top bar has it.
  await expect(remote.getByRole("main").getByRole("link")).toHaveCount(0);
});

// Picks a source in the search's source menu.
async function pickSource(
  remote: Page,
  source: "All" | "DAM" | "Joysound",
): Promise<void> {
  await remote
    .getByRole("combobox", { name: "Source" })
    .selectOption({ label: source });
}

test("the search's source is picked from the phone's own menu, and the button names it", async ({
  remote,
}) => {
  const searched: string[] = [];
  for (const catalog of ["dam", "joysound"]) {
    await remote.route(`**/api/${catalog}SearchSongs`, (route) => {
      searched.push(catalog);
      return route.fulfill({ json: { items: [], nextOffset: null } });
    });
  }
  // A native <select>, unseen over the button's look.
  const select = remote.getByRole("combobox", { name: "Source" });
  const button = select.locator("..");
  const shown = button.locator(":scope > span");
  await expect(select.locator("option")).toHaveText(["All", "DAM", "Joysound"]);
  await expect(select).toHaveValue("all");
  await expect(select).toHaveCSS("opacity", "0");
  // At least 16px, so iOS doesn't zoom in on it.
  await expect(select).toHaveCSS("font-size", "16px");
  // On All, the button shows only its icons.
  await expect(shown).toHaveText(["", ""]);
  // The select covers the whole button, and a 44px target.
  const [selectBox, buttonBox] = await Promise.all(
    [select, button].map(async (locator) => (await locator.boundingBox())!),
  );
  expect(selectBox.x).toBeLessThanOrEqual(buttonBox.x);
  expect(selectBox.x + selectBox.width).toBeGreaterThanOrEqual(
    buttonBox.x + buttonBox.width,
  );
  expect(selectBox.height).toBeGreaterThanOrEqual(44);

  // A pick: the button names the source, and the search uses it.
  await pickSource(remote, "DAM");
  await expect(select).toHaveValue("dam");
  await expect(shown).toHaveText(["", "DAM", ""]);
  await expect(remote).toHaveURL(/[?&]source=dam(&|$)/);
  await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");
  await expect(remote.getByText("No results found")).toBeVisible();
  expect(searched).toEqual(["dam"]);

  // From the keyboard: Tab reaches it, and the button shows the focus.
  await remote.getByRole("radio", { name: "Title" }).focus();
  await remote.keyboard.press("Tab");
  await expect(select).toBeFocused();
  await expect(button).toHaveCSS("outline-style", "solid");

  // Back on All, the icons alone again.
  await pickSource(remote, "All");
  await expect(shown).toHaveText(["", ""]);
  await expect(remote).toHaveURL(/[?&]source=all(&|$)/);
});

// History, Settings and Home: the top bar's three, in that order.
const PLACES = ["History", "Settings", "Home"] as const;
const places = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("link", { name: /^(Home|History|Settings)$/ });

// "#1cb3ff" as getComputedStyle gives a color: "rgb(28, 179, 255)".
// (The build may shorten a custom property's "#666666" to "#666".)
const rgb = (hex: string) => {
  const digits =
    hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1);
  const n = parseInt(digits, 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

test("the top bar has History, Settings and Home in the same place on every screen", async ({
  karafriends,
  remote,
}) => {
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: {
        ...damSong(1),
        lyricsPreview: null,
        vocalTypes: ["NORMAL"],
        tieUp: null,
        playtime: 200,
      },
    }),
  );
  let first: unknown;
  for (const [hash, current] of [
    ["#/", "Home"],
    ["#/history", "History"],
    ["#/settings", "Settings"],
    ["#/song/e2e-1", null],
  ] as const) {
    await remote.goto(new URL(hash, karafriends.remoconUrl).href);
    const buttons = places(remote);
    await expect(buttons).toHaveCount(3);
    for (const [i, name] of PLACES.entries()) {
      const button = buttons.nth(i);
      await expect(button).toHaveAccessibleName(name);
      if (name === current) {
        await expect(button).toHaveAttribute("aria-current", "page");
      } else {
        await expect(button).not.toHaveAttribute("aria-current");
      }
    }
    const boxes = await Promise.all(
      [0, 1, 2].map((i) => buttons.nth(i).boundingBox()),
    );
    for (const box of boxes) {
      expect([box!.width, box!.height], hash).toEqual([44, 44]);
    }
    // Where they were on the first screen.
    first ??= boxes;
    expect(boxes, hash).toEqual(first);
    // Back on the left, except on the search screen.
    await expect(remote.getByRole("banner").getByLabel("Back")).toHaveCount(
      current === "Home" ? 0 : 1,
    );
    if (current) {
      // In the accent, and a tap stays put.
      const button = buttons.nth(PLACES.indexOf(current));
      const accent = await remote.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--kf-accent")
          .trim(),
      );
      await expect(button).toHaveCSS("color", rgb(accent));
      const before = remote.url();
      await button.click();
      await expect(remote.getByRole("main")).toBeVisible();
      expect(remote.url()).toBe(before);
    }
  }
});

test("Settings in the top bar is a gear, and the old Profile address opens it", async ({
  karafriends,
  remote,
}) => {
  const settings = places(remote).nth(1);
  // The gear's teeth: Material's settings icon, not the person.
  await expect(settings.locator("path")).toHaveAttribute(
    "d",
    /^M19\.14 12\.94/,
  );
  await settings.click();
  await expect(remote).toHaveURL(/#\/settings$/);
  await expect(remote.getByRole("heading", { name: "Settings" })).toBeVisible();

  await remote.goto(new URL("#/profile", karafriends.remoconUrl).href);
  await expect(remote).toHaveURL(/#\/settings$/);
  await expect(remote.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("History in the top bar opens the history", async ({ remote }) => {
  await places(remote).nth(0).click();
  await expect(remote.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(remote).toHaveURL(/#\/history$/);
  await places(remote).nth(2).click();
  await expect(
    remote.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
});

test("a phone with site storage blocked still gets in, until it reloads", async ({
  karafriends,
  page,
}) => {
  // As Chrome with site data blocked: reading localStorage throws.
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  const errors: Error[] = [];
  page.on("pageerror", (err) => errors.push(err));
  await page.goto(karafriends.remoconUrl);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Nickname").fill("ken");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  await showQueue(page);
  await expect(page.getByRole("region", { name: "Queue" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a new phone picks a nickname before anything else", async ({
  karafriends,
  page,
}) => {
  await page.goto(new URL("#/history", karafriends.remoconUrl).href);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const nickname = page.getByLabel("Nickname");
  await expect(nickname).toBeFocused();
  // Just the nickname, and the language to read it in.
  await expect(page.getByRole("main").getByRole("heading")).toHaveText([
    "You",
    "This phone",
  ]);
  await expect(page.getByRole("radiogroup")).toHaveCount(1);
  await expect(
    page.getByRole("radiogroup", { name: "Language" }).getByRole("radio"),
  ).toHaveText(["English", "日本語"]);
  // Nothing else until it has one: the top bar's three are there but
  // disabled, there's no way back, and no sheet.
  await expect(places(page)).toHaveCount(3);
  for (const [i, name] of PLACES.entries()) {
    const button = places(page).nth(i);
    await expect(button).toHaveAccessibleName(name);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).not.toHaveAttribute("href");
  }
  await expect(page.getByLabel("Back")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Now playing" })).toHaveCount(
    0,
  );

  await nickname.fill("  ken  ");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("nickname"))).toBe(
    "ken",
  );

  // It can change it later, in the settings.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByLabel("Nickname")).toHaveValue("ken");
  await page.getByLabel("Nickname").fill("ken2");
  await page.getByRole("button", { name: "Save nickname" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("nickname")))
    .toBe("ken2");
});

test("the language toggle switches the remote to Japanese", async ({
  remote,
}) => {
  await remote.getByRole("link", { name: "Settings" }).click();
  await remote.getByRole("radio", { name: "日本語" }).click();
  await expect(remote.getByRole("heading", { name: "設定" })).toBeVisible();
  await expect(remote.getByRole("radio", { name: "日本語" })).toBeChecked();
  await remote.getByRole("button", { name: "戻る" }).click();
  await expect(remote.getByRole("heading", { name: "曲を探す" })).toBeVisible();
  await expect(remote.locator("html")).toHaveAttribute("lang", "ja");
});

test("the Theme setting picks light, dark, or the phone's mode", async ({
  remote,
}) => {
  const html = remote.locator("html");
  const body = remote.locator("body");
  const LIGHT = "rgb(237, 239, 242)";
  const DARK = "rgb(12, 13, 15)";
  const theme = remote.getByRole("radiogroup", { name: "Theme" });
  const choice = (name: string) =>
    theme.getByRole("radio", { name, exact: true });

  // Auto at first, following the phone's mode as it changes.
  await remote.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(body).toHaveCSS("background-color", LIGHT);
  // So does the CSS alone, as on the first frame, before theme.ts runs.
  await html.evaluate((el) => el.removeAttribute("data-theme"));
  await expect(body).toHaveCSS("background-color", LIGHT);
  await remote.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(body).toHaveCSS("background-color", DARK);

  await remote.getByRole("link", { name: "Settings" }).click();
  await expect(theme).toBeVisible();
  await expect(theme.getByRole("radio")).toHaveText(["Light", "Dark", "Auto"]);
  await expect(choice("Auto")).toBeChecked();

  // Light stays light in dark mode, and the sheet (white, above the page)
  // and the top bar go with it.
  await choice("Light").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(body).toHaveCSS("background-color", LIGHT);
  await expect(remote.getByRole("banner").locator("div").first()).toHaveCSS(
    "background-color",
    LIGHT,
  );
  await expect(remote.getByRole("region", { name: "Now playing" })).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  expect(await remote.evaluate(() => localStorage.getItem("theme"))).toBe(
    "light",
  );

  // Dark stays dark in light mode, and after a reload.
  await choice("Dark").click();
  await remote.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(body).toHaveCSS("background-color", DARK);
  await remote.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(choice("Dark")).toBeChecked();

  // Auto follows the phone again.
  await choice("Auto").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await remote.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(body).toHaveCSS("background-color", DARK);
  expect(await remote.evaluate(() => localStorage.getItem("theme"))).toBe(
    "auto",
  );
});

test("a setting's choices read as picked, and the arrow keys move the pick", async ({
  remote,
}) => {
  await remote.getByRole("link", { name: "Settings" }).click();
  const theme = remote.getByRole("radiogroup", { name: "Theme" });
  const choice = (name: string) =>
    theme.getByRole("radio", { name, exact: true });
  const html = remote.locator("html");
  await expect(choice("Auto")).toBeChecked();

  // The picked one filled in the accent, with a tick; the others plain.
  const fill = await remote.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--kf-accent-fill")
      .trim(),
  );
  await expect(choice("Auto")).toHaveCSS("background-color", rgb(fill));
  await expect(choice("Auto").locator("svg")).toHaveCount(1);
  await expect(choice("Light")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(choice("Light").locator("svg")).toHaveCount(0);

  // One tab stop: the picked one.
  await expect(theme.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(choice("Auto")).toHaveAttribute("tabindex", "0");
  await choice("Auto").focus();
  for (const [key, name, mode] of [
    ["ArrowLeft", "Dark", "dark"],
    ["Home", "Light", "light"],
    // Round from either end.
    ["ArrowLeft", "Auto", "light"],
    ["ArrowRight", "Light", "light"],
    ["ArrowDown", "Dark", "dark"],
    ["End", "Auto", "light"],
  ] as const) {
    await remote.keyboard.press(key);
    await expect(choice(name), key).toBeChecked();
    await expect(choice(name), key).toBeFocused();
    await expect(choice(name), key).toHaveAttribute("tabindex", "0");
    await expect(html, key).toHaveAttribute("data-theme", mode);
  }
  expect(await remote.evaluate(() => localStorage.getItem("theme"))).toBe(
    "auto",
  );

  // Tab leaves the group.
  await remote.keyboard.press("Tab");
  await expect(theme.locator(":focus")).toHaveCount(0);
});

// DAM and Joysound only answer Japanese IPs, so the remote's searches and
// song lookups get made-up answers here: this tests the remote, not them.
const PAGE_SIZE = 30;
const songName = (n: number) => `E2E DAM song ${String(n).padStart(2, "0")}`;
const damSong = (n: number) => ({
  id: `e2e-${n}`,
  name: songName(n),
  nameYomi: "",
  artistName: "E2E artist",
  artistNameYomi: "",
});

// Answers a search with `total` made-up results, PAGE_SIZE at a time.
function fakePages(
  route: Route,
  total: number,
  item: (n: number) => object,
): Promise<void> {
  const { offset } = route.request().postDataJSON();
  const items = Array.from(
    { length: Math.min(PAGE_SIZE, total - offset) },
    (_, i) => item(offset + i + 1),
  );
  const next = offset + items.length;
  return route.fulfill({
    json: { items, nextOffset: next < total ? next : null },
  });
}

test.describe("a DAM title search", () => {
  const RESULTS = 35;

  test("says why it failed, tries again, pages with More, and is kept for going back", async ({
    remote,
  }) => {
    // How the fake DAM answers each search, in turn, and the offsets asked
    // for.
    const answers = ["fail", "page", "fail", "page"];
    const offsets: number[] = [];
    await remote.route("**/api/damSearchSongs", (route) => {
      const { query, offset } = route.request().postDataJSON();
      expect(query).toBe("E2E");
      offsets.push(offset);
      if (answers.shift() !== "page") {
        return route.fulfill({
          status: 502,
          json: { error: "DAM didn't answer" },
        });
      }
      return fakePages(route, RESULTS, damSong);
    });
    await remote.route("**/api/damSong", (route) => {
      const { id } = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...damSong(Number(id.replace("e2e-", ""))),
          lyricsPreview: null,
          vocalTypes: ["NORMAL"],
          tieUp: null,
          playtime: 200,
        },
      });
    });

    await pickSource(remote, "DAM");
    await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");

    // The failure shows in place of the results; the page around it stays.
    const main = remote.getByRole("main");
    const alert = main.getByRole("alert");
    await expect(alert).toContainText("Couldn't search DAM: DAM didn't answer");
    await expect(remote.getByRole("searchbox", { name: "Search" })).toHaveValue(
      "E2E",
    );

    await alert.getByRole("button", { name: "Try again" }).click();
    const songs = main.getByRole("link", { name: /E2E DAM song/ });
    await expect(songs).toHaveCount(30);
    await expect(songs.first()).toContainText("DAM");
    await expect(alert).toHaveCount(0);

    // A failed "More" keeps what's there and can be pressed again.
    const more = main.getByRole("button", { name: "More" });
    await more.click();
    await expect(alert).toContainText(
      "Couldn't load more from DAM: DAM didn't answer",
    );
    await expect(songs).toHaveCount(30);
    await more.click();
    await expect(songs).toHaveCount(RESULTS);
    await expect(alert).toHaveCount(0);
    await expect(more).toBeHidden();

    // A song's page, and back: the results are all still there, without
    // asking again.
    await songs.filter({ hasText: songName(31) }).click();
    await expect(
      remote.getByRole("heading", { name: songName(31) }),
    ).toBeVisible();
    await expect(
      remote.getByRole("button", { name: "Queue song", exact: true }),
    ).toBeVisible();
    await remote.getByRole("button", { name: "Back" }).click();
    await expect(songs).toHaveCount(RESULTS);
    expect(offsets).toEqual([0, 0, 30, 30]);
  });
});

// Scrolls `target` a few screens down: with the wheel over it, or in mobile
// WebKit, which has no wheel in Playwright, by bringing its last row into
// view (which scrolls every scroller around it, the page too if it could).
async function scrollDown(page: Page, target: Locator) {
  if (page.context().browser()?.browserType().name() === "webkit") {
    await target.getByRole("listitem").last().scrollIntoViewIfNeeded();
    return;
  }
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 2000);
}

const scrollTop = (scroller: Locator) =>
  scroller.evaluate((el) => el.scrollTop);

// Only the screen and the queue scroll: the page never does, so the top bar
// and the now-playing sheet never move (on iOS, the page bounced and
// dragged them along).
const pageScroll = (page: Page) =>
  page.evaluate(() => [window.scrollY, document.documentElement.scrollTop]);

test("the top bar and the now-playing sheet stay put while results scroll", async ({
  remote,
}) => {
  await remote.route("**/api/damSearchSongs", (route) =>
    fakePages(route, PAGE_SIZE, damSong),
  );
  await pickSource(remote, "DAM");
  await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");
  const main = remote.getByRole("main");
  await expect(main.getByRole("link", { name: /E2E DAM song/ })).toHaveCount(
    PAGE_SIZE,
  );
  // Out of the field, as when the keyboard closes.
  await remote.getByRole("searchbox", { name: "Search" }).blur();

  const topBar = remote.getByRole("banner");
  const sheet = remote.getByRole("region", { name: "Now playing" });
  const before = [await topBar.boundingBox(), await sheet.boundingBox()];
  await scrollDown(remote, main);
  await expect.poll(() => scrollTop(main)).toBeGreaterThan(500);
  expect([await topBar.boundingBox(), await sheet.boundingBox()]).toEqual(
    before,
  );
  expect(await pageScroll(remote)).toEqual([0, 0]);
});

test("Home on a song page goes to the search screen", async ({
  karafriends,
  remote,
}) => {
  // On the search screen itself, it's the current screen's.
  await expect(remote.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: {
        ...damSong(1),
        lyricsPreview: null,
        vocalTypes: ["NORMAL"],
        tieUp: null,
        playtime: 200,
      },
    }),
  );
  await remote.goto(new URL("#/song/e2e-1", karafriends.remoconUrl).href);
  await expect(
    remote.getByRole("heading", { name: songName(1) }),
  ).toBeVisible();

  await remote.getByRole("link", { name: "Home" }).click();
  await expect(
    remote.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  expect(new URL(remote.url()).hash).toBe("#/");
});

// The details a DAM song's page asks for, for song n.
const damSongDetail = (n: number) => ({
  ...damSong(n),
  lyricsPreview: null,
  vocalTypes: ["NORMAL"],
  tieUp: null,
  playtime: 200,
  picture: false,
});

test("a queue button shows its download's progress as a bar", async ({
  karafriends,
  remote,
}) => {
  // The live state, with this song 42% downloaded: the server's own, with
  // its downloads replaced.
  const state = await liveState(karafriends.remoconUrl);
  const downloading = {
    ...state,
    downloads: [
      {
        id: 1,
        kind: "joysound",
        songId: "428493",
        suffix: null,
        progress: 0.42,
        status: "downloading",
        reason: null,
        isMine: true,
      },
    ],
  };
  await remote.route("**/api/events*", (route) =>
    route.fulfill({
      headers: { "Content-Type": "text/event-stream" },
      body: `data: ${JSON.stringify({ type: "state", state: downloading, sentAt: Date.now() })}\n\n`,
    }),
  );
  await remote.route("**/api/joysoundSong", (route) =>
    route.fulfill({
      json: {
        id: "428493",
        name: "SHYでもいいよ",
        artistName: "AISHA",
        lyricsPreview: null,
        tieUp: null,
        picture: false,
        guideVocal: false,
      },
    }),
  );
  await remote.route("**/api/queueSong", (route) =>
    route.fulfill({ json: { ok: true, eta: 120 } }),
  );
  await remote.goto(
    new URL("#/joysoundSong/428493", karafriends.remoconUrl).href,
  );
  // The live state's stream starts again, faked.
  await remote.reload();
  const main = remote.getByRole("main");
  await main.getByRole("button", { name: "Queue song", exact: true }).click();
  const button = main.getByRole("button", { name: "Downloading 42.0%" });
  await expect(button).toBeVisible();
  // Filled to 42% (the screen reader has the label, not the bar).
  await expect
    .poll(() =>
      button.evaluate((el) => {
        const bar = el.querySelector('[aria-hidden="true"]')!;
        const fill = bar.lastElementChild!;
        return Math.round(
          (100 * fill.getBoundingClientRect().width) /
            bar.getBoundingClientRect().width,
        );
      }),
    )
    .toBe(42);
});

test("a Joysound song with a guide-vocal version can be queued as either", async ({
  karafriends,
  remote,
}) => {
  const song = (guideVocal: boolean) => ({
    id: "9630",
    name: "残酷な天使のテーゼ",
    artistName: "高橋洋子",
    lyricsPreview: null,
    tieUp: null,
    picture: false,
    guideVocal,
  });
  await remote.route("**/api/joysoundSong", (route) =>
    route.fulfill({ json: song(true) }),
  );
  const asked: Record<string, unknown>[] = [];
  await remote.route("**/api/queueSong", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: false, reason: "Not now" } });
  });
  await remote.goto(
    new URL("#/joysoundSong/9630", karafriends.remoconUrl).href,
  );
  const main = remote.getByRole("main");
  await main
    .getByRole("button", { name: "Queue song with guide vocal" })
    .click();
  await expect.poll(() => asked.length).toBe(1);
  await expect(main.getByText("Not now")).toBeVisible();
  // The melody version's button: as before, no guideVocal.
  await expect(
    main.getByRole("button", { name: "Queue song", exact: true }),
  ).toBeEnabled();
  await main.getByRole("button", { name: "Queue song", exact: true }).click();
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[0]).toMatchObject({
    kind: "joysound",
    songId: "9630",
    guideVocal: true,
  });
  expect(asked[1]).not.toHaveProperty("guideVocal");

  // A song without one has the one button.
  await remote.unroute("**/api/joysoundSong");
  await remote.route("**/api/joysoundSong", (route) =>
    route.fulfill({ json: { ...song(false), id: "428493" } }),
  );
  await remote.goto(
    new URL("#/joysoundSong/428493", karafriends.remoconUrl).href,
  );
  await expect(
    main.getByRole("button", { name: "Queue song", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "Queue song with guide vocal" }),
  ).toHaveCount(0);
});

test("a Joysound artist's page says how many songs the artist has, as DAM's does", async ({
  karafriends,
  remote,
}) => {
  let asked = 0;
  await remote.route("**/api/joysoundArtistSongs", (route) => {
    asked++;
    return route.fulfill({
      json: {
        items: [{ id: "425691", name: "Lemon", artistName: "米津玄師" }],
        nextOffset: 20,
        songCount: 139,
      },
    });
  });
  await remote.goto(
    new URL("#/joysoundArtist/232873", karafriends.remoconUrl).href,
  );
  await expect(remote.getByRole("heading", { level: 2 })).toHaveText(
    "米津玄師",
  );
  await expect(
    remote.getByRole("main").getByText("Joysound · 139 songs", { exact: true }),
  ).toBeVisible();
  // The count came with the songs: one request.
  expect(asked).toBe(1);
});

// A 1×1 PNG, for a song's picture.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("a DAM song's page shows its title card and its length; a picture that won't load goes", async ({
  karafriends,
  remote,
}) => {
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: { ...damSongDetail(1), playtime: 265, picture: true },
    }),
  );
  let pictures = 0;
  await remote.route("**/api/songPicture/dam/e2e-1", (route) => {
    pictures++;
    return route.fulfill({ contentType: "image/png", body: PNG });
  });
  await remote.goto(new URL("#/song/e2e-1", karafriends.remoconUrl).href);
  const main = remote.getByRole("main");
  await expect(
    remote.getByRole("heading", { name: songName(1) }),
  ).toBeVisible();
  await expect(main.getByText("DAM · 4:25", { exact: true })).toBeVisible();
  const picture = main.locator('img[src="/api/songPicture/dam/e2e-1"]');
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  expect(pictures).toBe(1);

  // Song 2's picture fails: the page shows without it.
  await remote.route("**/api/songPicture/dam/e2e-2", (route) =>
    route.fulfill({ status: 502, json: { error: "no answer" } }),
  );
  await remote.unroute("**/api/damSong");
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({ json: { ...damSongDetail(2), picture: true } }),
  );
  await remote.evaluate(() => (window.location.hash = "#/song/e2e-2"));
  await expect(
    remote.getByRole("heading", { name: songName(2) }),
  ).toBeVisible();
  await expect(main.locator("img")).toHaveCount(0);
});

test("another song's page starts afresh: its own spinner, not the last song or its error", async ({
  karafriends,
  remote,
}) => {
  // Song 1 fails, song 3 waits until let go.
  let letGo = () => {};
  const held = new Promise<void>((resolve) => (letGo = resolve));
  await remote.route("**/api/damSong", async (route) => {
    const n = Number(route.request().postDataJSON().id.replace("e2e-", ""));
    if (n === 1) {
      return route.fulfill({ status: 502, json: { error: "DAM is down" } });
    }
    if (n === 3) await held;
    return route.fulfill({ json: damSongDetail(n) });
  });
  const main = remote.getByRole("main");
  await remote.goto(new URL("#/song/e2e-1", karafriends.remoconUrl).href);
  await expect(main.getByRole("alert")).toContainText("DAM is down");

  // As the now-playing link does: another page of the same kind. Song 2
  // is asked for at once, without a tap on Try again.
  await remote.evaluate(() => (window.location.hash = "#/song/e2e-2"));
  await expect(
    remote.getByRole("heading", { name: songName(2) }),
  ).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);

  // While song 3 loads, the spinner shows, not song 2 and its buttons.
  await remote.evaluate(() => (window.location.hash = "#/song/e2e-3"));
  await expect(main.getByRole("status", { name: "Loading" })).toBeVisible();
  await expect(remote.getByRole("heading", { name: songName(2) })).toHaveCount(
    0,
  );
  await expect(
    remote.getByRole("button", { name: "Queue song", exact: true }),
  ).toHaveCount(0);
  letGo();
  await expect(
    remote.getByRole("heading", { name: songName(3) }),
  ).toBeVisible();
});

test("each screen keeps its own scroll: Back lands where it was, a new screen opens at the top", async ({
  remote,
}) => {
  await remote.route("**/api/damSearchSongs", (route) =>
    fakePages(route, PAGE_SIZE, damSong),
  );
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: damSongDetail(
        Number(route.request().postDataJSON().id.replace("e2e-", "")),
      ),
    }),
  );
  await remote.route("**/api/history", (route) =>
    route.fulfill({ json: { items: [], nextOffset: null } }),
  );
  await pickSource(remote, "DAM");
  const search = remote.getByRole("searchbox", { name: "Search" });
  await search.fill("E2E");
  const main = remote.getByRole("main");
  const songs = main.getByRole("link", { name: /E2E DAM song/ });
  await expect(songs).toHaveCount(PAGE_SIZE);
  await search.blur();

  await scrollDown(remote, main);
  await expect.poll(() => scrollTop(main)).toBeGreaterThan(500);
  // Settled (WebKit's scroll into view can still be moving).
  let left = -1;
  await expect
    .poll(async () => {
      const now = await scrollTop(main);
      const settled = now === left;
      left = now;
      return settled;
    })
    .toBe(true);

  // A row in the middle of the screen, as a finger would tap it.
  const box = (await main.boundingBox())!;
  await remote.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(remote).toHaveURL(/#\/song\//);
  await expect(
    remote.getByRole("button", { name: "Queue song", exact: true }),
  ).toBeVisible();
  expect(await scrollTop(main)).toBe(0);

  await remote.getByRole("button", { name: "Back" }).click();
  await expect(songs).toHaveCount(PAGE_SIZE);
  await expect.poll(() => scrollTop(main)).toBe(left);

  // A screen opened from there starts at its top too.
  await remote.getByRole("link", { name: "Settings" }).click();
  await expect(remote.getByRole("textbox", { name: "Nickname" })).toBeVisible();
  // (Tall enough that it could have opened part way down.)
  expect(
    await main.evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeGreaterThan(0);
  expect(await scrollTop(main)).toBe(0);
  await remote.getByRole("button", { name: "Back" }).click();
  await expect.poll(() => scrollTop(main)).toBe(left);
});

test("an artist search from both catalogs takes turns on equal matches, and More loads both", async ({
  remote,
}) => {
  // Names of one length, so every artist matches "E2E" equally well.
  const artist = (source: string) => (n: number) => ({
    id: `${source}-${n}`,
    name: `E2E ${source} artist ${String(n).padStart(2, "0")}`,
    nameYomi: "",
    songCount: n,
  });
  await remote.route("**/api/damSearchArtists", (route) =>
    fakePages(route, 40, artist("DAM")),
  );
  await remote.route("**/api/joysoundSearchArtists", (route) =>
    fakePages(route, 35, artist("JOY")),
  );

  await remote.getByRole("radio", { name: "Artist" }).click();
  await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");
  const results = remote
    .getByRole("list", { name: "Results" })
    .getByRole("link");
  const names = async () =>
    (await results.allTextContents()).map((text) => {
      const [, source, n] = text.match(/E2E (DAM|JOY) artist (\d+)/)!;
      return `${source} ${Number(n)}`;
    });
  const turns = (count: number) =>
    Array.from({ length: count }, (_, i) => [`DAM ${i + 1}`, `JOY ${i + 1}`]);
  await expect(results).toHaveCount(60);
  expect(await names()).toEqual(turns(30).flat());
  await remote.getByRole("button", { name: "More" }).click();
  await expect(results).toHaveCount(75);
  expect(await names()).toEqual([
    ...turns(35).flat(),
    "DAM 36",
    "DAM 37",
    "DAM 38",
    "DAM 39",
    "DAM 40",
  ]);
  // The address keeps the search, for going back to it.
  const hash = new URL(remote.url()).hash;
  expect(
    Object.fromEntries(new URLSearchParams(hash.replace(/^#\/\?/, ""))),
  ).toEqual({ q: "E2E", by: "artist" });
});

test("a pasted YouTube or Niconico link opens the video's page", async ({
  remote,
}) => {
  await remote.route(/youtube\.com|ytimg\.com|nicovideo\.jp/, (route) =>
    route.abort(),
  );
  await remote.route("**/api/youtubeInfo", (route) =>
    route.fulfill({ json: { ok: false, reason: "E2E offline" } }),
  );
  await remote.route("**/api/nicoInfo", (route) =>
    route.fulfill({ json: { ok: false, reason: "E2E offline" } }),
  );
  const search = remote.getByRole("searchbox", { name: "Search" });

  await search.fill("https://youtu.be/jNQXAC9IVRw?si=e2e");
  await expect(remote).toHaveURL(/#\/search\/youtube\/jNQXAC9IVRw$/);
  await expect(remote.getByRole("heading", { name: "YouTube" })).toBeVisible();
  await expect(remote.getByRole("alert")).toHaveText(
    "Couldn't get this video: E2E offline",
  );

  // A bare ID could be half typed ("sm1" of "sm12345"), or a title that
  // only looks like one ("OneLastKiss"): it's searched for, Enter and
  // leaving the field stay on the results, and a row above them opens the
  // video.
  for (const method of ["damSearchSongs", "joysoundSearchSongs"]) {
    await remote.route(`**/api/${method}`, (route) =>
      route.fulfill({ json: { items: [], nextOffset: null } }),
    );
  }
  const byId = remote.getByRole("list", {
    name: "Open as video ID",
  });
  await remote.getByRole("button", { name: "Back" }).click();
  await search.fill("sm9");
  await expect(remote).toHaveURL(/q=sm9/);
  await search.press("Enter");
  await expect(remote.getByText("No results found")).toBeVisible();
  await expect(remote).toHaveURL(/q=sm9/);
  await expect(byId.getByRole("link")).toContainText("sm9");
  await expect(byId.getByRole("link")).toContainText("Niconico");
  await byId.getByRole("link").click();
  await expect(remote).toHaveURL(/#\/search\/niconico\/sm9$/);
  await expect(remote.getByRole("heading", { name: "Niconico" })).toBeVisible();

  await remote.getByRole("button", { name: "Back" }).click();
  for (const title of ["OneLastKiss", "jNQXAC9IVRw"]) {
    await search.fill(title);
    await expect(remote).toHaveURL(new RegExp(`q=${title}`));
    await search.press("Enter");
    await search.focus();
    await search.blur();
    await expect(remote.getByText("No results found")).toBeVisible();
    await expect(remote).toHaveURL(new RegExp(`q=${title}`));
    await expect(byId.getByRole("link")).toContainText(title);
    await expect(byId.getByRole("link")).toContainText("YouTube");
  }
  await byId.getByRole("link").click();
  await expect(remote).toHaveURL(/#\/search\/youtube\/jNQXAC9IVRw$/);

  // A title is just searched for, with no row.
  await remote.getByRole("button", { name: "Back" }).click();
  await search.fill("Butterflies");
  await expect(remote).toHaveURL(/q=Butterflies/);
  await expect(remote.getByText("No results found")).toBeVisible();
  await expect(byId).toHaveCount(0);
});

test("the sheet's toolbar: the switch, the transport and the key, in that order", async ({
  remote,
}) => {
  await remote.setViewportSize({ width: 412, height: 800 });
  await showQueue(remote);
  const sheetBody = await remote
    .getByRole("button", { name: "Hide queue" })
    .getAttribute("aria-controls");
  const button = (name: string) =>
    remote.getByRole("button", { name, exact: true });
  const mode = button("Show emotes");
  const [restart, play, skip, lower, raise] = [
    "Restart",
    "Play",
    "Skip",
    "Lower key",
    "Raise key",
  ].map(button);
  const key = remote.getByRole("status", { name: "Key" });
  const box = async (el: Locator) => (await el.boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;

  // Every control is a full tap target; play is the big one, in the middle
  // of the row.
  for (const control of [mode, restart, play, skip, lower, raise]) {
    const b = await box(control);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  const big = await box(play);
  expect(big.width).toBeGreaterThan((await box(restart)).width);
  expect(Math.abs(big.x + big.width / 2 - 206)).toBeLessThan(2);

  for (const width of [412, 360, 320]) {
    await remote.setViewportSize({ width, height: 700 });
    const [m, r, p, s, l, k, ra] = await Promise.all(
      [mode, restart, play, skip, lower, key, raise].map(box),
    );
    // Restart, play and skip side by side; ♭, the key and ♯ too.
    for (const [a, b] of [
      [r, p],
      [p, s],
      [l, k],
      [k, ra],
    ]) {
      expect(a.x + a.width, `${width}px`).toBeLessThanOrEqual(b.x);
    }
    if (width >= 360) {
      // One row: the switch, then the transport, then the key.
      expect(m.x + m.width, `${width}px`).toBeLessThanOrEqual(r.x);
      expect(s.x + s.width, `${width}px`).toBeLessThanOrEqual(l.x);
      for (const b of [m, r, s, l, ra]) {
        expect(Math.abs(middle(b) - middle(p)), `${width}px`).toBeLessThan(1);
      }
    } else {
      // Two rows: the transport first, then the switch and the key.
      expect(m.y, `${width}px`).toBeGreaterThanOrEqual(p.y + p.height);
      expect(l.y, `${width}px`).toBeGreaterThanOrEqual(p.y + p.height);
      expect(m.x + m.width, `${width}px`).toBeLessThanOrEqual(l.x);
    }
    // Inside the screen, and nothing to scroll sideways.
    expect(m.x, `${width}px`).toBeGreaterThanOrEqual(0);
    expect(ra.x + ra.width, `${width}px`).toBeLessThanOrEqual(width);
    expect(
      await remote.evaluate((id) => {
        const scrolls = (el: Element) => el.scrollWidth > el.clientWidth;
        return [document.documentElement, document.getElementById(id)!].some(
          scrolls,
        );
      }, sheetBody!),
      `${width}px`,
    ).toBe(false);
  }

  // (Its sign: see "the now-playing bar".)
  await expect(key).toHaveText("0");

  // Showing the emotes, the switch stays where it is, and the emotes and
  // the button to change them take the rest of the row.
  await remote.setViewportSize({ width: 360, height: 700 });
  const before = await box(mode);
  await mode.click();
  const back = button("Show playback controls");
  expect(await box(back)).toEqual(before);
  const fire = await box(remote.getByRole("button", { name: "🔥" }));
  const edit = await box(button("Edit emotes"));
  expect(fire.x).toBeGreaterThanOrEqual(before.x + before.width);
  expect(edit.x).toBeGreaterThan(fire.x + fire.width);
  expect(edit.x + edit.width).toBeLessThanOrEqual(360);
  await back.click();
  await expect(play).toBeVisible();
});

test.describe("in supervised mode", () => {
  test.use({ appConfig: { supervisedMode: true } });

  test("dimmed controls do nothing from the keyboard either", async ({
    remote,
  }) => {
    const sent: string[] = [];
    for (const method of ["setPlaybackState", "setPitchShiftSemis"]) {
      await remote.route(`**/api/${method}`, (route) => {
        sent.push(method);
        return route.fulfill({ json: null });
      });
    }
    await showQueue(remote);
    // Someone else's song, so the transport and the key are dimmed.
    for (const name of ["Restart", "Play", "Skip", "Lower key"]) {
      const control = remote.getByRole("button", { name, exact: true });
      await expect(control).toHaveAttribute("aria-disabled", "true");
      await control.focus();
      await expect(control).toBeFocused();
      await remote.keyboard.press("Enter");
      await remote.keyboard.press("Space");
    }
    await remote.waitForTimeout(300);
    expect(sent).toEqual([]);
  });
});

test.describe("Joysound off (turned off, or no working login)", () => {
  test.use({ catalogs: "dam" });

  test("Browse isn't in the top bar, search leaves it out quietly, and a Joysound page says why", async ({
    remote,
  }) => {
    await expect(
      remote.getByRole("link", { name: "Settings" }).first(),
    ).toBeVisible();
    await expect(remote.getByRole("link", { name: "Browse" })).toHaveCount(0);
    await expect(remote.getByText(/isn't available/)).toHaveCount(0);
    // Only DAM: no source to pick.
    await expect(remote.getByLabel("Source")).toHaveCount(0);
    const asked: string[] = [];
    remote.on("request", (request) => {
      if (isApiRequest(request.url()))
        asked.push(new URL(request.url()).pathname);
    });
    await remote.route("**/api/damSearchSongs", (route) =>
      route.fulfill({
        json: {
          items: [{ id: "1234-56", name: "DAM only", artistName: "A" }],
          nextOffset: null,
        },
      }),
    );
    await remote.getByRole("searchbox", { name: "Search" }).fill("only");
    await expect(remote.getByRole("link", { name: /DAM only/ })).toBeVisible();
    expect(asked).not.toContain("/api/joysoundSearchSongs");

    // Nothing says Joysound is left out.
    await expect(remote.getByText(/isn't available/)).toHaveCount(0);

    // An old link to a Joysound song.
    await remote.goto(`${remote.url().split("#")[0]}#/joysoundSong/425691`);
    await remote.reload();
    await expect(
      remote.getByText("Joysound isn't available on this karaoke PC."),
    ).toBeVisible();
  });
});

test.describe("DAM and Joysound both off", () => {
  test.use({ catalogs: "" });

  test("search takes video links only: no Title or Artist, and no lookups", async ({
    remote,
  }) => {
    const asked: string[] = [];
    remote.on("request", (request) => {
      if (isApiRequest(request.url()))
        asked.push(new URL(request.url()).pathname);
    });
    const hint = remote.getByText(
      "Paste a YouTube or Niconico link to queue a video.",
    );
    await expect(hint).toBeVisible();
    await expect(remote.getByRole("radiogroup")).toHaveCount(0);
    await remote.getByRole("searchbox", { name: "Search" }).fill("Lemon");
    await remote.getByRole("searchbox", { name: "Search" }).press("Enter");
    await expect(remote).toHaveURL(/q=Lemon/);
    await expect(hint).toBeVisible();
    await expect(remote.getByText(/isn't available|No results/)).toHaveCount(0);
    expect(asked.filter((path) => /Search/.test(path))).toEqual([]);
  });
});

test.describe("Browse", () => {
  const song = (n: number) => ({
    id: `${n}`,
    name: `Browse song ${n}`,
    artistName: "Browse artist",
  });

  test("lists new songs, genres and featured lists, and opens their songs", async ({
    remote,
  }) => {
    await remote.route("**/api/joysoundGenres", (route) =>
      route.fulfill({
        json: [
          { id: "10000001", name: "J-POP" },
          { id: "10000011", name: "演歌" },
        ],
      }),
    );
    await remote.route("**/api/joysoundFeatures", (route) =>
      route.fulfill({
        json: [
          {
            id: "63",
            title: "バラードソング特集",
            songCount: 2,
            picture: true,
          },
        ],
      }),
    );
    const genresAsked: string[] = [];
    await remote.route("**/api/joysoundGenreSongs", (route) => {
      genresAsked.push(route.request().postDataJSON().id);
      return route.fulfill({
        json: { items: [song(1), song(2)], nextOffset: null },
      });
    });
    await remote.route("**/api/joysoundNewSongs", (route) =>
      route.fulfill({ json: { items: [song(3)], nextOffset: null } }),
    );
    await remote.route("**/api/joysoundFeature", (route) =>
      route.fulfill({
        json: {
          id: "63",
          title: "バラードソング特集",
          description: "しっとり抒情的な曲を。",
          picture: true,
          songs: [song(4), song(5)],
        },
      }),
    );
    await remote.route("**/api/songPicture/joysoundFeature/63", (route) =>
      route.fulfill({ contentType: "image/png", body: PNG }),
    );
    await remote.route("**/api/joysoundSong", (route) =>
      route.fulfill({
        json: {
          ...song(Number(route.request().postDataJSON().id)),
          lyricsPreview: null,
          tieUp: null,
          picture: false,
          guideVocal: false,
        },
      }),
    );

    await remote.getByRole("link", { name: "Browse" }).click();
    const main = remote.getByRole("main");
    await expect(
      main.getByRole("list", { name: "Popular by genre" }).getByRole("link"),
    ).toHaveText(["J-POP", "演歌"]);
    await expect(
      main.getByRole("list", { name: "Featured" }).getByRole("link"),
    ).toHaveText([/バラードソング特集.*2 songs/]);

    // A genre: its name over its songs; a song opens its page.
    await main.getByRole("link", { name: "J-POP" }).click();
    await expect(main.getByRole("heading", { name: "J-POP" })).toBeVisible();
    expect(genresAsked).toEqual(["10000001"]);
    await main.getByRole("link", { name: /Browse song 2/ }).click();
    await expect(
      remote.getByRole("heading", { name: "Browse song 2" }),
    ).toBeVisible();
    await remote.getByRole("button", { name: "Back" }).click();
    await remote.getByRole("button", { name: "Back" }).click();

    // The newest songs.
    await main.getByRole("link", { name: /New on Joysound/ }).click();
    await expect(
      main.getByRole("link", { name: /Browse song 3/ }),
    ).toBeVisible();
    await remote.getByRole("button", { name: "Back" }).click();

    // A featured list: its picture, description and songs, in its order.
    await main.getByRole("link", { name: /バラードソング特集/ }).click();
    await expect(
      main.getByRole("img", { name: "バラードソング特集" }),
    ).toBeVisible();
    await expect(main.getByText("しっとり抒情的な曲を。")).toBeVisible();
    await expect(
      main.getByRole("list", { name: "バラードソング特集" }).getByRole("link"),
    ).toHaveText([/Browse song 4/, /Browse song 5/]);
  });
});

test.describe("the now-playing bar", () => {
  const NICKNAME_LONG = "someone with a really very long nickname";
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        {
          kind: "nico",
          songId: "sm60002",
          name: "E2E playing song with a title long enough to need cutting short",
          artistName: "E2E artist",
          playtime: 60,
          timestamp: String(Date.UTC(2026, 0, 1)),
          user: { deviceId: "e2e-someone", nickname: NICKNAME_LONG },
        },
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  // A tap where a finger lands, on whatever is on top there: the bar's
  // text lets taps through to the toggle under it, so Playwright's click on
  // the text itself would wait for it forever.
  // The sheet first stops moving, so the tap lands where the text is.
  const tap = async (el: Locator) => {
    await sheetSettled(el.page());
    const box = (await el.boundingBox())!;
    await el.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  test("drags open and shut by its bar, following the finger, and settles by how far it got or a flick", async ({
    remote,
  }) => {
    const sheet = remote.getByRole("region", { name: "Now playing" });
    const toggle = sheet.getByRole("button", { name: /^(Show|Hide) queue$/ });
    const queue = sheet.getByRole("region", { name: "Queue" });
    await expect(sheet.getByText(/^E2E playing song/)).toBeVisible({
      timeout: 15_000,
    });
    const top = async () => (await sheet.boundingBox())!.y;
    const folded = await top();
    // From the middle of the bar's arrow, with a pause before letting go
    // (no flick).
    const box = (await toggle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const drag = async (to: number, steps = 10) => {
      await remote.mouse.move(x, y);
      await remote.mouse.down();
      await remote.mouse.move(x, to, { steps });
    };
    // Past the time a quick swipe takes (a flick, whatever the distance).
    const letGo = async (pause = 300) => {
      await remote.waitForTimeout(pause);
      await remote.mouse.up();
    };

    // Up 60 px: the sheet comes up with the finger, the queue under it.
    await drag(y - 60);
    expect(Math.abs(folded - 60 - (await top()))).toBeLessThan(3);
    await expect(queue).toBeVisible();
    // Let go that low, it goes back down.
    await letGo();
    await expect(queue).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await sheetSettled(remote);
    expect(await top()).toBe(folded);

    // Most of the way up: it opens.
    await drag(80);
    await letGo();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(queue).toBeVisible();
    await sheetSettled(remote);
    expect(await top()).toBeLessThan(folded - 150);
    const open = await top();
    // A drag never toggles it again as it ends.
    await remote.waitForTimeout(400);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Down a little and back: it stays open.
    const bar = (await toggle.boundingBox())!;
    const barY = bar.y + bar.height / 2;
    await remote.mouse.move(x, barY);
    await remote.mouse.down();
    await remote.mouse.move(x, barY + 40, { steps: 5 });
    expect(Math.abs(open + 40 - (await top()))).toBeLessThan(3);
    await letGo();
    await expect.poll(top).toBe(open);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // A quick flick down folds it, however short: a finger's, all within
    // one task, so the test's own timing can't slow it.
    await toggle.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const at = (type: string, dy: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          button: type === "pointermove" ? -1 : 0,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2 + dy,
        });
      button.dispatchEvent(at("pointerdown", 0));
      button.dispatchEvent(at("pointermove", 15));
      button.dispatchEvent(at("pointermove", 30));
      button.dispatchEvent(at("pointerup", 30));
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(queue).toBeHidden();
    await expect.poll(top).toBe(folded);
  });

  test("slides open and shut when tapped, and at once with reduced motion", async ({
    remote,
  }) => {
    const sheet = remote.getByRole("region", { name: "Now playing" });
    const toggle = sheet.getByRole("button", { name: /^(Show|Hide) queue$/ });
    await expect(sheet.getByText(/^E2E playing song/)).toBeVisible({
      timeout: 15_000,
    });
    // The body's style straight after the tap (React renders a click's
    // change a task later, at most): on its way, from where it was.
    const tapAndLook = () =>
      toggle.evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const body = document.getElementById(
          button.getAttribute("aria-controls")!,
        )!;
        return {
          transition: body.style.transition,
          height: body.style.height,
          hidden: body.hidden,
        };
      });
    const opening = await tapAndLook();
    expect(opening.transition).toContain("height");
    expect(opening.hidden).toBe(false);
    expect(parseFloat(opening.height)).toBeGreaterThan(100);
    await expect(sheet.getByRole("region", { name: "Queue" })).toBeVisible();
    // Settled, the body has no style of its own left.
    await expect
      .poll(() =>
        toggle.evaluate(
          (button) =>
            document.getElementById(button.getAttribute("aria-controls")!)!
              .style.cssText,
        ),
      )
      .toBe("");
    const closing = await tapAndLook();
    expect(closing).toMatchObject({ height: "0px", hidden: false });
    await expect(sheet.getByRole("region", { name: "Queue" })).toBeHidden();

    await remote.emulateMedia({ reducedMotion: "reduce" });
    expect(await tapAndLook()).toEqual({
      transition: "",
      height: "",
      hidden: false,
    });
    expect(await tapAndLook()).toEqual({
      transition: "",
      height: "",
      hidden: true,
    });
  });

  test("is the only place the current song shows, and a toggle anywhere but its link", async ({
    remote,
  }) => {
    const sheet = remote.getByRole("region", { name: "Now playing" });
    const toggle = sheet.getByRole("button", { name: /^(Show|Hide) queue$/ });
    const title = sheet.getByText(/^E2E playing song/);
    // The title's line, which clips it (Marquee): getByText finds the text
    // inside, as wide as the whole title.
    const titleLine = title.locator("..");
    // The display starts it within 5 seconds.
    await expect(title).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAccessibleName("Show queue");
    // Folded, the toggle is all there is to press.
    await expect(sheet.getByRole("button")).toHaveCount(1);
    await expect(sheet.getByRole("link")).toHaveCount(0);

    // "Now playing" over the title, the title over the artist; the singer
    // on the right, the nickname whole as far as the bar allows, sliding
    // when it doesn't fit, as the title does.
    const label = sheet.getByText("Now playing", { exact: true });
    const artist = sheet.getByText("E2E artist", { exact: true });
    const nickname = sheet.getByText(NICKNAME_LONG);
    const [l, t, a, n] = await Promise.all(
      [label, titleLine, artist, nickname].map(
        async (el) => (await el.boundingBox())!,
      ),
    );
    expect(t.y).toBeGreaterThan(l.y);
    expect(a.y).toBeGreaterThan(t.y);
    expect(n.x).toBeGreaterThan(t.x + t.width);
    // Too long for the bar, the title slides, and so does the nickname.
    await expect(titleLine).toHaveAttribute("data-marquee");
    await expect(nickname.locator("..")).toHaveAttribute("data-marquee");
    const muted = await remote.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--kf-muted")
        .trim(),
    );
    await expect(nickname).toHaveCSS("color", rgb(muted));
    await expect(label).toHaveCSS("color", rgb(muted));

    // A tap anywhere on it opens the sheet: on the title, then on the
    // singer to close it, then on the arrow.
    await tap(titleLine);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Hide queue");
    const queue = sheet.getByRole("region", { name: "Queue" });
    await expect(queue).toBeVisible();
    await tap(nickname);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(queue).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Open, the queue holds only the songs waiting, under "Up next": none.
    await expect(sheet.getByRole("heading", { name: "Up next" })).toBeVisible();
    await expect(queue.getByText("The queue is empty")).toBeVisible();
    await expect(queue).not.toContainText("E2E playing song");

    // Open, the title and artist are a link to the song's page, with its
    // source, beside the toggle rather than in it.
    const link = sheet.getByRole("link", { name: /^E2E playing song/ });
    await expect(link).toHaveAttribute("href", "#/search/niconico/sm60002");
    await expect(link).toContainText("Niconico");
    await expect(link).toContainText("E2E artist");
    expect(await link.evaluate((el) => !!el.closest("button"))).toBe(false);
    // Each reachable by keyboard: the link, then the toggle. (WebKit on
    // macOS tabs to form fields only, as Safari does by default; Option-Tab
    // reaches links and buttons too.)
    await link.focus();
    const macWebKit =
      process.platform === "darwin" &&
      remote.context().browser()?.browserType().name() === "webkit";
    await remote.keyboard.press(macWebKit ? "Alt+Tab" : "Tab");
    await expect(toggle).toBeFocused();
    // A tap on the singer still folds it.
    await tap(nickname);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(link).toHaveCount(0);
    await toggle.click();

    // The link opens the song's page and folds the sheet, so the page
    // shows.
    await tap(titleLine);
    await expect(remote).toHaveURL(/#\/search\/niconico\/sm60002$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the key shows its sign, and a key change for no song is dropped", async ({
    karafriends,
    remote,
  }) => {
    await showQueue(remote);
    // Once the display has started the song, the controls work.
    const pause = remote.getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toHaveAttribute("aria-disabled", "false", {
      timeout: 15_000,
    });
    const key = remote.getByRole("status", { name: "Key" });
    const song = await currentSongKey(karafriends.remoconUrl);
    expect(song).toBe(`sm60002@${Date.UTC(2026, 0, 1)}`);
    const setKey = async (semis: number, song: string) => {
      const res = await fetch(
        new URL("api/setPitchShiftSemis", karafriends.remoconUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ semis, song }),
        },
      );
      expect(res.status).toBe(200);
      return res.json();
    };

    // Below zero, a minus sign (U+2212).
    await expect(key).toHaveText("0");
    for (const [semis, shown] of [
      [2, "+2"],
      [-1, "−1"],
      [0, "0"],
    ] as const) {
      expect(await setKey(semis, song)).toBe(true);
      await expect(key).toHaveText(shown);
    }
    // A late tap meant for the song before.
    expect(await setKey(3, "sm1@1")).toBe(false);
    await remote.waitForTimeout(500);
    await expect(key).toHaveText("0");
  });

  test("quick ♯ taps each count", async ({ karafriends, remote }) => {
    await showQueue(remote);
    const raise = remote.getByRole("button", {
      name: "Raise key",
      exact: true,
    });
    await expect(raise).toHaveAttribute("aria-disabled", "false", {
      timeout: 15_000,
    });
    const key = remote.getByRole("status", { name: "Key" });
    // Faster than the live state's 250 ms: each tap's echo comes after the
    // next tap, and used to undo it.
    for (let i = 0; i < 5; i++) {
      await raise.click();
      await remote.waitForTimeout(60);
    }
    await expect(key).toHaveText("+5");
    await expect
      .poll(
        async () => (await liveState(karafriends.remoconUrl)).pitchShiftSemis,
      )
      .toBe(5);
    await remote.waitForTimeout(1_500);
    await expect(key).toHaveText("+5");
  });
});

// Picking a background video changes the song page's address in place. Back
// must still walk the remote's history: the artist, the song, the search.
test("a Joysound song with a background keeps the way back", async ({
  remote,
}) => {
  const joysoundSong = (n: number) => ({
    id: `e2e-joy-${n}`,
    name: `E2E Joysound song ${n}`,
    artistName: "E2E artist",
  });
  await remote.route(/youtube\.com|ytimg\.com/, (route) => route.abort());
  await remote.route("**/api/joysoundSearchSongs", (route) =>
    fakePages(route, 3, joysoundSong),
  );
  await remote.route("**/api/joysoundSearchArtists", (route) =>
    fakePages(route, 1, (n) => ({ id: `e2e-${n}`, name: "E2E artist" })),
  );
  await remote.route("**/api/joysoundSong", (route) =>
    route.fulfill({
      json: { ...joysoundSong(1), lyricsPreview: null, tieUp: null },
    }),
  );
  await remote.route("**/api/youtubeInfo", (route) =>
    route.fulfill({
      json: {
        ok: true,
        info: {
          title: "Me at the zoo",
          author: "jawed",
          channelId: "UC4QobU6STFB0P71PMvOGN5A",
          lengthSeconds: 19,
          description: "",
          viewCount: 1,
          captionLanguages: [],
          keywords: [],
          gainValue: 1,
        },
      },
    }),
  );

  await pickSource(remote, "Joysound");
  const search = remote.getByRole("searchbox", { name: "Search" });
  await search.fill("E2E");
  await remote
    .getByRole("main")
    .getByRole("link", { name: /E2E Joysound song 1/ })
    .click();
  await remote.getByRole("button", { name: "Add YouTube video" }).click();
  await remote.getByLabel("YouTube link or video ID").fill("jNQXAC9IVRw");
  await remote.getByRole("button", { name: "Use this video" }).click();
  await expect(remote).toHaveURL(/#\/joysoundSong\/e2e-joy-1\/jNQXAC9IVRw$/);
  await expect(remote.getByText("Me at the zoo")).toBeVisible();

  // The artist link opens the search by artist, a home screen without a
  // Back button: the phone's own back returns from it.
  await remote.getByRole("link", { name: "E2E artist" }).click();
  await expect(remote).toHaveURL(/by=artist/);
  await remote.goBack();
  await expect(remote).toHaveURL(/#\/joysoundSong\/e2e-joy-1\/jNQXAC9IVRw$/);
  await expect(
    remote.getByRole("button", { name: "Remove video" }),
  ).toBeVisible();
  // The top bar's Back goes back in the history, to the search, not to an
  // empty one.
  await remote.getByRole("button", { name: "Back" }).click();
  await expect(search).toHaveValue("E2E");
  await expect(
    remote.getByRole("main").getByRole("link", { name: /E2E Joysound song/ }),
  ).toHaveCount(3);
});

// The live state changes several times a second while anything downloads.
// That used to re-render the whole remote each time, which kept a DAM queue
// button's 2.5-second reset from ever going off.
test("a DAM queue button is ready again while the live state keeps changing", async ({
  karafriends,
  display,
  remote,
}) => {
  // Made-up answers, as above. queueSong too, so nothing asks DAM for the
  // song.
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: {
        ...damSong(1),
        lyricsPreview: null,
        vocalTypes: ["NORMAL"],
        tieUp: null,
        playtime: 200,
      },
    }),
  );
  await remote.route("**/api/queueSong", (route) =>
    route.fulfill({ json: { ok: true, eta: 60 } }),
  );
  await remote.goto(new URL("#/song/e2e-1", karafriends.remoconUrl).href);
  const button = remote.getByRole("button", {
    name: /^Queue song$|^Queued/,
  });
  await expect(button).toHaveText("Queue song");

  // Change the song volume about 6 times a second, as download progress
  // would change the state. (Not the key: with no song playing, the server
  // takes no key change.)
  let changing = true;
  let changed = 0;
  const changes = (async () => {
    for (let volume = 60; changing; volume = volume === 90 ? 60 : volume + 10) {
      expect(await displayCall(display, "setSongVolume", { volume })).toEqual({
        ok: true,
        output: true,
      });
      changed++;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();
  try {
    await expect.poll(() => changed).toBeGreaterThan(2);
    await button.click();
    await expect(button).toHaveText("Queued, up in 1:00");
    await expect(button).toBeDisabled();
    await expect(button).toHaveText("Queue song", { timeout: 5_000 });
    await expect(button).toBeEnabled();
  } finally {
    changing = false;
    await changes;
  }
});

test("a video's line says 1 view, and leaves out a count it doesn't have", async ({
  karafriends,
  remote,
}) => {
  let info: Record<string, unknown> = { lengthSeconds: 320, viewCount: 1 };
  await remote.route("**/api/nicoInfo", (route) =>
    route.fulfill({
      json: {
        ok: true,
        info: {
          title: "千本桜",
          author: "黒うさP",
          channelId: "4",
          description: "",
          thumbnailUrl: "data:,",
          ...info,
        },
      },
    }),
  );
  await remote.goto(
    new URL("#/search/niconico/sm9", karafriends.remoconUrl).href,
  );
  await expect(remote.getByText("Niconico · 5:20 · 1 view")).toBeVisible();

  // NaN and undefined arrive as null and as no key at all.
  info = { lengthSeconds: null };
  await remote.goto(
    new URL("#/search/niconico/sm10", karafriends.remoconUrl).href,
  );
  await expect(remote.getByRole("heading", { name: "千本桜" })).toBeVisible();
  // No length and no views: the line is just the source.
  await expect(remote.getByText(/ · |views?$/)).toHaveCount(0);
  await expect(
    remote.getByRole("button", { name: "Queue video" }),
  ).toBeEnabled();
});

test("a video lookup that failed isn't kept: the page asks again when it opens again", async ({
  karafriends,
  remote,
}) => {
  const answers = [
    { ok: false, reason: "Video unavailable" },
    {
      ok: true,
      info: {
        title: "千本桜",
        author: "黒うさP",
        channelId: "4",
        lengthSeconds: 320,
        description: "",
        viewCount: 1,
        thumbnailUrl: "data:,",
      },
    },
  ];
  let asked = 0;
  await remote.route("**/api/nicoInfo", (route) =>
    route.fulfill({ json: answers[Math.min(asked++, 1)] }),
  );
  const open = (hash: string) =>
    remote.goto(new URL(hash, karafriends.remoconUrl).href);
  await open("#/search/niconico/sm9");
  await expect(remote.getByRole("alert")).toContainText("Video unavailable");
  // Elsewhere, then back a moment later: asked again, not the failure
  // kept. (Suspense keeps any answer for a second.)
  await open("#/");
  await expect(remote.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await remote.waitForTimeout(1_100);
  await open("#/search/niconico/sm9");
  await expect(remote.getByRole("heading", { name: "千本桜" })).toBeVisible();
  expect(asked).toBe(2);
  // A good answer is kept.
  await open("#/");
  await expect(remote.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await remote.waitForTimeout(1_100);
  await open("#/search/niconico/sm9");
  await expect(remote.getByRole("heading", { name: "千本桜" })).toBeVisible();
  expect(asked).toBe(2);
});

test("a song already queued says why it wasn't queued again", async ({
  karafriends,
  remote,
}) => {
  await remote.route("**/api/queueSong", (route) =>
    route.fulfill({
      json: { ok: false, reason: "That song is already in the queue" },
    }),
  );
  await remote.route("**/api/nicoInfo", (route) =>
    route.fulfill({
      json: {
        ok: true,
        info: {
          title: "新・豪血寺一族 -煩悩解放 - レッツゴー！陰陽師",
          author: "中の",
          channelId: "4",
          lengthSeconds: 320,
          description: "",
          viewCount: 1,
          thumbnailUrl: "data:,",
        },
      },
    }),
  );
  await remote.goto(
    new URL("#/search/niconico/sm9", karafriends.remoconUrl).href,
  );
  await remote.getByRole("button", { name: "Queue video" }).click();
  await expect(
    remote.getByRole("button", {
      name: "Couldn't queue: That song is already in the queue",
    }),
  ).toBeDisabled();
  await expect(
    remote.getByRole("button", { name: "Queue video" }),
  ).toBeEnabled();
});

test.describe("with everyone an admin", () => {
  const PASSWORD = "e2e everyone";
  test.use({
    appConfig: { ...adminPasswordConfig(PASSWORD), everyoneIsAdmin: true },
  });

  test("the settings say so, and Sign out shows only for a phone that signed in", async ({
    display,
    remote,
  }) => {
    const admin = remote.getByRole("region", { name: "Admin" });
    const signOut = admin.getByRole("button", { name: "Sign out" });
    await remote.getByRole("link", { name: "Settings" }).click();
    await expect(admin.getByRole("status")).toHaveText(
      "Everyone has admin access",
    );
    await expect(
      admin.getByRole("slider", { name: "Song volume" }),
    ).toBeVisible();
    await expect(signOut).toHaveCount(0);

    // Off, a guest signs in as before, and can sign out.
    const setEveryoneIsAdmin = (everyoneIsAdmin: boolean) =>
      displayCall(display, "setSettings", { settings: { everyoneIsAdmin } });
    await setEveryoneIsAdmin(false);
    await admin.getByLabel("Admin password").fill(PASSWORD);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await expect(admin.getByRole("status")).toHaveText("Signed in as admin");
    await expect(signOut).toBeVisible();

    // On again, the phone that signed in still can.
    await setEveryoneIsAdmin(true);
    await expect(admin.getByRole("status")).toHaveText(
      "Everyone has admin access",
    );
    await expect(signOut).toBeVisible();
  });
});

// The server answers 409 when the host set no admin password (403 is a
// wrong one). Made up here, so this tests what the remote says.
test("signing in without an admin password says there is none", async ({
  remote,
}) => {
  await remote.route("**/api/adminLogin", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "No admin password is set" },
    }),
  );
  await remote.getByRole("link", { name: "Settings" }).click();
  await remote.getByLabel("Admin password").fill("anything");
  await remote.getByRole("button", { name: "Sign in" }).click();
  await expect(remote.getByRole("alert")).toHaveText(
    "The host hasn't set an admin password.",
  );
});

test.describe("an admin's queue", () => {
  const PASSWORD = "e2e remote admin";
  const song = (n: number) => ({
    kind: "nico",
    songId: `sm6000${n}`,
    name: `E2E queue song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-someone", nickname: "someone" },
  });
  test.use({
    appConfig: { supervisedMode: true, ...adminPasswordConfig(PASSWORD) },
    seedQueue: {
      currentSong: null,
      songQueue: [1, 2, 3, 4].map(song),
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  async function rows(remote: Page) {
    return remote
      .getByRole("region", { name: "Queue" })
      .getByRole("listitem")
      .allTextContents();
  }

  test("a tapped song says who queued it in place of its artist and source, and links to its page", async ({
    remote,
  }) => {
    await showQueue(remote);
    const queue = remote.getByRole("region", { name: "Queue" });
    const row = queue
      .getByRole("listitem")
      .filter({ hasText: "E2E queue song 4" });
    await expect(row).toContainText("E2E artist");
    await expect(row).toContainText("Niconico");
    await expect(row).not.toContainText("Queued by");

    await row.getByRole("button", { name: /E2E queue song 4/ }).click();
    await expect(row).toContainText("Queued by someone");
    await expect(row).not.toContainText("E2E artist");
    await expect(row).not.toContainText("Niconico");

    // Its page, for anyone; the sheet folds to show it.
    await row.getByRole("link", { name: "Song page" }).click();
    await expect(remote).toHaveURL(/#\/search\/niconico\/sm60004$/);
    await expect(
      remote.getByRole("button", { name: "Show queue" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(queue).toBeHidden();
  });

  test("moves songs, which a guest can't", async ({ remote }) => {
    await showQueue(remote);
    const queue = remote.getByRole("region", { name: "Queue" });
    // Song 1 starts within 5 seconds: it's on the bar, and the queue holds
    // the other three.
    await expect(
      remote
        .getByRole("region", { name: "Now playing" })
        .getByRole("link", { name: /^E2E queue song 1/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(queue.getByRole("listitem")).toHaveCount(3);
    await expect(queue.getByText("E2E queue song 1")).toHaveCount(0);
    const song4 = queue.getByRole("button", { name: /E2E queue song 4/ });

    // A guest sees who queued it, and nothing to press.
    await song4.click();
    await expect(song4).toHaveAttribute("aria-expanded", "true");
    await expect(queue).toContainText("Queued by someone");
    await expect(
      queue.getByRole("button", { name: "Move to top" }),
    ).toHaveCount(0);
    await expect(
      queue.getByRole("button", { name: "Remove from queue" }),
    ).toHaveCount(0);
    await expect(
      queue.getByRole("button", { name: "Drag to reorder" }),
    ).toHaveCount(0);

    await remote.getByRole("link", { name: "Settings" }).click();
    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("Signed in as admin")).toBeVisible();

    // (The row stays open.)
    await queue.getByRole("button", { name: "Move to top" }).click();
    await expect
      .poll(() => rows(remote))
      .toEqual([
        expect.stringContaining("song 4"),
        expect.stringContaining("song 2"),
        expect.stringContaining("song 3"),
      ]);
    // At the top, it can't go higher.
    await expect(
      queue.getByRole("button", { name: "Move to top" }),
    ).toBeDisabled();
    await queue.getByRole("button", { name: "Remove from queue" }).click();
    await expect(queue.getByText("E2E queue song 4")).toHaveCount(0);
  });
});

test.describe("history", () => {
  const HISTORY_LENGTH = 35;
  const songName = (n: number) =>
    `E2E history song ${String(n).padStart(2, "0")}`;

  // queue.json with a history of 35 songs, newest first: the newest one
  // with when it was sung, the rest as 0.1.0 saved them, without. The app
  // still reads those (parseState in src/main/state.ts), so this also checks
  // that an old queue.json survives an upgrade.
  test.use({
    seedQueue: {
      currentSong: null,
      currentSongAdhocLyrics: [],
      idToAdhocLyrics: {},
      pitchShiftSemis: 0,
      playbackState: "WAITING",
      songQueue: [],
      downloadQueue: [],
      songHistory: Array.from({ length: HISTORY_LENGTH }, (_, i) => {
        const n = HISTORY_LENGTH - i;
        return {
          song: {
            kind: "youtube",
            songId: `e2e-history-${n}`,
            name: songName(n),
            artistName: "E2E artist",
            playtime: 60,
            timestamp: String(Date.UTC(2026, 0, 1) + n * 60_000),
            user: { deviceId: "e2e-device", nickname: NICKNAME },
            hasAdhocLyrics: false,
            hasCaptions: false,
            gainValue: 1,
          },
          ...(n === HISTORY_LENGTH && {
            playedAt: Date.UTC(2026, 0, 1) + (n + 30) * 60_000,
          }),
        };
      }),
    },
  });

  test("pages through all 35 songs, each with who queued it", async ({
    remote,
  }) => {
    await remote.getByRole("link", { name: "History" }).click();
    await expect(
      remote.getByRole("heading", { name: "History" }),
    ).toBeVisible();

    const songs = remote
      .getByRole("main")
      .getByRole("link", { name: /E2E history song/ });
    // The first page holds 30.
    await expect(songs).toHaveCount(30);
    await expect(songs.first()).toContainText(songName(35));
    await expect(
      remote.getByRole("main").getByRole("listitem").first(),
    ).toContainText(NICKNAME);
    // The time is when it was sung, and for a song from before that was
    // kept, when it was queued, which says so.
    const times = remote
      .getByRole("main")
      .getByRole("listitem")
      .locator("time");
    await expect(times.first()).toHaveText(/^Sung /);
    await expect(times.first()).toHaveAttribute(
      "datetime",
      new Date(Date.UTC(2026, 0, 1) + 65 * 60_000).toISOString(),
    );
    await expect(times.nth(1)).toHaveText(/^Queued /);

    await remote.getByRole("button", { name: "More" }).click();
    await expect(songs).toHaveCount(HISTORY_LENGTH);
    await expect(remote.getByRole("button", { name: "More" })).toBeHidden();
    for (let n = 1; n <= HISTORY_LENGTH; n++) {
      await expect(songs.filter({ hasText: songName(n) })).toHaveCount(1);
    }

    // Tapping one opens its page.
    await songs.filter({ hasText: songName(35) }).click();
    await expect(remote).toHaveURL(/#\/search\/youtube\/e2e-history-35$/);
  });
});

test.describe("history, everyone's or mine", () => {
  const MINE = "e2e-history-mine";
  const entry = (n: number, deviceId: string) => ({
    song: {
      kind: "youtube",
      songId: `e2e-whose-${n}`,
      name: `E2E whose song ${n}`,
      artistName: "E2E artist",
      playtime: 60,
      timestamp: String(Date.UTC(2026, 0, 1) + n * 60_000),
      user: { deviceId, nickname: deviceId === MINE ? NICKNAME : "someone" },
      hasAdhocLyrics: false,
      hasCaptions: false,
      gainValue: 1,
    },
    playedAt: Date.UTC(2026, 0, 1) + (n + 1) * 60_000,
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [],
      playbackState: "WAITING",
      songHistory: [4, 3, 2, 1].map((n) =>
        entry(n, n % 2 ? MINE : "e2e-someone"),
      ),
    },
  });

  test("shows everyone's songs, or with Mine just this phone's, and remembers which", async ({
    remote,
  }) => {
    await remote.evaluate((id) => localStorage.setItem("deviceId", id), MINE);
    await remote.reload();
    await remote.getByRole("link", { name: "History" }).click();
    const whose = remote.getByRole("radiogroup", { name: "Whose songs" });
    const songs = remote
      .getByRole("main")
      .getByRole("link", { name: /E2E whose song/ });
    await expect(whose.getByRole("radio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(songs).toHaveText([/song 4/, /song 3/, /song 2/, /song 1/]);

    await whose.getByRole("radio", { name: "Mine" }).click();
    await expect(songs).toHaveText([/song 3/, /song 1/]);
    await remote.reload();
    await expect(whose.getByRole("radio", { name: "Mine" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(songs).toHaveText([/song 3/, /song 1/]);

    // Another phone has sung nothing.
    await remote.evaluate(() =>
      localStorage.setItem("deviceId", "e2e-history-nobody"),
    );
    await remote.reload();
    await expect(
      remote.getByText("No songs from this phone yet"),
    ).toBeVisible();
    await whose.getByRole("radio", { name: "All" }).click();
    await expect(songs).toHaveCount(4);
  });
});

test.describe("a long queue", () => {
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: Array.from({ length: 12 }, (_, i) => ({
        kind: "nico",
        songId: `sm7000${i + 1}`,
        name: `E2E long queue song ${i + 1}`,
        artistName: "E2E artist",
        playtime: 60,
        timestamp: String(Date.UTC(2026, 0, 1) + i),
        user: { deviceId: "e2e-someone", nickname: "someone" },
      })),
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  // Opens the sheet once song 1 has started (within 5 seconds): it's on the
  // bar, and the other eleven wait in the queue.
  async function openQueue(remote: Page) {
    await showQueue(remote);
    await expect(
      remote
        .getByRole("region", { name: "Now playing" })
        .getByRole("link", { name: /^E2E long queue song 1\b/ }),
    ).toBeVisible({ timeout: 15_000 });
    const queue = remote.getByRole("region", { name: "Queue" });
    await expect(queue.getByRole("listitem")).toHaveCount(11);
    return queue;
  }

  test("scrolls in the sheet without moving the screen or the top bar", async ({
    remote,
  }) => {
    const queue = await openQueue(remote);

    // The rows have no fill of their own: they sit in the queue's well,
    // which is sunk into the sheet, a color of its own.
    const sheet = remote.getByRole("region", { name: "Now playing" });
    const fill = (el: Locator) =>
      el.evaluate((node) => getComputedStyle(node).backgroundColor);
    const well = await remote.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--kf-well")
        .trim(),
    );
    expect(await fill(queue.getByRole("listitem").first())).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(await fill(queue)).toBe(rgb(well));
    expect(await fill(sheet)).not.toBe(rgb(well));

    const topBar = remote.getByRole("banner");
    const main = remote.getByRole("main");
    const before = await topBar.boundingBox();
    await scrollDown(remote, queue);
    await expect.poll(() => scrollTop(queue)).toBeGreaterThan(100);
    expect(await topBar.boundingBox()).toEqual(before);
    expect(await scrollTop(main)).toBe(0);
    expect(await pageScroll(remote)).toEqual([0, 0]);
    // The controls stay below the queue, in view.
    await expect(
      remote.getByRole("button", { name: "Show emotes" }),
    ).toBeInViewport();
  });

  // iOS before 16 ignores overscroll-behavior, so the remote stops the
  // touch drags that would bounce the page. Synthetic touches, from the
  // middle of target: whether the remote stopped the move.
  const touchDragStopped = (target: Locator, dx: number, dy: number) =>
    target.evaluate(
      (el, [dx, dy]) => {
        const { left, top, width, height } = el.getBoundingClientRect();
        const [x, y] = [left + width / 2, top + height / 2];
        const touch = (x: number, y: number) =>
          new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        const event = (type: string, x: number, y: number) =>
          new TouchEvent(type, {
            touches: [touch(x, y)],
            bubbles: true,
            cancelable: true,
          });
        el.dispatchEvent(event("touchstart", x, y));
        const move = event("touchmove", x + dx, y + dy);
        el.dispatchEvent(move);
        return move.defaultPrevented;
      },
      [dx, dy],
    );

  // (Playwright's WebKit has no Touch constructor.)
  const skipWithoutTouch = async (remote: Page) => {
    const canTouch = await remote.evaluate(() => {
      try {
        return !!new Touch({ identifier: 1, target: document.body });
      } catch {
        return false;
      }
    });
    test.skip(!canTouch, "No Touch constructor");
  };

  test("leaves touch scrolling to the browser where overscroll-behavior works", async ({
    remote,
  }) => {
    await skipWithoutTouch(remote);
    const queue = await openQueue(remote);
    const row = queue.getByRole("listitem").nth(1);
    expect(await touchDragStopped(row, 0, 20)).toBe(false);
    expect(await touchDragStopped(remote.getByRole("banner"), 0, 20)).toBe(
      false,
    );
  });

  test("on iOS 15, stops touch drags that would bounce the page", async ({
    remote,
  }) => {
    await skipWithoutTouch(remote);
    // As iOS before 16, which ignores overscroll-behavior.
    await remote.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args: [string, string?]) =>
        args[0] === "overscroll-behavior"
          ? false
          : supports(...(args as [string, string]));
    });
    await remote.reload();
    const queue = await openQueue(remote);
    const row = queue.getByRole("listitem").nth(1);

    // The queue at its top: up scrolls it, down would bounce.
    expect(await touchDragStopped(row, 0, -20)).toBe(false);
    expect(await touchDragStopped(row, 0, 20)).toBe(true);
    // Sideways, it's not a scroll.
    expect(await touchDragStopped(row, 20, 5)).toBe(false);
    // Scrolled to the bottom: the other way round.
    await queue.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = queue.getByRole("listitem").last();
    expect(await touchDragStopped(last, 0, -20)).toBe(true);
    expect(await touchDragStopped(last, 0, 20)).toBe(false);
    // The top bar, outside every scroller.
    expect(await touchDragStopped(remote.getByRole("banner"), 0, 20)).toBe(
      true,
    );
  });
});

test("a title search ranks both catalogs' results together, best match first", async ({
  remote,
}) => {
  // Each catalog has the exact match, but not first.
  const dam = [
    ["恋愛サーキュレーション", "花澤香菜"],
    ["初恋", "宇多田ヒカル"],
    ["恋", "星野源"],
  ];
  const joysound = [
    ["恋におちて", "小林明子"],
    ["恋人よ", "五輪真弓"],
    ["恋", "星野源"],
  ];
  await remote.route("**/api/damSearchSongs", (route) =>
    route.fulfill({
      json: {
        items: dam.map(([name, artistName], i) => ({
          id: `e2e-${i}`,
          name,
          nameYomi: "",
          artistName,
          artistNameYomi: "",
        })),
        nextOffset: null,
      },
    }),
  );
  await remote.route("**/api/joysoundSearchSongs", (route) =>
    route.fulfill({
      json: {
        items: joysound.map(([name, artistName], i) => ({
          id: `e2e-joy-${i}`,
          name,
          artistName,
        })),
        nextOffset: null,
      },
    }),
  );

  await remote.getByRole("searchbox", { name: "Search" }).fill("恋");
  const results = remote
    .getByRole("list", { name: "Results" })
    .getByRole("link");
  await expect(results).toHaveCount(6);
  // Both exact matches, side by side, then the shorter of the titles that
  // start with 恋. Each row keeps its catalog's label.
  expect((await results.allTextContents()).slice(0, 3)).toEqual([
    "恋DAM星野源",
    "恋Joysound星野源",
    "恋人よJoysound五輪真弓",
  ]);
});

test.describe("dragging the queue", () => {
  const song = (n: number) => ({
    kind: "nico",
    songId: `sm6100${n}`,
    name: `E2E drag song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-someone", nickname: "someone" },
  });
  // Every phone is an admin, so this one drags without signing in.
  test.use({
    appConfig: { everyoneIsAdmin: true },
    seedQueue: {
      currentSong: null,
      songQueue: [1, 2, 3, 4].map(song),
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  // The queue's song names in the server's live state.
  const liveQueue = async (remoconUrl: string): Promise<string[]> =>
    (await liveState(remoconUrl)).queue.map(
      (item: { name: string }) => item.name,
    );

  // Opens the queue once song 1 has started (within 5 seconds): its queued
  // rows, each with a handle, a song's handle, and a check of the order on
  // the phone, in the live state and on the display.
  async function openQueue(
    remote: Page,
    karafriends: { remoconUrl: string; display: Page },
  ) {
    await showQueue(remote);
    const queue = remote.getByRole("region", { name: "Queue" });
    await expect(
      remote
        .getByRole("region", { name: "Now playing" })
        .getByRole("link", { name: /^E2E drag song 1/ }),
    ).toBeVisible({ timeout: 15_000 });
    const queued = queue
      .getByRole("listitem")
      .filter({ has: remote.getByRole("button", { name: "Drag to reorder" }) });
    const handle = (n: number) =>
      queued
        .filter({ hasText: `E2E drag song ${n}` })
        .getByRole("button", { name: "Drag to reorder" });
    const names = (songs: number[]) => songs.map((n) => `E2E drag song ${n}`);
    const expectOrder = async (...songs: number[]) => {
      const rows = names(songs).map((name) => new RegExp(name));
      await expect(queued).toHaveText(rows);
      await expect
        .poll(() => liveQueue(karafriends.remoconUrl))
        .toEqual(names(songs));
      await expect(
        karafriends.display
          .getByRole("region", { name: "Up next" })
          .getByRole("listitem"),
      ).toHaveText(rows);
    };
    return { queue, queued, handle, expectOrder };
  }

  test("drags a song above the first, and moves one with the arrow keys", async ({
    remote,
    karafriends,
  }) => {
    const { queued, handle, expectOrder } = await openQueue(
      remote,
      karafriends,
    );
    await expectOrder(2, 3, 4);
    // The first waits for what is left of song 1's minute, counting down.
    await expect(queued.first()).toContainText(/\+0:\d\d/);

    // Song 4 held by its handle and dragged above song 2, a few steps at a
    // time.
    const grip = (await handle(4).boundingBox())!;
    const top = (await queued.first().boundingBox())!;
    const x = grip.x + grip.width / 2;
    await remote.mouse.move(x, grip.y + grip.height / 2);
    await remote.mouse.down();
    await remote.mouse.move(x, top.y + 10, { steps: 8 });
    await remote.mouse.up();
    await expectOrder(4, 2, 3);
    await expect(queued.first()).toContainText(/\+0:\d\d/);

    // Arrow Up on song 3's handle, twice: it keeps the focus as it moves.
    await handle(3).focus();
    await remote.keyboard.press("ArrowUp");
    await expectOrder(4, 3, 2);
    await expect(handle(3)).toBeFocused();
    await remote.keyboard.press("ArrowUp");
    await expectOrder(3, 4, 2);

    // A move the server refuses goes back, and says why.
    await remote.route("**/api/moveSong", (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Only an admin can reorder the queue" },
      }),
    );
    await handle(2).focus();
    await remote.keyboard.press("ArrowUp");
    await expect(remote.getByRole("alert")).toHaveText(
      "Couldn't move the song: Only an admin can reorder the queue",
    );
    await expectOrder(3, 4, 2);
  });

  test("a song removed mid-drag leaves the held one held, and the held one removed lets go", async ({
    remote,
    karafriends,
  }) => {
    const { queue, queued, handle, expectOrder } = await openQueue(
      remote,
      karafriends,
    );
    await expectOrder(2, 3, 4);
    // Another phone removes a song.
    const remove = async (n: number) => {
      const { songId, timestamp } = song(n);
      const res = await fetch(
        new URL("api/removeSong", karafriends.remoconUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Karafriends-Device-Id": "e2e-other-phone",
            "X-Karafriends-Nickname": "other",
          },
          body: JSON.stringify({ songId, timestamp }),
        },
      );
      expect(res.status).toBe(200);
    };
    const hold = async (n: number) => {
      const grip = (await handle(n).boundingBox())!;
      const x = grip.x + grip.width / 2;
      await remote.mouse.move(x, grip.y + grip.height / 2);
      await remote.mouse.down();
      await remote.mouse.move(x, grip.y, { steps: 2 });
      return x;
    };

    // Song 4 held, song 3 above it removed, song 4 dropped above song 2:
    // song 4 moves, not whichever song is where it was.
    const x = await hold(4);
    await remove(3);
    await expect(queued).toHaveCount(2);
    const top = (await queued.first().boundingBox())!;
    await remote.mouse.move(x, top.y + 10, { steps: 8 });
    await remote.mouse.up();
    await expectOrder(4, 2);

    // Song 2 held, then removed: the drag ends with nothing left lifted,
    // and song 4 drags again.
    await hold(2);
    await remove(2);
    await expectOrder(4);
    await expect(
      queue.locator("[data-dragging], [data-reordering]"),
    ).toHaveCount(0);
    expect(await queued.evaluate((row) => row.style.transform)).toBe("");
    await remote.mouse.up();
    await hold(4);
    await expect(queue.locator("li[data-dragging]")).toHaveCount(1);
    await remote.mouse.up();
    await expect(queue.locator("[data-dragging]")).toHaveCount(0);
  });

  test.describe("with twelve songs", () => {
    test.use({
      seedQueue: {
        currentSong: null,
        songQueue: Array.from({ length: 12 }, (_, i) => song(i + 1)),
        songHistory: [],
        playbackState: "WAITING",
      },
    });

    test("a row held at the top of the queue scrolls it up", async ({
      remote,
      karafriends,
    }) => {
      const { queue, queued, handle, expectOrder } = await openQueue(
        remote,
        karafriends,
      );
      await expect(queued).toHaveCount(11);
      // Song 12, scrolled into view at the bottom, held and taken to the
      // top edge, where the queue scrolls until song 2 is back in view.
      await handle(12).scrollIntoViewIfNeeded();
      expect(await scrollTop(queue)).toBeGreaterThan(100);
      const grip = (await handle(12).boundingBox())!;
      const region = (await queue.boundingBox())!;
      const x = grip.x + grip.width / 2;
      await remote.mouse.move(x, grip.y + grip.height / 2);
      await remote.mouse.down();
      await remote.mouse.move(x, region.y + 5, { steps: 8 });
      await expect.poll(() => scrollTop(queue)).toBe(0);
      await remote.mouse.up();
      await expectOrder(12, ...Array.from({ length: 10 }, (_, i) => i + 2));
    });
  });
});

// Joysound songs, offline: each looks downloaded before (fakeJoysoundDownload:
// its lyrics, without lines, and a minute of black video), so queueSong
// queues it at once.
test.describe("the lyrics mode", () => {
  // Three songs from one phone.
  test.use({ appConfig: { paxSongQueueLimit: 0 } });

  test("a Joysound song is queued with the lyrics mode picked, preset from the settings", async ({
    karafriends,
    remote,
  }) => {
    const { app, remoconUrl } = karafriends;
    const LABELS = { kana: "Kana", romaji: "Romaji", both: "Both" };
    for (const mode of Object.keys(LABELS)) {
      await fakeJoysoundDownload(app, `e2e-${mode}`);
    }
    await remote.route("**/api/joysoundSong", (route) => {
      const { id } = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id,
          name: `E2E Joysound ${id}`,
          artistName: "E2E artist",
          lyricsPreview: null,
          tieUp: null,
        },
      });
    });
    // "Lyrics" under "TV" in the settings; "Lyrics on the TV" on a
    // song's page.
    const choice = remote.getByRole("radiogroup", { name: /^Lyrics/ });
    const selected = choice.getByRole("radio", { checked: true });

    // The phone's default: kana, until the settings say otherwise.
    await remote.getByRole("link", { name: "Settings" }).click();
    await expect(
      remote
        .getByRole("region", { name: "TV", exact: true })
        .getByRole("radiogroup", { name: "Lyrics", exact: true }),
    ).toBeVisible();
    await expect(choice.getByRole("radio")).toHaveText(Object.values(LABELS));
    await expect(selected).toHaveText("Kana");
    await choice.getByRole("radio", { name: "Romaji" }).click();
    await expect(selected).toHaveText("Romaji");
    expect(
      await remote.evaluate(() => localStorage.getItem("lyricsMode")),
    ).toBe("romaji");

    for (const mode of ["romaji", "kana", "both"] as const) {
      await remote.goto(new URL(`#/joysoundSong/e2e-${mode}`, remoconUrl).href);
      await expect(
        remote.getByRole("heading", { name: `E2E Joysound e2e-${mode}` }),
      ).toBeVisible();
      // Each song page starts at the settings' choice.
      await expect(
        remote.getByRole("radiogroup", { name: "Lyrics on the TV" }),
      ).toBeVisible();
      await expect(selected).toHaveText("Romaji");
      await choice.getByRole("radio", { name: LABELS[mode] }).click();
      await expect(selected).toHaveText(LABELS[mode]);
      await Promise.all([
        remote.waitForResponse("**/api/queueSong"),
        remote.getByRole("button", { name: "Queue song", exact: true }).click(),
      ]);
    }

    // The first is playing by now and the others wait, each with its mode.
    await expect
      .poll(async () => {
        const { currentSong, queue } = await liveState(remoconUrl);
        return Object.fromEntries(
          [currentSong, ...queue]
            .filter((item) => item?.kind === "joysound")
            .map((item) => [item.songId, item.lyricsMode]),
        );
      })
      .toEqual({
        "e2e-romaji": "romaji",
        "e2e-kana": "kana",
        "e2e-both": "both",
      });
    // The open sheet shows each one's mode by its source: the one playing
    // on the bar (its link), the others on their rows in the queue.
    await showQueue(remote);
    const songs = remote
      .getByRole("region", { name: "Now playing" })
      .locator("a, li");
    for (const [mode, label] of Object.entries(LABELS)) {
      await expect(songs.filter({ hasText: `e2e-${mode}` })).toContainText(
        `Joysound · ${label}`,
      );
    }
  });
});

test.describe("the guide melody slider", () => {
  const PASSWORD = "e2e guide melody";
  test.use({ appConfig: adminPasswordConfig(PASSWORD) });

  test("is in the settings' Admin group for an admin only, always enabled", async ({
    karafriends,
    remote,
  }) => {
    const { remoconUrl } = karafriends;
    const slider = remote.getByRole("slider", { name: "Guide melody" });
    // Not in the playback controls any more.
    await showQueue(remote);
    await expect(remote.getByText("Nothing playing")).toBeVisible();
    await expect(
      remote.getByRole("button", { name: "Raise key" }),
    ).toBeVisible();
    await expect(slider).toHaveCount(0);

    // A guest's settings: the sign-in, no slider.
    await remote.getByRole("link", { name: "Settings" }).click();
    await expect(remote.getByLabel("Admin password")).toBeVisible();
    await expect(slider).toHaveCount(0);

    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("Signed in as admin")).toBeVisible();
    await expect(
      remote.getByRole("region", { name: "Admin" }).getByRole("slider", {
        name: "Guide melody",
      }),
    ).toBeVisible();

    // With nothing playing, as with anything else.
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveValue("0");
    expect((await slider.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await slider.fill("0.7");
    await expect
      .poll(async () => (await liveState(remoconUrl)).guideMelodyLevel)
      .toBe(0.7);
    await expect(slider).toHaveValue("0.7");
    // Its label shows the level in percent.
    await expect(remote.getByText("Guide melody 70%")).toBeVisible();

    // Dragged down across several steps, it sends the level once, when
    // let go.
    const sent: unknown[] = [];
    remote.on("request", (request) => {
      if (request.url().endsWith("/api/setGuideMelodyLevel")) {
        sent.push(request.postDataJSON());
      }
    });
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await remote.mouse.move(box.x + box.width * 0.7, y);
    await remote.mouse.down();
    await remote.mouse.move(box.x + box.width * 0.3, y, { steps: 10 });
    await expect(slider).not.toHaveValue("0.7");
    expect(sent).toEqual([]);
    await remote.mouse.up();
    const level = Number(await slider.inputValue());
    expect(level).toBeLessThan(0.6);
    await expect.poll(() => sent).toEqual([{ level }]);
    await expect
      .poll(async () => (await liveState(remoconUrl)).guideMelodyLevel)
      .toBe(level);
    await expect(slider).toHaveValue(String(level));

    // Signed out, it goes.
    await remote.getByRole("button", { name: "Sign out" }).click();
    await expect(remote.getByLabel("Admin password")).toBeVisible();
    await expect(slider).toHaveCount(0);
  });
});

test.describe("the song volume and mic sliders", () => {
  const PASSWORD = "e2e mic sliders";
  test.use({ appConfig: adminPasswordConfig(PASSWORD) });

  async function signIn(remote: Page) {
    await remote.getByRole("link", { name: "Settings" }).click();
    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("Signed in as admin")).toBeVisible();
  }

  test("the host setting the admin password again signs the phone out at once", async ({
    display,
    remote,
  }) => {
    await signIn(remote);
    await expect(
      remote.getByRole("slider", { name: "Song volume" }),
    ).toBeVisible();
    // The same password: it still ends every session.
    expect(
      await displayCall(display, "setAdminPassword", { password: PASSWORD }),
    ).toMatchObject({ ok: true });
    await expect(remote.getByLabel("Admin password")).toBeVisible();
    await expect(
      remote.getByRole("slider", { name: "Song volume" }),
    ).toHaveCount(0);
    expect(
      await remote.evaluate(() => localStorage.getItem("adminToken")),
    ).toBeNull();
  });

  test("the song volume is above the guide melody and sends setSongVolume", async ({
    karafriends,
    remote,
  }) => {
    const sent: unknown[] = [];
    remote.on("request", (request) => {
      if (request.url().endsWith("/api/setSongVolume")) {
        sent.push(request.postDataJSON());
      }
    });
    await signIn(remote);

    const volume = remote.getByRole("slider", { name: "Song volume" });
    const guide = remote.getByRole("slider", { name: "Guide melody" });
    await expect(volume).toHaveValue("100");
    expect((await volume.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await volume.boundingBox())!.y).toBeLessThan(
      (await guide.boundingBox())!.y,
    );
    // The display has no mics open.
    await expect(remote.getByText("No microphones")).toBeVisible();

    await volume.fill("40");
    await expect.poll(() => sent).toEqual([{ volume: 40 }]);
    await expect
      .poll(async () => (await liveState(karafriends.remoconUrl)).songVolume)
      .toBe(40);
    await expect(volume).toHaveValue("40");
    await expect(remote.getByText("Song volume 40%")).toBeVisible();
  });

  test("a slider dragged back to where it started follows the live level again", async ({
    display,
    remote,
  }) => {
    const setSongVolume = (volume: number) =>
      displayCall(display, "setSongVolume", { volume });
    const sent: unknown[] = [];
    remote.on("request", (request) => {
      if (request.url().endsWith("/api/setSongVolume")) {
        sent.push(request.postDataJSON());
      }
    });
    await signIn(remote);
    const volume = remote.getByRole("slider", { name: "Song volume" });
    await setSongVolume(50);
    await expect(volume).toHaveValue("50");

    // From the thumb, in the middle, out and back: no change, nothing sent.
    const box = (await volume.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await remote.mouse.move(x, y);
    await remote.mouse.down();
    await remote.mouse.move(box.x + box.width * 0.8, y, { steps: 5 });
    await expect(volume).not.toHaveValue("50");
    await remote.mouse.move(x, y, { steps: 5 });
    await remote.mouse.up();
    await expect(volume).toHaveValue("50");
    expect(sent).toEqual([]);

    // The display changes it: the thumb follows.
    await setSongVolume(30);
    await expect(volume).toHaveValue("30");
    expect(sent).toEqual([]);
  });

  test("the display's mics show with their gain and echo, which send setMicLevels", async ({
    karafriends,
    display,
    remote,
  }) => {
    const mics = [
      {
        id: "Yeti Stereo Microphone (USB)#1",
        label: "Yeti Stereo Microphone (USB), channel 1",
        gain: 100,
        echo: 40,
        gate: -60,
      },
      {
        id: "Focusrite USB (USB)#2",
        label: "Focusrite USB (USB), channel 2",
        gain: 123,
        echo: 0,
        gate: -45,
      },
    ];
    // As it starts, the display sends its own mics (none). Wait for it to be
    // up, or its list could replace this one.
    await expect(
      display.getByRole("img", { name: "QR code for the remote" }),
    ).toBeVisible();
    expect(await displayCall(display, "setMics", { mics })).toMatchObject({
      ok: true,
    });
    const sent: unknown[] = [];
    remote.on("request", (request) => {
      if (request.url().endsWith("/api/setMicLevels")) {
        sent.push(request.postDataJSON());
      }
    });
    await signIn(remote);

    await expect(remote.getByText("No microphones")).toHaveCount(0);
    // Each slider is named for its mic, so two mics' sliders aren't alike.
    const slider = (
      mic: (typeof mics)[number],
      level: "Gain" | "Echo" | "Noise gate",
    ) =>
      remote.getByRole("slider", {
        name: `${mic.label}: ${level}`,
        exact: true,
      });
    await expect(slider(mics[0], "Gain")).toHaveValue("100");
    await expect(slider(mics[0], "Echo")).toHaveValue("40");
    await expect(slider(mics[1], "Gain")).toHaveValue("123");
    await expect(slider(mics[1], "Echo")).toHaveValue("0");
    // The labels show the levels, as the display's do.
    await expect(remote.getByText("Gain 123%")).toBeVisible();
    await expect(remote.getByText("Echo 40%")).toBeVisible();
    // The noise gate in dB, Off at its floor.
    await expect(slider(mics[0], "Noise gate")).toHaveValue("-60");
    await expect(slider(mics[1], "Noise gate")).toHaveValue("-45");
    await expect(remote.getByText("Noise gate Off")).toBeVisible();
    await expect(remote.getByText("Noise gate \u221245 dB")).toBeVisible();
    await expect(
      remote.getByText("Mutes the mic below this level"),
    ).toBeVisible();

    await slider(mics[1], "Echo").fill("63");
    await expect.poll(() => sent).toEqual([{ id: mics[1].id, echo: 63 }]);
    await slider(mics[0], "Noise gate").fill("-50");
    await expect
      .poll(() => sent)
      .toEqual([
        { id: mics[1].id, echo: 63 },
        { id: mics[0].id, gate: -50 },
      ]);
    await expect(slider(mics[1], "Echo")).toHaveValue("63");
    // The display applies it to the mic and lists its mics again (these
    // aren't open there, so do its part: settings.spec has the real one).
    const applied = [
      { ...mics[0], gate: -50 },
      { ...mics[1], echo: 63 },
    ];
    await displayCall(display, "setMics", { mics: applied });
    await expect
      .poll(async () => (await liveState(karafriends.remoconUrl)).mics)
      .toEqual(applied);
    await expect(slider(mics[1], "Echo")).toHaveValue("63");
  });
});

// Picks a Readings choice in the settings and goes back. Back is
// history.back(), which lands later: a goto() before it would be undone.
async function pickReadings(remote: Page, choice: string) {
  await remote.getByRole("link", { name: "Settings" }).click();
  await remote
    .getByRole("radiogroup", { name: "Readings" })
    .getByRole("radio", { name: choice, exact: true })
    .click();
  await remote.getByRole("button", { name: "Back" }).click();
  await expect(remote).not.toHaveURL(/#\/settings$/);
}

test("the Readings setting puts DAM's readings in place of the search rows' text", async ({
  remote,
}) => {
  // As the real DAM answers: readings in hiragana. Joysound gives none.
  await remote.route("**/api/damSearchSongs", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "5860-12",
            name: "恋",
            nameYomi: "こい",
            artistName: "星野 源",
            artistNameYomi: "ほしのげん",
          },
        ],
        nextOffset: null,
      },
    }),
  );
  await remote.route("**/api/joysoundSearchSongs", (route) =>
    route.fulfill({
      json: {
        items: [{ id: "e2e-joy-koi", name: "恋", artistName: "星野源" }],
        nextOffset: null,
      },
    }),
  );

  await remote.getByRole("searchbox", { name: "Search" }).fill("恋");
  const results = remote
    .getByRole("list", { name: "Results" })
    .getByRole("link");
  const joysound = "恋Joysound星野源";
  await expect(results).toHaveText(["恋DAM星野 源", joysound]);
  // The choices: no "Both" any more.
  await remote.getByRole("link", { name: "Settings" }).click();
  await expect(
    remote.getByRole("radiogroup", { name: "Readings" }).getByRole("radio"),
  ).toHaveText(["Written", "Kana", "Romaji"]);
  await remote.getByRole("button", { name: "Back" }).click();
  for (const [choice, dam] of [
    ["Kana", "こいDAMほしのげん"],
    ["Romaji", "koiDAMhoshinogen"],
    ["Written", "恋DAM星野 源"],
  ]) {
    await pickReadings(remote, choice);
    await expect(results).toHaveText([dam, joysound]);
  }
  expect(await remote.evaluate(() => localStorage.getItem("readings"))).toBe(
    "written",
  );

  // An artist search too.
  await remote.route("**/api/damSearchArtists", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "e2e-gen",
            name: "星野 源",
            nameYomi: "ほしのげん",
            songCount: 9,
          },
        ],
        nextOffset: null,
      },
    }),
  );
  await remote.route("**/api/joysoundSearchArtists", (route) =>
    route.fulfill({ json: { items: [], nextOffset: null } }),
  );
  await pickReadings(remote, "Romaji");
  await remote.getByRole("radio", { name: "Artist" }).click();
  await expect(results).toHaveText(["hoshinogenDAM9 songs"]);
  // And the artist's page: the artist and the songs.
  await remote.route("**/api/damArtist", (route) =>
    route.fulfill({
      json: {
        id: "e2e-gen",
        name: "星野 源",
        nameYomi: "ほしのげん",
        songCount: 1,
        songs: {
          items: [
            {
              id: "5860-12",
              name: "恋",
              nameYomi: "こい",
              artistName: "星野 源",
              artistNameYomi: "ほしのげん",
            },
          ],
          nextOffset: null,
        },
      },
    }),
  );
  await results.first().click();
  await expect(remote.getByRole("heading", { level: 2 })).toHaveText(
    "hoshinogen",
  );
  await expect(results).toHaveText(["koiDAM"]);
  // And a song's page, with the artist's reading from the row: DAM's song
  // details give none.
  await remote.route("**/api/damSong", (route) =>
    route.fulfill({
      json: {
        id: "5860-12",
        name: "恋",
        nameYomi: "コイ",
        artistName: "星野 源",
        artistNameYomi: "",
        lyricsPreview: null,
        vocalTypes: ["NORMAL"],
        tieUp: null,
        playtime: 252,
      },
    }),
  );
  await results.first().click();
  await expect(
    remote.getByRole("main").getByRole("link", { name: "hoshinogen" }),
  ).toBeVisible();
});

test("an older phone's saved Both reads as written", async ({ remote }) => {
  await remote.evaluate(() => localStorage.setItem("readings", "both"));
  await remote.reload();
  await remote.getByRole("link", { name: "Settings" }).click();
  await expect(
    remote
      .getByRole("radiogroup", { name: "Readings" })
      .getByRole("radio", { name: "Written" }),
  ).toBeChecked();
});

test("a title or artist that doesn't fit slides, and one that fits stays still", async ({
  karafriends,
  remote,
}) => {
  await remote.emulateMedia({ reducedMotion: "no-preference" });
  const LONG_ARTIST = "E2E artist with a name far too long for the phone";
  const LONG_TITLE =
    "残酷な天使のテーゼ (TVアニメ『新世紀エヴァンゲリオン』オープニングテーマ)";
  const song = (id: string, name: string) => ({
    id,
    name,
    nameYomi: "",
    artistName: LONG_ARTIST,
    artistNameYomi: "",
  });
  await remote.route("**/api/damArtist", (route) =>
    route.fulfill({
      json: {
        id: "e2e-long",
        name: LONG_ARTIST,
        nameYomi: "",
        songCount: 2,
        songs: {
          items: [song("e2e-long-1", LONG_TITLE), song("e2e-long-2", "Lemon")],
          nextOffset: null,
        },
      },
    }),
  );
  await remote.goto(new URL("#/artist/e2e-long", karafriends.remoconUrl).href);

  // A Marquee's text (what getByText finds): whether its box slides, and
  // how.
  const marquee = (text: Locator) =>
    text.evaluate((el) => {
      const box = el.parentElement!;
      const style = getComputedStyle(el);
      return {
        sliding: box.hasAttribute("data-marquee"),
        moving: style.animationName !== "none",
        shift: parseFloat(box.style.getPropertyValue("--kf-marquee-shift")),
        seconds: parseFloat(style.animationDuration),
        iterations: style.animationIterationCount,
        direction: style.animationDirection,
        ellipsis:
          style.textOverflow === "ellipsis" && style.overflow === "hidden",
      };
    });
  const sliding = (text: Locator) =>
    expect.poll(async () => (await marquee(text)).sliding);

  // The artist's name over the page, and the long title in its row, slide:
  // 32px a second, with 2 s still at each end.
  const heading = remote
    .getByRole("heading", { level: 2 })
    .getByText(LONG_ARTIST);
  const rows = remote.getByRole("list", { name: "Results" });
  const title = rows.getByText(LONG_TITLE);
  const lemon = rows.getByText("Lemon", { exact: true });
  for (const text of [heading, title]) {
    await sliding(text).toBe(true);
    const slide = await marquee(text);
    expect(slide).toMatchObject({
      moving: true,
      iterations: "infinite",
      direction: "alternate",
      ellipsis: false,
    });
    const speed = slide.shift / (slide.seconds - 2);
    expect(speed).toBeGreaterThan(30);
    expect(speed).toBeLessThan(34);
  }
  // A short title stays still.
  expect(await marquee(lemon)).toMatchObject({
    sliding: false,
    moving: false,
  });

  // Its size: on a wide screen the long title fits and stops, and on a
  // narrow one it slides again.
  await remote.setViewportSize({ width: 1600, height: 900 });
  await sliding(title).toBe(false);
  expect((await marquee(title)).moving).toBe(false);
  await remote.setViewportSize({ width: 360, height: 780 });
  await sliding(title).toBe(true);

  // Its text: a longer one in place of "Lemon" (as a reading puts in place
  // of a title) slides too, without the row being drawn again.
  await lemon.evaluate((el) => {
    el.firstChild!.textContent = "Lemon, a title made much longer in place";
  });
  await sliding(rows.getByText("Lemon, a title made")).toBe(true);

  // Asked for less motion, nothing moves, and the long title ends in an
  // ellipsis.
  await remote.emulateMedia({ reducedMotion: "reduce" });
  expect(await marquee(title)).toMatchObject({
    moving: false,
    ellipsis: true,
  });
});

test.describe("a DAM song's page", () => {
  test("shows the reading as its title, and the title as written under it", async ({
    karafriends,
    remote,
  }) => {
    await remote.route("**/api/damSong", (route) =>
      route.fulfill({
        json: {
          id: "5860-12",
          name: "恋",
          nameYomi: "コイ",
          artistName: "星野 源",
          artistNameYomi: "",
          lyricsPreview: null,
          vocalTypes: ["NORMAL"],
          tieUp: null,
          playtime: 252,
        },
      }),
    );
    const about = remote.getByRole("main");
    for (const [choice, title, subtitle] of [
      // As written, the title over its kana, as before.
      ["Written", "恋", "こい"],
      ["Kana", "こい", "恋"],
      ["Romaji", "koi", "恋"],
    ]) {
      await pickReadings(remote, choice);
      await remote.goto(new URL("#/song/5860-12", karafriends.remoconUrl).href);
      const heading = about.getByRole("heading", { level: 2 });
      await expect(heading).toHaveText(title);
      // The subtitle comes right under the title.
      const below = heading.locator("xpath=following-sibling::p[1]");
      await expect(below).toHaveText(subtitle);
      await remote.goto(new URL("#/", karafriends.remoconUrl).href);
    }
  });
});

test.describe("a queued DAM song", () => {
  // A song that plays for a minute first, so the DAM song (which has no
  // stream here) waits in the queue.
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        {
          kind: "nico",
          songId: "sm60001",
          name: "E2E playing song",
          artistName: "E2E artist",
          playtime: 60,
          timestamp: String(Date.UTC(2026, 0, 1)),
          user: { deviceId: "e2e-someone", nickname: "someone" },
        },
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("goes with the phone's readings, and shows in the queue each phone's way", async ({
    karafriends,
    remote,
  }) => {
    // DAM's song details give the reading in katakana, and no artist
    // reading.
    await remote.route("**/api/damSong", (route) =>
      route.fulfill({
        json: {
          id: "5860-12",
          name: "恋",
          nameYomi: "コイ",
          artistName: "星野 源",
          artistNameYomi: "",
          lyricsPreview: null,
          vocalTypes: ["NORMAL"],
          tieUp: null,
          playtime: 252,
        },
      }),
    );
    await pickReadings(remote, "Romaji");
    await remote.goto(new URL("#/song/5860-12", karafriends.remoconUrl).href);
    const queued = remote.waitForResponse((res) =>
      res.url().endsWith("/api/queueSong"),
    );
    await remote
      .getByRole("button", { name: "Queue song", exact: true })
      .click();
    const response = await queued;
    expect(await response.json()).toMatchObject({ ok: true });
    // The phone's choice goes with the song, for the TV.
    expect(response.request().postDataJSON()).toMatchObject({
      songId: "5860-12",
      readingsMode: "romaji",
    });

    await showQueue(remote);
    const row = remote
      .getByRole("region", { name: "Queue" })
      .getByRole("listitem")
      .filter({ hasText: "星野 源" });
    // DAM's song details give no artist reading: the artist as written.
    await expect(row).toContainText("koiDAM星野 源");
    await expect(row).not.toContainText("恋");
    // Its accessible name starts with the title as shown.
    await expect(row.getByRole("button", { name: /^koi, / })).toBeVisible();
    // This phone's choice, not the one the song was queued with.
    await pickReadings(remote, "Kana");
    await expect(row).toContainText("こいDAM星野 源");
    await pickReadings(remote, "Written");
    await expect(row).toContainText("恋DAM星野 源");
  });
});
