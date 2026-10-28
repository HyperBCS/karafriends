import fs from "fs";
import path from "path";

import type {
  ElectronApplication,
  Locator,
  Page,
  Route,
} from "@playwright/test";

import {
  adminPasswordConfig,
  displayCall,
  expect,
  NICKNAME,
  test,
} from "./fixtures";

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
  const source = remote.getByRole("button", { name: "Source: All" });
  await expect(source).toHaveAttribute("aria-haspopup", "menu");
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
  await remote.getByRole("button", { name: /^Source:/ }).click();
  await remote
    .getByRole("menu", { name: "Source" })
    .getByRole("menuitemradio", { name: source, exact: true })
    .click();
}

test("the search's source is picked from a menu, and the button names it", async ({
  remote,
}) => {
  const searched: string[] = [];
  for (const catalog of ["dam", "joysound"]) {
    await remote.route(`**/api/${catalog}SearchSongs`, (route) => {
      searched.push(catalog);
      return route.fulfill({ json: { items: [], nextOffset: null } });
    });
  }
  const button = remote.getByRole("button", { name: /^Source:/ });
  const menu = remote.getByRole("menu", { name: "Source" });
  const items = menu.getByRole("menuitemradio");
  // On All, the button shows only its icon.
  await expect(button).toHaveAccessibleName("Source: All");
  await expect(button).toHaveText("");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);

  // Open: the three sources, the picked one ticked and focused.
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(items).toHaveText(["All", "DAM", "Joysound"]);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(
    "All",
  );
  await expect(items.first().locator("svg")).toHaveCount(1);
  await expect(items.nth(1).locator("svg")).toHaveCount(0);
  await expect(items.first()).toBeFocused();

  // A pick closes it, puts the focus back on the button, and the button
  // names the source.
  await items.nth(1).click();
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toHaveAccessibleName("Source: DAM");
  await expect(button).toHaveText("DAM");
  await expect(remote).toHaveURL(/[?&]source=dam(&|$)/);
  await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");
  await expect(remote.getByText("No results found")).toBeVisible();
  expect(searched).toEqual(["dam"]);

  // From the keyboard: the arrow keys go round the menu, and Escape closes
  // it as it was.
  await button.focus();
  await remote.keyboard.press("Enter");
  await expect(items.nth(1)).toBeFocused();
  await remote.keyboard.press("ArrowDown");
  await expect(items.nth(2)).toBeFocused();
  await remote.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await remote.keyboard.press("ArrowUp");
  await expect(items.nth(2)).toBeFocused();
  await remote.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("Source: DAM");

  // Enter picks.
  await remote.keyboard.press("Enter");
  await remote.keyboard.press("End");
  await expect(items.nth(2)).toBeFocused();
  await remote.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveText("Joysound");

  // A tap anywhere else closes it, changing nothing.
  await button.click();
  await expect(menu).toBeVisible();
  await remote.getByRole("heading", { name: "Find a song" }).click();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAccessibleName("Source: Joysound");

  // Back on All, the icon alone again.
  await pickSource(remote, "All");
  await expect(button).toHaveText("");
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

  // A bare ID could be half typed ("sm1" of "sm12345"): the pause in typing
  // searches for it, and Enter or leaving the field opens it.
  for (const method of ["damSearchSongs", "joysoundSearchSongs"]) {
    await remote.route(`**/api/${method}`, (route) =>
      route.fulfill({ json: { items: [], nextOffset: null } }),
    );
  }
  await remote.getByRole("button", { name: "Back" }).click();
  await search.fill("sm9");
  await expect(remote).toHaveURL(/q=sm9/);
  await search.press("Enter");
  await expect(remote).toHaveURL(/#\/search\/niconico\/sm9$/);
  await expect(remote.getByRole("heading", { name: "Niconico" })).toBeVisible();

  await remote.getByRole("button", { name: "Back" }).click();
  await search.fill("jNQXAC9IVRw");
  await expect(remote).toHaveURL(/q=jNQXAC9IVRw/);
  await search.blur();
  await expect(remote).toHaveURL(/#\/search\/youtube\/jNQXAC9IVRw$/);
});

test("the sheet's toolbar: the switch, the transport and the key, in that order", async ({
  karafriends,
  remote,
}) => {
  await remote.setViewportSize({ width: 412, height: 800 });
  await remote.getByRole("button", { name: "Show queue" }).click();
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
    "Lower the key",
    "Raise the key",
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

  // The key shows its sign (below zero, a minus sign, U+2212).
  await expect(key).toHaveText("0");
  for (const [semis, shown] of [
    [2, "+2"],
    [-1, "−1"],
    [0, "0"],
  ] as const) {
    const res = await fetch(
      new URL("api/setPitchShiftSemis", karafriends.remoconUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semis }),
      },
    );
    expect(res.status).toBe(200);
    await expect(key).toHaveText(shown);
  }

  // Showing the emotes, the switch stays where it is, and the emotes and
  // the button to change them take the rest of the row.
  await remote.setViewportSize({ width: 360, height: 700 });
  const before = await box(mode);
  await mode.click();
  const back = button("Show playback controls");
  expect(await box(back)).toEqual(before);
  const fire = await box(remote.getByRole("button", { name: "🔥" }));
  const edit = await box(button("Change emotes"));
  expect(fire.x).toBeGreaterThanOrEqual(before.x + before.width);
  expect(edit.x).toBeGreaterThan(fire.x + fire.width);
  expect(edit.x + edit.width).toBeLessThanOrEqual(360);
  await back.click();
  await expect(play).toBeVisible();
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
  const tap = async (el: Locator) => {
    const box = (await el.boundingBox())!;
    await el.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

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
    // on the right, the nickname whole as far as the bar allows, cut after
    // the title is.
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
    // Too long for the bar, the title slides.
    await expect(titleLine).toHaveAttribute("data-marquee");
    await expect(nickname).toHaveCSS("text-overflow", "ellipsis");
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
    // Each reachable by keyboard: the link, then the toggle.
    await link.focus();
    await remote.keyboard.press("Tab");
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
  await remote
    .getByRole("button", { name: "Play a YouTube video behind the lyrics" })
    .click();
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
    remote.getByRole("button", { name: "Remove the video" }),
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

  // Change the key about 6 times a second, as download progress would.
  let changing = true;
  let changed = 0;
  const changes = (async () => {
    for (let semis = 1; changing; semis = (semis % 4) + 1) {
      const res = await fetch(
        new URL("api/setPitchShiftSemis", karafriends.remoconUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ semis }),
        },
      );
      expect(res.status).toBe(200);
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
      name: "Not queued: That song is already in the queue",
    }),
  ).toBeDisabled();
  await expect(
    remote.getByRole("button", { name: "Queue video" }),
  ).toBeEnabled();
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

  test("moves songs, which a guest can't", async ({ remote }) => {
    await remote.getByRole("button", { name: "Show queue" }).click();
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
    await expect(remote.getByText("You're an admin")).toBeVisible();

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

  // queue.json in the format older versions wrote (GraphQL-shaped items with
  // __typename and userIdentity), with a history of 35 songs, newest first.
  // The app still reads it (parseState in src/main/state.ts), so this also
  // checks that an old queue.json survives an upgrade.
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
            __typename: "YoutubeQueueItem",
            songId: `e2e-history-${n}`,
            name: songName(n),
            artistName: "E2E artist",
            playtime: 60,
            timestamp: String(Date.UTC(2026, 0, 1) + n * 60_000),
            userIdentity: { deviceId: "e2e-device", nickname: NICKNAME },
            hasAdhocLyrics: false,
            hasCaptions: false,
            gainValue: 1,
          },
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
    await remote.getByRole("button", { name: "Show queue" }).click();
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

  test("stops touch drags that would bounce the page", async ({ remote }) => {
    // (Playwright's WebKit has no Touch constructor.)
    const canTouch = await remote.evaluate(() => {
      try {
        return !!new Touch({ identifier: 1, target: document.body });
      } catch {
        return false;
      }
    });
    test.skip(!canTouch, "No Touch constructor");
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
    await remote.getByRole("button", { name: "Show queue" }).click();
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

// Joysound songs, offline: each looks downloaded before (its lyrics and
// video in the app's temp folder), so queueSong queues it at once. The
// lyrics file is just enough for its playtime (getSongDuration), so the
// display plays a minute of black video without lyrics.
async function fakeJoysoundDownload(app: ElectronApplication, songId: string) {
  const temp = await app.evaluate(({ app }) => app.getPath("temp"));
  const dir = path.join(temp, "karafriends_tmp");
  fs.mkdirSync(dir, { recursive: true });
  const telop = Buffer.alloc(32);
  telop.writeUInt32LE(10, 6); // where the metadata starts
  telop.writeUInt16LE(60, 10 + 18); // the playtime, in seconds
  fs.writeFileSync(path.join(dir, `joysound-${songId}.joy_02`), telop);
  fs.copyFileSync(
    path.join(__dirname, "..", "fixtures", "black.mp4"),
    path.join(dir, `joysound-${songId}-default.mp4`),
  );
}

// The server's live state: the first event of a fresh /api/events stream.
async function liveState(remoconUrl: string) {
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
    // "Lyrics" under "On the TV" in the settings; "Lyrics on the TV" on a
    // song's page.
    const choice = remote.getByRole("radiogroup", { name: /^Lyrics/ });
    const selected = choice.getByRole("radio", { checked: true });

    // The phone's default: kana, until the settings say otherwise.
    await remote.getByRole("link", { name: "Settings" }).click();
    await expect(
      remote
        .getByRole("region", { name: "On the TV" })
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
            .filter(Boolean)
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
    await remote.getByRole("button", { name: "Show queue" }).click();
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
    await remote.getByRole("button", { name: "Show queue" }).click();
    await expect(remote.getByText("Nothing playing")).toBeVisible();
    await expect(
      remote.getByRole("button", { name: "Raise the key" }),
    ).toBeVisible();
    await expect(slider).toHaveCount(0);

    // A guest's settings: the sign-in, no slider.
    await remote.getByRole("link", { name: "Settings" }).click();
    await expect(remote.getByLabel("Admin password")).toBeVisible();
    await expect(slider).toHaveCount(0);

    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("You're an admin")).toBeVisible();
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
    await expect(remote.getByText("You're an admin")).toBeVisible();
  }

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
      },
      {
        id: "Focusrite USB (USB)#2",
        label: "Focusrite USB (USB), channel 2",
        gain: 123,
        echo: 0,
      },
    ];
    // As it starts, the display sends its own mics (none), then opens
    // Settings on a first launch. Wait for that, or its list could replace
    // this one.
    await expect(
      display.getByRole("dialog", { name: "Settings" }),
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
    const slider = (mic: (typeof mics)[number], level: "Gain" | "Echo") =>
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

    await slider(mics[1], "Echo").fill("63");
    await expect.poll(() => sent).toEqual([{ id: mics[1].id, echo: 63 }]);
    await expect
      .poll(async () => (await liveState(karafriends.remoconUrl)).mics)
      .toEqual([mics[0], { ...mics[1], echo: 63 }]);
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

    await remote.getByRole("button", { name: "Show queue" }).click();
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
