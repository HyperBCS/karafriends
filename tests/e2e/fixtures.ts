// Playwright fixtures that launch the production build of karafriends in a
// throwaway profile and open its phone remote in an emulated phone.
//
// Everything a test touches lives in a fresh temp directory:
//   <tmp>/user-data          --user-data-dir: config.yaml, externalResources
//   <tmp>/karafriends_tmp    app.getPath("temp") + /karafriends_tmp: queue.json, downloads
// and the remote server listens on a free port, so tests never see (or
// change) the real app's queue, config or downloads, and can run while the
// real app holds port 8080.
//
// The tests drive the UI the way a person would (the display window and the
// remote's pages), not the server API, so they keep working when the API and
// the bundler are replaced.

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { parse, stringify } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_ENTRY = path.join(REPO_ROOT, "build", "prod", "main_", "index.js");

// The nickname the remote uses. Setting it up front skips the prompt() that
// asks for one on first visit.
export const NICKNAME = "e2e";

export type MediaTools =
  // Empty placeholder ffmpeg and yt-dlp: the app sees fresh copies and never
  // downloads them. Enough for every test that doesn't download a video.
  | "stub"
  // A copy of the binaries the installed app already downloaded (see
  // installedAppDataDir), for tests that queue videos.
  | "installed";

type Options = {
  // Contents of queue.json, written before launch.
  seedQueue: object | null;
  mediaTools: MediaTools;
  // Copy the DAM/Joysound logins from the installed app's config.yaml.
  realCredentials: boolean;
};

export type Karafriends = {
  app: ElectronApplication;
  // The karaoke display window.
  display: Page;
  // Console errors and uncaught exceptions from the display window.
  displayErrors: string[];
  // The phone remote's address.
  remoconUrl: string;
};

type Fixtures = {
  karafriends: Karafriends;
  display: Page;
  remote: Page;
};

// Where an installed (or `yarn run-dev`) karafriends keeps its config.yaml and
// downloaded binaries: Electron's userData for the app name "karafriends".
function installedAppDataDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "karafriends",
      );
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "karafriends",
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "karafriends",
      );
  }
}

// Mirrors resourcePathsFor() in src/common/externalResourcesPlan.ts.
const MEDIA_TOOL_FILES = {
  ffmpeg: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  ytdlp:
    process.platform === "win32"
      ? "yt-dlp.exe"
      : process.platform === "darwin"
        ? "yt-dlp_macos"
        : "yt-dlp",
};

function prepareMediaTools(userDataDir: string, mode: MediaTools) {
  const dest = path.join(userDataDir, "externalResources");
  if (mode === "stub") {
    for (const [dir, file] of Object.entries(MEDIA_TOOL_FILES)) {
      fs.mkdirSync(path.join(dest, dir), { recursive: true });
      fs.writeFileSync(path.join(dest, dir, file), "");
    }
    return;
  }

  const source = path.join(installedAppDataDir(), "externalResources");
  for (const [dir, file] of Object.entries(MEDIA_TOOL_FILES)) {
    if (!fs.existsSync(path.join(source, dir, file))) {
      throw new Error(
        `This test downloads a video, so it needs the ffmpeg and yt-dlp that ` +
          `karafriends downloads on first launch, in ${source}. Start the ` +
          `app once with \`yarn run-dev\` and let it finish downloading.`,
      );
    }
  }
  // versions.json comes along, so the app only re-downloads a tool when a
  // newer release is out.
  fs.cpSync(source, dest, { recursive: true });
}

const CREDENTIAL_KEYS = [
  "damUsername",
  "damPassword",
  "joysoundEmail",
  "joysoundPassword",
] as const;

// Reads the DAM/Joysound logins from the installed app's config.yaml. The
// values are never logged: errors name the file and the key, nothing else.
function readRealCredentials(): Record<string, string> {
  const file = path.join(installedAppDataDir(), "config.yaml");
  let config: Record<string, unknown> | null;
  try {
    config = parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Not rethrown: a YAML error message quotes the offending line.
    throw new Error(`Couldn't read DAM/Joysound logins from ${file}`);
  }
  const credentials: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = config?.[key];
    if (
      typeof value !== "string" ||
      value === "" ||
      value.startsWith("YOUR_")
    ) {
      throw new Error(`${file} has no ${key}`);
    }
    credentials[key] = value;
  }
  return credentials;
}

// Compares paths after resolving symlinks and Windows 8.3 short names.
function samePath(a: string, b: string): boolean {
  const canonical = (p: string) => {
    const real = fs.realpathSync.native(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return canonical(a) === canonical(b);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function launchKarafriends(
  options: Options,
  testInfo: TestInfo,
): Promise<{ karafriends: Karafriends; close: () => Promise<void> }> {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} is missing; run \`yarn build-prod\` first.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-e2e-"));
  const userDataDir = path.join(tempDir, "user-data");
  fs.mkdirSync(userDataDir);
  let app: ElectronApplication | undefined;
  const mainLog: string[] = [];

  const close = async (
    failed = testInfo.status !== testInfo.expectedStatus,
  ) => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
    if (failed && mainLog.length > 0) {
      await testInfo.attach("main-process.log", {
        body: mainLog.join(""),
        contentType: "text/plain",
      });
    }
    try {
      // Windows can hold a file for a moment after the process exits.
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10 });
    } catch (err) {
      console.warn(`Couldn't delete ${tempDir}: ${err}`);
    }
  };

  try {
    const port = await freePort();
    fs.writeFileSync(
      path.join(userDataDir, "config.yaml"),
      stringify({
        remoconPort: port,
        ...(options.realCredentials ? readRealCredentials() : {}),
      }),
    );
    prepareMediaTools(userDataDir, options.mediaTools);
    if (options.seedQueue) {
      const queueDir = path.join(tempDir, "karafriends_tmp");
      fs.mkdirSync(queueDir);
      fs.writeFileSync(
        path.join(queueDir, "queue.json"),
        JSON.stringify(options.seedQueue),
      );
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Set by some Electron-based hosts; it would start Electron as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      // Serve the built renderer and remote, as a packaged app does.
      ELECTRON_IS_DEV: "0",
      // app.getPath("temp"): TEMP/TMP on Windows, TMPDIR elsewhere.
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
      KARAFRIENDS_REMOCON_PORT: String(port),
    });

    app = await electron.launch({
      args: [
        // Never make a sound, even when a test plays a video.
        "--mute-audio",
        `--user-data-dir=${userDataDir}`,
        // Linux CI runners have no setuid sandbox helper, and no GPU for the
        // display's WebGL piano roll, so allow the software fallback.
        ...(process.platform === "linux"
          ? ["--no-sandbox", "--enable-unsafe-swiftshader"]
          : []),
        MAIN_ENTRY,
      ],
      cwd: REPO_ROOT,
      env,
      timeout: 60_000,
    });

    // The main process logs DAM tokens and Joysound cookies once logged in,
    // so its output is only kept when the test runs without real logins.
    if (!options.realCredentials) {
      app.process().stdout?.on("data", (chunk) => mainLog.push(String(chunk)));
      app.process().stderr?.on("data", (chunk) => mainLog.push(String(chunk)));
    }

    // Listen from the start, so errors while the display loads count too.
    const displayErrors: string[] = [];
    const watchForErrors = (page: Page) => {
      page.on("console", (message) => {
        if (message.type() === "error") displayErrors.push(message.text());
      });
      page.on("pageerror", (error) => displayErrors.push(String(error)));
    };
    app.windows().forEach(watchForErrors);
    app.on("window", watchForErrors);

    // Guard the real profile: stop if Electron ignored the isolation.
    const appPaths = await app.evaluate(({ app }) => ({
      userData: app.getPath("userData"),
      temp: app.getPath("temp"),
    }));
    if (
      !samePath(appPaths.userData, userDataDir) ||
      !samePath(appPaths.temp, tempDir)
    ) {
      throw new Error(
        `The app isn't using the test profile: ${JSON.stringify(appPaths)}`,
      );
    }

    const display = await app.firstWindow();

    const remoconUrl = `http://127.0.0.1:${port}/`;
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(remoconUrl)).status;
          } catch {
            return 0;
          }
        },
        { message: "the remote server never came up", timeout: 30_000 },
      )
      .toBe(200);

    return {
      karafriends: { app, display, displayErrors, remoconUrl },
      close,
    };
  } catch (err) {
    await close(true);
    throw err;
  }
}

export const test = base.extend<Options & Fixtures>({
  seedQueue: [null, { option: true }],
  mediaTools: ["stub", { option: true }],
  realCredentials: [false, { option: true }],

  karafriends: async (
    { seedQueue, mediaTools, realCredentials },
    use,
    testInfo,
  ) => {
    const { karafriends, close } = await launchKarafriends(
      { seedQueue, mediaTools, realCredentials },
      testInfo,
    );
    try {
      await use(karafriends);
    } finally {
      await close();
    }
  },

  display: async ({ karafriends }, use) => {
    await use(karafriends.display);
  },

  // The phone remote, opened by someone who already picked a nickname. The
  // page comes from Playwright's own page fixture, so it gets the Pixel 7
  // emulation from playwright.config.ts and a trace on failure.
  remote: async ({ page, karafriends }, use) => {
    await page.addInitScript((nickname) => {
      localStorage.setItem("nickname", nickname);
    }, NICKNAME);
    await page.goto(karafriends.remoconUrl);
    await expect(
      page.getByRole("heading", { name: "Find a song" }),
    ).toBeVisible();
    await use(page);
  },
});

export { expect };
