// The JSON RPC API (POST /api/<method>, GET /api/events), the server-side
// admin checks and admin sign-in. No network: the queued songs are Niconico
// videos that are never downloaded, so the display can't play them.
import net from "net";

import type { Page } from "@playwright/test";

import { adminPasswordConfig, expect, test } from "./fixtures";

const DEVICE_ID = "e2e-remote-device";
const NICKNAME = "e2e";
const ADMIN_PASSWORD = "e2e admin パスワード";
const ADMIN_CONFIG = adminPasswordConfig(ADMIN_PASSWORD);

// Who the remote is, as its requests say.
const REMOTE_HEADERS = {
  "X-Karafriends-Device-Id": DEVICE_ID,
  "X-Karafriends-Nickname": NICKNAME,
};

async function call(
  remoconUrl: string,
  method: string,
  input: object,
  headers: Record<string, string> = {},
) {
  const res = await fetch(new URL(`api/${method}`, remoconUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: await res.json() };
}

// The first event of a fresh /api/events stream: the live state.
async function liveState(remoconUrl: string) {
  const controller = new AbortController();
  const res = await fetch(new URL("api/events", remoconUrl), {
    signal: controller.signal,
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The stream ended early: ${text}`);
      text += value;
      const data = text.match(/^data: (.*)$/m);
      if (data) return JSON.parse(data[1]);
    }
  } finally {
    controller.abort();
  }
}

// A call from the display, over IPC through its preload: { ok, output } or
// { ok: false, status, error }.
async function displayCall(display: Page, method: string, input: object) {
  return display.evaluate(
    ([method, input]) =>
      (
        window as unknown as {
          karafriends: {
            api: { call(method: string, input: object): Promise<unknown> };
          };
        }
      ).karafriends.api.call(method, input),
    [method, input] as const,
  );
}

test("/api refuses a form-encoded POST", async ({ karafriends }) => {
  const res = await fetch(new URL("api/whoami", karafriends.remoconUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://example.com",
    },
    body: "a=b",
  });
  expect(res.status).toBe(415);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

// GraphQL is gone: the server answers /graphql like any unknown path. (And
// every test checks that neither client asks for it: see forbidGraphql.)
test("/graphql answers 404", async ({ karafriends }) => {
  const url = new URL("graphql", karafriends.remoconUrl);
  const post = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ queue { __typename } }" }),
  });
  expect(post.status).toBe(404);
  expect((await fetch(url)).status).toBe(404);
});

// Nothing speaks WebSocket. A phone that asks anyway, then resets the
// connection, used to crash the app.
test("a WebSocket upgrade is refused, and a reset after it is harmless", async ({
  karafriends,
}) => {
  const { hostname, port } = new URL(karafriends.remoconUrl);
  for (let i = 0; i < 3; i++) {
    const socket = net.connect(Number(port), hostname);
    socket.on("error", () => {});
    const answer = await new Promise<string>((resolve, reject) => {
      let text = "";
      socket.once("error", reject);
      socket.on("data", (data) => {
        text += data;
        if (text.includes("\r\n\r\n")) resolve(text);
      });
      socket.write(
        "GET / HTTP/1.1\r\nHost: karafriends\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    socket.resetAndDestroy();
  }
  // Time for the resets to arrive, and for a crash to happen.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const proc = karafriends.app.process();
  expect([proc.exitCode, proc.signalCode]).toEqual([null, null]);
  expect(
    await call(karafriends.remoconUrl, "whoami", {}, REMOTE_HEADERS),
  ).toEqual({ status: 200, body: { isAdmin: false } });
});

test("whoami answers, and the display is an admin", async ({
  karafriends,
  display,
}) => {
  expect(
    await call(karafriends.remoconUrl, "whoami", {}, REMOTE_HEADERS),
  ).toEqual({ status: 200, body: { isAdmin: false } });
  expect(await displayCall(display, "whoami", {})).toEqual({
    ok: true,
    output: { isAdmin: true },
  });
  // Over IPC, a failure comes back as /api would answer it.
  expect(
    await displayCall(display, "setPlaybackState", { playbackState: "LOUD" }),
  ).toEqual({ ok: false, status: 400, error: expect.any(String) });
});

test.describe("admin sign-in", () => {
  test.use({ appConfig: ADMIN_CONFIG });

  test("a wrong password is refused, and the sixth try in a minute gets 429", async ({
    karafriends,
  }) => {
    const { remoconUrl } = karafriends;
    for (const password of [
      "guess",
      "e2e admin",
      "E2E ADMIN パスワード",
      "x",
    ]) {
      expect(
        await call(remoconUrl, "adminLogin", { password }, REMOTE_HEADERS),
      ).toEqual({ status: 403, body: { error: "Wrong admin password" } });
    }
    // The right one, as the fifth try.
    const fifth = await call(
      remoconUrl,
      "adminLogin",
      { password: ADMIN_PASSWORD },
      REMOTE_HEADERS,
    );
    expect(fifth.status).toBe(200);
    // The sixth is refused, right or not.
    const sixth = await call(
      remoconUrl,
      "adminLogin",
      { password: ADMIN_PASSWORD },
      REMOTE_HEADERS,
    );
    expect(sixth).toEqual({
      status: 429,
      body: { error: "Too many sign-in tries. Wait a minute, then try again." },
    });
    // The session from the fifth still works, and nothing else is limited.
    expect(
      await call(
        remoconUrl,
        "whoami",
        {},
        {
          ...REMOTE_HEADERS,
          "X-Karafriends-Admin-Token": fifth.body.token,
        },
      ),
    ).toEqual({ status: 200, body: { isAdmin: true } });
  });
});

test.describe("without an admin password", () => {
  test("no phone can sign in", async ({ karafriends }) => {
    expect(
      await call(
        karafriends.remoconUrl,
        "adminLogin",
        { password: "anything" },
        REMOTE_HEADERS,
      ),
    ).toEqual({
      status: 409,
      body: { error: "The host hasn't set an admin password" },
    });
  });
});

test("/api/events sends the live state", async ({ karafriends }) => {
  const event = await liveState(karafriends.remoconUrl);
  expect(event).toEqual({
    type: "state",
    state: {
      currentSong: null,
      queue: [],
      playbackState: expect.any(String),
      pitchShiftSemis: 0,
      adhocLyrics: [],
      downloads: [],
      config: { supervisedMode: false, everyoneIsAdmin: false },
      toolsProblem: null,
    },
  });
});

test.describe("supervised mode", () => {
  // A Niconico song in the API's queue.json format. The display never
  // downloaded it, so starting it plays nothing.
  const song = (n: number, owner: { deviceId: string; nickname: string }) => ({
    kind: "nico",
    songId: `sm9000${n}`,
    name: `E2E supervised song ${n}`,
    artistName: "E2E artist",
    playtime: 60,
    timestamp: String(Date.UTC(2026, 0, 1) + n),
    user: owner,
  });
  const someoneElse = { deviceId: "someone-elses-device", nickname: "someone" };
  const me = { deviceId: DEVICE_ID, nickname: NICKNAME };

  const seed = (owner: typeof me) => ({
    currentSong: null,
    songQueue: [song(1, owner), song(2, someoneElse)],
    songHistory: [],
    playbackState: "WAITING",
  });

  // Phones that sign in with the password are admins. "host" is a nickname,
  // which counts for nothing.
  test.use({ appConfig: { supervisedMode: true, ...ADMIN_CONFIG } });

  // The remote, opened by the e2e phone (not an admin).
  async function openRemote(page: Page, remoconUrl: string) {
    await page.addInitScript(
      ([deviceId, nickname]) => {
        localStorage.setItem("deviceId", deviceId);
        localStorage.setItem("nickname", nickname);
      },
      [DEVICE_ID, NICKNAME],
    );
    await page.goto(remoconUrl);
    await expect(
      page.getByRole("heading", { name: "Find a song" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show queue" }).click();
  }

  // The display starts song 1 at its first check, within 5 seconds.
  async function waitForSong1(remoconUrl: string) {
    await expect
      .poll(async () => {
        const { state } = await liveState(remoconUrl);
        return [state.currentSong?.songId, state.playbackState];
      })
      .toEqual(["sm90001", "PLAYING"]);
  }

  test.describe("someone else's song", () => {
    test.use({ seedQueue: seed(someoneElse) });

    test("a phone can't remove it or pause it", async ({
      karafriends,
      display,
      page,
    }) => {
      const { remoconUrl } = karafriends;
      await openRemote(page, remoconUrl);
      await waitForSong1(remoconUrl);

      // /api
      expect(
        await call(remoconUrl, "whoami", {}, REMOTE_HEADERS),
      ).toMatchObject({ body: { isAdmin: false } });
      expect(
        await call(
          remoconUrl,
          "removeSong",
          { songId: "sm90002", timestamp: song(2, someoneElse).timestamp },
          REMOTE_HEADERS,
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await call(
          remoconUrl,
          "setPlaybackState",
          { playbackState: "PAUSED" },
          REMOTE_HEADERS,
        ),
      ).toMatchObject({ status: 403 });

      // Nor can it pass for the singer, or for an admin, by nickname (every
      // phone sees the nicknames) or with a made-up admin token.
      for (const nickname of ["someone", "host"]) {
        const headers = {
          ...REMOTE_HEADERS,
          "X-Karafriends-Nickname": nickname,
          "X-Karafriends-Admin-Token": "0".repeat(64),
        };
        expect(await call(remoconUrl, "whoami", {}, headers)).toEqual({
          status: 200,
          body: { isAdmin: false },
        });
        expect(
          await call(
            remoconUrl,
            "removeSong",
            { songId: "sm90002", timestamp: song(2, someoneElse).timestamp },
            headers,
          ),
        ).toMatchObject({ status: 403 });
        expect(
          await call(
            remoconUrl,
            "setPlaybackState",
            { playbackState: "SKIPPING" },
            headers,
          ),
        ).toMatchObject({ status: 403 });
      }

      // The remote: its UI hides the remove button and disables the playback
      // controls...
      const queue = page.getByRole("region", { name: "Queue" });
      await expect(queue.getByText("E2E supervised song 2")).toBeVisible();
      await queue.getByRole("button", { name: "Queued by someone" }).click();
      await expect(
        queue.getByRole("button", { name: "Remove from queue" }),
      ).toHaveCount(0);
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toHaveAttribute("aria-disabled", "true");

      // ...and the server refuses the Pause button's request anyway, clicked
      // regardless.
      const pauseResponse = page.waitForResponse((res) =>
        res.url().endsWith("/api/setPlaybackState"),
      );
      await pause.dispatchEvent("click");
      expect((await pauseResponse).status()).toBe(403);
      expect((await (await pauseResponse).json()).error).toContain(
        "Supervised mode",
      );

      const { state } = await liveState(remoconUrl);
      expect(state.playbackState).toBe("PLAYING");
      expect(
        state.queue.map((item: { songId: string }) => item.songId),
      ).toEqual(["sm90002"]);

      // The display can.
      expect(
        await displayCall(display, "removeSong", {
          songId: "sm90002",
          timestamp: song(2, someoneElse).timestamp,
        }),
      ).toEqual({ ok: true, output: true });
    });
  });

  test.describe("an admin", () => {
    test.use({ seedQueue: seed(someoneElse) });

    test("signs in over the API, and may remove and pause anyone's song", async ({
      karafriends,
    }) => {
      const { remoconUrl } = karafriends;
      await waitForSong1(remoconUrl);

      const login = await call(
        remoconUrl,
        "adminLogin",
        { password: ADMIN_PASSWORD },
        REMOTE_HEADERS,
      );
      expect(login.status).toBe(200);
      expect(login.body.token).toMatch(/^[0-9a-f]{64}$/);
      const admin = {
        ...REMOTE_HEADERS,
        "X-Karafriends-Admin-Token": login.body.token,
      };
      expect(await call(remoconUrl, "whoami", {}, admin)).toEqual({
        status: 200,
        body: { isAdmin: true },
      });
      expect(
        await call(
          remoconUrl,
          "removeSong",
          { songId: "sm90002", timestamp: song(2, someoneElse).timestamp },
          admin,
        ),
      ).toEqual({ status: 200, body: true });
      expect(
        await call(
          remoconUrl,
          "setPlaybackState",
          { playbackState: "PAUSED" },
          admin,
        ),
      ).toEqual({ status: 200, body: true });
      expect((await liveState(remoconUrl)).state).toMatchObject({
        playbackState: "PAUSED",
        queue: [],
      });

      // Signed out, it's a guest again.
      expect(await call(remoconUrl, "adminLogout", {}, admin)).toEqual({
        status: 200,
        body: {},
      });
      expect(await call(remoconUrl, "whoami", {}, admin)).toEqual({
        status: 200,
        body: { isAdmin: false },
      });
      expect(
        await call(
          remoconUrl,
          "setPlaybackState",
          { playbackState: "PLAYING" },
          admin,
        ),
      ).toMatchObject({ status: 403 });
    });

    test("signs in from the profile page, and gets the controls at once", async ({
      karafriends,
      page,
    }) => {
      const { remoconUrl } = karafriends;
      await openRemote(page, remoconUrl);
      await waitForSong1(remoconUrl);
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toHaveAttribute("aria-disabled", "true");

      await page.getByRole("link", { name: "Profile" }).click();
      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible();
      await expect(page.getByLabel("Nickname")).toHaveValue(NICKNAME);
      const password = page.getByLabel("Admin password");
      const signIn = page.getByRole("button", { name: "Sign in" });

      // A wrong one first.
      await password.fill("not it");
      await signIn.click();
      await expect(
        page.getByText("Wrong password. Ask the host for it."),
      ).toBeVisible();

      await password.fill(ADMIN_PASSWORD);
      await signIn.click();
      await expect(page.getByText("You're an admin")).toBeVisible();
      // No reload: the controls follow.
      await expect(pause).toHaveAttribute("aria-disabled", "false");
      expect(
        await page.evaluate(() => localStorage.getItem("adminToken")),
      ).toMatch(/^[0-9a-f]{64}$/);

      // Still signed in after a reload.
      await page.reload();
      await expect(page.getByText("You're an admin")).toBeVisible();
      await expect(pause).toHaveAttribute("aria-disabled", "false");
      const token = await page.evaluate(() =>
        localStorage.getItem("adminToken"),
      );

      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByLabel("Admin password")).toBeVisible();
      await expect(pause).toHaveAttribute("aria-disabled", "true");
      expect(
        await page.evaluate(() => localStorage.getItem("adminToken")),
      ).toBeNull();
      // The server ended the session too: the old token is nobody's.
      expect(
        await call(
          remoconUrl,
          "whoami",
          {},
          { ...REMOTE_HEADERS, "X-Karafriends-Admin-Token": token! },
        ),
      ).toEqual({ status: 200, body: { isAdmin: false } });
    });
  });

  test.describe("three songs", () => {
    test.use({
      seedQueue: {
        ...seed(someoneElse),
        songQueue: [1, 2, 3].map((n) => song(n, someoneElse)),
      },
    });

    test("an admin moves one to the top, and a guest can't", async ({
      karafriends,
      display,
    }) => {
      const { remoconUrl } = karafriends;
      await waitForSong1(remoconUrl);
      const song3 = {
        songId: "sm90003",
        timestamp: song(3, someoneElse).timestamp,
      };

      expect(
        await call(
          remoconUrl,
          "moveSong",
          { ...song3, toIndex: 0 },
          REMOTE_HEADERS,
        ),
      ).toMatchObject({ status: 403 });

      const login = await call(
        remoconUrl,
        "adminLogin",
        { password: ADMIN_PASSWORD },
        REMOTE_HEADERS,
      );
      const admin = {
        ...REMOTE_HEADERS,
        "X-Karafriends-Admin-Token": login.body.token,
      };
      expect(
        await call(remoconUrl, "moveSong", { ...song3, toIndex: 0 }, admin),
      ).toEqual({ status: 200, body: { ok: true } });

      // Another phone's live state, and the display's queue.
      const { state } = await liveState(remoconUrl);
      expect(
        state.queue.map((item: { songId: string }) => item.songId),
      ).toEqual(["sm90003", "sm90002"]);
      await expect(
        display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
      ).toHaveText([/E2E supervised song 3/, /E2E supervised song 2/]);
    });

    test("while everyone is an admin, a phone with no password moves one", async ({
      karafriends,
      display,
      page,
    }) => {
      const { remoconUrl } = karafriends;
      await waitForSong1(remoconUrl);
      const song3 = {
        songId: "sm90003",
        timestamp: song(3, someoneElse).timestamp,
      };
      const move = () =>
        call(remoconUrl, "moveSong", { ...song3, toIndex: 0 }, REMOTE_HEADERS);
      const setEveryoneIsAdmin = (everyoneIsAdmin: boolean) =>
        displayCall(display, "setSettings", { settings: { everyoneIsAdmin } });
      // The remote's next whoami answer saying isAdmin.
      const whoamiSays = (isAdmin: boolean) =>
        page.waitForResponse(
          async (res) =>
            res.url().endsWith("/api/whoami") &&
            (await res.json()).isAdmin === isAdmin,
        );

      // The remote, open on the e2e phone with no admin token.
      await page.addInitScript(
        ([deviceId, nickname]) => {
          localStorage.setItem("deviceId", deviceId);
          localStorage.setItem("nickname", nickname);
        },
        [DEVICE_ID, NICKNAME],
      );
      const notAdmin = whoamiSays(false);
      await page.goto(remoconUrl);
      await notAdmin;

      // On: the remote asks again without a reload, and the phone moves it.
      const admin = whoamiSays(true);
      expect(await setEveryoneIsAdmin(true)).toEqual({
        ok: true,
        output: { ok: true, needsRestart: false },
      });
      await admin;
      expect((await liveState(remoconUrl)).state.config).toEqual({
        supervisedMode: true,
        everyoneIsAdmin: true,
      });
      expect(await move()).toEqual({ status: 200, body: { ok: true } });
      const { state } = await liveState(remoconUrl);
      expect(
        state.queue.map((item: { songId: string }) => item.songId),
      ).toEqual(["sm90003", "sm90002"]);

      // Off: refused again.
      const notAdminAgain = whoamiSays(false);
      await setEveryoneIsAdmin(false);
      await notAdminAgain;
      expect(await move()).toMatchObject({ status: 403 });
    });
  });

  test.describe("my own song", () => {
    test.use({ seedQueue: seed(me) });

    test("its singer can pause it from the remote", async ({
      karafriends,
      page,
    }) => {
      const { remoconUrl } = karafriends;
      await openRemote(page, remoconUrl);
      await waitForSong1(remoconUrl);

      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toHaveAttribute("aria-disabled", "false");
      await pause.click();
      await expect
        .poll(async () => (await liveState(remoconUrl)).state.playbackState)
        .toBe("PAUSED");

      // Someone else's song is still theirs to remove.
      expect(
        await call(
          remoconUrl,
          "removeSong",
          { songId: "sm90002", timestamp: song(2, someoneElse).timestamp },
          REMOTE_HEADERS,
        ),
      ).toMatchObject({ status: 403 });
    });
  });

  // A YouTube video queued with adhoc lyrics, never downloaded, so the
  // display plays nothing.
  test.describe("adhoc lyrics", () => {
    const VIDEO = "jNQXAC9IVRw";
    const LYRICS = ["E2E first line", "E2E second line"];
    const lyricsSeed = (owner: typeof me) => ({
      currentSong: null,
      songQueue: [
        {
          kind: "youtube",
          songId: VIDEO,
          name: "E2E lyrics song",
          artistName: "",
          playtime: 60,
          timestamp: String(Date.UTC(2026, 0, 1)),
          user: owner,
          hasAdhocLyrics: true,
          hasCaptions: false,
          gainValue: 1,
        },
      ],
      songHistory: [],
      playbackState: "WAITING",
      // As older versions saved them: by video ID.
      idToAdhocLyrics: { [VIDEO]: LYRICS },
    });

    async function waitForLyricsSong(remoconUrl: string) {
      await expect
        .poll(async () => {
          const { state } = await liveState(remoconUrl);
          return [state.currentSong?.songId, state.playbackState];
        })
        .toEqual([VIDEO, "PLAYING"]);
    }

    test.describe("on someone else's song", () => {
      test.use({ seedQueue: lyricsSeed(someoneElse) });

      test("a phone can't push them, but the display can", async ({
        karafriends,
        display,
      }) => {
        const { remoconUrl } = karafriends;
        await waitForLyricsSong(remoconUrl);

        for (const nickname of [NICKNAME, "someone", "host"]) {
          const headers = {
            ...REMOTE_HEADERS,
            "X-Karafriends-Nickname": nickname,
          };
          expect(
            await call(
              remoconUrl,
              "pushAdhocLyrics",
              { lyricIndex: 0 },
              headers,
            ),
          ).toMatchObject({ status: 403 });
        }
        // Nor can any phone put its own text on the screen.
        expect(
          await call(
            remoconUrl,
            "pushAdhocLyrics",
            { lyric: "E2E graffiti", lyricIndex: 0 },
            REMOTE_HEADERS,
          ),
        ).toMatchObject({ status: 400 });
        expect((await liveState(remoconUrl)).state.adhocLyrics).toEqual([]);

        expect(
          await displayCall(display, "pushAdhocLyrics", { lyricIndex: 1 }),
        ).toEqual({ ok: true, output: true });
        expect(
          await displayCall(display, "pushAdhocLyrics", { lyricIndex: 2 }),
        ).toMatchObject({ ok: false, status: 400 });
        expect((await liveState(remoconUrl)).state.adhocLyrics).toEqual([
          { lyric: LYRICS[1], lyricIndex: 1 },
        ]);
      });
    });

    test.describe("on my own song", () => {
      test.use({ seedQueue: lyricsSeed(me) });

      test("its singer pushes them from the remote, and the display shows them", async ({
        karafriends,
        display,
        page,
      }) => {
        const { remoconUrl } = karafriends;
        await openRemote(page, remoconUrl);
        await waitForLyricsSong(remoconUrl);

        await page.goto(new URL(`#/adhocLyrics/${VIDEO}`, remoconUrl).href);
        await expect(
          page
            .getByRole("listbox", { name: "Lyrics" })
            .getByRole("option", { selected: true }),
        ).toHaveText(`0 | ${LYRICS[0]}`);
        await page
          .getByRole("button", { name: "Tap here to show the next line" })
          .click();

        await expect(display.getByText(LYRICS[0])).toBeVisible();
        expect((await liveState(remoconUrl)).state.adhocLyrics).toEqual([
          { lyric: LYRICS[0], lyricIndex: 0 },
        ]);
      });
    });
  });
});
