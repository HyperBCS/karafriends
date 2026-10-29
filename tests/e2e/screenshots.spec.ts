// Screenshots of the remote for reviewing the UI against the design brief in
// notes/PLAN-product.md, saved to notes/ui-refresh-screenshots/. Not a test:
// skipped unless KARAFRIENDS_SCREENSHOTS=1.
//
// /dev/ui is only in a build made with VITE_KARAFRIENDS_DEV_UI=1:
//
//   VITE_KARAFRIENDS_DEV_UI=1 yarn build-prod
//   KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots
//
// then build again without it before anything else. Phase C's screens need
// no flag: KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots -g "phase C".
// Phase M2's, in Chromium and WebKit:
//
//   KARAFRIENDS_SCREENSHOTS=1 KARAFRIENDS_E2E_WEBKIT=1 yarn test:e2e screenshots -g "phase M2"
import path from "path";

import { devices, type Page } from "@playwright/test";

import {
  adminPasswordConfig,
  displayCall,
  expect,
  showQueue,
  test,
} from "./fixtures";

const OUT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "notes",
  "ui-refresh-screenshots",
);

test.skip(
  process.env.KARAFRIENDS_SCREENSHOTS !== "1",
  "Screenshots only with KARAFRIENDS_SCREENSHOTS=1",
);

// At the phone's CSS size, as the earlier screenshots in notes/ are.
const shoot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    scale: "css",
    fullPage,
    animations: "disabled",
  });

// Seeded songs: each plays a minute of black video (as in live.spec.ts).
const song = (
  n: number,
  name: string,
  artistName: string,
  nickname: string,
) => ({
  kind: "nico",
  songId: `sm9000${n}`,
  name,
  artistName,
  playtime: 240,
  timestamp: String(Date.UTC(2026, 0, 1) + n),
  user: { deviceId: `e2e-screenshot-${nickname}`, nickname },
});

// The artist on the now-playing bar's second line, once the song plays
// (the queue in the sheet holds only the songs after it).
const nowPlaying = (page: Page, artist: string) =>
  page
    .getByRole("region", { name: "Now playing" })
    .getByText(artist, { exact: true });

// Phases B and C took their shots as a Pixel 7; with
// KARAFRIENDS_E2E_WEBKIT=1, the iPhone leaves them as they are.
const CHROMIUM_ONLY = "Phases B and C are shot in Chromium only";

test.describe("phase B", () => {
  test.skip(({ browserName }) => browserName !== "chromium", CHROMIUM_ONLY);
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        song(1, "【初音ミク】千本桜【オリジナル曲PV】", "黒うさP", "Ken"),
        song(2, "紅蓮華", "LiSA", "あやか"),
        song(3, "マリーゴールド", "あいみょん", "Mio"),
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("home on the dark background, and /dev/ui in both languages", async ({
    remote,
    karafriends,
  }) => {
    await shoot(remote, "b-home");
    await showQueue(remote);
    await expect(
      remote.getByRole("region", { name: "Queue" }).getByText("紅蓮華").first(),
    ).toBeVisible();
    await shoot(remote, "b-home-queue");
    // The display went dark too; its up-next list shows the same queue.
    await expect(karafriends.display.getByText("紅蓮華").first()).toBeVisible();
    await karafriends.display.setViewportSize({ width: 1920, height: 1080 });
    await karafriends.display.screenshot({
      path: path.join(OUT_DIR, "b-display.png"),
      animations: "disabled",
    });

    for (const language of ["en", "ja"]) {
      await remote.evaluate(
        (value) => localStorage.setItem("language", value),
        language,
      );
      await remote.goto(`${karafriends.remoconUrl}#/dev/ui`);
      // Only the hash changed; the language is read when the page loads.
      await remote.reload();
      await expect(
        remote.getByRole("heading", { name: "InlineError" }),
        "/dev/ui is missing: build with VITE_KARAFRIENDS_DEV_UI=1",
      ).toBeVisible();
      await expect(remote.locator("html")).toHaveAttribute("lang", language);
      await shoot(remote, `b-ui-${language}`, true);
    }
  });
});

// Real songs for phases C and M2. DAM's and Joysound's answers are made up
// (they only answer Japanese IPs); the queue is seeded.
const at = (minute: number) => String(Date.UTC(2026, 9, 24, 11, minute));
const user = (nickname: string) => ({
  deviceId: `e2e-screenshot-${nickname}`,
  nickname,
});
const queued = {
  nico: (songId: string, name: string, artistName: string, who: string) => ({
    kind: "nico",
    songId,
    name,
    artistName,
    playtime: 240,
    timestamp: at(55),
    user: user(who),
  }),
};
const QUEUE = [
  queued.nico(
    "sm15630734",
    "【初音ミク】千本桜【オリジナル曲PV】",
    "黒うさP",
    "Ken",
  ),
  {
    kind: "dam",
    songId: "dam-gurenge",
    name: "紅蓮華",
    artistName: "LiSA",
    playtime: 239,
    timestamp: at(56),
    user: user("あやか"),
    streamingUrlIdx: 0,
  },
  {
    kind: "joysound",
    songId: "joysound-marigold",
    name: "マリーゴールド",
    artistName: "あいみょん",
    playtime: 304,
    timestamp: at(57),
    user: user("Mio"),
    lyricsMode: "kana",
    youtubeVideoId: null,
  },
  {
    kind: "youtube",
    songId: "TQ8WlA2GXbk",
    name: "Official髭男dism - Pretender［Official Video］",
    artistName: "Official髭男dism",
    playtime: 327,
    timestamp: at(58),
    user: user("Taro"),
    hasAdhocLyrics: false,
    hasCaptions: false,
    gainValue: 1,
  },
  queued.nico("sm2057168", "残酷な天使のテーゼ", "高橋洋子", "Ken"),
];

// DAM's come with their readings, in hiragana as DAM gives them.
const SEARCH = {
  dam: [
    ["恋", "星野源", "こい", "ほしのげん"],
    [
      "恋愛サーキュレーション",
      "千石撫子(花澤香菜)",
      "れんあいさーきゅれーしょん",
      "せんごくなでこはなざわかな",
    ],
    ["恋するフォーチュンクッキー", "AKB48", "こいするふぉーちゅんくっきー"],
    [
      "恋人がサンタクロース",
      "松任谷由実",
      "こいびとがさんたくろーす",
      "まつとうやゆみ",
    ],
    [
      "恋におちて -Fall in love-",
      "小林明子",
      "こいにおちてふぉーるいんらぶ",
      "こばやしあきこ",
    ],
  ],
  joysound: [
    ["恋", "星野源"],
    ["恋人よ", "五輪真弓"],
    ["恋のバカンス", "ザ・ピーナッツ"],
    ["恋愛裁判", "40mP"],
    ["恋は渾沌の隷也", "後ろから這いより隊G"],
  ],
};

// Answers every search with SEARCH, and every DAM song page with 恋.
async function fakeCatalogs(page: Page) {
  for (const catalog of ["dam", "joysound"] as const) {
    await page.route(`**/api/${catalog}SearchSongs`, (route) =>
      route.fulfill({
        json: {
          items: SEARCH[catalog].map(
            ([name, artistName, nameYomi = "", artistNameYomi = ""], i) => ({
              id: `${catalog}-${i}`,
              name,
              nameYomi,
              artistName,
              artistNameYomi,
            }),
          ),
          nextOffset: null,
        },
      }),
    );
  }
  await page.route("**/api/damSong", (route) =>
    route.fulfill({
      json: {
        id: "dam-0",
        name: "恋",
        nameYomi: "こい",
        artistName: "星野源",
        // As DAM's song details give it: the reading comes from the row.
        artistNameYomi: "",
        lyricsPreview: null,
        vocalTypes: ["NORMAL", "GUIDE_MALE"],
        tieUp: "TBS系 火曜ドラマ「逃げるは恥だが役に立つ」主題歌",
        playtime: 252,
      },
    }),
  );
}

// Phase C: each screen of the remote, in English and Japanese. The history
// is seeded too.
test.describe("phase C", () => {
  test.skip(({ browserName }) => browserName !== "chromium", CHROMIUM_ONLY);
  const ADMIN_PASSWORD = "screenshots";
  const HISTORY = [
    ["夜に駆ける", "YOASOBI", "Mio", "dam", 50],
    ["Lemon", "米津玄師", "Ken", "joysound", 44],
    ["白日", "King Gnu", "Taro", "dam", 39],
    ["First Love", "宇多田ヒカル", "あやか", "joysound", 33],
    ["丸の内サディスティック", "椎名林檎", "Ken", "dam", 27],
  ].map(([name, artistName, who, kind, minute]) => ({
    song: {
      kind,
      songId: `history-${minute}`,
      name,
      artistName,
      playtime: 240,
      timestamp: at(minute as number),
      user: user(who as string),
      ...(kind === "dam"
        ? { streamingUrlIdx: 0 }
        : { lyricsMode: "kana", youtubeVideoId: null }),
    },
  }));

  test.use({
    appConfig: adminPasswordConfig(ADMIN_PASSWORD),
    seedQueue: {
      currentSong: null,
      songQueue: QUEUE,
      songHistory: HISTORY,
      playbackState: "WAITING",
    },
  });

  test("every screen in both languages", async ({
    remote,
    karafriends,
    browser,
  }) => {
    const { remoconUrl } = karafriends;
    // A real-looking nickname, not the fixture's (this runs after its).
    await remote.addInitScript(() => localStorage.setItem("nickname", "Ken"));
    await fakeCatalogs(remote);
    // Signed in as an admin, for the queue's controls.
    await remote.evaluate(async (password) => {
      const res = await fetch("api/adminLogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      localStorage.setItem("adminToken", (await res.json()).token);
    }, ADMIN_PASSWORD);

    // The display starts the first song within 5 seconds.
    await expect(
      remote.getByRole("region").getByText("千本桜").first(),
    ).toBeVisible({ timeout: 15_000 });

    for (const language of ["en", "ja"] as const) {
      // A new phone, before it has a nickname.
      const context = await browser.newContext({
        ...devices["Pixel 7"],
        locale: "en-US",
      });
      const phone = await context.newPage();
      await phone.addInitScript(
        (value) => localStorage.setItem("language", value),
        language,
      );
      await phone.goto(remoconUrl);
      await expect(phone.locator("input")).toBeFocused();
      await phone.locator("input").blur();
      await shoot(phone, `c-nickname-${language}`);
      await context.close();

      const open = async (hash: string, expanded = false) => {
        await remote.evaluate(
          ([value, sheet]) => {
            localStorage.setItem("language", value);
            localStorage.setItem("expanded", sheet);
          },
          [language, String(expanded)] as const,
        );
        await remote.goto(`${remoconUrl}#${hash}`);
        await remote.reload();
        await expect(remote.locator("html")).toHaveAttribute("lang", language);
      };

      await open(`/?q=${encodeURIComponent("恋")}`);
      await expect(
        remote.getByRole("link", { name: /恋愛裁判/ }),
      ).toBeVisible();
      await shoot(remote, `c-search-${language}`);

      await open("/song/dam-0");
      await expect(
        remote.getByRole("heading", { name: "恋", exact: true }),
      ).toBeVisible();
      await shoot(remote, `c-song-${language}`);

      await open("/history");
      await expect(
        remote.getByRole("link", { name: /夜に駆ける/ }),
      ).toBeVisible();
      await shoot(remote, `c-history-${language}`);

      await open("/settings");
      await expect(remote.getByRole("status").last()).toBeVisible();
      await shoot(remote, `c-profile-${language}`);

      // The sheet, open, with an admin's controls on the second song.
      await open("/", true);
      await remote.getByRole("button", { name: /^マリーゴールド/ }).click();
      await expect(
        remote.getByRole("button", {
          name: language === "en" ? "Move to top" : "先頭に移動",
        }),
      ).toBeEnabled();
      await shoot(remote, `c-queue-${language}`);
    }
  });
});

// Phase M2 (the mobile round's locked shell, Home button and contrast):
// m-<screen>-<browser>.png, as a Pixel 7 in Chromium and, with
// KARAFRIENDS_E2E_WEBKIT=1, as an iPhone in WebKit.
test.describe("phase M2", () => {
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        ...QUEUE,
        queued.nico("sm1715919", "メルト", "ryo", "あやか"),
        queued.nico("sm3504435", "ワールドイズマイン", "ryo", "Mio"),
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("search, the open sheet and a song page", async ({
    remote,
    browserName,
  }) => {
    // (No reloads here: after one, WebKit's searches got past these.)
    await fakeCatalogs(remote);
    // The display starts the first song within 5 seconds; six wait.
    await expect(nowPlaying(remote, "黒うさP")).toBeVisible({
      timeout: 15_000,
    });

    const search = remote.getByRole("searchbox", { name: "Search" });
    await search.fill("恋");
    await search.blur();
    await expect(remote.getByRole("link", { name: /恋愛裁判/ })).toBeVisible();
    await shoot(remote, `m-search-${browserName}`);

    await showQueue(remote);
    await expect(
      remote.getByRole("region", { name: "Queue" }).getByRole("listitem"),
    ).toHaveCount(6);
    await shoot(remote, `m-queue-${browserName}`);
    await remote.getByRole("button", { name: "Hide queue" }).click();

    // DAM's 恋, the first result.
    await remote
      .getByRole("main")
      .getByRole("link", { name: /星野源/ })
      .first()
      .click();
    await expect(
      remote.getByRole("heading", { name: "恋", exact: true }),
    ).toBeVisible();
    await shoot(remote, `m-song-${browserName}`);
  });
});

// Phase M3's, the same way with -g "phase M3": the open sheet with a
// handle on every queued row, one of them held halfway up.
test.describe("phase M3", () => {
  test.use({
    appConfig: { everyoneIsAdmin: true },
    seedQueue: {
      currentSong: null,
      songQueue: QUEUE,
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("the queue mid-drag", async ({ remote, browserName }) => {
    await expect(nowPlaying(remote, "黒うさP")).toBeVisible({
      timeout: 15_000,
    });
    await showQueue(remote);
    const handles = remote
      .getByRole("region", { name: "Queue" })
      .getByRole("button", { name: "Drag to reorder" });
    await expect(handles).toHaveCount(4);

    // マリーゴールド, held above 紅蓮華's middle: 紅蓮華 slides down.
    const grip = (await handles.nth(1).boundingBox())!;
    const row = (await handles.nth(0).boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await remote.mouse.move(x, y);
    await remote.mouse.down();
    await remote.mouse.move(x, y - (grip.y - row.y) * 0.7, { steps: 6 });
    await shoot(remote, `m-queue-drag-${browserName}`);
    await remote.mouse.up();
  });
});

// Phase M7: search results with the Readings setting on "Romaji" (the
// polish round made the reading replace the text).
test.describe("phase M7", () => {
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: QUEUE,
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("search results with their readings", async ({
    remote,
    browserName,
  }) => {
    await fakeCatalogs(remote);
    await remote.getByRole("link", { name: "Settings" }).click();
    await remote
      .getByRole("radiogroup", { name: "Readings" })
      .getByRole("radio", { name: "Romaji", exact: true })
      .click();
    await remote.getByRole("button", { name: "Back" }).click();
    await expect(nowPlaying(remote, "黒うさP")).toBeVisible({
      timeout: 15_000,
    });

    const search = remote.getByRole("searchbox", { name: "Search" });
    await search.fill("恋");
    await search.blur();
    await expect(
      remote.getByText("koi", { exact: true }).first(),
    ).toBeVisible();
    await shoot(remote, `m-readings-${browserName}`);
  });
});

// The polish round's P2, the same way with -g "phase P2": search (readings
// in romaji), the open sheet, the profile as an admin and a song page, in
// the light and the dark theme: p-<screen>-<theme>-<browser>.png.
test.describe("phase P2", () => {
  const ADMIN_PASSWORD = "screenshots";
  test.use({
    appConfig: adminPasswordConfig(ADMIN_PASSWORD),
    seedQueue: {
      currentSong: null,
      songQueue: QUEUE,
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  // No reloads (after one, WebKit's searches got past the fake catalogs):
  // the profile is set by hand, the theme stays Auto and follows the
  // emulated mode, and every screen is reached by a tap.
  test("search, the sheet, the profile and a song page in both themes", async ({
    remote,
    browserName,
  }) => {
    await fakeCatalogs(remote);
    // A real-looking nickname, romaji, and signed in as an admin.
    await remote.getByRole("link", { name: "Settings" }).click();
    await remote.getByLabel("Nickname").fill("Ken");
    await remote.getByRole("button", { name: "Save nickname" }).click();
    await remote
      .getByRole("radiogroup", { name: "Readings" })
      .getByRole("radio", { name: "Romaji" })
      .click();
    await remote.getByLabel("Admin password").fill(ADMIN_PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("You're an admin")).toBeVisible();
    await remote.getByRole("link", { name: "Home" }).click();
    // The display starts the first song within 5 seconds.
    await expect(nowPlaying(remote, "黒うさP")).toBeVisible({
      timeout: 15_000,
    });
    // The sheet's toggle, the arrow at the end of the bar.
    const toggle = remote
      .getByRole("region", { name: "Now playing" })
      .getByRole("button", { name: /^(Show|Hide) queue$/ });
    const top = (name: string) =>
      remote.getByRole("banner").getByRole("link", { name, exact: true });

    for (const theme of ["light", "dark"] as const) {
      await remote.emulateMedia({ colorScheme: theme });
      await expect(remote.locator("html")).toHaveAttribute("data-theme", theme);
      const name = (screen: string) => `p-${screen}-${theme}-${browserName}`;

      const search = remote.getByRole("searchbox", { name: "Search" });
      await search.fill("恋");
      await search.blur();
      await expect(
        remote.getByRole("link", { name: /恋愛裁判/ }),
      ).toBeVisible();
      await shoot(remote, name("search"));

      await toggle.click();
      await expect(
        remote.getByRole("region", { name: "Queue" }).getByRole("listitem"),
      ).toHaveCount(4);
      await shoot(remote, name("sheet"));
      await toggle.click();

      // DAM's 恋, the first result.
      await remote
        .getByRole("main")
        .getByRole("link", { name: /hoshinogen/ })
        .first()
        .click();
      await expect(
        remote.getByRole("heading", { name: "koi", exact: true }),
      ).toBeVisible();
      await shoot(remote, name("song"));

      await top("Settings").click();
      // Scrolled down to the theme. (The admin's sliders below it fit on
      // a Pixel 7, not on an iPhone 15.)
      await remote
        .getByText("Theme", { exact: true })
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(
        remote.getByRole("radiogroup", { name: "Theme" }),
      ).toBeInViewport();
      await shoot(remote, name("profile"));
      await top("Home").click();
    }
  });
});

// The mic round's R1, the same way with -g "phase R1": the profile's Admin
// section with the song volume, the guide melody and two mics, which the
// display sets, in the light and the dark theme:
// n-remote-admin-<theme>-<browser>.png.
test.describe("phase R1", () => {
  const ADMIN_PASSWORD = "screenshots";
  test.use({ appConfig: adminPasswordConfig(ADMIN_PASSWORD) });

  const MICS = [
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
      gain: 120,
      echo: 20,
      gate: -45,
    },
  ];

  test("the Admin section in both themes", async ({
    display,
    remote,
    browserName,
  }) => {
    // As the display would, over IPC.
    for (const [method, input] of [
      ["setMics", { mics: MICS }],
      ["setSongVolume", { volume: 80 }],
      ["setGuideMelodyLevel", { level: 0.5 }],
    ] as const) {
      expect(await displayCall(display, method, input)).toEqual({
        ok: true,
        output: true,
      });
    }
    // A real-looking nickname, signed in as an admin.
    await remote.getByRole("link", { name: "Settings" }).click();
    await remote.getByLabel("Nickname").fill("Ken");
    await remote.getByRole("button", { name: "Save nickname" }).click();
    await remote.getByLabel("Admin password").fill(ADMIN_PASSWORD);
    await remote.getByRole("button", { name: "Sign in" }).click();
    await expect(remote.getByText("You're an admin")).toBeVisible();
    await expect(
      remote.getByRole("slider", { name: "Song volume" }),
    ).toHaveValue("80");
    await expect(remote.getByRole("slider", { name: "Gain" })).toHaveCount(2);

    for (const theme of ["light", "dark"] as const) {
      await remote.emulateMedia({ colorScheme: theme });
      await expect(remote.locator("html")).toHaveAttribute("data-theme", theme);
      await remote
        .getByRole("heading", { name: "Admin" })
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      // Its top: the whole section is taller than an iPhone 15's screen.
      await expect(
        remote.getByRole("slider", { name: "Song volume" }),
      ).toBeInViewport();
      await shoot(remote, `n-remote-admin-${theme}-${browserName}`);
    }
  });
});

// The UI round's U4, the same way with -g "phase U4": the search's one row
// of options, with the source menu open, and the settings' groups, in the
// light and the dark theme: u4-<screen>-<theme>-<browser>.png.
test.describe("phase U4", () => {
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: QUEUE,
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("the search's source menu and the settings in both themes", async ({
    remote,
    browserName,
  }) => {
    await fakeCatalogs(remote);
    // A real-looking nickname.
    await remote.getByRole("link", { name: "Settings" }).click();
    await remote.getByLabel("Nickname").fill("Ken");
    await remote.getByRole("button", { name: "Save nickname" }).click();
    await remote.getByRole("link", { name: "Home" }).click();
    // The display starts the first song within 5 seconds.
    await expect(nowPlaying(remote, "黒うさP")).toBeVisible({
      timeout: 15_000,
    });
    const source = remote.getByRole("combobox", { name: "Source" });

    for (const theme of ["light", "dark"] as const) {
      await remote.emulateMedia({ colorScheme: theme });
      await expect(remote.locator("html")).toHaveAttribute("data-theme", theme);
      const name = (screen: string) => `u4-${screen}-${theme}-${browserName}`;

      const search = remote.getByRole("searchbox", { name: "Search" });
      await search.fill("恋");
      await search.blur();
      await expect(
        remote.getByRole("link", { name: /恋愛裁判/ }),
      ).toBeVisible();
      await shoot(remote, name("search"));

      // On DAM, so the button names it. (The menu itself is the phone's
      // own picker, which a screenshot doesn't show.)
      await source.selectOption({ label: "DAM" });
      await expect(source.locator("..")).toContainText("DAM");
      await shoot(remote, name("search-source"));
      await source.selectOption({ label: "All" });

      await remote.getByRole("link", { name: "Settings" }).click();
      await expect(
        remote.getByRole("radiogroup", { name: "Theme" }),
      ).toBeVisible();
      await shoot(remote, name("settings"));
      await remote.getByRole("link", { name: "Home" }).click();
    }
  });
});
