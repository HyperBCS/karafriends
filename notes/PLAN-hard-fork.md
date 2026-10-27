# Plan: hard-fork karafriends and simplify the stack

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                                | State           | Branch / commit       | Notes                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quick wins (Sentry, niconico, lazy YouTube)         | done            | merged in `51f6f62`   | YouTube + Niconico lookups checked in the running app                                                                                                                                                                                                          |
| Phase 1: Yarn node_modules, untrack cache           | done            | merged in `2979465`   | clean install, checks, app launch, DAM/Joysound/YouTube checked; Dependabot turned off in `89f3e48`                                                                                                                                                            |
| Phase 2: purge history, new standalone repo         | done            | new repo at `89f3e48` | 2.4 GB → 57 MB; final tree identical (`ed95948`); 3 cache-only commits dropped; old fork renamed `karafriends-fork-archive`. Local branches `claude/inspiring-tharp-487dd1` and `claude/yarn-node-modules-e69f7d` carry pre-purge hashes: **never merge them** |
| Phase 5a: plain HTTP client for DAM/Joysound        | done            | merged in `d8e00b0`   | live DAM/Joysound lookups, logins, queue+remove checked on JP IP; proxy path untested                                                                                                                                                                          |
| Phase 3: build tidy-ups                             | in progress     |                       | Dependabot already removed in `89f3e48`                                                                                                                                                                                                                        |
| Phase 4: Playwright smoke tests                     | queued          |                       |                                                                                                                                                                                                                                                                |
| Phase 5b–5f: RPC + SSE, client, delete GraphQL, IPC | queued          |                       | 5b: fix `saveDb()` saving a null `currentSong` (restart loads `[null]` into the queue) and DAM paging `slice(after % 30, first)` for non-multiples of 30                                                                                                       |
| Phase 6: electron-vite                              | queued          |                       |                                                                                                                                                                                                                                                                |
| Phase 7: lighter UI libraries                       | queued          |                       |                                                                                                                                                                                                                                                                |
| User follow-up: re-add `MACOS_*` secrets            | waiting on user |                       | only needed for mac releases, after Phase 2                                                                                                                                                                                                                    |

## How this plan is run

- **One session (or worktree subagent) per phase.** The app won't start sessions from automated turns, so overnight phases run as background subagents with their own worktree. A coordinating session starts each phase (or Phase 5 sub-step) as a fresh session in its own worktree, branched from the latest `master`. The brief points at this file. The coordinator keeps only short reports, so it doesn't run out of context.
- **Each phase session:**
  - Implements its section of this plan, with one commit per change and the commit hook passing.
  - Runs the checks in its section: `yarn typecheck`, `yarn test:unit`, `yarn build-dev`, a real app launch (and Playwright once Phase 4 exists).
  - Reports what changed, what it verified, and what it couldn't.
  - Doesn't push or merge.
- **The coordinator** reviews the diff, re-runs the checks on the merged result, merges into `master` with `--no-ff`, pushes, updates the Status table above, and starts the next phase. The user approved merge-and-push after checks on 2026-10-27.
- **Order (updated 2026-10-27, user approved):** quick wins → 1 → 2 → 5a → 3 → 4 → 5b → 5c → 5d → 5e → 5f → 6 → 7.
  - **Phase 2 runs right after Phase 1 merges, with no other session in flight.** The user logged `gh` in and approved the coordinator doing the repo rename and creation with `gh`:
    1. `gh repo rename karafriends-fork-archive`.
    2. Make a full bare clone from the archive URL and run `git filter-repo`.
    3. `gh repo create HyperBCS/karafriends --public`.
    4. Push `master` and tags only.
    5. Reset the local clone onto the new history, and delete local branches and worktrees that still carry old hashes; they must never be merged again.
  - The user re-adds the four `MACOS_*` Actions secrets later.
  - The Japan VPN stays on overnight, so 5a runs right after Phase 2 and tests real DAM/Joysound logins and searches. If `ipinfo.io/country` isn't `JP`, skip those checks and say so.
- **Windows/MSIX notes for every session:**
  - The Claude app here is the Microsoft Store build: writes under `%APPDATA%`/`%LOCALAPPDATA%` from Claude's shells land in a private copy. Keep tool caches inside the repo; leave global installs to the user.
  - DAM/Joysound need a Japanese IP (`curl -s https://ipinfo.io/country`).
  - Don't stop processes you didn't start; another app instance may hold ports 3000/8080.

## Context

karafriends (Electron karaoke app; HyperBCS/karafriends, a GitHub fork of emmaworley/karafriends) carries much more machinery than it needs. The reviews in `notes/stack-review-build.md` and `notes/stack-review-runtime.md` found the bloat mostly in:

- Yarn PnP with a committed all-platform cache: 458 MB and 1,779 files in the tree, 95% of a 2.5 GB history.
- Parcel: idle since February. It's the largest tooling tree and caused both dev-mode bugs we hit.
- GraphQL + Relay: 35 operations where about 20 are needed, codegen, Babel, and four reimplementations of "subscribe to live state".

You decided to stop syncing with upstream, so none of this has to stay merge-friendly. The goal: same app on all four platforms, about 1,000 fewer packages, a small repo with no "forked from" link, a one-command dev loop, and smoke tests to catch regressions.

## Decisions (from Q&A)

- **Upstream:** hard fork. Stop syncing, and remove the `upstream` remote.
- **Scope:**
  - Yarn node_modules with no committed cache
  - GraphQL/Relay → JSON RPC + SSE
  - Parcel → electron-vite
  - Build tidy-ups
  - Extras: display over IPC, lighter UI libraries, server-side admin checks, history purge
- **API:** `POST /api/<method>` with shared TypeScript types, TanStack Query on the client, one SSE live-state stream.
- **Tests:** add Playwright smoke tests before the rewrites.
- **Platforms:** keep all four (win-x64, mac arm64/x64, linux-x64), CI and releases.
- **Dependabot:** off.
- **Landing:**
  - Each phase on its own branch, with a PR on the fork.
  - History purge: move to a new standalone `HyperBCS/karafriends` and archive the old fork under a new name.
  - Delete `joysound_fixes_only`. Its only commit, `386b606`, is already in master (`git cherry` shows it as patch-equivalent).

## Before Phase 1

- Merge the in-flight runtime-quick-wins branch first: Sentry/OTel removal, niconico → yt-dlp, lazy Innertube. It changes `package.json`, `yarn.lock`, `.yarn/cache` and `graphql.ts`.
- **You**, in your own terminal (the Claude app here is the MSIX build, so global installs from Claude don't stick):
  - `winget install GitHub.cli`, then `gh auth login`. That lets PRs be opened and CI be read.
  - `pip install git-filter-repo`, needed for Phase 2.
- `git remote remove upstream`.

## Phases (each leaves the app building and running)

### Phase 1: Yarn node_modules, stop committing the cache (branch `yarn-node-modules`)

- `.yarnrc.yml`:
  - Set `nodeLinker: node-modules`.
  - Remove `supportedArchitectures`.
  - Keep `enableGlobalCache: false`, so the cache stays in `.yarn/cache`: untracked, and outside AppData, which avoids the MSIX redirect.
  - `yarn set version 4.18.1`.
- Untrack the cache: `git rm -r --cached .yarn/cache .pnp.cjs .pnp.loader.mjs`, then add them, `node_modules` and `.yarn/install-state.gz` to `.gitignore`.
- `package.json`:
  - Drop `dependenciesMeta` and `@yarnpkg/pnpify`, and remove the `pnpify` prefixes from scripts.
  - Replace `node electron.js X` with `electron X`, then delete `electron.js`. It only injects PnP.
  - Keep the `youtubei.js` `patch:` entry; it works under node_modules.
- CI (`.github/workflows/build.yaml`, `release.yaml`): add `actions/setup-node` with `cache: yarn`. Keep `yarn install --immutable`.
- Update `notes/HANDOFF.md` and `README.md`: no partial-clone or cache-restore steps, no corepack gotcha (`yarnPath` covers it).
- **Verify:**
  - A clean `yarn install` leaves `git status` clean. This fixes the Windows `libc` problem.
  - `yarn typecheck`, `yarn test:unit`, `yarn build-dev` and `yarn run-dev` pass, and the remote page renders.
  - CI is green on all four jobs.

### Phase 2: purge history, move to a standalone repo (no PR; right after Phase 1 merges, with no other branches open)

All commit hashes change, so first finish or abandon every branch and worktree, including Claude worktrees.

1. Delete the remote branch `joysound_fixes_only`.
2. Make a full bare clone into a scratch folder: `git clone --bare git@github.com:HyperBCS/karafriends.git`. This downloads about 2.5 GB; a partial clone can't be filtered efficiently.
3. Run `git filter-repo --analyze` and review the largest remaining paths. Then:
   ```bash
   git filter-repo --invert-paths --path .yarn/cache --path .pnp.cjs --path .pnp.loader.mjs
   ```
   Add any other dead bulk the analysis shows.
4. **You**, on GitHub:
   - Rename the current repo to `karafriends-fork-archive`.
   - Create a new empty public `HyperBCS/karafriends` with no README.
   - Re-add the Actions secrets `MACOS_SIGNING_CERT_BASE`, `MACOS_SIGNING_CERT_PASSWORD`, `MACOS_KEYCHAIN_PASSWORD` and `MACOS_NOTARIZATION_API_KEY_BASE`.
5. Push the filtered repo to the new repo: `git push origin --all` and `git push origin --tags`.
6. **Verify:**
   - The new `master`'s `HEAD^{tree}` equals the old one. Phase 1 already untracked the cache, so the trees must match exactly.
   - The commit count is unchanged, and `git count-objects -vH` shows tens of MB.
7. Make a fresh clone of the new repo and run `yarn install`. Delete the old local clone only after the new one builds and runs.
8. Archive `karafriends-fork-archive` on GitHub once you're satisfied.

### Phase 3: build tidy-ups (branch `build-tidy`, one commit each)

- **Drop wdio:**
  - Delete `renderer.wdio.conf.ts`, `remocon.wdio.conf.ts`, `tests/wdio/`, the `test:wdio*` scripts, the broken `ephemeral-port-reserve` script and the wdio dependencies.
  - Remove the self-hosted `build-macos-aarch64` CI job, which only ran wdio on upstream's runner.
- **tslint → oxlint:**
  - Remove `tslint`, `tslint-config-prettier`, `tslint.json` and the `// tslint:disable` comments.
  - Add `oxlint`, a minimal `.oxlintrc.json` and a `lint` script.
  - In lint-staged, run oxlint on `*.{ts,tsx}`.
- **Clippy only on Rust changes:** move `cargo clippy` from `.husky/pre-commit` into lint-staged's `*.rs` entry, in function form so filenames aren't appended.
- **Packaging:**
  - In `packager.js`, switch `electron-packager` to `@electron/packager` 20, which uses a named export.
  - Replace `glob` with `fs.globSync`.
- **Dead dependencies:** remove `@babel/runtime`, then re-check for anything else left unused.
- **Dependabot off:**
  - Delete `.github/dependabot.yml` and `.github/workflows/dependabot-automerge.yml`.
  - **You:** turn off Dependabot updates in repo settings. Security alerts are your call.
- **CI:** in the Linux job, add `prettier --check .`, `yarn lint` and `yarn typecheck`.
- **Verify:**
  - A TS-only commit doesn't run Clippy.
  - `yarn lint` is clean.
  - `yarn build-prod && yarn package-prod` on Windows produces a zip that launches.

### Phase 4: Playwright smoke tests (branch `e2e-smoke`)

- Add `@playwright/test` with tests in `tests/e2e/`.
- Install browsers with `PLAYWRIGHT_BROWSERS_PATH=0`, which puts them inside `node_modules` instead of `%LOCALAPPDATA%`. Set the same variable in the `test:e2e` scripts.
- Run against the **prod build**: `yarn build-prod`, then launch with `ELECTRON_IS_DEV=0`. This makes `electron-is-dev` serve the built renderer and remocon, and the tests then survive the bundler switch.
- Isolation fixture:
  - Pass `--user-data-dir=<tmp>`; `config.yaml` is read from `userData` (`src/common/config.ts`).
  - Set env `TEMP`/`TMP` to `<tmp>`; `queue.json` and downloads live under `app.getPath("temp")/karafriends_tmp` (`videoDownloader.ts:20`, `graphql.ts:314`).
  - Pick a free port via `KARAFRIENDS_REMOCON_PORT` (existing override in `config.ts:62`).
- Tests:
  1. The display window launches and shows the idle screen, with no unexpected console errors.
  2. The phone remote (Chromium, Pixel 7 emulation, nickname preset in `localStorage`) shows the search screen.
  3. History paging: seed `queue.json` with 35 history items, open History, press "More", see all 35. This needs no network.
  4. `@net`: queue a short YouTube video from the remote, see it in the remote and display queues, remove it.
  5. `@net`: playback controls (pause/skip) change the display's state.
  6. `@jp` (opt-in via env, Japan VPN): a DAM and a Joysound search return results.
- Scripts: `test:e2e`, plus a CI variant with `--grep-invert "@net|@jp"`.
- CI: run on `windows-latest`, and on `ubuntu-latest` under `xvfb-run`.
- Later phases add tests for supervised mode (Phase 5b) and IPC (Phase 5f).

### Phase 5: GraphQL/Relay → JSON RPC + SSE (strangler; one PR per sub-step)

Both APIs live side by side until 5e, so the app works after every sub-step. The design is §4 of `stack-review-runtime.md`.

- **5a. Plain HTTP client:**
  - Add `src/main/http.ts` (about 40 lines: timeout, proxy agent, body/response handling, throw on non-2xx).
  - Replace `@apollo/datasource-rest`, `@apollo/utils.*` and `dataloader` in `damApi.ts` and `joysoundApi.ts`.
  - Route both logins through it, which fixes the proxy bypass.
  - Create the clients once, not per request.
  - Keep the manual `k=v&…` body join.
- **5b. Server core:**
  - `src/common/api.ts`: shared types (`Api`, `LiveState`, `LiveEvent`, `QueueItem`, `Page<T>`).
  - `src/main/state.ts`: move the `db` and `queue.json` persistence out of `graphql.ts` (281–373), behind `update(mutator)` that persists and emits a change.
  - `src/main/api.ts`: the handler map; existing resolvers call into it.
  - `src/main/server.ts`:
    - `POST /api/:method` requires `Content-Type: application/json` (CSRF guard) and validates inputs.
    - `GET /api/events` is the SSE stream: a snapshot on connect, a heartbeat every 20 s, and excluded from `compression()`.
  - **Server-side admin checks:**
    - The client sends its device ID and nickname as headers.
    - With supervised mode on, `removeSong` is allowed for the owner or an admin; `setPlaybackState` and `tryHeadOfQueue` are admin-only.
    - A new `whoami` method returns `{ isAdmin }`. `LiveState.config` carries only `supervisedMode`, so the admin list no longer goes to phones.
  - Unit tests for `state.ts`/`api.ts` with `node --test` via `tsx`.
- **5c. Live state on the client:**
  - `src/common/apiClient.ts`: `call()`, `LiveStateProvider`/`useLiveState`/`useLiveEvent`.
  - Replace `useQueue`, `useNowPlaying`, `usePlaybackState`, `usePitchShiftSemis` and `useConfig`, the emote/adhoc-lyrics/queue-added subscriptions, and the three 1 s download-progress polling loops.
- **5d. Lookups and commands on TanStack Query**, one feature per commit:
  - DAM, then Joysound, YouTube/Nico, history, queue buttons (four mutations become one `queueSong`), then remove/playback/pitch/emote/adhoc lyrics, then the display's `popSong`.
- **5e. Delete GraphQL and Relay:**
  - Files: `schema.graphql`, the GraphQL half of `graphql.ts`, `graphqlEnvironment.ts`, `__generated__/`, the `relay` config, `.babelrc`, and the `build-relay-*` scripts.
  - Packages: Apollo, `graphql*`, `ws`/`bufferutil`/`utf-8-validate`/`supports-color`, `react-relay`, `relay-*`, `babel-plugin-relay`, `@babel/core`.
- **5f. Display over IPC:**
  - The preload exposes `api.call` and `onLive`. `ipcMain.handle("api")` dispatches into the same handler map, with the display treated as admin, and live events go out via `webContents.send`.
  - Remove the localhost CORS rewrites in `src/main/index.ts` (keep the ipcasting.jp rule) and the dev CORS middleware.
  - `EADDRINUSE` becomes a warning instead of quitting the app.
- **Verify each sub-step:**
  - Typecheck, unit tests and Playwright (including `@net` locally).
  - A manual pass with the VPN for `@jp` flows (5a, 5d).
  - Check that `/api/*` rejects a form-encoded POST.

### Phase 6: Parcel → electron-vite (branch `electron-vite`)

- Start with a half-day spike: bundle main with Rolldown, including `youtubei.js`, Express and the native `index.node`.
- `electron.vite.config.ts`:
  - Main and preload with `build.externalizeDeps: false`, keeping "bundle everything, ship only `build/`".
  - Output under `build/{dev,prod}` so `packager.js` and the hard-coded paths keep working.
  - Renderer as multi-page `renderer` + `remocon`, with `publicDir: static` (the kuromoji `dict/` is copied once), `@vitejs/plugin-react` and `sass`.
- Import edits:
  - `url:` becomes `?asset`.
  - `worklet:` becomes `?worker&url`.
  - `.glsl` becomes `?raw`.
  - The remote's `icon.png` symlink becomes an import of the real `icon.png`. This also fixes the broken header logo on Windows.
  - The service worker moves to `public/`.
- Dev: `electron-vite dev -w`.
  - Vite binds `host: true` and proxies `/api` (including SSE) to Express. The dev QR code points at Vite's port.
  - `remoconReverseProxy.ts` shrinks to the prod `express.static`.
- Remove `parcel`, `@parcel/*`, `.parcelrc`, `parcel.d.ts`, `disableParcelErrorOverlay.ts`, the `targets`/`alias`/`@parcel` keys, `parcel-reporter-static-files-copy`, `process`, `postcss`, `concurrently`, `wait-on` and `cross-env`.
- Remove the `youtubei.js` patch and confirm YouTube info still works on Windows. If it breaks, keep the patch.
- **Verify:**
  - `yarn dev` works, with hot reload on a phone.
  - Playwright passes against the Vite prod build.
  - The Windows packaged zip launches.
  - CI is green on all four OSes, and a release dry run builds all four zips.

### Phase 7: lighter UI libraries (branch `ui-libs`, one commit each)

- `react-icons` → a small `Icon` component with the 21 inlined SVGs.
- `materialize-css` → about 50 lines of CSS plus a 30-line toast. Its select `AutoInit` calls become native selects.
- `react-fade-in` → CSS `@keyframes`.
- `react-mobile-picker-scroll` → a scroll-snap list.
- `lodash.memoize` in the preload → a local 5-line memo.
- **Verify:** before/after screenshots of the remote and display, and Playwright.

## Order and parallelism

- Phases 1 and 2 run alone and in order, because Phase 2 rewrites every hash.
- After Phase 2:
  - Phases 3 and 4 can run in parallel sessions; only `package.json` and CI overlap.
  - Phase 5 goes in sub-step order. Phase 6 comes after 5e, so Vite never needs the Relay/Babel plugin.
  - Phase 7 can run alongside Phase 6, or any time after 5d.

## Expected result

- Roughly 1,000 fewer lockfile packages (of 1,835).
- No committed cache, and a repo of tens of MB.
- A single `yarn dev`, and no hand-written proxy.
- Main bundle down about 75%, remote bundle down about 70%.
- Three fewer CORS hacks.
- A Playwright safety net running on Windows and Linux CI.

## Risks and notes

- **New repo:** loses the old repo's stars, issues, PR history and settings. Secrets must be re-added (Phase 2, step 4).
- **YouTube in CI:** downloads are flaky on CI runners, so `@net` tests are local-only. `@jp` tests always need your VPN.
- **Playwright's Electron API** is labeled experimental but is widely used. If it breaks, fall back to testing the remote in Chromium only.
- **Main-process bundling with Rolldown** is the riskiest part of Phase 6, hence the spike.
- **MSIX app:** any global tool install (gh, git-filter-repo) is yours to run in your own terminal.
