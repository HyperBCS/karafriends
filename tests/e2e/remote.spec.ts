import type { Page, Route } from "@playwright/test";

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

test("an artist search from both catalogs shows a page from each in turn", async ({
  remote,
}) => {
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
    fakePages(route, 35, artist("Joysound")),
  );

  await remote.getByRole("tab", { name: "Artist" }).click();
  await remote.getByRole("searchbox", { name: "Search" }).fill("E2E");
  const results = remote
    .getByRole("list", { name: "Results" })
    .getByRole("link");
  await expect(results).toHaveCount(60);
  await remote.getByRole("button", { name: "More" }).click();
  await expect(results).toHaveCount(75);

  const names = (await results.allTextContents()).map((text) => {
    const [, source, n] = text.match(/E2E (DAM|Joysound) artist (\d+)/)!;
    return `${source} ${Number(n)}`;
  });
  const run = (source: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${source} ${from + i}`);
  expect(names).toEqual([
    ...run("DAM", 1, 30),
    ...run("Joysound", 1, 30),
    ...run("DAM", 31, 40),
    ...run("Joysound", 31, 35),
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
    // At the top, it can only go down.
    await expect(queue.getByRole("button", { name: "Move up" })).toBeDisabled();
    await queue.getByRole("button", { name: "Move down" }).click();
    await expect
      .poll(() => rows(remote))
      .toEqual([
        expect.stringContaining("song 1"),
        expect.stringContaining("song 2"),
        expect.stringContaining("song 4"),
        expect.stringContaining("song 3"),
      ]);
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
