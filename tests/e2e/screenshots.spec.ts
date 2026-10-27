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
import path from "path";

import { devices, type Page } from "@playwright/test";

import { adminPasswordConfig, expect, test } from "./fixtures";

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

// Songs that were never downloaded, so nothing plays (as in live.spec.ts).
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

test.describe("phase B", () => {
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
    await remote.getByRole("button", { name: "Show queue" }).click();
    await expect(
      remote.getByRole("region", { name: "Queue" }).getByText("紅蓮華").first(),
    ).toBeVisible();
    await shoot(remote, "b-home-queue");
    // The display went dark too; its sidebar shows the same queue.
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

// Phase C: each screen of the remote, in English and Japanese, with real
// songs. DAM's and Joysound's answers are made up here (they only answer
// Japanese IPs); the queue and history are seeded.
test.describe("phase C", () => {
  const ADMIN_PASSWORD = "screenshots";
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
      isRomaji: false,
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
        : { isRomaji: false, youtubeVideoId: null }),
    },
  }));

  const SEARCH = {
    dam: [
      ["恋", "星野源"],
      ["恋愛サーキュレーション", "千石撫子(花澤香菜)"],
      ["恋するフォーチュンクッキー", "AKB48"],
      ["恋人がサンタクロース", "松任谷由実"],
      ["恋におちて -Fall in love-", "小林明子"],
    ],
    joysound: [
      ["恋", "星野源"],
      ["恋人よ", "五輪真弓"],
      ["恋のバカンス", "ザ・ピーナッツ"],
      ["恋愛裁判", "40mP"],
      ["恋は渾沌の隷也", "後ろから這いより隊G"],
    ],
  };

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
    for (const catalog of ["dam", "joysound"] as const) {
      await remote.route(`**/api/${catalog}SearchSongs`, (route) =>
        route.fulfill({
          json: {
            items: SEARCH[catalog].map(([name, artistName], i) => ({
              id: `${catalog}-${i}`,
              name,
              nameYomi: "",
              artistName,
              artistNameYomi: "",
            })),
            nextOffset: null,
          },
        }),
      );
    }
    await remote.route("**/api/damSong", (route) =>
      route.fulfill({
        json: {
          id: "dam-0",
          name: "恋",
          nameYomi: "こい",
          artistName: "星野源",
          artistNameYomi: "ほしのげん",
          lyricsPreview: null,
          vocalTypes: ["NORMAL", "GUIDE_MALE"],
          tieUp: "TBS系 火曜ドラマ「逃げるは恥だが役に立つ」主題歌",
          playtime: 252,
        },
      }),
    );
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

      await open("/profile");
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
