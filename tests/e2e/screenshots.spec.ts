// Screenshots of the remote for reviewing the UI against the design brief in
// notes/PLAN-product.md, saved to notes/ui-refresh-screenshots/. Not a test:
// skipped unless KARAFRIENDS_SCREENSHOTS=1.
//
// /dev/ui is only in a build made with VITE_KARAFRIENDS_DEV_UI=1:
//
//   VITE_KARAFRIENDS_DEV_UI=1 yarn build-prod
//   KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots
//
// then build again without it before anything else.
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
      remote
        .getByRole("region", { name: "Queue" })
        .getByText("LiSA - 紅蓮華")
        .first(),
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
