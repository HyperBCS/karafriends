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
  protocol,
} from "electron";
import isDev from "electron-is-dev";
import express from "express";

import karafriendsConfig, { HIDE_WINDOW, LOCAL_ONLY } from "../common/config";
import { ensureExternalResources } from "./../common/externalResources";
import { TEMP_FOLDER } from "./../common/videoDownloader";
import { IPC_CHANNELS, REMOCON_PORT_ARG } from "../common/ipc";
import { startHttpServer } from "./httpServer";
import { createDisplayIpc } from "./ipc";
import setupMdns from "./mdns";
import remoconServiceWorkerAllowed from "./middleware/remoconServiceWorkerAllowed";
import { apiRouter, shouldCompress } from "./server";
import { api, hub } from "./services";

// In dev, start a debug server if we don't have one already (opening a
// second one would throw). Packaged builds don't open one, since anything
// on this machine could attach to it and run code in the main process.
if (isDev && inspector.url() === undefined) inspector.open();

try {
  nativeAudio.allocConsole();
} catch (e) {
  // Started from a terminal, the process already has a console and Windows
  // refuses a second one with "Access is denied" (os error 5). That's fine.
  if (!String(e).includes("os error 5")) console.error(e);
}

if (!LOCAL_ONLY) setupMdns();

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

let rendererWindow: BrowserWindow | null;

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
ipcMain.handle(IPC_CHANNELS.remoconProblem, (event) =>
  displayIpc.remoconProblem(event),
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
  // karaoke display permanently blank. Reload the window so the show goes on.
  rendererWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone (${details.reason})`);
    if (details.reason !== "clean-exit") {
      rendererWindow?.reload();
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

  if (karafriendsConfig.proxyEnable) {
    session
      .setProxy({
        proxyRules: `${karafriendsConfig.proxyHost}:${karafriendsConfig.proxyPort}`,
        proxyBypassRules: "<local>,192.168.0.0/16,172.16.0.0/12,10.0.0.0/8",
      })
      .catch((err) => console.error("Failed to set proxy:", err));
  }

  protocol.registerFileProtocol("karafriends", (request, callback) => {
    console.log(`Got protocol request: ${request.method} ${request.url}`);
    // URLs are karafriends://local/<file>; the case-sensitive file name is in
    // the path (the standard-scheme host is lowercased, so it can't go there).
    const file = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/+/,
      "",
    );
    const root = path.resolve(TEMP_FOLDER);
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    // Only serve files inside the temp folder (net::ERR_ACCESS_DENIED).
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      callback({ error: -10 });
      return;
    }
    callback({ path: target });
  });

  const expressApp = express();

  expressApp.use(compression({ filter: shouldCompress }));

  expressApp.use("/api", apiRouter(api, hub));

  expressApp.use(remoconServiceWorkerAllowed());

  // The phone remote: its page at /, and the assets and service worker it
  // loads. (With the pages on the Vite dev server, phones use that instead.)
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
    displayIpc.reportRemoconProblem,
  );

  if (rendererWindow) {
    // A failed load (dev server not ready, a transient file/protocol error)
    // would leave the karaoke display blank, and the unhandled loadURL
    // rejection would reach the process-level handler. Catch it and retry a few
    // times so the show still comes up.
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
    loadRenderer();
  }
}

app.on("ready", () => {
  // Start warming the external resource cache as soon as the app is ready so
  // the binaries are usually in place before the first song is queued. This is
  // best-effort: failures are logged and retried on demand by the downloader,
  // and must be caught here so the unhandledRejection handler doesn't exit.
  ensureExternalResources().catch((err) =>
    console.error(`Error preparing external resources: ${err}`),
  );
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (rendererWindow === null) {
    createWindow();
  }
});

function refreshRendererWindow() {
  if (!rendererWindow) return;
  if (
    dialog.showMessageBoxSync(rendererWindow, {
      message: "Are you sure you want to reload the renderer window?",
      buttons: ["Reload", "Cancel"],
    }) === 0
  ) {
    rendererWindow.reload();
  }
}

app.on("browser-window-focus", () => {
  globalShortcut.register("CommandOrControl+R", refreshRendererWindow);
  globalShortcut.register("F5", refreshRendererWindow);
});

app.on("browser-window-blur", () => {
  globalShortcut.unregister("CommandOrControl+R");
  globalShortcut.unregister("F5");
});

app.on("login", (event, webContents, request, authInfo, callback) => {
  console.log(
    `login event received: authinfo=${authInfo} callback=${callback}`,
  );
  if (karafriendsConfig.proxyEnable) {
    const { proxyHost, proxyPort, proxyUser, proxyPass } = karafriendsConfig;
    console.log(`Time to login to ${proxyHost}:${proxyPort}`);
    callback(proxyUser, proxyPass);
    event.preventDefault();
  } else {
    // Well that's strange...
    console.log("Received login event even though proxy is not enabled?");
    if (rendererWindow) {
      dialog.showMessageBoxSync(rendererWindow, {
        message:
          "Received login event even though proxy is not enabled. Proceed with caution",
      });
    }
  }
});
