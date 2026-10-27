// The display starts a song queued while nothing plays at once, not at its
// next 5-second check. No network: yt-dlp is a fake
// (tests/fixtures/bin/yt-dlp-downloads) that "downloads" an empty video at
// once, so the display "plays" nothing.
import path from "path";

import { expect, test } from "./fixtures";

const FAKE_YTDLP = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "bin",
  process.platform === "win32" ? "yt-dlp-downloads.cmd" : "yt-dlp-downloads",
);

test.use({ appEnv: { KARAFRIENDS_YTDLP_PATH: FAKE_YTDLP } });

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

test("a song queued while the display waits starts within 2 seconds", async ({
  karafriends,
  display,
}) => {
  // The display is up, and waiting: its idle screen shows.
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toBeVisible();
  await display.waitForTimeout(1_000);

  const res = await fetch(new URL("api/queueSong", karafriends.remoconUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Karafriends-Device-Id": "e2e-player-device",
      "X-Karafriends-Nickname": "e2e",
    },
    body: JSON.stringify({
      kind: "nico",
      songId: "sm9",
      name: "E2E player song",
      artistName: "E2E artist",
      playtime: 60,
    }),
  });
  expect(await res.json()).toMatchObject({ ok: true });
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
  await expect(corner).toContainText("E2E artist · e2e");
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toHaveCount(0);
});
