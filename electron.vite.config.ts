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
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// The static/ folder: the kuromoji dict/ and the remote's service worker.
const STATIC_DIR = path.resolve("static");

export default defineConfig(({ mode }) => {
  const production = mode === "production";
  const outDir = path.resolve("build", production ? "prod" : "dev");
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
      plugins: [react()],
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
    },
  };
});
