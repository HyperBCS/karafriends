import { expect, test } from "./fixtures";

test("the display opens on its idle screen without console errors", async ({
  display,
  karafriends,
}) => {
  await expect(display).toHaveTitle("karafriends");

  // The sidebar: the remote's QR code, settings and an empty queue.
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toBeVisible();
  await expect(display.getByText("Settings", { exact: true })).toBeVisible();
  // The remote's addresses carry its port, which the preload got from the
  // main process.
  const { port } = new URL(karafriends.remoconUrl);
  await expect(
    display.locator(`option[value="karafriends.local:${port}"]`),
  ).toHaveCount(1);
  await expect(
    display.getByRole("button", { name: "Clear mics" }),
  ).toBeVisible();
  await expect(display.getByRole("list", { name: "Queue" })).toBeAttached();
  await expect(
    display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
  ).toHaveCount(0);

  // Nothing is playing.
  const video = display.locator("video");
  await expect(video).toBeVisible();
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
