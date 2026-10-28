import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures";

// A Marquee's text (the element getByText finds) and its box: whether it
// slides, and the animation's settings.
const marquee = (text: Locator) =>
  text.evaluate((el) => {
    const box = el.parentElement!;
    const style = getComputedStyle(el);
    return {
      sliding: box.hasAttribute("data-marquee"),
      name: style.animationName,
      shift: parseFloat(box.style.getPropertyValue("--kf-marquee-shift")),
      seconds: parseFloat(style.animationDuration),
      delay: style.animationDelay,
      iterations: style.animationIterationCount,
      direction: style.animationDirection,
      ellipsis: style.textOverflow === "ellipsis",
      fits: el.getBoundingClientRect().width <= box.clientWidth + 0.5,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });

// Where a sliding text is (its x offset, px) at points of its animation,
// which is paused there: before it starts, held at the start, halfway,
// at the end (and how far its end is from the box's), held there on the
// way back, and back at the start.
const slidePath = (text: Locator) =>
  text.evaluate((el) => {
    const box = el.parentElement!;
    const [animation] = el.getAnimations();
    animation.pause();
    const timing = animation.effect!.getComputedTiming();
    const delay = timing.delay!;
    const duration = timing.duration as number;
    const hold =
      (parseFloat(box.style.getPropertyValue("--kf-marquee-hold")) / 100) *
      duration;
    const at = (ms: number) => {
      animation.currentTime = ms;
      const transform = getComputedStyle(el).transform;
      return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
    };
    const path = {
      waiting: at(delay / 2),
      holding: at(delay + hold / 2),
      halfway: at(delay + duration / 2),
      end: at(delay + duration),
      endGap:
        box.getBoundingClientRect().right - el.getBoundingClientRect().right,
      holdingAtEnd: at(delay + duration + hold / 2),
      back: at(delay + 2 * duration - hold / 2),
    };
    animation.play();
    return path;
  });

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
    // Small, bottom-left, above the strip.
    const box = (await qrCode.boundingBox())!;
    const strip = (await display
      .getByRole("region", { name: "Up next" })
      .boundingBox())!;
    const [width, rem] = await display.evaluate(() => [
      window.innerWidth,
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    ]);
    expect(box.x + box.width).toBeLessThan(width / 2);
    expect(box.y).toBeGreaterThan(strip.y / 2);
    expect(box.y + box.height).toBeLessThan(strip.y);
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
    // Song 1 (60 s) has started, leaving song 2 up next. (A poll stops at
    // a throw, which innerText of two songs is.)
    await expect(next).toHaveCount(1, { timeout: 15_000 });
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

test.describe("long names on the TV", () => {
  // Song 1 plays first, with a long title and artist in the corner; song 2
  // has a title too long for its place in the strip, song 3 a short title
  // and a long artist.
  const LONG_TITLE =
    "残酷な天使のテーゼ (TVアニメ『新世紀エヴァンゲリオン』オープニングテーマ) E2E long title";
  const LONG_ARTIST =
    "E2E artist with a name far too long for one line of the corner or the strip";
  const song = (n: number, name: string, artistName: string) => ({
    kind: "nico",
    songId: `sm7200${n}`,
    name,
    artistName,
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-mio", nickname: "Mio" },
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        song(1, `${LONG_TITLE} 1`, LONG_ARTIST),
        song(2, `${LONG_TITLE} 2`, "E2E artist"),
        song(3, "E2E short", LONG_ARTIST),
      ],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  test("a title or artist that doesn't fit slides to its end and back; one that fits stays still", async ({
    display,
    karafriends,
  }) => {
    await display.setViewportSize({ width: 1920, height: 1080 });
    await display.emulateMedia({ reducedMotion: "no-preference" });

    // The corner: the title wraps, all of it at once (the card is up for
    // 4 s, too short to read one sliding); the artist slides at once.
    const corner = display
      .getByRole("status")
      .filter({ hasText: "Now playing" });
    const cornerArtist = corner.getByText(LONG_ARTIST);
    // (Measured before the first frame it shows in.)
    await expect
      .poll(async () => (await marquee(cornerArtist)).sliding)
      .toBe(true);
    expect(await marquee(cornerArtist)).toMatchObject({
      name: "kfMarquee",
      delay: "0s",
    });
    expect(await marquee(corner.getByText(`${LONG_TITLE} 1`))).toMatchObject({
      sliding: false,
      fits: true,
    });

    const settings = display.getByRole("dialog", { name: "Settings" });
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    const items = display
      .getByRole("region", { name: "Up next" })
      .getByRole("listitem");
    await expect(items).toHaveCount(2);
    const title = items.nth(0).getByText(`${LONG_TITLE} 2`);
    const short = items.nth(1).getByText("E2E short", { exact: true });
    const artist = items.nth(1).getByText(LONG_ARTIST);

    // The long title slides, one way and back, over and over, at 2rem a
    // second (32px at 1080p) with 2 s still at each end.
    await expect.poll(async () => (await marquee(title)).sliding).toBe(true);
    const slide = await marquee(title);
    expect(slide).toMatchObject({
      sliding: true,
      name: "kfMarquee",
      iterations: "infinite",
      direction: "alternate",
      ellipsis: false,
    });
    expect(slide.rem).toBe(16);
    const speed = slide.shift / (slide.seconds - 2);
    expect(speed).toBeGreaterThan(30);
    expect(speed).toBeLessThan(34);
    // The short one is still; the long artist beside it slides, starting
    // at another time than the title before it.
    expect(await marquee(short)).toMatchObject({
      sliding: false,
      name: "none",
      fits: true,
    });
    const artistSlide = await marquee(artist);
    expect(artistSlide.name).toBe("kfMarquee");
    expect(artistSlide.delay).not.toBe(slide.delay);

    // Still before it starts and for a while at each end; at the end, the
    // text's end is at the box's.
    const path = await slidePath(title);
    expect(path.waiting).toBeCloseTo(0, 1);
    expect(path.holding).toBeCloseTo(0, 1);
    expect(path.halfway).toBeCloseTo(-slide.shift / 2, 0);
    expect(path.end).toBeCloseTo(-slide.shift, 0);
    expect(path.endGap).toBeGreaterThanOrEqual(-0.5);
    expect(path.endGap).toBeLessThanOrEqual(1.5);
    expect(path.holdingAtEnd).toBeCloseTo(-slide.shift, 0);
    expect(path.back).toBeCloseTo(0, 1);

    // The long song keeps to its width, and the next one follows it on the
    // screen.
    const [first, second] = [
      (await items.nth(0).boundingBox())!,
      (await items.nth(1).boundingBox())!,
    ];
    expect(first.width).toBeLessThanOrEqual(56.25 * 16 + 0.5);
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.width - 1);
    expect(second.x).toBeLessThan(1920);

    // Asked for less motion, it stays still and ends in an ellipsis.
    await display.emulateMedia({ reducedMotion: "reduce" });
    expect(await marquee(title)).toMatchObject({
      name: "none",
      ellipsis: true,
      fits: true,
    });
    await display.emulateMedia({ reducedMotion: "no-preference" });
    expect((await marquee(title)).name).toBe("kfMarquee");

    expect(karafriends.displayErrors).toEqual([]);
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
    // The corner, for the 4 seconds it shows song 1: the singer's initial
    // and whole nickname.
    const corner = display
      .getByRole("status")
      .filter({ hasText: "Now playing" });
    await expect(corner.getByText("こい", { exact: true })).toBeVisible();
    await expect(corner.getByText("ほしのげん", { exact: true })).toBeVisible();
    await expect(corner.getByText("K", { exact: true })).toBeVisible();
    const cornerNickname = corner.getByText("Ken", { exact: true });
    await expect(cornerNickname).toBeVisible();
    expect((await cornerNickname.boundingBox())!.width).toBeGreaterThan(10);
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
    for (const text of ["senbonzakura", "kurousapii", "K"]) {
      await expect(rows.nth(0).getByText(text, { exact: true })).toBeVisible();
    }
    await expect(rows.nth(0)).not.toContainText("千本桜");
    // As written: no mode, and LiSA has no reading to give.
    for (const text of ["紅蓮華", "LiSA", "K"]) {
      await expect(rows.nth(1).getByText(text, { exact: true })).toBeVisible();
    }
    for (const row of await rows.allTextContents()) {
      expect(row).not.toContain("·");
    }
    // Up next shows the singer as the initial only; the nickname is there
    // for screen readers, but takes no room.
    for (const row of await rows.all()) {
      await expect(row).toContainText("Ken");
      const nickname = row.getByText("Ken", { exact: true });
      expect((await nickname.boundingBox())!.width).toBeLessThanOrEqual(1);
    }
  });
});
