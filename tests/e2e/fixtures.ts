// Playwright fixtures that launch the production build of karafriends in a
// throwaway profile and open its phone remote in an emulated phone.
//
// Everything a test touches lives in a fresh temp directory:
//   <tmp>/user-data          --user-data-dir: config.yaml, queue.json,
//                            externalResources, downloads
//   <tmp>                    app.getPath("temp")
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
// Every test also fails if the display sends a request to /api (it talks to
// the main process over IPC; see isApiRequest), or logs an error to its
// console that the test didn't expect (see allowDisplayErrors).

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { parse, stringify } from "yaml";

import {
  hashAdminPassword,
  newAdminSalt,
} from "../../src/common/adminPassword";
import type { LiveState } from "../../src/common/api";
import { resourcePathsFor } from "../../src/common/externalResourcesPlan";
import { songFileNames } from "../../src/common/songFiles";
import { buildJoy02 } from "../fixtures/joy02";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const MAIN_ENTRY = path.join(
  REPO_ROOT,
  "build",
  "prod",
  "main",
  "index.js",
);

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
  // Write it (and its songs' videos) where versions before 0.3 kept them,
  // with the downloads in the temp folder.
  seedQueueInTempFolder: boolean;
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
  // The display's console errors (and uncaught exceptions) a test expects,
  // e.g. a song that fails to play (see anyOf). Any other fails the test.
  allowDisplayErrors: RegExp | null;
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

// The app's downloads folder (in userData), which the display plays from.
export async function downloadsFolder(
  app: ElectronApplication,
): Promise<string> {
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  return path.join(userData, "downloads");
}

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

// How much of a slider's track the accent fills, in percent: the
// --kf-fill that the display and the remote set from its value.
export function sliderFill(slider: Locator): Promise<number> {
  return slider.evaluate((el) =>
    parseFloat(getComputedStyle(el).getPropertyValue("--kf-fill")),
  );
}

// A pattern that matches what any of these do, for allowDisplayErrors.
export function anyOf(...patterns: RegExp[]): RegExp {
  return new RegExp(
    patterns.map((pattern) => `(?:${pattern.source})`).join("|"),
  );
}

// The phone's now-playing sheet once it has stopped moving: it slides open
// and shut, and follows a drag, marked data-moving meanwhile (Sheet.tsx).
export async function sheetSettled(page: Page) {
  await expect(
    page.getByRole("region", { name: "Now playing" }),
  ).not.toHaveAttribute("data-moving");
}

// Opens the now-playing sheet with its toggle, and waits for it to settle.
export async function showQueue(page: Page) {
  await page.getByRole("button", { name: "Show queue" }).click();
  await sheetSettled(page);
}

// The address the display's QR code shows by default: this computer's first
// LAN address (localhost with none), with the remote's port.
export async function defaultAddress(display: Page): Promise<string> {
  return display.evaluate(() => {
    const { karafriends } = window as unknown as {
      karafriends: { ipAddresses(): string[]; remoconPort(): number };
    };
    const [first = "localhost"] = karafriends.ipAddresses();
    return `${first}:${karafriends.remoconPort()}`;
  });
}

// A phone, as its requests name it.
export type Phone = { deviceId: string; nickname: string };
export const PHONE: Phone = { deviceId: "e2e-phone", nickname: NICKNAME };

// The headers a phone's requests carry.
export function phoneHeaders(phone: Phone): Record<string, string> {
  return {
    "X-Karafriends-Device-Id": phone.deviceId,
    "X-Karafriends-Nickname": phone.nickname,
  };
}

// A phone's call to the API (POST /api/<method>): its status and JSON
// answer. With phone null, the request names no phone.
export async function apiCall(
  remoconUrl: string,
  method: string,
  input: object,
  phone: Phone | null = PHONE,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(`api/${method}`, remoconUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(phone ? phoneHeaders(phone) : {}),
      ...headers,
    },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: await res.json() };
}

// The first event of a fresh /api/events stream (the live state, as the
// phone with deviceId sees it, if given): its data, as sent, and the
// response's Content-Type. Pings and other named events are skipped. Fails
// after timeoutMs instead of waiting for the test's own timeout.
export async function firstLiveEvent(
  remoconUrl: string,
  {
    deviceId,
    timeoutMs = 10_000,
  }: { deviceId?: string; timeoutMs?: number } = {},
): Promise<{ data: string; contentType: string | null }> {
  const url = new URL("api/events", remoconUrl);
  if (deviceId) url.searchParams.set("deviceId", deviceId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The stream ended early: ${text}`);
      text += value.replace(/\r\n?/g, "\n");
      // Whole events only: each ends with a blank line.
      const events = text.split("\n\n").slice(0, -1);
      for (const event of events) {
        const lines = event.split("\n");
        if (lines.some((line) => line.startsWith("event:"))) continue;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""));
        if (data.length > 0) {
          return {
            data: data.join("\n"),
            contentType: res.headers.get("content-type"),
          };
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `No live state from ${url} within ${timeoutMs} ms: ${text}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// The live state, as a phone (with deviceId, if given) sees it.
export async function liveState(
  remoconUrl: string,
  deviceId?: string,
): Promise<LiveState> {
  const { data } = await firstLiveEvent(remoconUrl, { deviceId });
  return JSON.parse(data).state;
}

// The current song's songKey (songId@timestamp), or "none": what
// setPlaybackState, setPitchShiftSemis and pushAdhocLyrics name as the song
// they're for.
export async function currentSongKey(remoconUrl: string): Promise<string> {
  const song = (await liveState(remoconUrl)).currentSong;
  return song ? `${song.songId}@${song.timestamp}` : "none";
}

// The display's live state, from its preload (as the display sees it, over
// IPC).
export function displayLiveState(display: Page): Promise<LiveState> {
  type DisplayApi = {
    onLive(
      listener: (event: { type: string; state?: LiveState }) => void,
    ): () => void;
  };
  return display.evaluate(
    () =>
      new Promise<LiveState>((resolve) => {
        const api = (window as unknown as { karafriends: { api: DisplayApi } })
          .karafriends.api;
        const stop = api.onLive((event) => {
          if (event.type === "state") {
            resolve(event.state!);
            setTimeout(() => stop());
          }
        });
      }),
  );
}

// What the display's api.call answers.
export type DisplayAnswer = {
  ok: boolean;
  output?: any;
  status?: number;
  error?: string;
};

// A call from the display, over IPC through its preload: { ok, output } or
// { ok: false, status, error }.
export function displayCall(
  display: Page,
  method: string,
  input: object = {},
): Promise<DisplayAnswer> {
  return display.evaluate(
    ([method, input]) =>
      (
        window as unknown as {
          karafriends: {
            api: {
              call(method: string, input: object): Promise<DisplayAnswer>;
            };
          };
        }
      ).karafriends.api.call(method, input),
    [method, input] as const,
  );
}

// One of the fake tools in tests/fixtures/bin (yt-dlp-downloads,
// ffmpeg-fails, ...), for KARAFRIENDS_YTDLP_PATH and KARAFRIENDS_FFMPEG_PATH.
export function fakeTool(name: string): string {
  return path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

// A Joysound song that looks downloaded before, so queueSong queues it at
// once: its video (from tests/fixtures) and its lyrics, by default a telop
// with no lines that the display reads without an error.
export async function fakeJoysoundDownload(
  app: ElectronApplication,
  songId: string,
  {
    video = "black.mp4",
    seconds = 60,
    telop = buildJoy02({
      title: `E2E ${songId}`,
      artist: "E2E artist",
      seconds,
      blocks: [],
      events: [],
    }),
  }: { video?: string; seconds?: number; telop?: Buffer } = {},
) {
  const folder = await downloadsFolder(app);
  fs.mkdirSync(folder, { recursive: true });
  const names = songFileNames({ kind: "joysound", songId, suffix: null });
  fs.writeFileSync(path.join(folder, names.telop ?? ""), telop);
  fs.copyFileSync(
    path.join(REPO_ROOT, "tests", "fixtures", video),
    path.join(folder, names.video),
  );
}

// The environment and arguments the app is launched with: Electron's own
// environment plus these settings, isolated in tempDir and userDataDir.
export function appLaunch({
  tempDir,
  userDataDir,
  port,
  appEnv = {},
}: {
  tempDir: string;
  userDataDir: string;
  port: number;
  appEnv?: Record<string, string>;
}): { env: Record<string, string>; args: string[] } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Set by some Electron-based hosts; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    // Serve the built renderer and remote, as a packaged app does.
    ELECTRON_IS_DEV: "0",
    // app.getPath("temp"): TEMP/TMP on Windows, MAC_CHROMIUM_TMPDIR on macOS
    // (Chromium ignores TMPDIR there), TMPDIR elsewhere.
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    MAC_CHROMIUM_TMPDIR: tempDir,
    KARAFRIENDS_REMOCON_PORT: String(port),
    // Listen on 127.0.0.1 only and skip mDNS, so Windows Firewall doesn't
    // prompt for each worktree's Electron copy.
    KARAFRIENDS_LOCAL_ONLY: "1",
    // Keep the full-screen display window off the user's screen.
    KARAFRIENDS_HIDE_WINDOW: "1",
    // Fake mics and outputs (src/preload/index.ts): no test opens a real
    // device, and the display's calls can be read from
    // window.karafriendsFakeAudio.calls().
    KARAFRIENDS_FAKE_AUDIO: "1",
    ...appEnv,
  });
  const args = [
    // Never make a sound, even when a test plays a video.
    "--mute-audio",
    `--user-data-dir=${userDataDir}`,
    // Linux CI runners have no setuid sandbox helper, and no GPU for the
    // display's WebGL piano roll, so allow the software fallback.
    ...(process.platform === "linux"
      ? ["--no-sandbox", "--enable-unsafe-swiftshader"]
      : []),
    MAIN_ENTRY,
  ];
  return { env, args };
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

function prepareMediaTools(userDataDir: string, mode: MediaTools) {
  const dest = path.join(userDataDir, "externalResources");
  const tools = Object.values(resourcePathsFor(process.platform, dest));
  if (mode === "stub") {
    for (const tool of tools) {
      fs.mkdirSync(path.dirname(tool), { recursive: true });
      fs.writeFileSync(tool, "");
    }
    return;
  }

  const source = path.join(installedAppDataDir(), "externalResources");
  for (const tool of tools) {
    const installed = path.join(source, path.relative(dest, tool));
    if (!fs.existsSync(installed)) {
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

// With real logins, karafriends' link to the Joysound account
// (src/main/joysoundLink.ts) is kept here from one run to the next, so the
// @jp tests don't link a new JOYSOUND TV device to the account each time
// they start the app. "Local State" holds the key safeStorage encrypts the
// link with (on Windows), so it comes and goes with it.
const JOYSOUND_LINK_DIR = path.join(
  os.tmpdir(),
  "karafriends-e2e-joysound-link",
);
const JOYSOUND_LINK_FILES = ["Local State", "joysoundLink.bin"];

function restoreJoysoundLink(userDataDir: string) {
  if (!fs.existsSync(path.join(JOYSOUND_LINK_DIR, "joysoundLink.bin"))) return;
  for (const name of JOYSOUND_LINK_FILES) {
    const kept = path.join(JOYSOUND_LINK_DIR, name);
    if (fs.existsSync(kept)) {
      fs.copyFileSync(kept, path.join(userDataDir, name));
    }
  }
}

function keepJoysoundLink(userDataDir: string) {
  if (!fs.existsSync(path.join(userDataDir, "joysoundLink.bin"))) return;
  fs.mkdirSync(JOYSOUND_LINK_DIR, { recursive: true });
  for (const name of JOYSOUND_LINK_FILES) {
    const file = path.join(userDataDir, name);
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(JOYSOUND_LINK_DIR, name));
    }
  }
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

// Whether port is free on 127.0.0.1, where the app listens with LOCAL_ONLY.
// (Windows gives a port another test's app holds there to a listener on all
// addresses.)
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// A free port for the app's server, picked at random below every system's
// ephemeral range (Linux's starts at 32768; Windows' and macOS's at 49152).
// Nothing that asks for any free port (port 0) gets it while the app starts:
// another test's Electron opening its debug port, say. Two launches could
// still pick the same one, so the app is then checked to be the one
// listening (see listensOn).
async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (await isFree(port)) return port;
  }
}

// Whether the app's own main process has a server listening on port, and
// not some other process (another test's app that took the port first).
function listensOn(app: ElectronApplication, port: number): Promise<boolean> {
  return app.evaluate(
    (_, port) =>
      (
        process as unknown as {
          _getActiveHandles(): {
            listening?: boolean;
            address?: () => unknown;
          }[];
        }
      )
        ._getActiveHandles()
        .some(
          (handle) =>
            handle.listening === true &&
            (handle.address?.() as { port?: number } | null)?.port === port,
        ),
    port,
  );
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
  options: Omit<Options, "allowDisplayErrors">,
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
      const closing = app;
      await Promise.race([
        (async () => {
          // Playwright screenshots every page as its app closes, for the
          // report in case the test failed, and the hidden display (which
          // draws a frame or two a second) takes up to a second to give one.
          // A test that passed closes the display first: the app then quits.
          if (!failed) {
            for (const window of closing.windows()) await window.close();
          }
          await closing.close();
        })().catch(() => {}),
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
      const downloadsDir = path.join(userDataDir, "downloads");
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
    if (options.realCredentials) {
      try {
        keepJoysoundLink(userDataDir);
      } catch (err) {
        console.warn(`Couldn't keep the Joysound link: ${err}`);
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
    if (options.realCredentials) restoreJoysoundLink(userDataDir);
    if (options.seedQueue) {
      const [queueDir, videosDir] = options.seedQueueInTempFolder
        ? [
            path.join(tempDir, "karafriends_tmp"),
            path.join(tempDir, "karafriends_tmp"),
          ]
        : [userDataDir, path.join(userDataDir, "downloads")];
      fs.mkdirSync(videosDir, { recursive: true });
      fs.writeFileSync(
        path.join(queueDir, "queue.json"),
        JSON.stringify(options.seedQueue),
      );
      seedVideos(videosDir, options.seedQueue);
    }

    const { env, args } = appLaunch({
      tempDir,
      userDataDir,
      port,
      appEnv: options.appEnv,
    });
    app = await electron.launch({
      args,
      cwd: REPO_ROOT,
      env,
      timeout: 60_000,
    });
    // The app's only pages are the display's.
    const displayRequests: string[] = [];
    app.context().on("request", (request) => {
      displayRequests.push(request.url());
    });

    // The main process logs DAM tokens once logged in,
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
      const launched = app;
      await expect
        .poll(() => listensOn(launched, port), {
          message: `the app's server never listened on port ${port} (in use?)`,
          timeout: 30_000,
        })
        .toBe(true);
      expect((await fetch(remoconUrl)).status).toBe(200);
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

type Fixtures = {
  karafriends: Karafriends;
  display: Page;
  remote: Page;
};

export const test = base.extend<Options & Fixtures>({
  seedQueue: [null, { option: true }],
  seedQueueInTempFolder: [false, { option: true }],
  mediaTools: ["stub", { option: true }],
  realCredentials: [false, { option: true }],
  appConfig: [{}, { option: true }],
  occupyPort: [false, { option: true }],
  appEnv: [{}, { option: true }],
  allowDisplayErrors: [null, { option: true }],

  karafriends: async (
    {
      seedQueue,
      seedQueueInTempFolder,
      mediaTools,
      realCredentials,
      appConfig,
      occupyPort,
      appEnv,
      allowDisplayErrors,
    },
    use,
    testInfo,
  ) => {
    const { karafriends, close } = await launchKarafriends(
      {
        seedQueue,
        seedQueueInTempFolder,
        mediaTools,
        realCredentials,
        appConfig,
        occupyPort,
        appEnv,
      },
      testInfo,
    );
    try {
      await use(karafriends);
      expect(
        karafriends.displayRequests.filter(isApiRequest),
        "the display must use IPC, not the HTTP API",
      ).toEqual([]);
      expect(
        karafriends.displayErrors.filter(
          (error) => !allowDisplayErrors?.test(error),
        ),
        "the display's console errors (allowDisplayErrors lists the expected)",
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
