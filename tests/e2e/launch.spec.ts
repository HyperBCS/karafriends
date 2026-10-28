// The app as a whole: one copy at a time, and a display that crashes comes
// back, but not in a loop.
import { spawn } from "node:child_process";
import path from "node:path";

import { expect, test } from "./fixtures";

const MAIN_ENTRY = path.resolve(
  __dirname,
  "..",
  "..",
  "build",
  "prod",
  "main",
  "index.js",
);

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
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    ELECTRON_IS_DEV: "0",
    TEMP: first.temp,
    TMP: first.temp,
    TMPDIR: first.temp,
    KARAFRIENDS_REMOCON_PORT: new URL(remoconUrl).port,
    KARAFRIENDS_LOCAL_ONLY: "1",
    KARAFRIENDS_HIDE_WINDOW: "1",
    KARAFRIENDS_FAKE_AUDIO: "1",
  });
  const second = spawn(
    first.electron,
    [
      "--mute-audio",
      `--user-data-dir=${first.userData}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      MAIN_ENTRY,
    ],
    { env, stdio: "ignore" },
  );
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
  await app.evaluate(({ BrowserWindow }) => {
    const seen = { loads: 0 };
    Object.assign(globalThis, { displayLoads: seen });
    BrowserWindow.getAllWindows()[0].webContents.on(
      "did-finish-load",
      () => seen.loads++,
    );
  });
  const loads = () =>
    app.evaluate(
      () =>
        (globalThis as unknown as { displayLoads: { loads: number } })
          .displayLoads.loads,
    );
  const crash = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );

  // Reloaded after a second, then after 3 more.
  await crash();
  await expect.poll(loads).toBe(1);
  await crash();
  await expect.poll(loads).toBe(2);
  // A third crash within the minute: no reload (with the window shown, a
  // dialog asks the host).
  await crash();
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(await loads()).toBe(2);
});
