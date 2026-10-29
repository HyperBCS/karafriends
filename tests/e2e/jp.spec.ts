import type { Page } from "@playwright/test";

import {
  currentSongKey,
  displayCall,
  expect,
  liveState,
  NICKNAME,
  showQueue,
  test,
  type Karafriends,
} from "./fixtures";

// DAM and Joysound only answer Japanese IPs and need the logins from the
// installed app's config.yaml. Run with KARAFRIENDS_E2E_JP=1.

const CATALOGS = ["DAM", "Joysound"] as const;

// Searches the catalog by title and returns the results' links.
async function searchTitle(
  remote: Page,
  catalog: (typeof CATALOGS)[number],
  title: string,
) {
  await remote
    .getByRole("combobox", { name: "Source" })
    .selectOption({ label: catalog });
  await remote.getByRole("searchbox", { name: "Search" }).fill(title);
  return remote
    .getByRole("list", { name: "Results" })
    .getByRole("link")
    .filter({ hasText: title });
}

// Opens the first result's song page; returns the song's title.
async function openFirstSong(
  remote: Page,
  results: ReturnType<Page["getByRole"]>,
) {
  await expect(results.first()).toBeVisible({ timeout: 30_000 });
  await results.first().click();
  await remote.waitForURL(/#\/(song|joysoundSong)\//);
  // The song's name, once its page has loaded.
  const heading = remote.getByRole("main").getByRole("heading", { level: 2 });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  return (await heading.textContent()) ?? "";
}

// Clicks a queue button and checks that /api/queueSong took the song.
async function queue(remote: Page, button: ReturnType<Page["getByRole"]>) {
  const answer = remote.waitForResponse((res) =>
    res.url().endsWith("/api/queueSong"),
  );
  await button.click();
  expect(await (await answer).json()).toMatchObject({ ok: true });
}

// Takes this phone's song off the queue the way a person would.
async function removeFromQueue(remote: Page, title: string) {
  const queue = remote.getByRole("region", { name: "Queue" });
  const removal = remote.waitForResponse((res) =>
    res.url().endsWith("/api/removeSong"),
  );
  await queue
    .getByRole("button", { name: `${title}, Queued by ${NICKNAME}` })
    .click();
  await queue.getByRole("button", { name: "Remove from queue" }).click();
  expect(await (await removal).json()).toBe(true);
  await expect(queue.getByText(title)).toHaveCount(0);
  await expect(queue.getByText("The queue is empty")).toBeVisible();
}

// One at a time, not in parallel, here and in settings.spec.ts: they all
// sign in to the same DAM and Joysound accounts.
test.describe("DAM and Joysound", { tag: "@jp", lock: "jp-accounts" }, () => {
  test.use({ realCredentials: true });

  for (const catalog of CATALOGS) {
    test(`a ${catalog} title search finds Lemon`, async ({ remote }) => {
      const results = await searchTitle(remote, catalog, "Lemon");
      await expect(results.first()).toBeVisible({ timeout: 30_000 });
    });
  }

  test.describe("queueing", () => {
    // A song the display starts at once (a minute of black video, from
    // seedVideos) and the test pauses, so it never finishes: a song queued
    // after it waits in the queue, however long its download takes, until
    // the test takes it off. The app is muted too.
    test.use({
      seedQueue: {
        currentSong: null,
        songQueue: [
          {
            kind: "nico",
            songId: "sm70001",
            name: "E2E placeholder",
            artistName: "E2E artist",
            playtime: 60,
            timestamp: String(Date.UTC(2026, 0, 1)),
            user: { deviceId: "e2e-placeholder", nickname: "placeholder" },
          },
        ],
        songHistory: [],
        playbackState: "WAITING",
      },
    });

    // The display starts it within 5 seconds; then it's paused.
    async function waitForPlaceholder(
      remote: Page,
      { display, remoconUrl }: Karafriends,
    ) {
      await expect(
        remote
          .getByRole("region", { name: "Now playing" })
          .getByText("E2E placeholder")
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      expect(
        await displayCall(display, "setPlaybackState", {
          playbackState: "PAUSED",
          song: await currentSongKey(remoconUrl),
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(async () => (await liveState(remoconUrl)).playbackState)
        .toBe("PAUSED");
    }

    test("a DAM song can be queued from its page and taken off", async ({
      remote,
      karafriends,
    }) => {
      await waitForPlaceholder(remote, karafriends);
      const title = await openFirstSong(
        remote,
        await searchTitle(remote, "DAM", "Lemon"),
      );

      // A DAM song joins the queue at once.
      const button = remote
        .getByRole("main")
        .getByRole("button", { name: /^Queue song/ })
        .first();
      await queue(remote, button);
      await expect(
        remote.getByRole("main").getByText(/^Queued, up in /),
      ).toBeVisible();

      await showQueue(remote);
      await expect(
        remote.getByRole("region", { name: "Queue" }).getByText(title).first(),
      ).toBeVisible();
      await removeFromQueue(remote, title);
    });

    test.describe(() => {
      // A Joysound song downloads before it joins the queue.
      test.use({ mediaTools: "installed" });
      test.describe.configure({ timeout: 300_000 });

      test("a Joysound song can be queued from its page and taken off", async ({
        remote,
        karafriends,
      }) => {
        await waitForPlaceholder(remote, karafriends);
        const title = await openFirstSong(
          remote,
          await searchTitle(remote, "Joysound", "Lemon"),
        );

        await queue(
          remote,
          remote
            .getByRole("main")
            .getByRole("button", { name: "Queue song", exact: true }),
        );
        // The button follows the download in the live state.
        await expect(
          remote
            .getByRole("main")
            .getByRole("button", { name: /^Downloading/ }),
        ).toBeVisible();

        await showQueue(remote);
        await expect(
          remote
            .getByRole("region", { name: "Queue" })
            .getByText(title)
            .first(),
        ).toBeVisible({ timeout: 240_000 });
        await removeFromQueue(remote, title);
      });
    });
  });
});
