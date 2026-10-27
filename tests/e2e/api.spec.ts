// The JSON RPC API (POST /api/<method>, GET /api/events) and the server-side
// admin checks. No network: the queued songs are Niconico videos that are
// never downloaded, so the display can't play them.
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const DEVICE_ID = "e2e-remote-device";
const NICKNAME = "e2e";

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

async function displayToken(display: Page): Promise<string> {
  return display.evaluate(() =>
    (
      window as unknown as { karafriends: { displayToken(): string } }
    ).karafriends.displayToken(),
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

test("whoami answers, and the display is an admin", async ({
  karafriends,
  display,
}) => {
  expect(
    await call(karafriends.remoconUrl, "whoami", {}, REMOTE_HEADERS),
  ).toEqual({ status: 200, body: { isAdmin: false } });
  const token = await displayToken(display);
  expect(
    await call(
      karafriends.remoconUrl,
      "whoami",
      {},
      {
        "X-Karafriends-Display-Token": token,
      },
    ),
  ).toEqual({ status: 200, body: { isAdmin: true } });
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
      config: { supervisedMode: false },
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

  test.use({ appConfig: { supervisedMode: true } });

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

    test("a phone can't remove it or pause it, by /api or GraphQL", async ({
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

      // The remote: its UI hides the remove button and disables the playback
      // controls...
      const queue = page.getByRole("region", { name: "Queue" });
      // (The marquee repeats the title.)
      await expect(
        queue.getByText("E2E supervised song 2").first(),
      ).toBeVisible();
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

      // GraphQL refuses too, while it lasts (until Phase 5e).
      const removal = await fetch(new URL("graphql", remoconUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...REMOTE_HEADERS },
        body: JSON.stringify({
          query:
            "mutation ($songId: String!, $timestamp: String!) { removeSong(songId: $songId, timestamp: $timestamp) }",
          variables: {
            songId: "sm90002",
            timestamp: song(2, someoneElse).timestamp,
          },
        }),
      }).then((res) => res.json());
      expect(removal.errors?.[0]?.message).toContain("Supervised mode");

      const { state } = await liveState(remoconUrl);
      expect(state.playbackState).toBe("PLAYING");
      expect(
        state.queue.map((item: { songId: string }) => item.songId),
      ).toEqual(["sm90002"]);

      // The display can.
      const admin = {
        "X-Karafriends-Display-Token": await displayToken(display),
      };
      expect(
        await call(
          remoconUrl,
          "removeSong",
          { songId: "sm90002", timestamp: song(2, someoneElse).timestamp },
          admin,
        ),
      ).toEqual({ status: 200, body: true });
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
});
