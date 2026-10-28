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
// the bundler are replaced. The exceptions are api.spec.ts, which tests the
// JSON RPC API itself (admin sign-in included), and the device-ID checks in
// live.spec.ts.
//
// The server has no GraphQL any more, and neither client may ask for it:
// every test fails if the display or a phone sends a request to /graphql
// (see forbidGraphql). And the display talks to the main process over IPC,
// so every test also fails if it sends one to /api (see isApiRequest).

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import {
  _electron as electron,
  test as base,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { parse, stringify } from "yaml";

import {
  hashAdminPassword,
  newAdminSalt,
} from "../../src/common/adminPassword";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_ENTRY = path.join(REPO_ROOT, "build", "prod", "main", "index.js");

// The nickname the remote uses. Setting it up front skips the prompt() that
// asks for one on first visit.
export const NICKNAME = "e2e";

// config.yaml's admin password settings for password, for appConfig: phones
// that sign in with it are admins.
export function adminPasswordConfig(password: string) {
  const adminPasswordSalt = newAdminSalt();
  return {
    adminPasswordSalt,
    adminPasswordHash: hashAdminPassword(password, adminPasswordSalt),
  };
}

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
  // More config.yaml settings, e.g. { supervisedMode: true }.
  appConfig: Record<string, unknown>;
  // Take the remote's port before the app starts, so its server can't
  // listen.
  occupyPort: boolean;
  // More environment variables for the app, e.g. KARAFRIENDS_YTDLP_PATH.
  appEnv: Record<string, string>;
};

export type Karafriends = {
  app: ElectronApplication;
  // The karaoke display window.
  display: Page;
  // Console errors and uncaught exceptions from the display window.
  displayErrors: string[];
  // Every URL the display window requested, as Playwright saw it.
  displayRequests: string[];
  // The phone remote's address.
  remoconUrl: string;
};

// A request to the JSON API (/api/<method> or /api/events), which the display
// must not make: it uses IPC.
export function isApiRequest(url: string): boolean {
  try {
    const { protocol, pathname } = new URL(url);
    return protocol.startsWith("http") && /^\/api(\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

type Fixtures = {
  // The /graphql requests the clients made, which must stay empty.
  graphqlRequests: string[];
  karafriends: Karafriends;
  display: Page;
  remote: Page;
};

const GRAPHQL_URL = /\/graphql(?:[?#]|$)/;

// Refuses the browser context's GraphQL requests (HTTP and WebSocket), noting
// each in `seen`. The display and the remote only use /api, and the server
// has no /graphql (api.spec.ts checks it answers 404).
export async function forbidGraphql(context: BrowserContext, seen: string[]) {
  context.on("request", (request) => {
    if (GRAPHQL_URL.test(request.url())) {
      seen.push(`${request.method()} ${request.url()}`);
    }
  });
  await context.route(GRAPHQL_URL, (route) => route.abort());
  await context.routeWebSocket(GRAPHQL_URL, (ws) => {
    seen.push(`WebSocket ${ws.url()}`);
    ws.close();
  });
}

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

// Holds a port on 127.0.0.1, where the app listens with LOCAL_ONLY, until
// closed.
async function occupy(port: number): Promise<net.Server> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function launchKarafriends(
  options: Options,
  graphqlRequests: string[],
  testInfo: TestInfo,
): Promise<{ karafriends: Karafriends; close: () => Promise<void> }> {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} is missing; run \`yarn build-prod\` first.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends-e2e-"));
  const userDataDir = path.join(tempDir, "user-data");
  fs.mkdirSync(userDataDir);
  let app: ElectronApplication | undefined;
  let portHolder: net.Server | undefined;
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
    if (portHolder) {
      const holder = portHolder;
      await new Promise((resolve) => holder.close(resolve));
    }
    // On failure, keep the main process's output and the app's download logs
    // (yt-dlp, ffmpeg) with the report. Not with real logins: DAM stream URLs
    // carry tokens.
    if (failed && !options.realCredentials) {
      const logs: [string, string][] = [];
      if (mainLog.length > 0) {
        const logPath = testInfo.outputPath("main-process.log");
        fs.writeFileSync(logPath, mainLog.join(""));
        logs.push(["main-process.log", logPath]);
      }
      const downloadsDir = path.join(tempDir, "karafriends_tmp");
      if (fs.existsSync(downloadsDir)) {
        for (const file of fs.readdirSync(downloadsDir)) {
          if (!file.endsWith(".log")) continue;
          const logPath = testInfo.outputPath(file);
          fs.copyFileSync(path.join(downloadsDir, file), logPath);
          logs.push([file, logPath]);
        }
      }
      for (const [name, logPath] of logs) {
        await testInfo.attach(name, {
          path: logPath,
          contentType: "text/plain",
        });
      }
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
    if (options.occupyPort) portHolder = await occupy(port);
    fs.writeFileSync(
      path.join(userDataDir, "config.yaml"),
      stringify({
        ...options.appConfig,
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
      seedVideos(queueDir, options.seedQueue);
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
      // Listen on 127.0.0.1 only and skip mDNS, so Windows Firewall doesn't
      // prompt for each worktree's Electron copy.
      KARAFRIENDS_LOCAL_ONLY: "1",
      // Keep the full-screen display window off the user's screen.
      KARAFRIENDS_HIDE_WINDOW: "1",
      ...options.appEnv,
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
    await forbidGraphql(app.context(), graphqlRequests);
    // The app's only pages are the display's.
    const displayRequests: string[] = [];
    app.context().on("request", (request) => {
      displayRequests.push(request.url());
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

    // Stop if Electron ignored the isolation or the mute switch.
    const appState = await app.evaluate(({ app }) => ({
      userData: app.getPath("userData"),
      temp: app.getPath("temp"),
      muted: app.commandLine.hasSwitch("mute-audio"),
    }));
    if (
      !samePath(appState.userData, userDataDir) ||
      !samePath(appState.temp, tempDir) ||
      !appState.muted
    ) {
      throw new Error(
        `The app isn't isolated and muted: ${JSON.stringify(appState)}`,
      );
    }

    const display = await app.firstWindow();

    const remoconUrl = `http://127.0.0.1:${port}/`;
    // (With the port taken, it never does.)
    if (!options.occupyPort) {
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
    }

    return {
      karafriends: { app, display, displayErrors, displayRequests, remoconUrl },
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
  appConfig: [{}, { option: true }],
  occupyPort: [false, { option: true }],
  appEnv: [{}, { option: true }],

  // Checked once the test (and every fixture using it) is done.
  // oxlint-disable-next-line no-empty-pattern
  graphqlRequests: async ({}, use) => {
    const requests: string[] = [];
    await use(requests);
    expect(requests, "the display and the remote must not use GraphQL").toEqual(
      [],
    );
  },

  // Every page a test opens, the remote included.
  context: async ({ context, graphqlRequests }, use) => {
    await forbidGraphql(context, graphqlRequests);
    await use(context);
  },

  karafriends: async (
    {
      seedQueue,
      mediaTools,
      realCredentials,
      appConfig,
      occupyPort,
      appEnv,
      graphqlRequests,
    },
    use,
    testInfo,
  ) => {
    const { karafriends, close } = await launchKarafriends(
      {
        seedQueue,
        mediaTools,
        realCredentials,
        appConfig,
        occupyPort,
        appEnv,
      },
      graphqlRequests,
      testInfo,
    );
    try {
      await use(karafriends);
      expect(
        karafriends.displayRequests.filter(isApiRequest),
        "the display must use IPC, not the HTTP API",
      ).toEqual([]);
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

// The seeded queue's Niconico and YouTube songs come "downloaded" as a
// minute of black video (tests/fixtures/black.mp4), so the display plays
// them: a song whose file is missing is skipped as one that can't play.
// DAM and Joysound songs get no files.
function seedVideos(queueDir: string, seed: object) {
  type Song = { kind: string; songId: string } | null;
  const { currentSong, songQueue } = seed as {
    currentSong?: Song;
    songQueue?: Song[];
  };
  const prefixes: Record<string, string> = { nico: "nico", youtube: "yt" };
  for (const song of [currentSong, ...(songQueue ?? [])]) {
    if (!song || !(song.kind in prefixes)) continue;
    fs.copyFileSync(
      path.join(REPO_ROOT, "tests", "fixtures", "black.mp4"),
      path.join(queueDir, `${prefixes[song.kind]}-${song.songId}.mp4`),
    );
  }
}
