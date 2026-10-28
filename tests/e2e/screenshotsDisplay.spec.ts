// Screenshots of the display for reviewing it against the design brief in
// notes/PLAN-product.md, at 1920×1080, saved to
// notes/ui-refresh-screenshots/d-*.png, and the idle screen at 720p and 4K
// (m-display-*.png). Not a test: skipped unless KARAFRIENDS_SCREENSHOTS=1.
//
//   yarn build-prod
//   KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshotsDisplay
//
// The songs are Niconico videos; the fixture gives each a black video
// (tests/fixtures/black.mp4). The failed Test login is a real sign-in to
// DAM with a wrong password, so that shot needs the internet.
import path from "path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

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

async function shoot(display: Page, name: string) {
  await display.screenshot({
    path: path.join(OUT_DIR, `d-${name}.png`),
    animations: "disabled",
  });
}

const song = (
  n: number,
  name: string,
  artistName: string,
  nickname: string,
  playtime: number,
) => ({
  kind: "nico",
  songId: `sm9100${n}`,
  name,
  artistName,
  playtime,
  timestamp: String(Date.UTC(2026, 0, 1) + n),
  user: { deviceId: `e2e-screenshot-${nickname}`, nickname },
});

const SONGS = [
  song(1, "千本桜", "黒うさP", "Ken", 245),
  song(2, "紅蓮華", "LiSA", "あやか", 239),
  song(3, "マリーゴールド", "あいみょん", "Mio", 303),
  song(4, "夜に駆ける", "YOASOBI", "Yuki", 261),
];

// A DAM login the app never tries unless asked (Test login), so Settings
// doesn't open by itself.
const LOGIN = { damUsername: "karaoke-host", damPassword: "not-the-password" };

test.beforeEach(async ({ display }) => {
  await display.setViewportSize({ width: 1920, height: 1080 });
});

test.describe("phase D, with a login", () => {
  test.use({ appConfig: LOGIN });

  test("idle with an empty queue", async ({ display }) => {
    await expect(display.getByText("Scan to join")).toBeVisible();
    await shoot(display, "idle-empty");
  });

  test.describe("four queued", () => {
    // Saved as paused with no current song, the display starts the first
    // song only at its first check, 5 s after it loads, instead of at once:
    // time for the idle screen with the queue.
    test.use({
      seedQueue: {
        currentSong: null,
        songQueue: SONGS,
        songHistory: [],
        playbackState: "PAUSED",
      },
    });

    test("idle with four queued, then the first playing", async ({
      display,
    }) => {
      await expect(
        display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
      ).toHaveCount(4);
      await shoot(display, "idle-queued");

      // The shot shows what the display puts over a (black) video.
      await expect(
        display.getByRole("status").filter({ hasText: "Now playing" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(() =>
          display
            .locator("video")
            .evaluate((video: HTMLVideoElement) => video.currentTime > 0.5),
        )
        .toBe(true);
      await shoot(display, "playing-start");
    });
  });

  test("settings, and a failed Test login", async ({ display }) => {
    await expect(display.getByText("Scan to join")).toBeVisible();
    await display.keyboard.press("s");
    const settings = display.getByRole("dialog", { name: "Settings" });
    const dam = settings.getByRole("region", { name: "DAM login" });
    await expect(dam.getByLabel("Username")).toHaveValue("karaoke-host");
    await shoot(display, "settings");

    await dam.getByRole("button", { name: "Test login" }).click();
    await expect(dam.getByRole("status")).not.toHaveText("Signing in…", {
      timeout: 30_000,
    });
    await expect(dam.getByRole("status")).not.toHaveText("Signed in to DAM.");
    await shoot(display, "settings-test-failed");

    // The other tabs.
    for (const [tab, name] of [
      ["Party", "settings-queue"],
      ["Sound", "settings-sound"],
      ["Display", "settings-display"],
      ["Advanced", "settings-more"],
    ]) {
      await settings.getByRole("tab", { name: tab }).click();
      await expect(settings.getByRole("tabpanel")).toHaveAccessibleName(tab);
      await shoot(display, name);
    }
  });
});

// The UI round's U2: Settings in tabs, at 720p and 4K, and at 1080p with
// the UI scale at 150% (narrower margins), on its busiest tab (Sound, with
// two mics).
test.describe("U2, Settings", () => {
  test.use({ appConfig: LOGIN });

  for (const [width, height, scale] of [
    [1280, 720, 100],
    [3840, 2160, 100],
    [1920, 1080, 150],
  ]) {
    const name = scale === 100 ? `${height}` : `scale${scale}`;
    test(`Settings at ${width}×${height}, ${scale}%`, async ({ display }) => {
      await display.setViewportSize({ width, height });
      if (scale !== 100) {
        await display.evaluate(
          (scale) => localStorage.setItem("uiScale", String(scale)),
          scale,
        );
        await display.reload();
      }
      await expect(display.getByText("Scan to join")).toBeVisible();
      await display.keyboard.press("s");
      const settings = display.getByRole("dialog", { name: "Settings" });
      await settings.getByRole("tab", { name: "Sound" }).click();
      const add = settings.getByLabel("Add a microphone");
      await add.selectOption("E2E Mic (USB), channel 1");
      await add.selectOption("E2E Interface (USB), channel 2");
      await expect(settings.getByRole("group")).toHaveCount(2);
      await display.screenshot({
        path: path.join(OUT_DIR, `d-settings-${name}.png`),
        animations: "disabled",
      });
    });
  }
});

// The mobile round's M9: every size follows the window's height, so the idle
// screen with four queued looks the same at 720p as at 4K.
test.describe("M9, four queued", () => {
  test.use({
    appConfig: LOGIN,
    seedQueue: {
      currentSong: null,
      songQueue: SONGS,
      songHistory: [],
      playbackState: "PAUSED",
    },
  });

  for (const [width, height] of [
    [1280, 720],
    [3840, 2160],
  ]) {
    test(`idle at ${width}×${height}`, async ({ display }) => {
      await display.setViewportSize({ width, height });
      await expect(
        display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
      ).toHaveCount(4);
      await display.screenshot({
        path: path.join(OUT_DIR, `m-display-${height}.png`),
        animations: "disabled",
      });
    });
  }
});

// The polish round's P3: the strip, the idle list and the corner show the
// title, the artist and the singer apart, and each song the way its queuer
// reads it (千本桜 from a phone that reads romaji, 夜に駆ける from one that
// reads kana).
test.describe("P3, four queued with readings", () => {
  const withReadings = [
    {
      ...SONGS[0],
      nameYomi: "せんぼんざくら",
      artistNameYomi: "くろうさぴー",
      readingsMode: "romaji",
    },
    SONGS[1],
    SONGS[2],
    { ...SONGS[3], nameYomi: "よるにかける", readingsMode: "kana" },
  ];
  test.use({
    appConfig: LOGIN,
    seedQueue: {
      currentSong: null,
      songQueue: withReadings,
      songHistory: [],
      playbackState: "PAUSED",
    },
  });

  test("idle, then the first playing", async ({ display }) => {
    await expect(
      display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
    ).toHaveCount(4);
    await display.screenshot({
      path: path.join(OUT_DIR, "p-display-idle.png"),
      animations: "disabled",
    });

    await expect(
      display.getByRole("status").filter({ hasText: "Now playing" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        display
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime > 0.5),
      )
      .toBe(true);
    await display.screenshot({
      path: path.join(OUT_DIR, "p-display-playing.png"),
      animations: "disabled",
    });

    // Settings' Display tab.
    await display.keyboard.press("s");
    const settings = display.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Display" }).click();
    await expect(settings.getByLabel("UI scale")).toBeVisible();
    await display.screenshot({
      path: path.join(OUT_DIR, "p-display-settings.png"),
      animations: "disabled",
    });
  });
});

// The mic round's D1: the QR code in the corner while a song plays, and
// the Microphones section with the fixture's fake mics.
test.describe("D1, four queued", () => {
  test.use({
    appConfig: LOGIN,
    seedQueue: {
      currentSong: null,
      songQueue: SONGS,
      songHistory: [],
      playbackState: "PAUSED",
    },
  });

  test("the QR corner, then the mics", async ({ display }) => {
    await expect(
      display.getByRole("status").filter({ hasText: "Now playing" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        display
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime > 0.5),
      )
      .toBe(true);
    // After the corner announcement has gone.
    await expect(
      display.getByRole("status").filter({ hasText: "Now playing" }),
    ).toHaveCount(0, { timeout: 10_000 });
    await display.screenshot({
      path: path.join(OUT_DIR, "n-display-qr.png"),
      animations: "disabled",
    });

    await display.keyboard.press("s");
    const settings = display.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Sound" }).click();
    const section = settings.getByRole("region", { name: "Microphones" });
    await section
      .getByLabel("Add a microphone")
      .selectOption("E2E Mic (USB), channel 1");
    await section
      .getByLabel("Add a microphone")
      .selectOption("E2E Interface (USB), channel 2");
    await section.getByLabel("Gain 100%").first().fill("140");
    await section.getByLabel("Gain 140%").blur();
    await section.getByLabel("Mic output").selectOption("E2E Interface (ASIO)");
    await section.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await display.screenshot({
      path: path.join(OUT_DIR, "n-display-mics.png"),
      animations: "disabled",
    });
  });
});

test("the first-launch banner", async ({ display }) => {
  await expect(
    display.getByText("Add your DAM or Joysound login", { exact: false }),
  ).toBeVisible();
  await shoot(display, "first-launch");
});
