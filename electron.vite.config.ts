// The build: electron-vite (Vite 8) for the main process, the display's
// preload, and the two web pages, the display (src/renderer) and the phone
// remote (src/remocon).
//
// Everything is bundled, node_modules included, and the app ships only
// build/prod (see packager.js):
//   build/<prod|dev>/main      the main process, plus the native module in chunks/
//   build/<prod|dev>/preload   the display's preload
//   build/<prod|dev>/web       renderer/ and remocon/ pages, their assets/,
//                              and static/ (the kuromoji dict/ and the
//                              remote's service worker)
//
// The remote runs in phone browsers, so the two pages are built for them,
// back to iPhones on iOS 15 (REMOCON_TARGET); the display's Chromium runs
// that too. Main and preload target Electron's Node.
//
// `yarn dev` (electron-vite dev -w) builds main and preload into build/dev,
// rebuilding and restarting on change, and serves the pages from the Vite dev
// server. That server is the phones' front door in dev: it serves the remote
// with hot reload and proxies /api to the app's Express server. In dev, main
// and preload load the native module from build/dev/native instead of chunks/
// (see devNativeModule).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

import { HOSTNAME } from "./src/common/constants";

// In dev, Express listens on this port and Vite proxies /api to it. Set here,
// so the Electron app electron-vite starts (it inherits this process's
// environment) listens where the proxy points, whatever config.yaml says.
process.env.KARAFRIENDS_REMOCON_PORT ??= "8080";
const remoconPort = Number(process.env.KARAFRIENDS_REMOCON_PORT);

// On Linux, `yarn dev` starts Electron with --no-sandbox (what electron-vite's
// --noSandbox sets). Where the kernel blocks unprivileged user namespaces
// (Ubuntu 23.10 and later), Chromium falls back to node_modules' chrome-sandbox,
// which isn't setuid root, and aborts. The display runs unsandboxed anyway (its
// preload loads the native module), so this only unsandboxes Chromium's
// helper processes.
if (process.platform === "linux") process.env.NO_SANDBOX ??= "1";

// KARAFRIENDS_LOCAL_ONLY=1 (tests and checks): this machine only, so the dev
// server doesn't raise a firewall prompt either (see src/common/config.ts).
const localOnly = process.env.KARAFRIENDS_LOCAL_ONLY === "1";

// The static/ folder: the kuromoji dict/ and the remote's service worker.
const STATIC_DIR = path.resolve("static");

const PAGES = {
  renderer: path.resolve("src/renderer/index.html"),
  remocon: path.resolve("src/remocon/index.html"),
};

// The remote's browsers: Vite's defaults, with iPhones back to iOS 15. The
// CSS keeps the prefixes they need, such as the -webkit-user-select that iOS
// Safari does (remote.spec.ts checks the build).
const REMOCON_TARGET = [
  "chrome111",
  "edge111",
  "firefox114",
  "safari15",
  "ios15",
];

// Builds the pages for REMOCON_TARGET. electron-vite's own plugin sets the
// renderer's target to Electron's Chromium, and merges a build.target given
// in this config into it (two Chromes, which the bundler refuses), so this
// plugin replaces it afterwards. electron-vite then warns that the target
// "is not chrome?": expected.
function phoneTarget(): Plugin {
  return {
    name: "karafriends:phone-target",
    apply: "build",
    enforce: "post",
    config(config) {
      config.build = {
        ...config.build,
        target: REMOCON_TARGET,
        cssTarget: REMOCON_TARGET,
      };
    },
  };
}

// Two fixes to what the dev server serves.
function devServerRoutes(): Plugin {
  return {
    name: "karafriends:dev-server-routes",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // The phones' QR code points at the root; the remote is at /remocon/.
        if (req.url === "/") {
          res.statusCode = 302;
          res.setHeader("Location", "/remocon/");
          res.end();
          return;
        }
        // Vite would send the dictionary's .gz files with Content-Encoding:
        // gzip, so the browser would unzip them before kuromoji does. Send
        // them as they are, as file:// does in prod.
        const dict = req.url?.match(/^\/dict\/([\w.]+\.gz)$/);
        const file = dict && path.join(STATIC_DIR, "dict", dict[1]);
        if (file && fs.existsSync(file)) {
          res.setHeader("Content-Type", "application/octet-stream");
          fs.createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

const NATIVE_MODULE = path.resolve("native/index.node");
const DEV_NATIVE_DIR = path.resolve("build/dev/native");

// `yarn dev` only. The running app has the native module loaded, and Windows
// can't delete or overwrite a loaded DLL. A rebuild of main or preload
// empties its outDir and writes chunks/index-<hash>.node again, so it would
// fail with EPERM and the app would never restart. Instead, main and preload
// require a copy outside their outDirs, named by its content: a rebuild
// leaves it alone, and a new native build gets a new copy.
function devNativeModule(): Plugin {
  return {
    name: "karafriends:dev-native-module",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        !importer ||
        !source.endsWith(".node") ||
        path.resolve(path.dirname(importer), source) !== NATIVE_MODULE
      ) {
        return;
      }
      // A new native build rebuilds main and preload, as an import would.
      this.addWatchFile(NATIVE_MODULE);
      const contents = fs.readFileSync(NATIVE_MODULE);
      const hash = crypto.createHash("sha256").update(contents).digest("hex");
      const name = `index-${hash.slice(0, 16)}.node`;
      const copy = path.join(DEV_NATIVE_DIR, name);
      if (!fs.existsSync(copy)) {
        fs.mkdirSync(DEV_NATIVE_DIR, { recursive: true });
        fs.writeFileSync(`${copy}.tmp`, contents);
        fs.renameSync(`${copy}.tmp`, copy);
      }
      // Older copies go once no app has them loaded.
      for (const file of fs.readdirSync(DEV_NATIVE_DIR)) {
        if (file === name) continue;
        try {
          fs.rmSync(path.join(DEV_NATIVE_DIR, file), { force: true });
        } catch {
          // Still loaded; a later rebuild deletes it.
        }
      }
      // Left as require("<absolute path>") in the output.
      return { id: copy, external: "absolute" };
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const production = mode === "production";
  const outDir = path.resolve("build", production ? "prod" : "dev");
  if (command === "serve") {
    // Stack traces from the dev Electron app point into src/.
    process.env.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      "--enable-source-maps",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const nodePlugins = () => (command === "serve" ? [devNativeModule()] : []);
  return {
    main: {
      plugins: nodePlugins(),
      build: {
        externalizeDeps: false,
        outDir: path.join(outDir, "main"),
        lib: { entry: "src/main/index.ts" },
        minify: production,
        sourcemap: !production,
      },
    },
    preload: {
      plugins: nodePlugins(),
      build: {
        externalizeDeps: false,
        outDir: path.join(outDir, "preload"),
        lib: { entry: "src/preload/index.ts" },
        minify: production,
        sourcemap: !production,
      },
    },
    renderer: {
      root: "src",
      // Copied to the root of build/<mode>/web once, and served at / in dev.
      publicDir: STATIC_DIR,
      plugins: [react(), devServerRoutes(), phoneTarget()],
      resolve: {
        // kuromoji (the display's furigana): its own browser bundle. Its
        // sources need Node's path, and the gunzip they use only works with
        // CommonJS's top-level `this`.
        alias: [
          { find: /^kuromoji$/, replacement: "kuromoji/build/kuromoji.js" },
        ],
      },
      build: {
        outDir: path.join(outDir, "web"),
        minify: production,
        sourcemap: !production,
        // The display's bundle is about 1 MB; it loads from disk.
        chunkSizeWarningLimit: 1500,
        rolldownOptions: { input: PAGES },
      },
      server: {
        host: localOnly ? "127.0.0.1" : true,
        // Phones may use the app's mDNS name; IP addresses are allowed anyway.
        allowedHosts: [HOSTNAME],
        port: Number(process.env.KARAFRIENDS_DEV_PORT) || 5173,
        proxy: {
          // The live stream (/api/events) too: the proxy streams responses.
          "/api": { target: `http://127.0.0.1:${remoconPort}` },
        },
      },
    },
  };
});
