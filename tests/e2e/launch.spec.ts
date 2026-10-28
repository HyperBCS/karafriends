// The app as a whole: one copy at a time, and a display that crashes comes
// back, but not in a loop.
import { spawn } from "node:child_process";

import { appLaunch, expect, test } from "./fixtures";

// A second launch with the same profile (the launcher clicked again) leaves
// at once and brings the running display to the front, instead of opening a
// second display that writes the same queue.json.
test("a second launch leaves and focuses the first", async ({
  karafriends,
}) => {
  const { app, remoconUrl } = karafriends;
  const first = await app.evaluate(({ app }) => {
    const seen = { count: 0 };
    Object.assign(globalThis, { secondInstances: seen });
    app.on("second-instance", () => seen.count++);
    return {
      electron: process.execPath,
      userData: app.getPath("userData"),
      temp: app.getPath("temp"),
    };
  });

  // Launched as fixtures.ts launches the first, with the same profile.
  const { env, args } = appLaunch({
    tempDir: first.temp,
    userDataDir: first.userData,
    port: Number(new URL(remoconUrl).port),
  });
  const second = spawn(first.electron, args, { env, stdio: "ignore" });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      second.kill();
      resolve(null);
    }, 20_000);
    second.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  expect(exitCode, "the second launch should leave by itself").toBe(0);

  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { secondInstances: { count: number } })
            .secondInstances.count,
      ),
    )
    .toBe(1);
  // The first one's display and server are still there.
  expect(app.windows()).toHaveLength(1);
  expect((await fetch(remoconUrl)).status).toBe(200);
});

test("a crashed display reloads, but not in a loop", async ({
  karafriends,
}) => {
  const { app } = karafriends;
  // Counted from the display's first load on: a load still under way (a
  // busy machine) would otherwise count as a reload.
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const seen = { loads: 0, crashes: 0 };
        Object.assign(globalThis, { display: seen });
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const count = () => {
          contents.on("did-finish-load", () => seen.loads++);
          contents.on("render-process-gone", () => seen.crashes++);
          resolve();
        };
        if (contents.isLoading()) contents.once("did-finish-load", count);
        else count();
      }),
  );
  const seen = () =>
    app.evaluate(
      () =>
        (
          globalThis as unknown as {
            display: { loads: number; crashes: number };
          }
        ).display,
    );
  const crash = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );

  // Reloaded after a second, then after 3 more.
  await crash();
  await expect.poll(seen).toEqual({ loads: 1, crashes: 1 });
  await crash();
  await expect.poll(seen).toEqual({ loads: 2, crashes: 2 });
  // A third crash within the minute: no reload (with the window shown, a
  // dialog asks the host). Seen, then given longer than the longest wait
  // before a reload (3 s).
  await crash();
  await expect.poll(seen).toEqual({ loads: 2, crashes: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(await seen()).toEqual({ loads: 2, crashes: 3 });
});
