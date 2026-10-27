# Handoff: continuing karafriends on another Windows machine

Written 2026-10-27 when moving work off the first PC. Start a new Claude Code session in the cloned repo and point it at this file (and, optionally, the exported transcript zip from the old PC's Downloads folder).

## Where things stand

`master` (pushed to `HyperBCS/karafriends`) contains:

- **Upstream sync.** Merged `emmaworley/karafriends` master at `de77b97e` (714 commits). Build tooling matches upstream (Parcel + Yarn 4 PnP); the fork's old webpack/npm setup is gone. Local fixes kept on top: Joysound error fallbacks, HLS skip-on-error, audio worklet guard, deduped IPs, `app.setName`, own macOS signing identity.
- **Fixes made after the sync** (one commit each):
  - `youtubei.js` yarn patch: Parcel inlines `import.meta.url` as `file:///.yarn/...`, which crashed on Windows.
  - Remocon dev proxy: `remocon.<hash>.js` didn't get the `/remocon` prefix, so the phone UI was blank in dev.
  - Joysound login: sound-cafe now issues `JSESSIONID` only after login and wants the CSRF token in `X-XSRF-TOKEN` plus an `XSRF-TOKEN` cookie.
  - Failed DAM/Joysound logins are retried instead of cached until restart; DAM errors show their status code.
  - Joysound telop/ogg data is read through the Buffer's `byteOffset` (small buffers live in Node's shared pool; a short song crashed the app).
- **Repo cleanup** (9 commits): 42 unused dependencies (147 → 105), 171 cache zips (11 MB), 4 dead files, unused imports.

Verified on the old PC: `yarn typecheck`, `yarn test:unit` (32 pass), `yarn build-dev`; the app ran, the remocon loaded, and Joysound/DAM logged in with the Japan VPN on.

## Setting up the new machine

1. **Git**, then a partial clone (the full history is 2.5 GB, mostly old Yarn cache zips):
   ```bash
   git clone --filter=blob:none git@github.com:HyperBCS/karafriends.git
   cd karafriends
   git remote add upstream https://github.com/emmaworley/karafriends.git
   git config user.name "Brandon S"
   git config user.email "atomicbcs@gmail.com"
   ```
2. **Node**: `winget install OpenJS.NodeJS` (26.x was used). Node 25+ doesn't ship corepack, so in **your own terminal** (not through Claude, see gotchas) run `npm install -g corepack` and then `corepack enable`. `node .yarn/releases/yarn-4.6.0.cjs <args>` also works without it.
3. **Rust**: install rustup and make sure stable is at least 1.88 (`rustup update stable`); `ringbuf` 0.5 needs `let` chains. Also install the **Visual Studio Build Tools** with the "Desktop development with C++" workload for the native module.
4. **Config with credentials**: copy `%APPDATA%\karafriends\config.yaml` from the old PC to the same path on the new one. It holds the DAM/Joysound credentials and is never committed. (The old PC's original placeholder version is `config.yaml.bak` next to it; ignore that.)
5. `yarn install`, then `git checkout -- .yarn/cache` (see gotchas), then `yarn run-dev`. Turn on the Japan VPN before using DAM/Joysound.

## Gotchas

- **`yarn install` on Windows deletes Linux-only zips** (`*-linux-*`) from the committed `.yarn/cache` because `.yarnrc.yml` doesn't list `libc`. Restore them with `git checkout -- .yarn/cache` before committing. (One-line fix: add `libc: [glibc]` under `supportedArchitectures`; or it disappears if the cache stops being committed.)
- **The husky pre-commit hook** runs `cargo clippy` and `yarn lint-staged`, so `yarn` must be on PATH.
- **If the Claude desktop app is the Microsoft Store/MSIX build**, anything Claude's shells write under `%APPDATA%`/`%LOCALAPPDATA%` is redirected into the app's private folder. Global installs Claude runs (npm -g, corepack) won't exist for your own terminals; run those yourself. Terminal tabs inside the Claude app also keep the PATH from when the app launched, so restart the app after installing Node.
- **DAM and Joysound only work from a Japanese IP.** Without the VPN, sound-cafe returns 403 and DAM login returns `NG`. Check with `curl -s https://ipinfo.io/country`.
- **Joysound account has no subscription**, so songs come back as 45-second previews. That's the account, not the code.

## Reviews of the stack (read these next)

- [`stack-review-runtime.md`](stack-review-runtime.md): GraphQL + Relay is most of the complexity and barely used. Recommends JSON RPC (`POST /api/<method>`) + one SSE live-state stream + TanStack Query, in a strangler migration. Also: remove Sentry (its DSN is **upstream's** project, and breadcrumbs can carry DAM tokens/Joysound cookies), replace the `niconico` package (286 packages) with `yt-dlp -J`, make the YouTube client lazy. About 450 fewer packages, 98 MB less cache.
- [`stack-review-build.md`](stack-review-build.md): Yarn `nodeLinker: node-modules` with the cache no longer committed (95% of `.git` is cache history), electron-vite instead of Parcel (removes the dev proxy and likely the youtubei patch), oxlint instead of tslint, drop wdio (runs only on upstream's Mac), `@electron/packager` rename. About 956 fewer packages. Includes options for the 2.5 GB `.git` without rewriting history.

Both note which steps could go upstream as PRs and what each costs on future upstream syncs.

## Next steps (not started)

1. **Runtime quick wins**, review steps 2–4: remove Sentry/OpenTelemetry (file log in main via `app.getPath("logs")`, console in renderer, keep exit behaviour); move `await innertubeApiProvider()` from the Apollo context into the `youtubeVideoInfo` resolver; re-implement `nicoVideoInfo` with `yt-dlp --dump-single-json --skip-download` and `yarn remove niconico` (check whether the old code still works first). One commit each.
2. **Bugs found by the review**, one commit each:
   - `removeSong` with an unknown id does `splice(-1, 1)` and removes the last song (`src/main/graphql.ts`)
   - `songHistory` uses `slice(afterInt, firstInt)`, so page 2 is empty
   - `inspector.open()` runs in production (`src/main/index.ts`), leaving a debugger on 127.0.0.1:9229
   - the `config` resolver spreads the whole config, passwords included; return explicit fields
   - the remocon dev proxy `fetch` has no `.catch()`, so a refused request exits the app
3. **Bigger decisions** for the user: untrack the Yarn cache / switch linker; Parcel → electron-vite; GraphQL/Relay → RPC + SSE. The reviews recommend doing Relay removal before the bundler switch.

## Notes Claude kept about this setup

- The user is in the US and uses a Japan VPN for DAM/Joysound; check the IP country before debugging those services.
- On the old PC the Claude app was MSIX-packaged (AppData redirection, see gotchas); check whether that's true on the new one.
