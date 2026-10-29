// First: a second launch leaves here, before anything below loads.
import "./singleInstance";
// The native module is copied next to the bundle and loaded with require().
import nativeAudio from "../../native/index.node";

import fs from "fs";
import util from "util";

// Any uncaught exception or unhandled rejection is fatal: log it and exit.
// Fatal errors are also appended to fatal-errors.log in app.getPath("logs") so
// a crash can be diagnosed after the console is gone. Nothing else goes in that
// file, because regular console output can include DAM tokens and Joysound
// cookies.
function handleError(err: unknown) {
  console.error("Fatal error:", err);
  try {
    const logDir = app.getPath("logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "fatal-errors.log"),
      `[${new Date().toISOString()}] ${util.inspect(err)}\n`,
    );
  } catch (logErr) {
    console.error("Failed to write the fatal error log:", logErr);
  }
  process.exit(1);
}

process.on("uncaughtException", handleError);
process.on("unhandledRejection", handleError);

import inspector from "inspector";
import path from "path";
import { pathToFileURL } from "url";

import compression from "compression";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  powerSaveBlocker,
  protocol,
} from "electron";
import isDev from "electron-is-dev";
import express from "express";

import karafriendsConfig, { HIDE_WINDOW, LOCAL_ONLY } from "../common/config";
import { ensureExternalResources } from "./../common/externalResources";
import { stopAllTools, DOWNLOADS_FOLDER } from "./downloads";
import { useSystemCertificates } from "./downloads/run";
import { IPC_CHANNELS, REMOCON_PORT_ARG } from "../common/ipc";
import { startHttpServer } from "./httpServer";
import { createDisplayIpc } from "./ipc";
import setupMdns from "./mdns";
import { createCrashReloads } from "./rendererRecovery";
import { apiRouter, shouldCompress } from "./server";
import { api, hub, reportRemoconProblem, resumeDownloads } from "./services";

// In dev, start a debug server if we don't have one already (opening a
// second one would throw). Packaged builds don't open one, since anything
// on this machine could attach to it and run code in the main process.
if (isDev && inspector.url() === undefined) inspector.open();

// Not under tests: the console window would pop up and take the focus for
// every launch.
if (!HIDE_WINDOW) {
  try {
    nativeAudio.allocConsole();
  } catch (e) {
    // Started from a terminal, the process already has a console and
    // Windows refuses a second one with "Access is denied" (os error 5).
    // That's fine.
    if (!String(e).includes("os error 5")) console.error(e);
  }
}

if (!LOCAL_ONLY) setupMdns();

// Before any download starts a tool.
useSystemCertificates(process.env, process.platform, fs.existsSync);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "karafriends",
    privileges: {
      // standard + corsEnabled make this scheme requestable cross-origin from
      // the file:// renderer; without them Chromium blocks e.g. a <video src>
      // pointing at karafriends:// with a CORS error. secure keeps it a
      // trustworthy origin. NB: a standard scheme lowercases the URL host, so
      // the (case-sensitive) file name must live in the path -- see the handler
      // and the karafriends://local/<file> URLs in the renderer.
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let rendererWindow: BrowserWindow | undefined;

// When to reload the display after a crash.
const crashReloads = createCrashReloads();

// The built pages, next to this bundle (see electron.vite.config.ts).
const WEB_DIR = path.join(__dirname, "..", "web");

// `electron-vite dev` serves the pages from the Vite dev server, and says
// where in ELECTRON_RENDERER_URL.
const devServerUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;

// The display's page.
const rendererUrl = devServerUrl
  ? new URL("renderer/", devServerUrl).href
  : pathToFileURL(path.join(WEB_DIR, "renderer", "index.html")).href;

// The port phones connect to, for the display's QR code: in dev, the dev
// server's, which serves the remote and proxies /api to this app's server.
const phonePort = devServerUrl
  ? Number(new URL(devServerUrl).port)
  : karafriendsConfig.remoconPort;

// The display talks to this process over IPC, not HTTP (see ipc.ts).
const displayIpc = createDisplayIpc({
  handlers: api,
  hub,
  display: () =>
    rendererWindow && !rendererWindow.isDestroyed()
      ? rendererWindow.webContents
      : null,
  displayUrl: rendererUrl,
});

ipcMain.handle(IPC_CHANNELS.call, (event, method: unknown, input: unknown) =>
  displayIpc.call(event, method, input),
);
ipcMain.on(IPC_CHANNELS.liveSubscribe, (event) =>
  displayIpc.subscribeLive(event),
);

// Export and import config: dialogs over the display window, for the
// display only.
const YAML_FILES = [{ name: "Config files", extensions: ["yaml", "yml"] }];
ipcMain.handle(
  IPC_CHANNELS.saveTextFile,
  async (event, suggestedName: unknown, text: unknown) => {
    if (!displayIpc.isFromDisplay(event) || !rendererWindow) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(rendererWindow, {
      defaultPath: path.join(
        app.getPath("documents"),
        path.basename(String(suggestedName)),
      ),
      filters: YAML_FILES,
    });
    if (canceled || !filePath) return false;
    await fs.promises.writeFile(filePath, String(text), "utf8");
    return true;
  },
);
ipcMain.handle(IPC_CHANNELS.openTextFile, async (event) => {
  if (!displayIpc.isFromDisplay(event) || !rendererWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(rendererWindow, {
    properties: ["openFile"],
    filters: YAML_FILES,
  });
  if (canceled || !filePaths[0]) return null;
  return fs.promises.readFile(filePaths[0], "utf8");
});

// Once, at launch: the display's window, the karafriends:// protocol and the
// phones' server. (Closing the window quits the app.)
function createWindow() {
  rendererWindow = new BrowserWindow({
    frame: isDev,
    fullscreen: !isDev && !HIDE_WINDOW,
    show: !HIDE_WINDOW,
    webPreferences: {
      // A hidden window would otherwise have its timers throttled.
      backgroundThrottling: !HIDE_WINDOW,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      preload: path.join(__dirname, "..", "preload", "index.js"),
      // The preload reads the port from its process.argv, for the remote's
      // address in the QR code.
      additionalArguments: [`${REMOCON_PORT_ARG}${phonePort}`],
      sandbox: false,
      webSecurity: true,
    },
  });

  // A renderer crash (GPU reset, OOM, native fault) would otherwise leave the
  // karaoke display permanently blank. Reload the window so the show goes on,
  // after a wait, and not in a loop (rendererRecovery.ts).
  rendererWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone (${details.reason})`);
    if (details.reason === "clean-exit") return;
    const wait = crashReloads.crashed();
    if (wait !== null) {
      setTimeout(reloadDisplay, wait);
    } else {
      console.error("The display keeps crashing: asking before reloading it");
      askAfterCrashes(details.reason).catch((err) =>
        console.error("Failed to ask about the crashes:", err),
      );
    }
  });
  // (A reloaded page subscribes again, which replaces its old subscription.)
  rendererWindow.webContents.on("destroyed", displayIpc.endLive);

  // Ignore CORS when fetching ipcasting HLS (DAM's streams).
  const session = rendererWindow.webContents.session;
  const ignoreCORSFilter = { urls: ["https://*.ipcasting.jp/*"] };

  session.webRequest.onBeforeSendHeaders(
    ignoreCORSFilter,
    (details, callback) => {
      delete details.requestHeaders.Origin;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  session.webRequest.onHeadersReceived(
    ignoreCORSFilter,
    (details, callback) => {
      // Replace any ACAO the server sent: Chrome refuses one set twice.
      if (details.responseHeaders) {
        delete details.responseHeaders["access-control-allow-origin"];
        details.responseHeaders["Access-Control-Allow-Origin"] = ["*"];
      }
      callback({ responseHeaders: details.responseHeaders });
    },
  );

  protocol.registerFileProtocol("karafriends", (request, callback) => {
    console.log(`Got protocol request: ${request.method} ${request.url}`);
    // URLs are karafriends://local/<file>; the case-sensitive file name is in
    // the path (the standard-scheme host is lowercased, so it can't go there).
    const file = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/+/,
      "",
    );
    const root = path.resolve(DOWNLOADS_FOLDER);
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    // Only serve files inside the downloads folder (net::ERR_ACCESS_DENIED).
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      callback({ error: -10 });
      return;
    }
    callback({ path: target });
  });

  const expressApp = express();

  expressApp.use(compression({ filter: shouldCompress }));

  expressApp.use("/api", apiRouter(api, hub));

  // The phone remote: its page at /, and the assets it loads. (With the
  // pages on the Vite dev server, phones use that instead.)
  if (!devServerUrl) {
    expressApp.use(express.static(path.join(WEB_DIR, "remocon")));
    expressApp.use(express.static(WEB_DIR, { index: false }));
  }

  // If it can't listen, phones can't connect, but the display still works.
  startHttpServer(
    expressApp,
    {
      port: karafriendsConfig.remoconPort,
      // LOCAL_ONLY (tests and checks): this machine only, so no firewall
      // prompt.
      host: LOCAL_ONLY ? "127.0.0.1" : undefined,
    },
    reportRemoconProblem,
  );

  if (rendererWindow) {
    // A failed load (dev server not ready, a transient file/protocol error)
    // would leave the karaoke display blank, and the unhandled loadURL
    // rejection would reach the process-level handler. Catch it and retry a few
    // times so the show still comes up.
    // Since the last good load.
    let rendererLoadAttempts = 0;
    const loadRenderer = () => {
      rendererWindow
        ?.loadURL(rendererUrl)
        .catch((err) =>
          console.error(`Failed to load renderer ${rendererUrl}:`, err),
        );
    };
    rendererWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        // -3 (ERR_ABORTED) is a benign navigation cancel, not a real failure.
        if (!isMainFrame || errorCode === -3) return;
        console.error(
          `Renderer failed to load (${errorCode} ${errorDescription})`,
        );
        if (rendererLoadAttempts++ < 10) {
          setTimeout(loadRenderer, 1000);
        }
      },
    );
    rendererWindow.webContents.on("did-finish-load", () => {
      rendererLoadAttempts = 0;
    });
    loadRenderer();
  }
}

function reloadDisplay() {
  if (rendererWindow && !rendererWindow.isDestroyed()) rendererWindow.reload();
}

// The display crashed three times in a minute: say so on the TV, and
// reload only when the host asks. (Not with the window hidden: tests.)
async function askAfterCrashes(reason: string) {
  if (!rendererWindow || HIDE_WINDOW) return;
  const { response } = await dialog.showMessageBox(rendererWindow, {
    type: "error",
    message: "The karaoke display keeps crashing",
    detail: `It stopped 3 times in a minute (${reason}). Reload it to try again, or quit and start karafriends again.`,
    buttons: ["Reload", "Quit"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) {
    app.quit();
    return;
  }
  crashReloads.reset();
  reloadDisplay();
}

app.on("ready", () => {
  // Keep the TV on, and the computer awake, for as long as the app runs.
  // Between songs nothing plays, so nothing else stops the screen blanking
  // after the OS's idle timeout (5 minutes on GNOME, which also locks the
  // session): the QR code would be gone and later songs would play behind a
  // black or locked screen. Taken at launch, because taking it once the
  // screen has blanked doesn't bring the screen back. (Not for a hidden
  // window: the tests and checks.)
  if (!HIDE_WINDOW) powerSaveBlocker.start("prevent-display-sleep");
  // Start warming the external resource cache as soon as the app is ready so
  // the binaries are usually in place before the first song is queued. This is
  // best-effort: failures are logged and retried on demand by the downloader,
  // and must be caught here so the unhandledRejection handler doesn't exit.
  ensureExternalResources().catch((err) =>
    console.error(`Error preparing external resources: ${err}`),
  );
  // Songs whose downloads a restart cut short download again.
  resumeDownloads();
  createWindow();
});

// A second launch (singleInstance.ts) brings this display back to the front.
app.on("second-instance", () => {
  if (!rendererWindow || rendererWindow.isDestroyed()) return;
  if (rendererWindow.isMinimized()) rendererWindow.restore();
  if (!HIDE_WINDOW) rendererWindow.show();
  rendererWindow.focus();
});

app.on("window-all-closed", () => {
  app.quit();
});

// A download running now would go on without the app.
app.on("will-quit", stopAllTools);

// F5 or Ctrl+R on the host's keyboard asks first. The dialog doesn't block
// the main process, so phones, live updates and downloads carry on while
// it's up; a second press while it's up does nothing.
let confirmingReload = false;
async function refreshRendererWindow() {
  if (!rendererWindow || confirmingReload) return;
  confirmingReload = true;
  try {
    const { response } = await dialog.showMessageBox(rendererWindow, {
      message: "Are you sure you want to reload the renderer window?",
      buttons: ["Reload", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      crashReloads.reset();
      reloadDisplay();
    }
  } finally {
    confirmingReload = false;
  }
}
const onReloadKey = () => {
  refreshRendererWindow().catch((err) =>
    console.error("Failed to ask about reloading:", err),
  );
};

app.on("browser-window-focus", () => {
  globalShortcut.register("CommandOrControl+R", onReloadKey);
  globalShortcut.register("F5", onReloadKey);
});

app.on("browser-window-blur", () => {
  globalShortcut.unregister("CommandOrControl+R");
  globalShortcut.unregister("F5");
});
