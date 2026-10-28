// A second launch with the same profile (the launcher clicked again) leaves
// at once and brings the running display to the front, instead of opening a
// second display that writes the same queue.json.
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
