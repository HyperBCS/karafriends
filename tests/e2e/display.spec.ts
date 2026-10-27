import { expect, test } from "./fixtures";

test("the display opens on its idle screen without console errors", async ({
  display,
  karafriends,
}) => {
  await expect(display).toHaveTitle("karafriends");

  // A fresh profile has no DAM or Joysound login, so Settings opens first.
  const settings = display.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByText(
      "Add your DAM or Joysound login to search their catalogs. YouTube works without one.",
    ),
  ).toBeVisible();
  await display.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  // The idle screen: the remote's QR code and address, and an empty queue.
  // The address carries the remote's port, which the preload got from the
  // main process.
  const { port } = new URL(karafriends.remoconUrl);
  await expect(
    display.getByRole("img", { name: "QR code for the remote" }),
  ).toBeVisible();
  await expect(display.getByText("Scan to join")).toBeVisible();
  await expect(display.getByText(`karafriends.local:${port}`)).toBeVisible();
  await expect(
    display.getByRole("list", { name: "Queue" }).getByRole("listitem"),
  ).toHaveCount(0);

  // S, or the gear, opens Settings: the QR code's address and the
  // microphones are there.
  await display.keyboard.press("s");
  await expect(settings).toBeVisible();
  await expect(
    settings.locator(`option[value="karafriends.local:${port}"]`),
  ).toHaveCount(1);
  await expect(
    settings.getByRole("button", { name: "Clear mics" }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
  await display.getByRole("button", { name: "Settings" }).click();
  await expect(settings).toBeVisible();
  await display.keyboard.press("Escape");

  // Nothing is playing.
  const video = display.locator("video");
  await expect(video).toBeAttached();
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
