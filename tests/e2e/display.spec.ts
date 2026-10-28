import { expect, test } from "./fixtures";

test("the display opens on its idle screen without console errors", async ({
  display,
  karafriends,
}) => {
  await expect(display).toHaveTitle("karafriends");

  // A fresh profile has no DAM or Joysound login, so Settings opens first.
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByText(
      "Add your DAM or Joysound login to search their catalogs. YouTube works without one.",
    ),
  ).toBeVisible();
  await display.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  // The idle screen: the remote's QR code and address, and an empty queue.
  // The address carries the remote's port, which the preload got from the
  // main process.
  const { port } = new URL(karafriends.remoconUrl);
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toBeVisible();
  await expect(display.getByText("Scan to join")).toBeVisible();
  await expect(display.getByText(`karafriends.local:${port}`)).toBeVisible();
  await expect(
    display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
  ).toHaveCount(0);

  // S, or the gear, opens Settings: the QR code's address and the
  // microphones are there.
  await display.keyboard.press("s");
  await expect(settings).toBeVisible();
  await expect(
    settings.locator(`option[value="karafriends.local:${port}"]`),
  ).toHaveCount(1);
  await expect(
    settings.getByRole("button", { name: "Clear mics" }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
  await display.getByRole("button", { name: "Settings" }).click();
  await expect(settings).toBeVisible();
  await display.keyboard.press("Escape");

  // Nothing is playing.
  const video = display.locator("video");
  await expect(video).toBeAttached();
  expect(
    await video.evaluate((v: HTMLVideoElement) => ({
      paused: v.paused,
      src: v.currentSrc,
    })),
  ).toEqual({ paused: true, src: "" });

  // The display asks for the next song every 5 seconds; give it a couple of
  // rounds so errors from talking to the server have time to show up.
  await display.waitForTimeout(11_000);
  expect(karafriends.displayErrors).toEqual([]);
});

test.describe("while a song plays", () => {
  // Niconico songs (the fixture gives them a black video): song 1 starts
  // at the display's first check, and song 2 is up next.
  const song = (n: number) => ({
    kind: "nico",
    songId: `sm7000${n}`,
    name: `E2E strip song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-someone", nickname: "someone" },
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [song(1), song(2)],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("Q hides and shows the up-next strip", async ({ display }) => {
    // A first launch opens Settings; close it, so Q reaches the display.
    const settings = display.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    const upNext = display.getByRole("region", { name: "Up next" });
    await expect(upNext.getByRole("listitem")).toHaveText([/E2E strip song 2/]);
    await display.keyboard.press("q");
    await expect(upNext).toHaveCount(0);
    await display.keyboard.press("q");
    await expect(upNext.getByRole("listitem")).toHaveText([/E2E strip song 2/]);
  });

  test("the wait counts down, and stops while a phone pauses", async ({
    display,
    karafriends,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    const next = display
      .getByRole("region", { name: "Up next" })
      .getByRole("listitem");
    // Song 2's wait, in seconds: "someone · in 0:58".
    const wait = async () => {
      const [, minutes, seconds] = (await next.innerText()).match(
        /in (\d+):(\d\d)/,
      )!;
      return Number(minutes) * 60 + Number(seconds);
    };
    // Song 1 (60 s) has started.
    await expect.poll(wait, { timeout: 15_000 }).toBeLessThan(60);

    const before = await wait();
    await display.waitForTimeout(2_000);
    const after = await wait();
    expect(before - after).toBeGreaterThanOrEqual(1);
    expect(before - after).toBeLessThanOrEqual(3);

    // A phone pauses (anyone may, without supervised mode).
    const res = await fetch(
      new URL("api/setPlaybackState", karafriends.remoconUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Karafriends-Device-Id": "e2e-display-device",
          "X-Karafriends-Nickname": "e2e",
        },
        body: JSON.stringify({ playbackState: "PAUSED" }),
      },
    );
    expect(await res.json()).toBe(true);
    await expect
      .poll(() =>
        display.locator("video").evaluate((v: HTMLVideoElement) => v.paused),
      )
      .toBe(true);
    const paused = await wait();
    await display.waitForTimeout(2_000);
    expect(await wait()).toBe(paused);
  });
});
