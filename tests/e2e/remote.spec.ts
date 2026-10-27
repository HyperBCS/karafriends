import { expect, test } from "./fixtures";

test("the remote opens on the search screen", async ({ remote }) => {
  await expect(
    remote.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  for (const name of [
    "Title (Joysound)",
    "Artist (Joysound)",
    "Title (DAM)",
    "Artist (DAM)",
    "YouTube",
    "Niconico",
  ]) {
    await expect(remote.getByRole("link", { name, exact: true })).toBeVisible();
  }
});

test.describe("history", () => {
  const HISTORY_LENGTH = 35;
  const songName = (n: number) =>
    `E2E history song ${String(n).padStart(2, "0")}`;

  // queue.json in the format saveDb writes (src/main/graphql.ts), with a
  // history of 35 songs, newest first. The queue is empty rather than the
  // [null] that saveDb writes when nothing is playing: loading that makes
  // queue lookups fail until the display's first check (a known bug).
  test.use({
    seedQueue: {
      currentSong: null,
      currentSongAdhocLyrics: [],
      idToAdhocLyrics: {},
      pitchShiftSemis: 0,
      playbackState: "WAITING",
      songQueue: [],
      downloadQueue: [],
      songHistory: Array.from({ length: HISTORY_LENGTH }, (_, i) => {
        const n = HISTORY_LENGTH - i;
        return {
          song: {
            __typename: "YoutubeQueueItem",
            songId: `e2e-history-${n}`,
            name: songName(n),
            artistName: "E2E artist",
            playtime: 60,
            timestamp: String(Date.UTC(2026, 0, 1) + n * 60_000),
            userIdentity: { deviceId: "e2e-device", nickname: "e2e" },
            hasAdhocLyrics: false,
            hasCaptions: false,
            gainValue: 1,
          },
        };
      }),
    },
  });

  test("pages through all 35 songs", async ({ remote }) => {
    await remote.getByRole("link", { name: "History" }).click();
    await expect(
      remote.getByRole("heading", { name: "History" }),
    ).toBeVisible();

    const songs = remote
      .getByRole("main")
      .getByRole("link", { name: /E2E history song/ });
    // The first page holds 30.
    await expect(songs).toHaveCount(30);
    await expect(songs.first()).toContainText(songName(35));

    await remote.getByRole("button", { name: "More" }).click();
    await expect(songs).toHaveCount(HISTORY_LENGTH);
    await expect(remote.getByRole("button", { name: "More" })).toBeHidden();
    for (let n = 1; n <= HISTORY_LENGTH; n++) {
      await expect(songs.filter({ hasText: songName(n) })).toHaveCount(1);
    }
  });
});
