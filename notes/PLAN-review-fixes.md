# Plan: fixes from the 2026-10-28 code review

The whole-repo review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)) found 164 distinct problems (10 high, 41 medium, 113 low) and 49 over-engineering items worth acting on, 45 after merging overlaps. This round fixes all of them. Every finding id has a phase, and the round ends when each id is fixed, or marked "won't fix" or "needs hardware" with a reason. The detail each fix needs (the failure scenario, the suggested fix, the verifier's corrections) is in [`review-fixes/`](review-fixes/), one file per phase.

Same way of working as earlier rounds, with the coordinator's job split in two. A Fable orchestrator plans, dispatches and reviews. An Opus integrator merges and runs the checks. Opus workers each take one phase in their own worktree, branched from the current master. Nothing is pushed.

## Roles

- **Orchestrator: Fable.** This session, switched with `/model` before the round starts. It owns this file and keeps the status table current. It writes each worker's brief: the phase's entry below, its file in `review-fixes/`, and the rules. It launches the workers (Agent tool, `model: opus`, `isolation: worktree`), up to 6 at once. It reviews each report and diff against the phase's finding ids, and hands accepted branches to the integrator. It runs the completeness audit at the end.
- **Integrator: Opus.** One long-lived agent, kept across the round with SendMessage so it remembers earlier merges. It merges accepted branches, resolves conflicts and runs the checks (see Merge). When a conflict needs a behaviour choice, it asks the orchestrator.
- **Workers: Opus.** One per phase, in a fresh worktree from the current master. Each follows the rules below and reports back.

## Decisions (Q&A, 2026-10-28)

1. **Scope: everything.** That means the review's Fix now and Fix soon lists, the 13 over-engineering simplifications, and the low findings. Each low or WEAK item goes to the phase that already owns its file.
2. **Phone notifications are removed.** The remote is plain HTTP on the LAN, and browsers allow notifications and service workers only on HTTPS or localhost. The removal covers the hook, the service worker, the middleware, the Settings row, the i18n keys and the e2e test. The phone's queue already shows when a song is up.
3. **Key change: an in-house rewrite.** The pitch shift is rebuilt on each bin's true frequency (phase-vocoder style), with sine-in/measure-out tests at ±1, ±2 and ±5 semitones and a CPU budget check on the audio thread. No new dependency.
4. **Branches are merged locally into master.** Nothing is pushed.
5. **Hardware-only fixes are built anyway.** Each is checked as far as this laptop allows: cross-target `cargo check`/`clippy`, a container, unit tests with fakes. Then it goes on the "Checks for you" list below.
6. **The round runs straight through.** The orchestrator stops only for a failure it can't resolve or a decision this plan doesn't cover.

Choices this plan makes, which the orchestrator may revisit with a reason in the Notes column:

- The wake lock is `prevent-display-sleep` for as long as the app runs, not a setting. A second launch focuses the running window.
- Downloads and `queue.json` move from the temp folder to the user data folder. An existing `queue.json` is moved over once.
- The Linux load fix is `-C relro-level=partial` for every crate, guarded by a `readelf` check that the `pw_*` imports are JUMP_SLOT. The `--wrap` shim from build-ci-1 is the fallback if partial RELRO doesn't do it.
- The guide melody stays in the display this round. It is fetched once, decoded only as far as needed, and cancelled on skip. Reading it at download time is a follow-up if memory is still high.
- WEAK over-engineering items are done only while a phase is in that file anyway; a worker may skip one with a one-line reason. Three are "leave it" per their verifier: oe-main-4, oe-architecture-6 and oe-architecture-7 keep their code, and at most a comment is reworded.
- The display-only check (oe-main-2, oe-architecture-3) is optional and the weakest of the 13: `popSong` is left out of the set on purpose, and the main review called the double check deliberate.

## Status (keep this table current)

| Phase                                         | Wave | Starts after  | High / Med / Low / OE | State       | Branch / commit | Notes |
| --------------------------------------------- | ---- | ------------- | --------------------- | ----------- | --------------- | ----- |
| A: party basics (wake, one instance, mDNS)    | 1    | none          | 2 / 3 / 3 / 2         | not started |                 |       |
| B: tools and config                           | 1    | none          | 2 / 4 / 4 / 2         | not started |                 |       |
| C: downloads                                  | 1    | none          | 1 / 2 / 8 / 2         | not started |                 |       |
| D: upstream services                          | 1    | none          | 0 / 3 / 0 / 0         | not started |                 |       |
| E: native Linux loading and sound systems     | 1    | none          | 1 / 1 / 3 / 0         | not started |                 |       |
| F: native device recovery, exclusive, ASIO    | 1    | none          | 1 / 7 / 4 / 0         | not started |                 |       |
| G: key change rewrite                         | 1    | none          | 1 / 2 / 2 / 2         | not started |                 |       |
| H: display song output and mics               | 1    | none          | 1 / 3 / 1 / 0         | not started |                 |       |
| I: display pitch bars and guide melody        | 1    | none          | 0 / 3 / 6 / 2         | not started |                 |       |
| J: display Joysound lyrics and parser         | 1    | none          | 1 / 0 / 8 / 2         | not started |                 |       |
| K: display playback flow                      | 1    | none          | 0 / 4 / 1 / 0         | not started |                 |       |
| L: commands, playback state, clock            | 2    | A, C, H, K    | 0 / 3 / 9 / 4         | not started |                 |       |
| M: phone navigation and pages                 | 2    | A             | 0 / 2 / 7 / 0         | not started |                 |       |
| N: phone components, UI kit, i18n             | 2    | A             | 0 / 0 / 15 / 7        | not started |                 |       |
| O: native real time, pitch window, bindings   | 2    | E, F          | 0 / 1 / 5 / 8         | not started |                 |       |
| P: server live stream, admin, API cleanup     | 3    | L             | 0 / 1 / 13 / 11       | not started |                 |       |
| Q: TV Settings                                | 3    | H, O, P       | 0 / 1 / 9 / 0         | not started |                 |       |
| R: CI, build and tests                        | 3    | all of A to Q | 0 / 1 / 15 / 7        | not started |                 |       |
| Close-out: screenshots, docs, audit, full run |      | R             |                       | not started |                 |       |

A phase starts as soon as the phases in "Starts after" are merged, not when its whole wave is. The waves only show the rough order. The critical path is A, C, H and K, then L, P, Q and R.

## Phases

Each phase's file in `review-fixes/` lists its findings, most severe first. The notes here are what the orchestrator should check in the review.

- **A: party basics** ([file](review-fixes/A-party-basics.md)). Start `powerSaveBlocker("prevent-display-sleep")` at launch, and add a single-instance lock. Rewrite the mDNS handler: check every question, compare names case-insensitively, reply unicast to one-shot queriers (source port not 5353, or the QU bit), and answer with the IPv4 address on the querier's subnet. `ipAddresses()` returns only LAN IPv4, which also fixes the Address picker. Renderer crash reloads get a cap and backoff, F5 gets a non-blocking dialog, and dead boot code goes. Phone notifications are removed (decision 2). The mDNS logic becomes a pure function with unit tests over real packets.
- **B: tools and config** ([file](review-fixes/B-tools-and-config.md)). Linux downloads `yt-dlp_linux` (`_linux_aarch64` on arm64). Apple Silicon gets an arm64 ffmpeg, and darwin is no longer pinned to 6.1.1. A downloaded tool is run with `-version` before it replaces the old one. Linux ffmpeg isn't re-downloaded every launch. Update tools waits for running tools on Windows. "Requested format is not available" counts as a tools problem. A config.yaml that won't parse is reported to the host, and its values are checked against `CONFIG_RULES` at launch. Writes are fsynced before rename. Make `externalResources.ts` testable, with no Electron or I/O at module load.
- **C: downloads** ([file](review-fixes/C-downloads.md)). Merge `nicoJob` and `youtubeJob` into one yt-dlp job that always passes `--ffmpeg-location`. A Joysound job holds a yt-dlp slot only while yt-dlp runs. Downloads and `queue.json` leave `/tmp`. DAM downloads get a limit, partial files are swept, and the Joysound marker is kept until padding is done. ffmpeg's Duration is parsed across chunks, logs don't collide, and quitting kills running tools. Remove the download adapter layer and the dead `alreadyDownloading` guard, keeping one guard that reports through `onFailed` (see the verifier's note).
- **D: upstream services** ([file](review-fixes/D-upstream-services.md)). Cap promise-retry and stop retrying permanent errors (a refused login, a 403 from outside Japan, no scoring data). Drop a DAM or Joysound session on an auth-shaped failure and log in once more. Joysound lookups reject instead of returning `[]` or "Error" songs. Unit tests with faked HTTP. Real-service checks need the Japan VPN: see Checks for you.
- **E: native Linux** ([file](review-fixes/E-native-linux.md)). Partial RELRO through `.cargo/config.toml` (decision above). A `scripts/` check that fails when any `pw_*` import is GLOB_DAT. A stub-library load test as in the verifier's repro. PulseAudio gets a larger default buffer than PipeWire's 128. A registry that doesn't answer lists no outputs as mics. The PipeWire host is reused across calls. Linux's mic filters become pure functions with table tests.
- **F: native devices** ([file](review-fixes/F-native-devices.md)). Share one exclusive stream per endpoint across channels. Look up the input before opening the mic output, so a down mic doesn't reopen it every 2 s. Retry the chosen mic output when it's listed again. A stall check covers every host, not only exclusive. Evict cached input devices on failure. Handle the ASIO buffer size and the buzz on close. Add I24/U24 support. `setOutputDevice` changes nothing when it throws. Windows and macOS are checked by cross-target clippy only: see Checks for you.
- **G: key change** ([file](review-fixes/G-key-change.md)). The rewrite in decision 3, plus: no read above Nyquist, `timeCursor` wrapped, and no 37 ms drop when the key leaves 0. The tests run the real worklet with a fake `AudioWorkletProcessor` global, as the verifier's harness did. Report the measured semitones at ±1, ±2 and ±5 and the CPU per quantum, and give the user a by-ear check.
- **H: song output and mics** ([file](review-fixes/H-song-output-and-mics.md)). When the AudioContext suspends or errors, move to a silent sink and `resume()`. Re-apply the saved song output when it is listed again (`devicechange`). A mic that fails its first open starts "down", so the watchdog retries it, and it stays in the saved list. Settings shows why a device didn't open. The latency hint follows the output.
- **I: pitch bars** ([file](review-fixes/I-pitch-bars.md)). PianoRoll handles a missing context and context loss and restore. Replace the generic `ShaderProgram` class with a small helper, and rebuild GL only when it must. The mic trace becomes a ring buffer. A DAM song without scoring data shows no band. The guide melody is cancellable (decision above). Remove `color-convert` and `gl-vec2`. Add unit tests for PianoRoll's pure logic.
- **J: Joysound lyrics** ([file](review-fixes/J-joysound-lyrics.md)). Lyric textures are created shortly before their fade-in and deleted after fade-out. GL objects are freed on unmount. A whitespace-only block doesn't kill the song's lyrics, and a throw in `draw()` doesn't stop the loop. Kuromoji loads on the first Joysound song. AdhocLyrics renders from live state without the hidden canvas. Add JOY-02 parser tests from a fixture.
- **K: playback flow** ([file](review-fixes/K-playback-flow.md)). `loadJoysound` sets its gain. The overlay, hls.js and video are torn down when the queue runs dry. One failed DAM fragment doesn't end the song. A DAM stream that ends without `ended` still advances. A display reload replays the current song once per song id and start time. The e2e reload test must check the current song, not just the queue.
- **L: commands and clock** ([file](review-fixes/L-commands-and-clock.md)). Phone and display commands (playback, key, adhoc lyrics) carry the song they target, and the server drops stale ones. `popSong` shows a waiting state during the DAM wait. No commands are accepted while nothing is current. A restart doesn't restore a stale PLAYING. One `useLiveSetter` hook replaces the five hand-wired optimistic values, keeping quick taps. The current song's clock gets one writer. The display drops its QueryClient. One shared `secondsLeft()` lives in `src/common`. Touches the API contract, so the integrator merges L alone and runs the full e2e after it.
- **M: phone pages** ([file](review-fixes/M-phone-pages.md)). Same-route pages remount, each screen keeps its own scroll position, and the page-level lows are fixed (search IDs, songLink background, History times, ranking, readings).
- **N: phone components** ([file](review-fixes/N-phone-components.md)). Typed queue-button state, a native `<select>` for SourceMenu, UI-kit trims, tokens and barrels, and the component lows (VideoMetadata crash, plurals, emoji graphemes, unused fonts, `aria-disabled`).
- **O: native real time and bindings** ([file](review-fixes/O-native-realtime-bindings.md)). A sliding pitch window with a `get_pitch` test. Reverb processed in place, with no allocation per callback. Fix macOS's minimum-buffer pick. Simplify the config comparator. Remove Results that can't fail. `#[neon::export]` for the scalar functions, `windows` in place of `win32console`, and typed native exports shared by the preload, `global.ts` and the fakes. The fakes learn to fail, so tests can reach the mic error paths.
- **P: server cleanup** ([file](review-fixes/P-server-cleanup.md)). Mic levels get one owner: `setMicLevels` sends the display a message, and App.tsx's echo guard goes. "Phones can't connect" rides the live state. Download progress sends a small event, not the whole state. Phones stop getting events they don't use, and the stream has a keepalive. History is capped. nicoInfo errors keep their cause. Moves are made by song id. Admin sign-in races are fixed. The API cleanups (paging `limit`, `withTimeout`, the `setAdminPassword` factory, the optional display-only check). Touches the API contract: merged alone, then full e2e.
- **Q: TV Settings** ([file](review-fixes/Q-tv-settings.md)). Split `Settings.tsx` by tab into its own files first, as a commit with no behaviour change, then fix the Settings lows on top. Native listings run outside render and skip a bad device. The Address pick is kept. Escape and Close keep or report edits.
- **R: CI, build and tests** ([file](review-fixes/R-ci-build-tests.md)). An old-target smoke job: load the packaged native module and run the downloaded yt-dlp in an `ubuntu:22.04` container, plus the `readelf` check from E. Fail the release when a zip is missing. Typecheck the unit tests and fix their 15 type errors. Compile and run the Windows Rust tests. Trim nightly. Drop the nested Vite build and the GraphQL-era test guard and `refuseUpgrade`. Assert display console errors in e2e. Fix the e2e port race and the copied helpers. R runs last because it typechecks the tests that every other phase touched.

## Rules for every phase

- Start from the current master in a fresh worktree, on branch `fix/<letter>-<name>` (for example `fix/a-party-basics`).
- Read your phase file in `review-fixes/` first. The verifier's notes override the suggested fix. Line numbers are from `fb09949` and may have moved.
- Work only in the files your phase names. If you must touch another, keep it small and name it in the report.
- Reproduce before fixing where you can: write a failing test, then make the fix. Every high and medium gets a test unless it can't be tested here; then say why.
- Commit one finding or a small group at a time. The message says what changed in plain words and ends with the ids, for example `Niconico downloads pass --ffmpeg-location (review: main-downloads-1)`. Author and committer are `Brandon S <atomicbcs@gmail.com>`, set with the GIT_AUTHOR_* and GIT_COMMITTER_* variables, with the session's Co-Authored-By trailer.
- Don't edit `CHANGELOG.md` or `README.md`. Put the lines you'd add in your report; the close-out writes them. Don't commit screenshots.
- Native: E, F and O build the native module in their worktree. Other phases copy `native/index.node` from the main checkout and don't rebuild it. Native phases also run `cargo clippy --no-default-features --target x86_64-pc-windows-msvc` and `--target aarch64-apple-darwin`. ASIO needs the Steinberg SDK, so it can't be checked here.
- Nothing plays sound or opens a real audio device. Run the app hidden and off the network: `KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1`. Run e2e with `xvfb-run --auto-servernum`, only the specs your phase touches, with `--workers=4`.
- Before reporting, run `yarn typecheck`, `yarn lint`, `prettier --check` on the files you changed, `yarn test:unit`, your e2e specs, and for native phases `cargo clippy --all-targets` and `cargo test`.
- Report, for each finding id, one of:
  - fixed (commit)
  - won't fix (why)
  - needs hardware (the exact manual check)

  Also give the checks you ran and their results, your CHANGELOG/README lines, and anything the integrator should know: expected conflicts, out-of-phase edits, contract changes.

## Orchestrator loop

1. Keep up to 6 workers running. Start each phase when everything in its "Starts after" is merged.
2. On a report, read the diff against each finding id. Check that highs and mediums have tests and that "won't fix" reasons hold up. Send it back once, with specifics, if it falls short. Otherwise hand the branch to the integrator.
3. Update the status table at every change of state, and add each "needs hardware" check to the list below.
4. When R is merged, run the completeness audit: all 213 ids in `review-fixes/` have a state, and every "won't fix" has a reason a reader would accept. Then start the close-out.

## Merge

- The integrator merges each accepted branch into master with `git merge --no-ff` and the repo's message style (`Merge A: the screen stays on, phones find karafriends.local, ...`), in the order branches are accepted. L and P are merged alone, with nothing else in between.
- After each merge, it runs `yarn typecheck`, `yarn lint`, `prettier --check .`, `yarn test:unit`, and, when native changed, `cargo clippy --all-targets`, `cargo test` and `yarn build-native-dev`. It fixes small breakages itself. Otherwise it reverts the merge and hands the branch back to the orchestrator with the failure.
- When a wave's phases are all merged (and after L and after P), it runs `yarn build-prod`, `xvfb-run --auto-servernum yarn test:e2e:ci`, one hidden launch, and the cross-target clippy runs.
- Close-out:
  - Regenerate the screenshots once (`KARAFRIENDS_SCREENSHOTS=1`, both screenshot specs).
  - Write CHANGELOG.md and README.md from the workers' lines. The README's Linux section should say 22.04 works and drop any mention of notifications.
  - Run every check one last time.
  - Update `MEMORY.md`'s review note to point at this plan's final state.

## Checks for you on real hardware

The orchestrator adds each worker's "needs hardware" check here as phases report. These are known already:

- [ ] An Android phone opens the QR code's `karafriends.local` address, also with the Japan VPN on. An iPhone still does. (A)
- [ ] Left idle for 15 minutes, the TV stays on and the session doesn't lock. (A)
- [ ] On Ubuntu 22.04 or Mint 21, the Linux zip starts, the mics use PulseAudio, and YouTube and Niconico songs download. (E, B)
- [ ] On an Apple Silicon Mac without Rosetta, Joysound, YouTube and Niconico songs play. (B)
- [ ] On Windows, Update tools works while a download is running. (B)
- [ ] Windows exclusive mode: two channels of one USB interface as Mic 1 and Mic 2. (F)
- [ ] ASIO: the chosen buffer size holds with an ASIO mic on the output's driver, and closing the output doesn't buzz. (F)
- [ ] On Windows and macOS, unplugging and replugging a mic mid-song brings it back. (F)
- [ ] With a song output chosen, turning the TV off and on mid-song keeps the song going. A TV turned on after launch is used. (H)
- [ ] By ear: the key at ±1 and ±2 on a bass-heavy song sounds in tune. (G)
- [ ] On a 4K TV, ten Joysound songs in a row don't grow GPU memory, and lyrics appear without a stall. (J)
- [ ] With the Japan VPN, DAM and Joysound still log in, search and play, and a refused login stops retrying quickly. (D)
