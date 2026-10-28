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
  // Only the big one: the small one in the corner is for while a song plays.
  const { port } = new URL(karafriends.remoconUrl);
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toHaveCount(1);
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
  await expect(settings.getByLabel("Add a microphone")).toBeVisible();
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

  test("the QR code and the address stay in the corner, but not over Settings", async ({
    display,
    karafriends,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    const qrCode = display.getByRole("img", { name: "QR code for the remote" });
    const address = display.getByText(
      `karafriends.local:${new URL(karafriends.remoconUrl).port}`,
    );
    await display.keyboard.press("Escape");
    // Song 1 plays once song 2 is up next.
    await expect(
      display.getByRole("region", { name: "Up next" }).getByRole("listitem"),
    ).toHaveText([/E2E strip song 2/]);
    await expect(qrCode).toBeVisible();
    await expect(address).toBeVisible();
    await expect(display.getByText("Scan to join")).toHaveCount(0);
    // Small and top-left, clear of the lyrics along the bottom.
    const box = (await qrCode.boundingBox())!;
    const strip = (await display
      .getByRole("region", { name: "Up next" })
      .boundingBox())!;
    const [width, rem] = await display.evaluate(() => [
      window.innerWidth,
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    ]);
    expect(box.x + box.width).toBeLessThan(width / 2);
    expect(box.y + box.height).toBeLessThan(strip.y / 2);
    expect(box.width).toBeCloseTo(8 * rem, 0);

    await display.keyboard.press("s");
    await expect(settings).toBeVisible();
    await expect(qrCode).toHaveCount(0);
    await display.keyboard.press("Escape");
    await expect(qrCode).toBeVisible();
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
    // Song 2's wait, in seconds: "in 0:58".
    const wait = async () => {
      const [, minutes, seconds] = (await next.innerText()).match(
        /in (\d+):(\d\d)/,
      )!;
      return Number(minutes) * 60 + Number(seconds);
    };
    // Song 1 (60 s) has started: until then, it is up next too.
    await expect(next).toHaveText([/E2E strip song 2/]);
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

test.describe("readings and singers on the TV", () => {
  // Niconico songs again, queued by phones that read kana (song 1, which
  // starts at once), romaji (song 2) and as written (song 3).
  const song = (n: number, fields: object) => ({
    kind: "nico",
    songId: `sm7100${n}`,
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-ken", nickname: "Ken" },
    ...fields,
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        song(1, {
          name: "恋",
          artistName: "星野 源",
          nameYomi: "こい",
          artistNameYomi: "ほしのげん",
          readingsMode: "kana",
        }),
        song(2, {
          name: "千本桜",
          artistName: "黒うさP",
          nameYomi: "せんぼんざくら",
          artistNameYomi: "くろうさぴー",
          readingsMode: "romaji",
        }),
        song(3, { name: "紅蓮華", artistName: "LiSA", nameYomi: "ぐれんげ" }),
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("the corner and the strip show the queuer's reading instead of the text, and the artist apart from the singer", async ({
    display,
  }) => {
    // The corner, for the 4 seconds it shows song 1.
    const corner = display
      .getByRole("status")
      .filter({ hasText: "Now playing" });
    await expect(corner.getByText("こい", { exact: true })).toBeVisible();
    await expect(corner.getByText("ほしのげん", { exact: true })).toBeVisible();
    await expect(corner.getByText("Ken", { exact: true })).toBeVisible();
    await expect(corner).not.toContainText("恋");
    await expect(corner).not.toContainText("·");

    const settings = display.getByRole("dialog", { name: "Settings" });
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    const rows = display
      .getByRole("region", { name: "Up next" })
      .getByRole("listitem");
    await expect(rows).toHaveCount(2);
    // Each its own element: an artist joined to the singer wouldn't match.
    for (const text of ["senbonzakura", "kurousapii", "Ken"]) {
      await expect(rows.nth(0).getByText(text, { exact: true })).toBeVisible();
    }
    await expect(rows.nth(0)).not.toContainText("千本桜");
    // As written: no mode, and LiSA has no reading to give.
    for (const text of ["紅蓮華", "LiSA", "Ken"]) {
      await expect(rows.nth(1).getByText(text, { exact: true })).toBeVisible();
    }
    for (const row of await rows.allTextContents()) {
      expect(row).not.toContain("·");
    }
  });
});
