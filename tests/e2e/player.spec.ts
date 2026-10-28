// How the display plays the queue: it starts a song queued while nothing
// plays at once, not at its next 5-second check; it skips a song that can't
// play, once, and goes on with the next. No network: yt-dlp is a fake that
// "downloads" at once, a minute of black video
// (tests/fixtures/bin/yt-dlp-downloads-video) or an empty file the display
// can't play (yt-dlp-downloads).
import path from "path";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const fakeYtdlp = (name: string) =>
  path.resolve(
    __dirname,
    "..",
    "fixtures",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );

test.use({
  appEnv: { KARAFRIENDS_YTDLP_PATH: fakeYtdlp("yt-dlp-downloads-video") },
});

// The first event of a fresh /api/events stream: the live state.
async function liveState(remoconUrl: string) {
  const controller = new AbortController();
  const res = await fetch(new URL("api/events", remoconUrl), {
    signal: controller.signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The stream ended early: ${text}`);
      text += value;
      const data = text.match(/^data: (.*)$/m);
      if (data) return JSON.parse(data[1]).state;
    }
  } finally {
    controller.abort();
  }
}

// A phone's call to the API.
async function call(remoconUrl: string, method: string, input: object) {
  const res = await fetch(new URL(`api/${method}`, remoconUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Karafriends-Device-Id": "e2e-player-device",
      "X-Karafriends-Nickname": "e2e",
    },
    body: JSON.stringify(input),
  });
  return res.json();
}

// What's playing, as the phones see it.
async function nowPlaying(remoconUrl: string) {
  const state = await liveState(remoconUrl);
  return [state.currentSong?.name ?? null, state.playbackState];
}

// The songs the display took off the queue, newest first.
async function history(remoconUrl: string): Promise<string[]> {
  const { items } = await call(remoconUrl, "history", {});
  return items.map((item: { name: string }) => item.name);
}

const queueNico = (remoconUrl: string, name: string) =>
  call(remoconUrl, "queueSong", {
    kind: "nico",
    songId: "sm9",
    name,
    artistName: "E2E artist",
    playtime: 60,
  });

test("a song queued while the display waits starts within 2 seconds", async ({
  karafriends,
  display,
}) => {
  // The display is up, and waiting: its idle screen shows.
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toBeVisible();
  await display.waitForTimeout(1_000);

  expect(
    await queueNico(karafriends.remoconUrl, "E2E player song"),
  ).toMatchObject({ ok: true });
  const queuedAt = Date.now();

  // The download takes a moment, then the display takes the song.
  await expect
    .poll(
      async () => (await liveState(karafriends.remoconUrl)).currentSong?.name,
      { timeout: 2_000, intervals: [100] },
    )
    .toBe("E2E player song");
  expect(Date.now() - queuedAt).toBeLessThan(2_000);

  // The corner says so, and the idle screen made way for the video.
  const corner = display.getByRole("status").filter({ hasText: "Now playing" });
  await expect(corner).toContainText("E2E player song");
  const artist = corner.getByText("E2E artist", { exact: true }).first();
  await expect(artist).toBeVisible();
  await expect(corner.getByText("e2e", { exact: true }).first()).toBeVisible();
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toHaveCount(0);
});

test.describe("a download the display can't play", () => {
  test.use({
    appEnv: { KARAFRIENDS_YTDLP_PATH: fakeYtdlp("yt-dlp-downloads") },
  });

  test("is skipped, and the display waits for the next song", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    await expect(
      display.getByRole("img", { name: "QR code for the remote" }),
    ).toBeVisible();

    expect(await queueNico(remoconUrl, "E2E empty song")).toMatchObject({
      ok: true,
    });

    const corner = display
      .getByRole("status")
      .filter({ hasText: "Couldn't play" });
    await expect(corner).toContainText("E2E empty song");
    // The phones' controls come back: nothing plays, nothing is skipping.
    await expect.poll(() => nowPlaying(remoconUrl)).toEqual([null, "WAITING"]);
    expect(await history(remoconUrl)).toEqual(["E2E empty song"]);
    await expect(
      display.getByRole("img", { name: "QR code for the remote" }),
    ).toBeVisible();
  });
});

test.describe("a queued song whose files are missing", () => {
  const user = { deviceId: "e2e-player-device", nickname: "e2e" };
  const at = (n: number) => String(Date.UTC(2026, 0, 1) + n);
  // A Joysound song with neither its video nor its lyrics: both fail to
  // load, and the display must skip it once, not once for each. The
  // Niconico songs after it play (the fixture gives them a black video).
  const nico = (n: number) => ({
    kind: "nico",
    songId: `sm8000${n}`,
    name: `E2E next song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: at(n),
    user,
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        {
          kind: "joysound",
          songId: "e2e-missing",
          name: "E2E missing song",
          artistName: "E2E artist",
          playtime: 60,
          timestamp: at(0),
          user,
          lyricsMode: "kana",
          youtubeVideoId: null,
        },
        nico(1),
        nico(2),
      ],
      songHistory: [],
      // Saved as paused, the display takes the first song at its first
      // check, 5 s after it loads, not at once: time to watch the corner.
      playbackState: "PAUSED",
    },
  });

  test("is skipped once, and each song after it starts once", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    const corner = display
      .getByRole("status")
      .filter({ hasText: "Couldn't play" });
    await expect(corner).toContainText("E2E missing song", {
      timeout: 15_000,
    });
    await expect
      .poll(() => nowPlaying(remoconUrl))
      .toEqual(["E2E next song 1", "PLAYING"]);
    await expect(display.getByText("Couldn't play")).toHaveCount(1);

    // Past a 5-second check, song 1 still plays and song 2 waits: nothing
    // else asked for a song.
    await display.waitForTimeout(6_000);
    expect(await nowPlaying(remoconUrl)).toEqual([
      "E2E next song 1",
      "PLAYING",
    ]);
    expect((await liveState(remoconUrl)).queue).toHaveLength(1);
    expect(await history(remoconUrl)).toEqual([
      "E2E next song 1",
      "E2E missing song",
    ]);

    // A phone skips song 1, then song 2; then the display waits.
    expect(
      await call(remoconUrl, "setPlaybackState", { playbackState: "SKIPPING" }),
    ).toBe(true);
    await expect
      .poll(() => nowPlaying(remoconUrl))
      .toEqual(["E2E next song 2", "PLAYING"]);
    expect(
      await call(remoconUrl, "setPlaybackState", { playbackState: "SKIPPING" }),
    ).toBe(true);
    await expect.poll(() => nowPlaying(remoconUrl)).toEqual([null, "WAITING"]);
    expect(await history(remoconUrl)).toEqual([
      "E2E next song 2",
      "E2E next song 1",
      "E2E missing song",
    ]);

    // The video let go of song 2, so a Play from a phone now can't start
    // it over behind the idle screen.
    const video = display.locator("video");
    await expect
      .poll(() =>
        video.evaluate((v: HTMLVideoElement) => v.hasAttribute("src")),
      )
      .toBe(false);
    expect(
      await call(remoconUrl, "setPlaybackState", { playbackState: "PLAYING" }),
    ).toBe(true);
    await display.waitForTimeout(1_000);
    expect(
      await video.evaluate((v: HTMLVideoElement) => [
        v.readyState,
        v.currentTime,
      ]),
      // HAVE_NOTHING, at the start.
    ).toEqual([0, 0]);
  });
});

test.describe("where the song really is", () => {
  // Song 1 was queued as 100 s long, but its video (the fixture's black
  // one) is a minute. Song 2 waits behind it.
  const nico = (n: number, playtime: number) => ({
    kind: "nico",
    songId: `sm8100${n}`,
    name: `E2E timed song ${n}`,
    artistName: "E2E artist",
    playtime,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: { deviceId: "e2e-someone", nickname: "someone" },
  });
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [nico(1, 100), nico(2, 60)],
      songHistory: [],
      playbackState: "WAITING",
    },
  });

  // Song 1's video's length, in whole seconds, once it plays and the phones
  // have it in place of the 100 s it was queued with.
  async function songLength(display: Page, remoconUrl: string) {
    const video = display.locator("video");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.duration || 0), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const length = Math.round(
      await video.evaluate((v: HTMLVideoElement) => v.duration),
    );
    expect(length).toBeLessThan(100);
    await expect
      .poll(async () => (await liveState(remoconUrl)).currentSong?.playtime)
      .toBe(length);
    return length;
  }

  // The host moves the display's video to seconds in.
  const seek = (display: Page, seconds: number) =>
    display.locator("video").evaluate((v: HTMLVideoElement, to) => {
      v.currentTime = to;
    }, seconds);

  test("the waits follow the video's length, a seek and its own pause", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    // A first launch opens Settings; close it, so Up next shows.
    const settings = display.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await display.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    const video = display.locator("video");
    const next = display
      .getByRole("region", { name: "Up next" })
      .getByRole("listitem")
      .first();
    // Song 2's wait on the TV, in seconds: "in 0:58".
    const wait = async () => {
      const [, minutes, seconds] = (await next.innerText()).match(
        /in (\d+):(\d\d)/,
      )!;
      return Number(minutes) * 60 + Number(seconds);
    };
    // How far the phones' reckoning of song 1 is from its video, in seconds.
    const drift = async () => {
      const state = await liveState(remoconUrl);
      const position = await video.evaluate(
        (v: HTMLVideoElement) => v.currentTime,
      );
      const played =
        (state.currentSongPausedSince ?? Date.now()) -
        state.currentSongStartedAt -
        state.currentSongPausedMs;
      return Math.abs(played / 1000 - position);
    };

    // Song 1 plays, and the TV counts from its video's length.
    const length = await songLength(display, remoconUrl);
    await expect(next).toHaveText(/E2E timed song 2/);
    await expect.poll(wait).toBeLessThanOrEqual(length);

    // The host seeks to halfway: the wait drops to what is left.
    await seek(display, length / 2);
    await expect.poll(wait).toBeLessThanOrEqual(length / 2 + 1);
    expect(await wait()).toBeGreaterThanOrEqual(length / 2 - 3);
    expect(await drift()).toBeLessThan(1);
    // A song queued now waits for that, and song 2.
    const queued = await queueNico(remoconUrl, "E2E queued song");
    expect(queued).toMatchObject({ ok: true });
    expect(Math.abs(queued.eta - ((await wait()) + 60))).toBeLessThanOrEqual(2);

    // The host pauses the video itself, not from a phone: the wait stops.
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    await expect
      .poll(async () => (await liveState(remoconUrl)).currentSongPausedSince)
      .not.toBeNull();
    const paused = await wait();
    await display.waitForTimeout(2_000);
    expect(await wait()).toBe(paused);
    expect(await drift()).toBeLessThan(1);

    // It plays on, and back near the start the wait goes up again.
    await video.evaluate((v: HTMLVideoElement) => void v.play());
    await seek(display, 5);
    await expect.poll(wait).toBeGreaterThanOrEqual(length - 8);
    expect(await wait()).toBeLessThanOrEqual(length - 4);
    await expect
      .poll(async () => (await liveState(remoconUrl)).currentSongPausedSince)
      .toBeNull();
    expect(await drift()).toBeLessThan(1);
  });
});
