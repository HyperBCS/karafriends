// How the display plays the queue: it starts a song queued while nothing
// plays at once, not at its next 5-second check; it skips a song that can't
// play, once, and goes on with the next. No network: yt-dlp is a fake that
// "downloads" at once, a minute of black video
// (tests/fixtures/bin/yt-dlp-downloads-video) or an empty file the display
// can't play (yt-dlp-downloads). A Joysound song's lyrics keep only the
// textures of the lines around now.
import type { ElectronApplication, Page } from "@playwright/test";

import { buildJoy02, type Joy02Event, joy02Events } from "../fixtures/joy02";
import {
  apiCall,
  currentSongKey,
  displayCall,
  anyOf,
  expect,
  fakeJoysoundDownload,
  fakeTool,
  liveState,
  NICKNAME,
  test,
} from "./fixtures";

test.use({
  appEnv: { KARAFRIENDS_YTDLP_PATH: fakeTool("yt-dlp-downloads-video") },
});

// A phone's call to the API: its answer.
async function call(remoconUrl: string, method: string, input: object) {
  return (await apiCall(remoconUrl, method, input)).body;
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
    appEnv: { KARAFRIENDS_YTDLP_PATH: fakeTool("yt-dlp-downloads") },
    // The empty file, as the video element reports it.
    allowDisplayErrors: anyOf(
      /^Failed to load resource: net::ERR_REQUEST_RANGE_NOT_SATISFIABLE$/,
      /^The video failed: MEDIA_ELEMENT_ERROR: Format error$/,
      /^NotSupportedError: Failed to load because no supported source was found\.$/,
    ),
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
  // The Joysound song's video and lyrics.
  test.use({
    allowDisplayErrors: anyOf(
      /^Failed to load resource: net::ERR_FILE_NOT_FOUND$/,
      /^Couldn't load the lyrics for e2e-missing: /,
    ),
  });
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
    const skip = async (song: string) =>
      call(remoconUrl, "setPlaybackState", { playbackState: "SKIPPING", song });
    const song1 = await currentSongKey(remoconUrl);
    expect(await skip(song1)).toBe(true);
    await expect
      .poll(() => nowPlaying(remoconUrl))
      .toEqual(["E2E next song 2", "PLAYING"]);
    // A second Skip meant for song 1, landing late, doesn't skip song 2.
    expect(await skip(song1)).toBe(false);
    await display.waitForTimeout(1_000);
    expect(await nowPlaying(remoconUrl)).toEqual([
      "E2E next song 2",
      "PLAYING",
    ]);
    const song2 = await currentSongKey(remoconUrl);
    expect(await skip(song2)).toBe(true);
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
    // Nor will the server take one: no song is current.
    expect(
      await call(remoconUrl, "setPlaybackState", {
        playbackState: "PLAYING",
        song: song2,
      }),
    ).toBe(false);
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
        state.currentSongStartedAt!;
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

test.describe("a Joysound song's lyrics", () => {
  // Lyrics a minute long over black.mp4, as if downloaded before: a 1.5 s
  // title card, then `lines` lines, a new one every half second, two on
  // screen at once. Line 5 is only spaces.
  function fakeJoysoundSong(
    app: ElectronApplication,
    songId: string,
    lines: number,
  ) {
    const at = joy02Events;
    const events: Joy02Event[] = [at.titleOut(1500), at.fadeIn(2000, 2)];
    for (let line = 0; line < lines; line++) {
      const start = 2500 + line * 500;
      events.push(at.scroll(start, 30));
      if (line >= 1 && line < lines - 1) {
        events.push(at.fadeOut(start, 1), at.fadeIn(start, 1));
      }
    }
    events.push(at.fadeOut(2500 + lines * 500, 2));
    events.sort((a, b) => a.time - b.time);
    const telop = buildJoy02({
      title: "E2E 歌詞の曲",
      artist: "E2E 歌手",
      lyricist: "作詞者",
      composer: "作曲者",
      seconds: 60,
      blocks: Array.from({ length: lines }, (_, i) => ({
        x: 120,
        y: i % 2 ? 400 : 330,
        text: i === 5 ? "　　　" : "空港へ行く君の名は",
        ruby: i === 5 ? [] : [{ x: 0, text: "くうこう" }],
      })),
      events,
    });
    return fakeJoysoundDownload(app, songId, { telop });
  }

  const queueJoysound = async (
    remoconUrl: string,
    songId: string,
    lyricsMode: string,
  ) =>
    (
      await apiCall(
        remoconUrl,
        "queueSong",
        {
          kind: "joysound",
          songId,
          name: `E2E ${songId}`,
          artistName: "E2E artist",
          lyricsMode,
          youtubeVideoId: null,
        },
        // A phone each: one song in the queue each.
        { deviceId: `e2e-phone-${songId}`, nickname: NICKNAME },
      )
    ).body;

  // The lyrics canvas's texture count (JoysoundRenderer's data-textures) at
  // every frame for `ms`. (The hidden test window draws about one a second.)
  const textureCounts = (display: Page, ms: number) =>
    display.evaluate(async (ms) => {
      const counts: number[] = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const canvas = document.querySelector<HTMLCanvasElement>(
          "canvas.joysoundDisplay",
        );
        counts.push(Number(canvas?.dataset.textures ?? -1));
        await new Promise(requestAnimationFrame);
      }
      return counts;
    }, ms);

  test("hold the textures of the lines around now, and only romaji loads kuromoji's dictionary", async ({
    karafriends,
    display,
  }) => {
    const { remoconUrl } = karafriends;
    await fakeJoysoundSong(karafriends.app, "e2e-kana", 40);
    await fakeJoysoundSong(karafriends.app, "e2e-romaji", 12);
    const dictionaryFetches = () =>
      karafriends.displayRequests.filter((url) => url.includes("/dict/"));

    expect(await queueJoysound(remoconUrl, "e2e-kana", "kana")).toMatchObject({
      ok: true,
    });
    const canvas = display.locator("canvas.joysoundDisplay");
    await expect(canvas).toHaveAttribute("data-textures", /^[1-9]/, {
      timeout: 20_000,
    });
    // Over 12 s (about 24 lines of 40): never more than the title and four
    // lines' two textures, where all 40 lines' would be 81.
    const counts = await textureCounts(display, 12_000);
    expect(Math.max(...counts)).toBeLessThanOrEqual(9);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(4);
    // Kana needs no romaji, so no dictionary.
    expect(dictionaryFetches()).toEqual([]);

    // A song with romaji queued: the dictionary loads now, before it plays.
    expect(
      await queueJoysound(remoconUrl, "e2e-romaji", "romaji"),
    ).toMatchObject({ ok: true });
    await expect.poll(() => dictionaryFetches().length).toBeGreaterThan(0);
    expect(await display.locator("video").getAttribute("src")).toContain(
      "e2e-kana",
    );

    // Skipped to it: the old song's canvas goes, the new one draws its
    // lines (the one of spaces too: it doesn't stop the others).
    expect(
      await call(remoconUrl, "setPlaybackState", {
        playbackState: "SKIPPING",
        song: await currentSongKey(remoconUrl),
      }),
    ).toBe(true);
    await expect(display.locator("video")).toHaveAttribute("src", /e2e-romaji/);
    await expect(canvas).toHaveCount(1);
    await expect
      .poll(
        async () =>
          Math.max(...(await textureCounts(display, 500)).filter((n) => n > 1)),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(4);

    expect(karafriends.displayErrors).toEqual([]);
  });
});

test.describe("a YouTube song's adhoc lyrics", () => {
  const VIDEO = "e2eAdhocVid";
  const LYRICS = ["E2E first line", "E2E second line", "E2E third line"];
  test.use({
    seedQueue: {
      currentSong: null,
      songQueue: [
        {
          kind: "youtube",
          songId: VIDEO,
          name: "E2E lyrics song",
          artistName: "",
          playtime: 60,
          timestamp: String(Date.UTC(2026, 0, 1)),
          user: { deviceId: "e2e-player-device", nickname: "e2e" },
          hasAdhocLyrics: true,
          hasCaptions: false,
          gainValue: 1,
        },
      ],
      songHistory: [],
      playbackState: "WAITING",
      // By the queue item's songKey.
      idToAdhocLyrics: { [`${VIDEO}@${Date.UTC(2026, 0, 1)}`]: LYRICS },
    },
  });

  test("show each pushed line at the bottom, the older ones a line apart above it", async ({
    karafriends,
    display,
  }) => {
    await expect
      .poll(() => nowPlaying(karafriends.remoconUrl))
      .toEqual(["E2E lyrics song", "PLAYING"]);
    for (const lyricIndex of [0, 1, 2]) {
      expect(
        await displayCall(display, "pushAdhocLyrics", {
          lyricIndex,
          song: `${VIDEO}@${Date.UTC(2026, 0, 1)}`,
        }),
      ).toEqual({ ok: true, output: true });
    }

    const lines = display.locator(".lyrics-container .entry-container");
    await expect(lines).toHaveText(LYRICS);
    // Only the newest fades in.
    await expect(lines.locator(".lyric-fade-in")).toHaveText([LYRICS[2]]);
    // No measuring canvas: the CSS places them, 15.3vw apart, once they've
    // slid into place.
    await expect(display.locator(".lyrics-container canvas")).toHaveCount(0);
    const vw = await display.evaluate(() => window.innerWidth / 100);
    await expect
      .poll(async () => {
        const tops = await lines.evaluateAll((elements) =>
          elements.map((e) => e.getBoundingClientRect().top),
        );
        return tops.slice(1).map((top, i) => Math.round(top - tops[i]));
      })
      .toEqual([Math.round(15.3 * vw), Math.round(15.3 * vw)]);
    // The newest is on screen, above the container's bottom.
    const container = await display.locator(".lyrics-container").boundingBox();
    const newest = await lines.last().boundingBox();
    expect(newest!.y + newest!.height).toBeLessThanOrEqual(
      container!.y + container!.height,
    );
    expect(newest!.y).toBeGreaterThan(container!.y);
  });
});
