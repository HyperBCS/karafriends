// The display talks to the main process over Electron IPC, not HTTP: it
// makes no /api requests (every test checks that too, see fixtures.ts), and
// it keeps working when the remote's port is taken. No network: the songs
// are Niconico videos that were never downloaded, so the display "plays"
// nothing (and logs errors about the missing files, so these tests don't
// check for console errors; display.spec.ts does, with an empty queue).
import type { Page } from "@playwright/test";

import { expect, isApiRequest, test } from "./fixtures";

const title = (n: number) => `E2E IPC song ${n}`;

const song = (n: number) => ({
  kind: "nico",
  songId: `sm7000${n}`,
  name: title(n),
  artistName: "E2E artist",
  playtime: 60,
  timestamp: String(Date.UTC(2026, 0, 1) + n),
  user: { deviceId: "e2e-ipc-device", nickname: "e2e" },
});

test.use({
  seedQueue: {
    currentSong: null,
    songQueue: [song(1), song(2)],
    songHistory: [],
    playbackState: "WAITING",
  },
});

// The display starts song 1 at its first check (popSong), and its queue then
// shows song 2 alone (live state).
async function expectSong1Started(display: Page) {
  const queue = display.getByRole("list", { name: "Queue" });
  await expect(queue.getByText(title(2)).first()).toBeVisible();
  await expect(queue.getByText(title(1))).toHaveCount(0);
}

test("the display uses IPC, not the HTTP API", async ({
  karafriends,
  display,
}) => {
  await expectSong1Started(display);

  // Requests from the display to the remote's server are seen...
  const probe = new URL("ipc-probe", karafriends.remoconUrl).href;
  await display.evaluate(
    (url) => fetch(url, { mode: "no-cors" }).then(() => {}),
    probe,
  );
  await expect.poll(() => karafriends.displayRequests).toContain(probe);

  // ...but none go to /api, while the display asks for the next song every
  // 5 seconds.
  await display.waitForTimeout(6_000);
  expect(karafriends.displayRequests.filter(isApiRequest)).toEqual([]);
});

test.describe("with the remote's port taken", () => {
  test.use({ occupyPort: true });

  test("the display still works, and says phones can't connect", async ({
    karafriends,
    display,
  }) => {
    const { port } = new URL(karafriends.remoconUrl);
    const notice = display.getByRole("alert");
    await expect(notice).toContainText(
      `Phones can't connect: port ${port} is in use`,
    );

    // The display gets the live state and starts songs.
    await expectSong1Started(display);
    // The app didn't quit.
    expect(karafriends.app.process().exitCode).toBeNull();
    await expect(display.getByRole("list", { name: "Queue" })).toBeVisible();

    // The notice can be put away.
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
  });
});
