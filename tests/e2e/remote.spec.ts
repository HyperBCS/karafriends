import fs from "fs";
import path from "path";

import type {
  ElectronApplication,
  Locator,
  Page,
  Route,
} from "@playwright/test";

import { adminPasswordConfig, expect, NICKNAME, test } from "./fixtures";

test("the remote opens on the search screen", async ({ remote }) => {
  await expect(
    remote.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  await expect(remote.getByRole("searchbox", { name: "Search" })).toBeVisible();
  for (const [group, tabs] of [
    ["Search by", ["Title", "Artist"]],
    ["Source", ["All", "DAM", "Joysound"]],
  ] as const) {
    await expect(
      remote.getByRole("tablist", { name: group }).getByRole("tab"),
    ).toHaveText([...tabs]);
  }
  await expect(remote.getByRole("link", { name: "Profile" })).toBeVisible();
  await expect(remote.getByRole("link", { name: "History" })).toBeVisible();
});

test("a new phone picks a nickname before anything else", async ({
  karafriends,
  page,
}) => {
  await page.goto(new URL("#/history", karafriends.remoconUrl).href);
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  const nickname = page.getByLabel("Nickname");
  await expect(nickname).toBeFocused();
  // Nothing else until it has one: no profile button, no sheet.
  await expect(page.getByRole("link", { name: "Profile" })).toHaveCount(0);
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

  // It can change it later, on the profile screen.
  await page.getByRole("link", { name: "Profile" }).click();
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
  await remote.getByRole("link", { name: "Profile" }).click();
  await remote.getByRole("tab", { name: "日本語" }).click();
  await expect(
    remote.getByRole("heading", { name: "プロフィール" }),
  ).toBeVisible();
  await remote.getByRole("button", { name: "戻る" }).click();
  await expect(remote.getByRole("heading", { name: "曲を探す" })).toBeVisible();
  await expect(remote.locator("html")).toHaveAttribute("lang", "ja");
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

    await remote.getByRole("tab", { name: "DAM" }).click();
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
  await remote.getByRole("tab", { name: "DAM" }).click();
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
  // Not on the search screen itself.
  await expect(remote.getByRole("link", { name: "Home" })).toHaveCount(0);
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

  await remote.getByRole("tab", { name: "Artist" }).click();
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

test("the playback controls fit on a narrow phone", async ({ remote }) => {
  await remote.getByRole("button", { name: "Show queue" }).click();
  const sheetBody = await remote
    .getByRole("button", { name: "Hide queue" })
    .getAttribute("aria-controls");
  const first = remote.getByRole("button", { name: "Show emotes" });
  const last = remote.getByRole("button", { name: "Raise the key" });
  for (const width of [360, 320]) {
    await remote.setViewportSize({ width, height: 700 });
    // One row, inside the screen, and nothing to scroll sideways.
    const [a, b] = [await first.boundingBox(), await last.boundingBox()];
    expect(a!.x, `${width}px`).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width, `${width}px`).toBeLessThanOrEqual(width);
    expect(Math.abs(a!.y - b!.y), `${width}px`).toBeLessThan(1);
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

  await remote.getByRole("tab", { name: "Joysound" }).click();
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
  await remote.getByRole("link", { name: "Profile" }).click();
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
    // Song 1 starts within 5 seconds and is the accented first row.
    await expect(queue.locator('[aria-current="true"]')).toContainText(
      "E2E queue song 1",
      { timeout: 15_000 },
    );
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

    await remote.getByRole("link", { name: "Profile" }).click();
    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("You're an admin")).toBeVisible();

    // (The row stays open.)
    await queue.getByRole("button", { name: "Move to top" }).click();
    await expect
      .poll(() => rows(remote))
      .toEqual([
        expect.stringContaining("song 1"),
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

  test("scrolls in the sheet without moving the screen or the top bar", async ({
    remote,
  }) => {
    await remote.getByRole("button", { name: "Show queue" }).click();
    const queue = remote.getByRole("region", { name: "Queue" });
    await expect(queue.getByRole("listitem")).toHaveCount(12);

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

  // The queue's song names in the server's live state: the first event of
  // a fresh /api/events stream.
  async function liveQueue(remoconUrl: string): Promise<string[]> {
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
        if (data) {
          const { state } = JSON.parse(data[1]);
          return state.queue.map((item: { name: string }) => item.name);
        }
      }
    } finally {
      controller.abort();
    }
  }

  // Opens the queue once song 1 has started (within 5 seconds): its queued
  // rows, each with a handle, a song's handle, and a check of the order on
  // the phone, in the live state and on the display.
  async function openQueue(
    remote: Page,
    karafriends: { remoconUrl: string; display: Page },
  ) {
    await remote.getByRole("button", { name: "Show queue" }).click();
    const queue = remote.getByRole("region", { name: "Queue" });
    await expect(queue.locator('[aria-current="true"]')).toContainText(
      "E2E drag song 1",
      { timeout: 15_000 },
    );
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

  test("a Joysound song is queued with the lyrics mode picked, preset from the profile", async ({
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
    const choice = remote.getByRole("tablist", { name: "Lyrics on the TV" });
    const selected = choice.locator('[aria-selected="true"]');

    // The phone's default: kana, until the profile says otherwise.
    await remote.getByRole("link", { name: "Profile" }).click();
    await expect(choice.getByRole("tab")).toHaveText(Object.values(LABELS));
    await expect(selected).toHaveText("Kana");
    await choice.getByRole("tab", { name: "Romaji" }).click();
    await expect(selected).toHaveText("Romaji");
    expect(
      await remote.evaluate(() => localStorage.getItem("lyricsMode")),
    ).toBe("romaji");

    for (const mode of ["romaji", "kana", "both"] as const) {
      await remote.goto(new URL(`#/joysoundSong/e2e-${mode}`, remoconUrl).href);
      await expect(
        remote.getByRole("heading", { name: `E2E Joysound e2e-${mode}` }),
      ).toBeVisible();
      // Each song page starts at the profile's choice.
      await expect(selected).toHaveText("Romaji");
      await choice.getByRole("tab", { name: LABELS[mode] }).click();
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
  });
});

test.describe("the guide melody slider", () => {
  const PASSWORD = "e2e guide melody";
  test.use({ appConfig: adminPasswordConfig(PASSWORD) });

  test("shows during a Joysound song, disabled for a guest; an admin sets the level", async ({
    karafriends,
    remote,
  }) => {
    const { app, remoconUrl } = karafriends;
    await remote.getByRole("button", { name: "Show queue" }).click();
    const slider = remote.getByRole("slider", { name: "Guide melody" });
    await expect(remote.getByText("Nothing playing")).toBeVisible();
    await expect(slider).toHaveCount(0);

    await fakeJoysoundDownload(app, "e2e-melody");
    const res = await fetch(new URL("api/queueSong", remoconUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Karafriends-Device-Id": "e2e-someone",
        "X-Karafriends-Nickname": "someone",
      },
      body: JSON.stringify({
        kind: "joysound",
        songId: "e2e-melody",
        name: "E2E melody song",
        artistName: "E2E artist",
        lyricsMode: "kana",
        youtubeVideoId: null,
      }),
    });
    expect(res.status).toBe(200);

    // The display starts it at once.
    await expect(slider).toBeVisible({ timeout: 15_000 });
    await expect(slider).toBeDisabled();
    await expect(slider).toHaveValue("0");

    await remote.getByRole("link", { name: "Profile" }).click();
    await remote.getByLabel("Admin password").fill(PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("You're an admin")).toBeVisible();

    await expect(slider).toBeEnabled();
    expect((await slider.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await slider.fill("0.7");
    await expect
      .poll(async () => (await liveState(remoconUrl)).guideMelodyLevel)
      .toBe(0.7);
    await expect(slider).toHaveValue("0.7");
  });
});

// Picks a Readings choice on the profile screen and goes back.
async function pickReadings(remote: Page, choice: string) {
  await remote.getByRole("link", { name: "Profile" }).click();
  await remote
    .getByRole("tablist", { name: "Readings" })
    .getByRole("tab", { name: choice, exact: true })
    .click();
  await remote.getByRole("button", { name: "Back" }).click();
}

test("the Readings setting shows DAM's readings in the search rows", async ({
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
  for (const [choice, dam] of [
    ["Kana", "恋こいDAM星野 源 ほしのげん"],
    ["Romaji", "恋koiDAM星野 源 hoshinogen"],
    ["Both", "恋こい · koiDAM星野 源 ほしのげん · hoshinogen"],
    ["Written", "恋DAM星野 源"],
  ]) {
    await pickReadings(remote, choice);
    await expect(results).toHaveText([dam, joysound]);
  }
  expect(await remote.evaluate(() => localStorage.getItem("readings"))).toBe(
    "written",
  );
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

  test("shows its reading in the queue", async ({ karafriends, remote }) => {
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
    expect(await (await queued).json()).toMatchObject({ ok: true });

    await remote.getByRole("button", { name: "Show queue" }).click();
    const row = remote
      .getByRole("region", { name: "Queue" })
      .getByRole("listitem")
      .filter({ hasText: "星野 源" });
    await expect(row).toContainText("恋koiDAM星野 源");
    await pickReadings(remote, "Both");
    await expect(row).toContainText("恋こい · koiDAM星野 源");
  });
});
