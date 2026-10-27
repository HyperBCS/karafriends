import type { Page } from "@playwright/test";

import { expect, NICKNAME, test } from "./fixtures";

// "Me at the zoo": 19 seconds long and unlikely to ever go away. The app is
// launched with --mute-audio, so playing it makes no sound.
const VIDEO_ID = "jNQXAC9IVRw";
const VIDEO_TITLE = "Me at the zoo";

test.describe("YouTube", { tag: "@net" }, () => {
  test.use({ mediaTools: "installed" });
  test.describe.configure({
    // Looking up and downloading the video can take a while.
    timeout: 180_000,
    // YouTube sometimes keeps answering one app session's lookups with "Sign
    // in to confirm you're not a bot"; a retry starts a fresh app.
    retries: 2,
  });

  test("a queued video shows up on the remote and the display, and can be taken off", async ({
    remote,
    display,
  }) => {
    await queueVideo(remote);
    await remote.getByRole("button", { name: "Show queue" }).click();

    // Once downloaded, the video joins the queue, and the display starts it at
    // its next check (every 5 seconds). Either way both screens show it.
    const remoteQueue = remote.getByRole("region", { name: "Queue" });
    const queued = remoteQueue.getByText(VIDEO_TITLE);
    const nowPlaying = remote
      .getByRole("region", { name: "Now playing" })
      .getByText(VIDEO_TITLE);
    await expect(queued.or(nowPlaying).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(
        async () =>
          (await videoState(display)).src ||
          (await displayQueue(display).getByText(VIDEO_TITLE).count()) > 0,
      )
      .toBe(true);

    // Take it off: remove it while it's queued, or skip it once it's playing.
    let tookOffBy = "";
    await expect(async () => {
      if ((await queued.count()) > 0) {
        await remoteQueue
          .getByRole("button", { name: `Queued by ${NICKNAME}` })
          .click({ timeout: 2_000 });
        await remoteQueue
          .getByRole("button", { name: "Remove from queue" })
          .click({ timeout: 2_000 });
        tookOffBy = "removed from the queue";
      } else if ((await nowPlaying.count()) > 0) {
        await skipButton(remote).click({ timeout: 2_000 });
        tookOffBy = "skipped while playing";
      }
      await expect(
        remote.getByRole("contentinfo").getByText(VIDEO_TITLE),
      ).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    test.info().annotations.push({ type: "took off", description: tookOffBy });

    await expect(remoteQueue.getByText("The queue is empty")).toBeVisible();
    await expect(displayQueue(display).getByRole("listitem")).toHaveCount(0);
    await expect
      .poll(async () => (await videoState(display)).playing)
      .toBe(false);
  });

  test("pause, play and skip on the remote control the display", async ({
    remote,
    display,
  }) => {
    await queueVideo(remote);
    await remote.getByRole("button", { name: "Show queue" }).click();

    await expect
      .poll(() => videoState(display), { timeout: 60_000 })
      .toEqual({ src: true, playing: true });
    await expect(
      remote
        .getByRole("region", { name: "Now playing" })
        .getByText(VIDEO_TITLE)
        .first(),
    ).toBeVisible();

    await remote.getByRole("button", { name: "Pause", exact: true }).click();
    await expect
      .poll(() => videoState(display))
      .toEqual({ src: true, playing: false });

    await remote.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(() => videoState(display))
      .toEqual({ src: true, playing: true });

    await skipButton(remote).click();
    await expect
      .poll(() => videoState(display))
      .toEqual({ src: true, playing: false });
    await expect(
      remote.getByRole("contentinfo").getByText(VIDEO_TITLE),
    ).toHaveCount(0);
    await expect(skipButton(remote)).toHaveAttribute("aria-disabled", "true");
  });
});

async function queueVideo(remote: Page) {
  await remote.getByRole("link", { name: "YouTube", exact: true }).click();
  await remote.getByPlaceholder("YouTube video URL or ID").fill(VIDEO_ID);
  await remote.getByRole("button", { name: "Get Video Info" }).click();

  // YouTube sometimes answers a lookup with "Sign in to confirm you're not a
  // bot". Like a person would, reload the page (its address now names the
  // video) and look it up again.
  const title = remote.getByText(VIDEO_TITLE, { exact: true });
  const failure = remote.getByText("Unable to get video info");
  await expect(async () => {
    await expect(title.or(failure)).toBeVisible({ timeout: 30_000 });
    if (await failure.isVisible()) {
      const reason = await failure.textContent();
      await remote.reload();
      throw new Error(reason ?? "The video info lookup failed");
    }
  }).toPass({ intervals: [5_000, 10_000], timeout: 45_000 });

  // The remote queues it with /api/queueSong (and never GraphQL: see
  // forbidGraphql in fixtures.ts).
  const answer = remote.waitForResponse((res) =>
    res.url().endsWith("/api/queueSong"),
  );
  await remote.getByRole("button", { name: "Queue video" }).click();
  expect(await (await answer).json()).toMatchObject({ ok: true });
}

function skipButton(remote: Page) {
  return remote.getByRole("button", { name: "Skip", exact: true });
}

// The queue in the display's sidebar.
function displayQueue(display: Page) {
  return display.getByRole("list", { name: "Queue" });
}

// What the display's video player is doing with the test video.
async function videoState(display: Page) {
  return display.locator("video").evaluate(
    (video: HTMLVideoElement, videoId) => ({
      src: video.currentSrc.includes(videoId),
      playing: !video.paused && !video.ended,
    }),
    VIDEO_ID,
  );
}
