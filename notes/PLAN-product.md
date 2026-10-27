# Plan: product round one (after the hard fork)

The stack work in [`PLAN-hard-fork.md`](PLAN-hard-fork.md) is done. This plan is about what guests and the host see: the phone remote, the display, first-time setup, and the failures that happen at a party. Scoring is out of scope for this round.

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                             | State       | Branch / commit                                         | Notes                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1: download failures reach the phone            | done        | `claude/download-failures-457181`, merged 2026-10-27    | Also unified every yt-dlp/ffmpeg run behind one promise-based runner with a 15 min timeout, so A6 shrinks (see its section). Verified with real Joysound and YouTube downloads on a JP IP.                                                                                   |
| A2: admin password instead of device IDs         | done        | `claude/recursing-ramanujan-c5f879`, merged 2026-10-27  | Handover for A3 and C: `notes/A2-admin-password-handover.md`. `setAdminPassword` in `src/main/services.ts` has no caller until A3.                                                                                                                                           |
| A3: settings API, config export/import           | done        | `claude/priceless-lichterman-8878cb`, merged 2026-10-27 | Handover for D: `notes/A3-settings-handover.md`. Placeholders (`YOUR_USERNAME_HERE`) are masked like real values; D shows them as empty fields and relies on `isFirstRun`. Real DAM/Joysound test logins checked on a JP IP; the file dialogs are only checked by hand in D. |
| A4: admin queue reorder                          | done        | `claude/queue-reorder-9c9b3f`, merged 2026-10-27        | One method, `moveSong`; C builds Move to top / Up / Down on it.                                                                                                                                                                                                              |
| A5: tool status and update, event-driven popSong | done        | `worktree-agent-adcb09a825b4c209e`, merged 2026-10-27   | Handover for D: `notes/A5-tools-handover.md`. `LiveState.toolsProblem` carries the notice text; `getToolsStatus`/`updateTools` are display-only. A real `updateTools` took about 5 min (the ffmpeg archive); D shows progress or at least a busy state.                      |
| B: design tokens, primitives, i18n scaffold      | done        | `claude/design-system-5275d5`, merged 2026-10-27        | Usage guide for C and D: `notes/B-design-system-handover.md`. Screenshots in `notes/ui-refresh-screenshots/b-*.png`; `/dev/ui` is the review page (`VITE_KARAFRIENDS_DEV_UI=1 yarn build-prod`, then `KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots`).                 |
| E: cleanup and build hygiene                     | done        | `claude/cleanup-82f423`, merged 2026-10-27              | The macOS/Linux CI jobs are only verified by the CI run on master. **You:** run `git gc --prune=now` in your main checkout (or re-clone): the local `.git` still holds 478 MB of pre-purge packs in 226 pack files.                                                          |
| C: phone remote refresh                          | not started |                                                         |                                                                                                                                                                                                                                                                              |
| D: display refresh and settings screen           | not started |                                                         |                                                                                                                                                                                                                                                                              |
| A6: downloader move and tests                    | not started |                                                         | Reduced: A1 did the runner and promise rewrite.                                                                                                                                                                                                                              |
| F: tests for the new flows                       | not started |                                                         |                                                                                                                                                                                                                                                                              |
| Final: orchestrated code review                  | not started |                                                         |                                                                                                                                                                                                                                                                              |
| Final: party checklist                           | not started |                                                         |                                                                                                                                                                                                                                                                              |

## Decisions (from Q&A on 2026-10-27)

- **Admin access:** one shared admin password, set on the display's settings screen. A phone enters it once and gets a session token. `adminDeviceIds` and `adminNicks` go away. The display is always an admin.
- **Look:** dark karaoke box on both the display and the phone: dark, high contrast, one accent, big type readable from across a room. No gradients, no cards-in-a-grid. The design brief below is binding.
- **Search:** one search box for DAM and Joysound together, with a title/artist toggle and a source filter. A pasted YouTube or Niconico link or ID opens that page.
- **Queue order:** first come. Admins can move a song to the top, or up and down.
- **Config export/import:** one file with everything in `config.yaml`, DAM and Joysound logins included, from the display's settings screen. Queue and history stay on the machine.
- **Language:** the phone remote in English and Japanese, with a toggle. The display stays English.
- **Settings:** a settings screen inside the display window, with a Test login button. First launch opens it when no logins are set.
- **Autonomy:** the coordinator merges and pushes after checks, as in the hard-fork plan.
- **Out of scope this round:** scoring at the end of a song, round-robin queueing, a Japanese display.

## How this plan is run

- **Roles.** A Fable session coordinates (this file is its state). Each phase runs on Opus in its own worktree, branched from the latest `master`, with a brief that points at this file and names the phase. A1, B, E, A2, A3 and A4 ran as separate sessions; from A5 on, phases run as background subagents of the coordinator (`Agent` with `isolation: worktree`, `model: opus`), because the app only starts a session from a message typed in the desktop app and the user asked (2026-10-27) for the rest to run without their input. A subagent's worktree branch stays until merged; its report comes back to the coordinator, which reviews and merges as before. Phases in different lanes run at the same time; phases in one lane run one after another.
- **Each phase session:**
  - Implements its section, one commit per change, with the commit hook passing.
  - Runs `yarn typecheck`, `yarn lint`, `yarn test:unit`, `yarn build-prod`, `yarn test:e2e:ci`, and a real app launch with `KARAFRIENDS_LOCAL_ONLY=1 KARAFRIENDS_HIDE_WINDOW=1`.
  - A UI phase also takes screenshots through the Playwright fixture (display at 1920×1080, remote as Pixel 7) into `notes/ui-refresh-screenshots/<phase>-<screen>.png`, and checks its own work against the design brief before reporting.
  - Reports what changed, what it verified, what it couldn't, and any question for the user. Doesn't push or merge.
- **The coordinator** reviews the diff and the screenshots against the brief, re-runs the checks on the merged result, merges into `master` with `--no-ff`, pushes, updates the Status table, and starts the next phase. The user approved merge-and-push after checks on 2026-10-27, and later that day asked for the remaining phases to run each in their own session, the next one started as soon as the previous one merges (A4, A5, then C, D and A6 in parallel, then F, then the final review), with no further confirmation.
- **Lanes and order:**
  - Lane 1 (server, sequential since all touch `src/main/api.ts` and `src/common/api.ts`): A1 → A2 → A3 → A4 → A5.
  - Lane 2, at the same time as lane 1: B.
  - Lane 3, at the same time: E.
  - After lanes 1 and 2: C and D at the same time (C is `src/remocon`, D is `src/renderer`; neither changes `src/main`). A6 at the same time (only `src/common/videoDownloader.ts` and its callers' dependency shape).
  - After C, D and A6: F, then the final review, then the party checklist with the user.
- **Keep it simple (the user asked for this on 2026-10-27; it binds every phase and the coordinator's review):**
  - Build what the phase section names and nothing more. No abstraction, helper, registry, option or type for a single caller or a hypothetical future one. A pure function split out so a test can reach it is fine; a layer is not.
  - No new dependencies unless the section names one, and no new config settings nobody asked for.
  - Prefer deleting over adding: if a change makes an old path dead, remove it in the same phase.
  - If the diff grows past about twice what the section implies, stop and say why in the report.
  - The report lists everything added beyond the section, so the coordinator can cut it. The coordinator names, for each merge, anything that could go without losing a behavior the plan asks for, and has the session remove it before merging.
- **Windows/MSIX notes for every session** (unchanged from the hard-fork plan):
  - The Claude app here is the Microsoft Store build: writes under `%APPDATA%`/`%LOCALAPPDATA%` from Claude's shells land in a private copy. Keep tool caches inside the repo; leave global installs to the user.
  - A fresh worktree needs `yarn install` before anything builds.
  - DAM/Joysound need a Japanese IP (`curl -s https://ipinfo.io/country`). If it isn't `JP`, skip those checks and say so.
  - Don't stop processes you didn't start; another app instance may hold ports 5173/8080.
  - Set `KARAFRIENDS_LOCAL_ONLY=1` and `KARAFRIENDS_HIDE_WINDOW=1` for every app launch in checks. `yarn dev -- --mute-audio --user-data-dir=<tmp>` (with `TEMP`/`TMP` set to `<tmp>`) keeps a check off the real config and queue.
  - electron-vite empties `build/<mode>/{main,preload,web}` on every build.

## Design brief (binding for B, C and D; the coordinator reviews against it)

The app is used in a dim room, on phones held at arm's length and on a TV across the room. It should feel like the remote in a Japanese karaoke box: dense, dark, obvious, fast.

**Do**

- Dark surfaces: the phone on a near-black (not pure black) background with one lighter surface for lists and sheets; the display pure black behind video. One accent, taken from the app icon, used for the primary action and the current song only. Text at high contrast (white and one muted grey).
- Big, plain type. Phone body 16px minimum, list titles 18px, controls 20px or icons at 28px. Display: queue and up-next readable from 3 m (nothing under 32px on a 1080p screen).
- Real `<button>` and `<a>` elements with visible pressed and focus states, 44px minimum tap targets. No `<div role="button">`.
- Lists for lists. Search results, queue, history are rows with a one-line title, a one-line artist, and the source as a small label. One row style across DAM, Joysound, YouTube and Niconico.
- Short, specific copy in the imperative: "Search", "Queue", "Up next", "Your songs", "Move to top". Error text says what happened and what to do: "Couldn't download. Try another video."
- Empty states are one line of text. Loading states are a thin bar or a spinner in place, never a skeleton grid.
- Motion only where it carries information: the marquee for long titles, the newest lyric fading in, a song sliding into the queue. Nothing bounces, nothing slides in on page load.
- The phone's header is one bar: back, title, and the profile or language control. The footer is the now-playing sheet, as today, restyled.
- Fonts: the system stack on the phone (it already covers Japanese on iOS and Android). The display keeps its bundled Noto fonts for lyrics and uses the system stack for UI.

**Don't (these are the AI tells; a screenshot showing any of them fails review)**

- Purple, indigo or blue-to-pink gradients; glassmorphism; glows; blurred blobs.
- Emoji or sparkle icons in headings, buttons or empty states.
- Hero copy: "Welcome to…", "Discover…", "Get started", "Your ultimate…", "Elevate…".
- Card grids of features; three-column icon-title-blurb sections; tiles with a big rotated icon (the current search grid).
- Large radius and drop shadow on everything. Use a 4px radius and borders or spacing instead of shadows.
- A different color per source or per button. Color means one thing: the accent is the action or the current item.
- Page transitions, staggered fade-ins, confetti.
- Placeholder names or content in screenshots: use real songs from the Japan tests or fixed fixtures.

## Phases

### A1: download failures reach the phone (branch `download-failures`)

Today a failed Joysound, YouTube or Niconico download is only logged. The phone's button goes from "Downloading" to "Finished Downloading" (`src/remocon/hooks/useDownloadButtonText.ts`, "it was downloading and now it's gone: done") and the song never appears.

- `src/main/state.ts`: `DownloadQueueItem` gets `status: "downloading" | "failed"` and `reason: string | null`. Replace `downloadType: number` with `kind: "joysound" | "youtube" | "nico" | "dam"`.
- `src/common/videoDownloader.ts`: on any failure (spawn error, non-zero exit, timeout, missing file), mark the item failed with a short reason and remove it after 30 s. Reasons are for guests: "Video unavailable", "Download timed out", "Couldn't get the song from Joysound". The yt-dlp and ffmpeg logs stay in the log file.
- `src/common/api.ts`: `DownloadProgress` carries `status` and `reason`. A new live event `queueFailed: { item, reason }`, sent only to the phone that queued it (`src/main/live.ts` already knows each stream's device ID).
- Remote: `useDownloadButtonText` shows "Couldn't download: <reason>" for `RESULT_MS`, then the default text. `useQueueNotifications` shows a notification for `queueFailed`.
- Unit tests for the state transitions and for `nextDownloadText` with a failed item. An e2e test that points `KARAFRIENDS_YTDLP_PATH` (new override, see A5) at a script that exits 1 and checks the button text.

### A2: admin password instead of device IDs (branch `admin-password`)

- `config.yaml`: `adminPasswordHash` (scrypt, `crypto.scryptSync` with a per-install salt) replaces `adminDeviceIds` and `adminNicks`. An empty hash means no phone can be an admin; the display still is.
- `src/common/api.ts`: `adminLogin { password } → { token }` and `adminLogout`. `whoami` stays. The token goes in a new header `X-Karafriends-Admin-Token` (and the `/api/events` query, for `isMine`-style per-phone events later).
- `src/main/api.ts`: `isAdmin(caller)` is `caller.isDisplay || sessions.has(caller.adminToken)`. Sessions are random 32-byte tokens kept in `userData/adminSessions.json` so a restart mid-party doesn't log admins out; changing the password clears them. `adminLogin` is rate-limited to 5 tries a minute per IP (`src/main/server.ts`).
- Device IDs stay for `isMine` (whose song it is); they just no longer grant anything.
- Remote: `src/remocon/hooks/useUserIdentity.ts` stores the token; `apiClient` sends it. A profile screen (built properly in C; for now a minimal page at `/profile`) with nickname, "Admin password" and "Sign out".
- Remove the `adminNicks` warnings in `api.ts`. `parseState`/config loading tolerate the old keys and log once that they're ignored.
- Tests: unit for login, logout, rate limit, password change clearing sessions; e2e `api.spec.ts` updates for the new admin path (today's tests set `adminDeviceIds`).

### A3: settings API, config export/import (branch `settings-api`)

Settings are changed from the display only, over IPC (`src/main/ipc.ts`); phones never get these methods (`src/main/server.ts` refuses them with 403).

- `src/common/config.ts`: `getConfig()` becomes a small store: `get()`, `update(partial)` that validates, writes `config.yaml` atomically and emits a change. The DAM and Joysound credential providers in `src/main/services.ts` forget their memoized login when their credentials change. `remoconPort` and proxy changes take effect on restart; the API says so.
- Display-only methods in `src/common/api.ts`: `getSettings` (passwords masked), `setSettings`, `setAdminPassword`, `testLogin { service: "dam" | "joysound" } → { ok, reason }` (does a real login with the saved or the given credentials; from a non-JP IP it reports that), `exportConfig → { yaml }`, `importConfig { yaml } → { ok, problems[] }` (validates every field, applies, then re-tests logins), `restartApp`.
- Export is the full `config.yaml` (logins included, as decided) plus a `karafriendsConfigVersion: 1` line. Import accepts any older `config.yaml` too, drops unknown keys and says which.
- `isFirstRun` in `getSettings`: true when neither DAM nor Joysound credentials are set.
- Unit tests for validation, masking, import of old files; e2e for export/import round-trip over IPC (the fixture already drives the display).

### A4: admin queue reorder (branch `queue-reorder`)

- `moveSong { songId, timestamp, toIndex }` (admin only, in supervised mode and out of it) in `src/common/api.ts` and `src/main/api.ts`. `toIndex: 0` is "move to top". The ETAs in `useQueue` follow.
- Unit tests, and the live state check in `api.test.ts`.

### A5: tool status and update, event-driven popSong (branch `tools-status`)

- `src/common/externalResources.ts`: expose `toolsStatus → { ffmpeg: { version, updatedAt }, ytdlp: {...}, lastCheck, problem }` and `updateTools` (force the refresh). Record the version strings by running each binary with `--version` once after download.
- `KARAFRIENDS_YTDLP_PATH` and `KARAFRIENDS_FFMPEG_PATH` env overrides, for tests and for a host who wants their own build.
- Display: after a YouTube or Niconico download fails with a yt-dlp error, the live state's `problem` says "YouTube downloads are failing; update tools in Settings", which D shows.
- `src/renderer/Player.tsx`: when the player is waiting and the live state's queue becomes non-empty, call `popSong` at once instead of waiting for the 5 s poll. Keep the poll as a fallback.

### B: design tokens, primitives, i18n scaffold (branch `design-system`)

No screens change yet; this is what C and D build with.

- `src/remocon/tokens.scss` and `src/renderer/tokens.css`: colors (background, surface, text, muted, accent, danger), spacing scale, radius 4px, type scale, one shadow for sheets only. The accent comes from `icon.png`; write the chosen hex in the file's comment.
- Remote primitives in `src/remocon/components/ui/`: `Button` (primary, secondary, danger, icon; disabled and pressed states), `ListRow` (title, subtitle, source label, trailing slot, press), `TextField`, `Sheet` (the bottom now-playing panel), `TopBar`, `Tabs`, `EmptyState`, `InlineError`. Each is a real element with aria attributes; the existing e2e aria-labels must keep working.
- i18n: `src/remocon/i18n/index.ts` with a typed `t(key, vars?)`, `useLanguage()` and a `LanguageProvider`; `src/remocon/i18n/en.ts` and `ja.ts` with the same key set (a type error if one is missing). Language from `localStorage`, default from `navigator.language`. No library.
- Before/after screenshots aren't needed here; a Storybook isn't either. A single `/dev/ui` route in the remote (dev builds only) that renders every primitive is enough for review.

### E: cleanup and build hygiene (branch `cleanup`)

Each item one commit.

- Delete `tunnel.yaml`, `decryptor/`, and the `offkai.karafriends.party` entry in `src/renderer/HostnameSetting.tsx`.
- `tsconfig.json`: `target` and `lib` to `ES2022` (plus `DOM`); drop `ignoreDeprecations` if TypeScript 6 then compiles without it. Replace `Object.prototype.hasOwnProperty.call` with `Object.hasOwn`.
- `.github/workflows/release.yaml`: `actions-rust-lang/setup-rust-toolchain` like `build.yaml`.
- `build.yaml`: `Swatinem/rust-cache`; run `cargo install cargo-careful` and `test:native` on Linux only.
- `package.json` version `0.2.0`; add `CHANGELOG.md` with the hard-fork round summarized and this round's entries added by each phase.
- `README.md`: a "Running a party" section (install, first launch, settings, phones, admin password) written for the host, not the developer.
- Tell the user (not the session) to run `git gc --prune=now` or re-clone: the local `.git` still holds 478 MB of pre-purge packs.

### C: phone remote refresh (branch `remote-refresh`)

Depends on A1–A5 and B. Rebuild each screen with the primitives, translate every string, and keep every aria-label the e2e tests use.

- **Shell:** `TopBar` with back, title, profile. The now-playing `Sheet` at the bottom: collapsed shows the current song and the singer; expanded shows the queue, playback controls (or emotes), pitch.
- **Profile (`/profile`):** nickname (editable), language toggle, admin password field with signed-in state and sign-out, notifications toggle (moves `EnableNotificationsButton` here).
- **Search (`/`):** one `TextField` with a title/artist toggle and a source filter (All, DAM, Joysound). Results from DAM and Joysound interleave by relevance order as returned, each row labeled with its source. A pasted YouTube or Niconico URL or ID switches to that video's page. Delete the six search pages, `SearchMethodGrid`, and merge the DAM and Joysound result, artist and queue-button component pairs into one set keyed by `kind`.
- **Song pages:** one `SongPage` for DAM and Joysound (vocal type, key, Joysound-with-YouTube option), the YouTube page with captions and adhoc lyrics, the Niconico page. Queue button states: ready, waiting, downloading with percent, failed with reason (A1).
- **Queue (in the sheet):** rows with singer initial, title, artist, ETA; expanded row shows Remove (owner or admin) and, for admins, Move to top, Up, Down (A4). The current song row is accented.
- **History:** rows with when and who, re-queue by tapping.
- **Adhoc lyrics:** keep the scroll-snap picker, restyle.
- Screenshots: search with results, a song page, the sheet expanded with a queue of four, profile, history, in both languages.

### D: display refresh and settings screen (branch `display-refresh`)

Depends on A3, A5 and B.

- **Idle screen:** full-screen, black. A large QR code (at least a quarter of the screen height) with the address under it in large type, "Scan to join", and the up-next list when the queue isn't empty. No sidebar.
- **Playing:** the video full-screen as today. An overlay in one corner for 4 s when a song starts (title, artist, singer) and when one is queued (replaces the Materialize toast). Up-next as a thin strip at the bottom, toggled with `Q` like the sidebar today.
- **Settings (`S` key, or the gear on the idle screen):** a dark full-screen panel: DAM login, Joysound login, Test login for each with the result inline, admin password (set/change), supervised mode, per-person cap, low-bitrate, remote port and proxy (with the restart note and a Restart button), hostname for the QR code, microphones (the current pickers, restyled), tools status with Update now (A5), Export config (save dialog) and Import config (open dialog, then the problems list). First launch opens Settings with a one-line banner: "Add your DAM or Joysound login to search their catalogs. YouTube works without one."
- **Notices:** the remote-port banner and the tools problem (A5) as one notice bar at the top.
- **Player:** split `src/renderer/Player.tsx` into a `useSongPlayer` hook with one loader per kind, remove the stale-closure effect and the `let hls`, and de-duplicate the two DAM branches. Behavior unchanged; the e2e tests cover pause, skip and the YouTube path.
- Screenshots: idle with an empty queue, idle with four queued, playing with the start overlay, settings, settings after a failed test login.

### A6: downloader move and tests (branch `downloader`)

Can run beside C and D. A1 already replaced the callback pipelines in `src/common/videoDownloader.ts` with one promise-based `runTool` (timeout, log file, failure reasons in `src/common/downloadFailure.ts`) and `runDownload`, and typed the download kinds. What's left:

- Move the file to `src/main/downloads/` split as `run.ts` (`runTool`), `jobs.ts` (one async job per kind) and `queue.ts` (the two-at-once yt-dlp limit, de-duplication, the A1 failure bookkeeping), with `src/common/videoDownloader.ts` gone and its callers (`src/main/services.ts`, `src/main/index.ts` for `TEMP_FOLDER`) updated. Same output file names, so `Player.tsx` and `karafriends://local/` don't change.
- When one Joysound step fails, stop the other (the yt-dlp background download or the ffmpeg fetch), which A1 left running.
- Tests with fake `ffmpeg` and `yt-dlp` scripts under `tests/fixtures/bin/` (the `yt-dlp-fails` pair from A1 is the pattern) that print the real tools' progress lines and exit 0 or 1 as asked, driven through `KARAFRIENDS_YTDLP_PATH`/`KARAFRIENDS_FFMPEG_PATH`: a YouTube success with progress, a Joysound success without a background, a timeout (with the timeout made configurable for tests), and a failure mid-pipeline that cleans up.

### F: tests for the new flows (branch `tests-round-one`)

- e2e: admin login and sign-out from the profile screen; a non-admin can't move a song, an admin can; settings export then import on a fresh profile; first-launch banner; unified search (`@jp`); language toggle changes the search screen's title; download failure text (fake yt-dlp).
- Unit: anything A1–A6 left uncovered, found with `node --test --experimental-test-coverage`.
- CI unchanged: `test:e2e:ci` still skips `@net` and `@jp`.

### Final: orchestrated code review

As after the hard fork: Opus reviewers over `git diff <start of this round>..HEAD` in five areas (server and admin, settings and config handling, downloads, remote UI and i18n, display and Player), a Fable verifier that tries to disprove each finding, the report in `notes/code-review-<date>.md`, and one fix session per group of findings.

### Final: party checklist (with the user)

Run a real session before calling the round done: three phones (one admin, one in Japanese), DAM and Joysound on the VPN, a YouTube song with captions, one with adhoc lyrics, a Niconico song, a failing download (a private YouTube video), reorder, pause and skip from a phone, two mics, pitch shift, export the config and import it on a second profile. Note every snag in the Status table's Notes column for the next round.
