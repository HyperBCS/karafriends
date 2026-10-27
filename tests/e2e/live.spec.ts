// Live state: a change on one phone shows up at once on the other phones and
// the display, through GET /api/events. No network and no sound: the songs
// are Niconico videos that were never downloaded, so the display "plays"
// nothing.
import {
  devices,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { expect, forbidGraphql, test } from "./fixtures";

const ALICE = { deviceId: "e2e-alice-device", nickname: "alice" };
const BOB = { deviceId: "e2e-bob-device", nickname: "bob" };
const ADMIN_DEVICE = "e2e-admin-device";

const title = (n: number) => `E2E live song ${n}`;

// A queue.json song. Alice queued hers under an older nickname, so only her
// device ID says they are hers.
const song = (n: number, owner: { deviceId: string; nickname: string }) => ({
  kind: "nico",
  songId: `sm8000${n}`,
  name: title(n),
  artistName: "E2E artist",
  playtime: 60,
  timestamp: String(Date.UTC(2026, 0, 1) + n),
  user:
    owner === ALICE
      ? { deviceId: ALICE.deviceId, nickname: "alice-before" }
      : owner,
});

const seedQueue = {
  currentSong: null,
  songQueue: [song(1, ALICE), song(2, ALICE), song(3, BOB)],
  songHistory: [],
  playbackState: "WAITING",
};

// Each phone in its own browser context, so each has its own localStorage.
async function openPhone(
  browser: Browser,
  remoconUrl: string,
  who: { deviceId: string; nickname: string },
  graphqlRequests: string[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    locale: "en-US",
  });
  await forbidGraphql(context, graphqlRequests);
  const page = await context.newPage();
  await page.addInitScript(
    ([deviceId, nickname]) => {
      localStorage.setItem("deviceId", deviceId);
      localStorage.setItem("nickname", nickname);
    },
    [who.deviceId, who.nickname] as const,
  );
  await page.goto(remoconUrl);
  await expect(
    page.getByRole("heading", { name: "Find a song" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show queue" }).click();
  return { context, page };
}

// The first event of GET /api/events (the state), as text.
async function firstEvent(url: URL): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The stream ended early: ${text}`);
      text += value;
      const data = text.match(/^data: (.*)$/m);
      if (data) return data[1];
    }
  } finally {
    controller.abort();
  }
}

test.describe("live state", () => {
  test.use({
    seedQueue,
    appConfig: { supervisedMode: true, adminDeviceIds: [ADMIN_DEVICE] },
  });

  test("phones see which songs are theirs, but no device IDs", async ({
    karafriends,
  }) => {
    const { remoconUrl } = karafriends;
    const eventsFor = async (deviceId?: string) => {
      const url = new URL("api/events", remoconUrl);
      if (deviceId) url.searchParams.set("deviceId", deviceId);
      const text = await firstEvent(url);
      const { state } = JSON.parse(text);
      const songs = [state.currentSong, ...state.queue].filter(Boolean);
      return {
        text,
        mine: songs
          .filter((item: { isMine: boolean }) => item.isMine)
          .map((item: { name: string }) => item.name)
          .sort(),
      };
    };

    const alice = await eventsFor(ALICE.deviceId);
    expect(alice.mine).toEqual([title(1), title(2)]);
    expect((await eventsFor(BOB.deviceId)).mine).toEqual([title(3)]);
    expect((await eventsFor()).mine).toEqual([]);
    // No device IDs go out, the admins' included.
    for (const { text } of [alice, await eventsFor()]) {
      expect(text).not.toContain(ALICE.deviceId);
      expect(text).not.toContain(BOB.deviceId);
      expect(text).not.toContain(ADMIN_DEVICE);
      expect(text).not.toContain("deviceId");
    }
  });

  test("a change on one phone shows at once on the other and the display", async ({
    karafriends,
    display,
    browser,
    graphqlRequests,
  }) => {
    const { remoconUrl } = karafriends;
    const phones = [
      await openPhone(browser, remoconUrl, ALICE, graphqlRequests),
      await openPhone(browser, remoconUrl, BOB, graphqlRequests),
    ];
    try {
      const [alice, bob] = phones.map((phone) => phone.page);

      // The display starts song 1 within 5 seconds, and both phones see it.
      for (const phone of [alice, bob]) {
        await expect(
          phone
            .getByRole("region", { name: "Now playing" })
            .getByText(title(1))
            .first(),
        ).toBeVisible({ timeout: 15_000 });
      }

      // Supervised mode: song 1 is Alice's (by device), so only she has the
      // controls.
      const pause = (phone: Page) =>
        phone.getByRole("button", { name: "Pause", exact: true });
      const play = (phone: Page) =>
        phone.getByRole("button", { name: "Play", exact: true });
      await expect(pause(alice)).toHaveAttribute("aria-disabled", "false");
      await expect(pause(bob)).toHaveAttribute("aria-disabled", "true");

      // The key.
      const raise = alice.getByRole("button", { name: "Raise the key" });
      await raise.click();
      await raise.click();
      for (const phone of [alice, bob]) {
        await expect(phone.getByRole("status", { name: "Key" })).toHaveText(
          "2",
        );
      }

      // Pause, then restart: the display gets RESTARTING, rewinds and sets
      // PLAYING again, which Bob sees.
      await pause(alice).click();
      await expect(play(bob)).toBeVisible();
      await alice.getByRole("button", { name: "Restart", exact: true }).click();
      await expect(pause(bob)).toBeVisible();
      await expect(pause(alice)).toBeVisible();

      // Taking a song off the queue. Only Alice may remove song 2, and Bob
      // song 3.
      const queue = (phone: Page) =>
        phone.getByRole("region", { name: "Queue" });
      const displayQueue = display.getByRole("list", { name: "Queue" });
      await expect(displayQueue.getByText(title(2)).first()).toBeVisible();
      for (const [phone, removable] of [
        [alice, ["alice-before"]],
        [bob, ["bob"]],
      ] as const) {
        for (const nickname of ["alice-before", "bob"]) {
          const expanded = queue(phone).getByRole("button", {
            name: `Queued by ${nickname}`,
            expanded: true,
          });
          if ((await expanded.count()) === 0) {
            await queue(phone)
              .getByRole("button", { name: `Queued by ${nickname}` })
              .click();
          }
        }
        await expect(
          queue(phone).getByRole("button", { name: "Remove from queue" }),
        ).toHaveCount(removable.length);
      }
      await queue(alice)
        .getByRole("button", { name: "Remove from queue" })
        .click();
      await expect(queue(bob).getByText(title(2))).toHaveCount(0);
      await expect(displayQueue.getByText(title(2))).toHaveCount(0);
      await expect(displayQueue.getByText(title(3)).first()).toBeVisible();

      // An emote from Alice floats up the display (for a second).
      await display.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { seenEmotes: string[] }).seenEmotes = seen;
        new MutationObserver((records) => {
          for (const record of records) {
            record.addedNodes.forEach((node) =>
              seen.push(node.textContent ?? ""),
            );
          }
        }).observe(document.getElementById("effects")!, { childList: true });
      });
      await alice.getByRole("button", { name: "Show emotes" }).click();
      await alice.getByText("🔥", { exact: true }).click();
      await expect
        .poll(() =>
          display.evaluate(
            () => (window as unknown as { seenEmotes: string[] }).seenEmotes,
          ),
        )
        .toContain("🔥");
    } finally {
      for (const { context } of phones) await context.close();
    }
  });
});
