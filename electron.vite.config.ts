// The build: electron-vite (Vite 8) for the main process, the display's
// preload, and the two web pages, the display (src/renderer) and the phone
// remote (src/remocon).
//
// Everything is bundled, node_modules included, and the app ships only
// build/prod (see packager.js):
//   build/<prod|dev>/main      the main process, plus the native module in chunks/
//   build/<prod|dev>/preload   the display's preload
//   build/<prod|dev>/web       renderer/ and remocon/ pages, their shared
//                              assets/, and static/ (the kuromoji dict/ and
//                              the remote's service worker)
//
// `yarn dev` (electron-vite dev -w) builds main and preload into build/dev,
// rebuilding and restarting on change, and serves the pages from the Vite dev
// server. That server is the phones' front door in dev: it serves the remote
// with hot reload and proxies /api to the app's Express server.
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

// KARAFRIENDS_LOCAL_ONLY=1 (tests and checks): this machine only, so the dev
// server doesn't raise a firewall prompt either (see src/common/config.ts).
const localOnly = process.env.KARAFRIENDS_LOCAL_ONLY === "1";

// The static/ folder: the kuromoji dict/ and the remote's service worker.
const STATIC_DIR = path.resolve("static");

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
  return {
    main: {
      build: {
        externalizeDeps: false,
        outDir: path.join(outDir, "main"),
        lib: { entry: "src/main/index.ts" },
        minify: production,
        sourcemap: !production,
      },
    },
    preload: {
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
      plugins: [react(), devServerRoutes()],
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
        rolldownOptions: {
          input: {
            renderer: path.resolve("src/renderer/index.html"),
            remocon: path.resolve("src/remocon/index.html"),
          },
        },
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
