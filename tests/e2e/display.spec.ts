import type { Locator } from "@playwright/test";

import { secondsLeft } from "../../src/common/currentSong";
import {
  apiCall,
  currentSongKey,
  defaultAddress,
  expect,
  liveState,
  test,
} from "./fixtures";

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

  // A profile with a config.yaml opens on the idle screen, even without a
  // login (a first start opens the setup screen: settings.spec.ts).
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(display.getByRole("dialog")).toHaveCount(0);

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
  // This computer's LAN address: no mDNS name.
  const address = await defaultAddress(display);
  expect(address).toMatch(
    new RegExp(`^(\\d+\\.){3}\\d+:${port}$|^localhost:${port}$`),
  );
  await expect(display.getByText(address)).toBeVisible();
  await expect(
    display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
  ).toHaveCount(0);

  // S, or the gear, opens Settings: the QR code's address is under Party,
  // the microphones under Sound.
  await display.keyboard.press("s");
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "Party" }).click();
  await expect(settings.locator(`option[value="${address}"]`)).toHaveCount(1);
  await settings.getByRole("tab", { name: "Sound" }).click();
  await expect(settings.getByLabel("Add a microphone")).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
  await display.getByRole("button", { name: "Settings" }).click();
  await expect(settings.getByLabel("Add a microphone")).toBeVisible();
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

  test("an emote rises from the top of the up-next strip, not behind it", async ({
    display,
    karafriends,
  }) => {
    const upNext = display.getByRole("region", { name: "Up next" });
    await expect(upNext.getByRole("listitem")).toHaveText([/E2E strip song 2/]);

    expect(
      await apiCall(karafriends.remoconUrl, "sendEmote", { emote: "🎉" }),
    ).toMatchObject({ status: 200 });
    const emote = display.locator("#effects > div");
    await expect(emote).toHaveText("🎉");
    // The emotes' layer ends where the strip starts, so an emote starts
    // above it; and it's over the video, the whole width.
    const [layer, strip, stage] = await Promise.all(
      [display.locator("#effects"), upNext, display.locator(".appStage")].map(
        async (el) => (await el.boundingBox())!,
      ),
    );
    expect(Math.abs(layer.y + layer.height - strip.y)).toBeLessThan(1);
    expect(layer).toEqual(stage);
    // Without the strip, from the bottom of the screen.
    await display.keyboard.press("q");
    await expect(upNext).toHaveCount(0);
    const full = (await display.locator("#effects").boundingBox())!;
    expect(full.y + full.height).toBeCloseTo(
      await display.evaluate(() => window.innerHeight),
      0,
    );
  });

  test("Q hides and shows the up-next strip", async ({ display }) => {
    const upNext = display.getByRole("region", { name: "Up next" });
    await expect(upNext.getByRole("listitem")).toHaveText([/E2E strip song 2/]);
    await display.keyboard.press("q");
    await expect(upNext).toHaveCount(0);
    await display.keyboard.press("q");
    await expect(upNext.getByRole("listitem")).toHaveText([/E2E strip song 2/]);
  });

  test("the QR code stays in the corner, without the address, but not over Settings", async ({
    display,
  }) => {
    const settings = display.getByRole("dialog", { name: "Settings" });
    const qrCode = display.getByRole("img", { name: "QR code for the remote" });
    const address = display.getByText(await defaultAddress(display));
    // Song 1 plays once song 2 is up next.
    await expect(
      display.getByRole("region", { name: "Up next" }).getByRole("listitem"),
    ).toHaveText([/E2E strip song 2/]);
    await expect(qrCode).toBeVisible();
    // The code alone: the address and "Scan to join" are the idle screen's.
    await expect(address).toHaveCount(0);
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
    // About 7.25rem square: the code and a 2-module white border, 29
    // modules across, each a whole number of pixels, so within half a
    // module per module of it.
    expect(Math.abs(box.width - 7.25 * rem)).toBeLessThanOrEqual(29 / 2);
    expect(box.height).toBeCloseTo(box.width, 0);
    const canvasWidth = await qrCode.evaluate(
      (canvas: HTMLCanvasElement) => canvas.width,
    );
    expect(canvasWidth % 29).toBe(0);

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
    // Song 2's wait is what is left of song 1, by the server's clock (the
    // display's reports of its video), as the phones see it too.
    const { remoconUrl } = karafriends;
    const left = async () => {
      const state = await liveState(remoconUrl);
      return secondsLeft(state.currentSong!.playtime!, state, Date.now());
    };
    await expect
      .poll(async () => Math.abs((await wait()) - (await left())))
      .toBeLessThanOrEqual(1);
    // And it counts down.
    const before = await wait();
    await expect.poll(wait).toBeLessThan(before);

    // A phone pauses (anyone may, without supervised mode).
    expect(
      (
        await apiCall(remoconUrl, "setPlaybackState", {
          playbackState: "PAUSED",
          song: await currentSongKey(remoconUrl),
        })
      ).body,
    ).toBe(true);
    await expect
      .poll(() =>
        display.locator("video").evaluate((v: HTMLVideoElement) => v.paused),
      )
      .toBe(true);
    // The countdown stops once the video's pause reaches the server (the
    // display reports it: reportSongPosition), a moment later: the wait is
    // then what was left when it paused, and stays there.
    await expect
      .poll(async () => (await liveState(remoconUrl)).currentSongPausedSince)
      .not.toBeNull();
    const paused = await left();
    await expect.poll(wait).toBe(paused);
    await display.waitForTimeout(2_000);
    expect(await wait()).toBe(paused);
    expect(await left()).toBe(paused);
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

// In full screen the mouse pointer hides when the mouse is still, and shows
// as it moves; never under Settings. The window stays hidden: the test tells
// the display it's in full screen as the main process would (F11), rather
// than take over the screen.
test("in full screen, a still mouse pointer hides, and not under Settings; out of it, the window moves by its top", async ({
  karafriends,
  display,
}) => {
  test.slow();
  const pointerHidden = () =>
    display.evaluate(() => document.body.classList.contains("pointerHidden"));
  const fullScreen = (value: boolean) =>
    karafriends.app.evaluate(({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        "window:fullScreen",
        value,
      );
    }, value);
  // HIDE_AFTER_MS (src/renderer/idleCursor.ts), and a little.
  const still = () => display.waitForTimeout(3500);

  await expect(display.getByText("Scan to join")).toBeVisible();
  // Not in full screen (the window is hidden): it stays, and the window
  // (which has no frame) moves by the strip along its top.
  const dragBar = display.locator(".windowDragBar");
  await expect(dragBar).toHaveCount(1);
  expect(
    await dragBar.evaluate((bar) =>
      getComputedStyle(bar).getPropertyValue("-webkit-app-region"),
    ),
  ).toBe("drag");
  expect(
    await display
      .getByRole("button", { name: "Settings" })
      .evaluate((button) =>
        getComputedStyle(button).getPropertyValue("-webkit-app-region"),
      ),
  ).toBe("no-drag");
  await still();
  expect(await pointerHidden()).toBe(false);

  await fullScreen(true);
  // In full screen, nothing to drag.
  await expect(dragBar).toHaveCount(0);
  await expect.poll(pointerHidden, { timeout: 6000 }).toBe(true);
  await display.mouse.move(200, 200);
  expect(await pointerHidden()).toBe(false);
  await expect.poll(pointerHidden, { timeout: 6000 }).toBe(true);

  // Settings is for the mouse: shown, however still.
  await display.keyboard.press("s");
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  expect(await pointerHidden()).toBe(false);
  await still();
  expect(await pointerHidden()).toBe(false);
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
  await expect.poll(pointerHidden, { timeout: 6000 }).toBe(true);

  // Out of full screen, it shows, and the strip is back.
  await fullScreen(false);
  await expect.poll(pointerHidden).toBe(false);
  await expect(dragBar).toHaveCount(1);
});

// A long queue on the idle screen: the songs that fit whole, then how many
// more, and how many in all, never off the screen; at a bigger UI scale,
// fewer fit and the count follows. The display is held idle (no song
// starts) so the screen stays up.
test.describe("a long queue on the idle screen", () => {
  const people = ["Ken", "Mio", "Yuki"];
  test.use({
    holdIdle: true,
    seedQueue: {
      currentSong: null,
      songQueue: Array.from({ length: 30 }, (_, n) => ({
        kind: "nico",
        songId: `sm9300${n + 10}`,
        name: `Idle song ${n + 1}`,
        artistName: "E2E artist",
        playtime: 200,
        timestamp: String(Date.UTC(2026, 0, 1) + n),
        user: { deviceId: `e2e-${people[n % 3]}`, nickname: people[n % 3] },
      })),
      songHistory: [],
      playbackState: "PAUSED",
    },
  });

  test("lists the songs that fit, and counts the rest", async ({ display }) => {
    await display.setViewportSize({ width: 1920, height: 1080 });
    const upNext = display.getByRole("region", { name: "Up next" });
    const rows = upNext.getByRole("listitem");
    // Listed and counted: every song, once.
    const shown = async () => {
      await expect(upNext.getByText(/^\+\d+ more$/)).toBeVisible();
      const listed = await rows.count();
      const more = Number(
        (await upNext.getByText(/^\+\d+ more$/).textContent())!.match(
          /\d+/,
        )![0],
      );
      expect(listed + more).toBe(30);
      // Whole, and on the screen.
      for (const row of await rows.all()) {
        const box = (await row.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(1080);
      }
      return listed;
    };
    await expect(upNext).toContainText("30 songs");
    await expect(rows.first()).toContainText("Idle song 1");
    const atFull = await shown();
    expect(atFull).toBeGreaterThanOrEqual(3);

    await display.evaluate(() => localStorage.setItem("uiScale", "150"));
    await display.reload();
    await expect(upNext).toContainText("30 songs");
    await expect.poll(() => rows.count()).toBeLessThan(atFull);
    expect(await shown()).toBeGreaterThanOrEqual(1);
  });
});
