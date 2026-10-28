// A download that fails reaches the phone that asked for it: the queue
// button says why, the song never joins the queue, and asking again works.
// A failure that is yt-dlp's, not the video's, also tells the display to
// suggest updating the tools.
//
// yt-dlp is a fake (tests/fixtures/bin/yt-dlp-fails, or yt-dlp-broken) that
// fails the way the real one does for a removed video (or at YouTube's bot
// check), and the remote's video lookup is answered here, so this runs
// offline.

import path from "path";

import type { Page } from "@playwright/test";

import type { LiveState, YoutubeVideoInfo } from "../../src/common/api";
import { expect, NICKNAME, test } from "./fixtures";

const fakeYtdlp = (name: string) =>
  path.resolve(
    __dirname,
    "..",
    "fixtures",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
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

const TOOLS_PROBLEM =
  "YouTube downloads are failing; try Update tools in Settings";

type DisplayApi = {
  call(
    method: string,
    input: object,
  ): Promise<{ ok: boolean; output?: any; status?: number }>;
  onLive(
    listener: (event: { type: string; state?: LiveState }) => void,
  ): () => void;
};

// The display's live state, from its preload.
function displayLiveState(display: Page): Promise<LiveState> {
  return display.evaluate(
    () =>
      new Promise<LiveState>((resolve) => {
        const api = (window as unknown as { karafriends: { api: DisplayApi } })
          .karafriends.api;
        const stop = api.onLive((event) => {
          if (event.type === "state") {
            resolve(event.state!);
            setTimeout(() => stop());
          }
        });
      }),
  );
}

// A call from the display, over IPC.
function displayCall(display: Page, method: string) {
  return display.evaluate(
    (method) =>
      (
        window as unknown as { karafriends: { api: DisplayApi } }
      ).karafriends.api.call(method, {}),
    method,
  );
}

// Opens the video's page on the remote, with YouTube kept offline.
async function openVideo(remote: Page) {
  await remote.route(/youtube\.com|ytimg\.com/, (route) => route.abort());
  await remote.route("**/api/youtubeInfo", (route) =>
    route.fulfill({ json: { ok: true, info: VIDEO_INFO } }),
  );

  // An ID in the search box opens the video's page on Enter.
  await remote.getByRole("searchbox", { name: "Search" }).fill(VIDEO_ID);
  await remote.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(
    remote.getByText(VIDEO_INFO.title, { exact: true }),
  ).toBeVisible();
}

// Queues the video; the server takes it (the failure comes later, from the
// download).
async function queueVideo(remote: Page) {
  const answer = remote.waitForResponse((res) =>
    res.url().endsWith("/api/queueSong"),
  );
  await remote.getByRole("button", { name: "Queue video" }).click();
  expect(await (await answer).json()).toMatchObject({ ok: true });
}

test.describe("for a removed video", () => {
  test.use({ appEnv: { KARAFRIENDS_YTDLP_PATH: fakeYtdlp("yt-dlp-fails") } });

  test("a failed YouTube download says why on the remote and the display, and can be tried again", async ({
    remote,
    display,
  }) => {
    await openVideo(remote);
    const queueButton = remote.getByRole("button", { name: "Queue video" });
    const failed = remote.getByRole("button", {
      name: "Couldn't download: Video unavailable",
    });

    for (const attempt of ["first", "again"]) {
      await test.step(`queue it (${attempt})`, async () => {
        await queueVideo(remote);
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

    // The video's fault, not the tools'.
    expect((await displayLiveState(display)).toolsProblem).toBeNull();
  });
});

test.describe("at YouTube's bot check", () => {
  test.use({
    appEnv: { KARAFRIENDS_YTDLP_PATH: fakeYtdlp("yt-dlp-broken") },
  });

  test("a failed download tells the display to update the tools", async ({
    karafriends,
    remote,
    display,
  }) => {
    await openVideo(remote);
    expect((await displayLiveState(display)).toolsProblem).toBeNull();
    await queueVideo(remote);
    await expect(
      remote.getByRole("button", {
        name: "Couldn't download: YouTube blocked the download",
      }),
    ).toBeVisible();

    await expect
      .poll(async () => (await displayLiveState(display)).toolsProblem)
      .toBe(TOOLS_PROBLEM);

    // The settings screen's view: yt-dlp is the override, which the app
    // never downloads.
    expect(await displayCall(display, "getToolsStatus")).toMatchObject({
      ok: true,
      output: {
        ytdlp: { overridden: true, updatedAt: null },
        ffmpeg: { overridden: false },
        problem: TOOLS_PROBLEM,
        problemSince: expect.any(Number),
      },
    });

    // Phones get neither tools method.
    for (const method of ["getToolsStatus", "updateTools"]) {
      const res = await fetch(
        new URL(`api/${method}`, karafriends.remoconUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      expect(res.status, method).toBe(403);
    }
  });
});
