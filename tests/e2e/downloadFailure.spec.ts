// A download that fails reaches the phone that asked for it: the queue
// button says why, the song never joins the queue, and asking again works.
//
// yt-dlp is a fake (tests/fixtures/bin/yt-dlp-fails) that fails the way the
// real one does for a removed video, and the remote's video lookup is
// answered here, so this runs offline.

import path from "path";

import type { YoutubeVideoInfo } from "../../src/common/api";
import { expect, NICKNAME, test } from "./fixtures";

const FAKE_YTDLP = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "bin",
  process.platform === "win32" ? "yt-dlp-fails.cmd" : "yt-dlp-fails",
);

const VIDEO_ID = "jNQXAC9IVRw";
const VIDEO_INFO: YoutubeVideoInfo = {
  title: "Me at the zoo",
  author: "jawed",
  channelId: "UC4QobU6STFB0P71PMvOGN5A",
  lengthSeconds: 19,
  description: "",
  viewCount: 1,
  captionLanguages: [],
  keywords: [],
  gainValue: 1,
};

test.use({ appEnv: { KARAFRIENDS_YTDLP_PATH: FAKE_YTDLP } });

test("a failed YouTube download says why on the remote and the display, and can be tried again", async ({
  remote,
  display,
}) => {
  // The page embeds YouTube's player; keep it offline.
  await remote.route(/youtube\.com|ytimg\.com/, (route) => route.abort());
  await remote.route("**/api/youtubeInfo", (route) =>
    route.fulfill({ json: { ok: true, info: VIDEO_INFO } }),
  );

  await remote.getByRole("link", { name: "YouTube", exact: true }).click();
  await remote.getByPlaceholder("YouTube video URL or ID").fill(VIDEO_ID);
  await remote.getByRole("button", { name: "Get Video Info" }).click();
  await expect(
    remote.getByText(VIDEO_INFO.title, { exact: true }),
  ).toBeVisible();

  const queueButton = remote.getByRole("button", { name: "Queue video" });
  const failed = remote.getByRole("button", {
    name: "Couldn't download: Video unavailable",
  });

  for (const attempt of ["first", "again"]) {
    await test.step(`queue it (${attempt})`, async () => {
      const answer = remote.waitForResponse((res) =>
        res.url().endsWith("/api/queueSong"),
      );
      await queueButton.click();
      // The server takes it: the failure comes later, from the download.
      expect(await (await answer).json()).toMatchObject({ ok: true });
      await expect(failed).toBeVisible();
      // The display shows it too (the first toast may still be up).
      await expect(
        display
          .getByText(
            `Couldn't download ${VIDEO_INFO.title} for ${NICKNAME}: Video unavailable`,
          )
          .first(),
      ).toBeVisible();
      // Then the button is ready again.
      await expect(queueButton).toBeEnabled();
    });
  }

  await remote.getByRole("button", { name: "Show queue" }).click();
  await expect(
    remote
      .getByRole("region", { name: "Queue" })
      .getByText("The queue is empty"),
  ).toBeVisible();
});
