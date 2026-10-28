# Phase R: CI, build and tests

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 3; starts after: all other phases.

Files: .github/workflows/*, packager.js, electron.vite.config.ts, lint-staged.config.mjs, tsconfig.json (+ fixing the test files' type errors), src/main/httpServer.ts (refuseUpgrade), tests/e2e/**, playwright.config.ts.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                   | Severity                        | Title                                                                                                                                       |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [build-ci-2](#build-ci-2)                 | Medium                          | No CI job runs packager.js or the packaged app; the release job is the first to run them                                                    |
| [build-ci-3](#build-ci-3)                 | Low                             | packager.js ignores the zip step's result, and the upload step skips missing files, so a release can go green with a missing or partial zip |
| [build-ci-5](#build-ci-5)                 | Low                             | Unit tests are never typechecked; 15 type errors in 6 test files, with fixtures that no longer match the real types                         |
| [build-ci-6](#build-ci-6)                 | Low                             | Running Release by hand fails after the full build, and nothing ties the tag to package.json's version                                      |
| [build-ci-7](#build-ci-7)                 | Low                             | Build caches the ASIO SDK indefinitely while Release downloads it fresh, so a dead Steinberg link breaks only the Windows release           |
| [build-ci-8](#build-ci-8)                 | Low                             | Build workflow: four copy-pasted jobs that repeat work, and x86_64 macOS code is never linted                                               |
| [build-ci-9](#build-ci-9)                 | Low                             | The careful test step runs on an unpinned nightly and the latest cargo-careful, and continue-on-error hides install failures                |
| [build-ci-10](#build-ci-10)               | Low                             | lint-staged runs prettier --write and oxlint on the same .ts files at once, and CI never checks Rust formatting                             |
| [native-exclusive-9](#native-exclusive-9) | Low                             | CI never runs exclusive.rs's tests or compiles any Windows test code                                                                        |
| [tests-e2e-1](#tests-e2e-1)               | Low                             | jp.spec's queue tests need a seeded song that never ends, but seeded songs now play a 60-second video                                       |
| [tests-e2e-3](#tests-e2e-3)               | Low                             | Display console errors are collected in every test but checked in only three; a fake Joysound telop already throws unnoticed                |
| [tests-e2e-5](#tests-e2e-5)               | Low                             | No e2e plays a DAM or Joysound song with a mic open, so the mics' pitch on the bars never runs                                              |
| [tests-e2e-6](#tests-e2e-6)               | Low                             | settings.spec's @jp login test runs alongside jp.spec's, though both sign in to the same accounts                                           |
| [tests-e2e-7](#tests-e2e-7)               | Low                             | Five copies of the live-state reader, and several of the phone call, fake yt-dlp and fake Joysound download                                 |
| [tests-e2e-8](#tests-e2e-8)               | Low                             | The remote's port is picked, released, and bound seconds later, and the readiness check accepts any server on it                            |
| [tests-e2e-9](#tests-e2e-9)               | Low                             | ipc.spec's 6-second wait checks nothing the fixture doesn't already check                                                                   |
| [oe-build-tests-1](#oe-build-tests-1)     | Over-engineering (KEEP, medium) | build.yaml still installs and builds things nothing uses (nightly, rustfmt, build-dev, global yarn)                                         |
| [oe-build-tests-3](#oe-build-tests-3)     | Over-engineering (KEEP, medium) | The remote's separate nested Vite build, where the review's suggested target/cssTarget would have done                                      |
| [oe-build-tests-4](#oe-build-tests-4)     | Over-engineering (KEEP, medium) | Migration-era GraphQL guard still wraps every e2e test                                                                                      |
| [oe-build-tests-2](#oe-build-tests-2)     | Over-engineering (WEAK, low)    | Platform jobs copied out by hand instead of a matrix, in both build.yaml and release.yaml                                                   |
| [oe-architecture-8](#oe-architecture-8)   | Over-engineering (KEEP, low)    | Migration-era leftovers from GraphQL and the old tunnel                                                                                     |
| [oe-build-tests-5](#oe-build-tests-5)     | Over-engineering (WEAK, low)    | Copies of the same e2e/unit helpers (SSE first event, POST /api, fixture-bin path, media-tool names)                                        |
| [oe-build-tests-8](#oe-build-tests-8)     | Over-engineering (KEEP, low)    | CodeQL workflow is GitHub's multi-language template running one language                                                                    |

## build-ci-2

**No CI job runs packager.js or the packaged app; the release job is the first to run them** (medium, confirmed, build-ci) · `.github/workflows/build.yaml:170`

**Summary.** No CI job runs `yarn package-prod` or starts the packaged app. package-prod appears only in release.yaml, the release jobs run no tests, and e2e (tests/e2e/fixtures.ts:45) launches the unpackaged build/prod/main/index.js. A packaging-only regression goes unseen until the release is built. The Linux PipeWire load failure would currently reach users this way, although 0.2.0 hasn't been released yet.

**Scenario.** A change breaks the packaged app only, for example a runtime file outside build/prod, a wrong resources/extraResources path (externalResources.ts:46-48 takes the isPackaged branch only when packaged), or the libpipewire load failure above. Build is green on master, the release is published, and users download zips that don't work. The libpipewire issue shipped exactly this way.

**Suggested fix.** Add `yarn package-prod` to the Linux and Windows Build jobs; on macOS, only when the signing secrets exist, or with osxSign/osxNotarize behind an env flag. After it, unzip and check resources/app/build/prod/main/index.js and resources/extraResources/7za[.exe]. Then start the packaged binary for a smoke test, either with Playwright's electron.launch({ executablePath }) on one spec or, on Linux, with a native-module load in an ubuntu:22.04 container. That costs about a minute per job.

**Verifier.** CONFIRMED: Facts checked: package-prod is used only in release.yaml (lines 55, 100, 123, 148). The release jobs have no test steps. MAIN_ENTRY = build/prod/main/index.js. externalResources.ts:46 takes the isPackaged branch only when packaged, so that path is never tested. The claim that 'the libpipewire issue shipped exactly this way' is inaccurate: CHANGELOG says 0.2.0 is unreleased and there are no tags. Also, a plain package-prod on ubuntu-24.04 would not catch build-ci-1. Only the suggested smoke test on an old distro (a 22.04 container) would. Medium because the whole release path has zero automated checks, and build-ci-1 shows a defect of exactly that kind waiting to ship.

## build-ci-3

**packager.js ignores the zip step's result, and the upload step skips missing files, so a release can go green with a missing or partial zip** (low, confirmed, build-ci) · `packager.js:67`

**Summary.** packager.js:67 ignores spawnSync's error and status, so a 7za that fails to start or exits non-zero still prints 'Built …zip.' and exits 0. action-gh-release v3 only warns on unmatched files by default. Separately, `7za a` updates an existing archive, so a second local package-prod keeps deleted files in dist/*.zip. CI runners are fresh, so this can't affect published zips.

**Scenario.** (1) On the runner, 7za can't start (ENOENT/EACCES) or exits non-zero (disk full, unreadable file). The job uploads nothing, or a truncated zip, and still goes green, so the release is missing that platform. (2) Locally, a second `yarn package-prod` leaves the old index-<hash>.node, the old web assets and any deleted files in dist/karafriends-*.zip. On macOS those extra files inside the signed .app don't match the code seal, so Gatekeeper reports the app as damaged.

**Suggested fix.** In packager.js, `fs.rmSync(`${output}.zip`, { force: true })` before zipping, then `if (r.error || r.status !== 0) throw r.error ?? new Error(`7za exited ${r.status}`)`. Add `.catch(e => { console.error(e); process.exit(1); })` to the IIFE. Set `fail_on_unmatched_files: true` on all four gh-release steps. On macOS, Apple's recommended `ditto -c -k --keepParent` is the safer zipper.

**Verifier.** CONFIRMED: Confirmed with the bundled 7zip-bin linux/x64/7za. After deleting App/run and re-running `7za a -r out.zip App`, the archive still lists App/run. spawnSync('/nonexistent/7za') returns status null with error ENOENT and doesn't throw. I fetched softprops/action-gh-release v3's run.ts: without fail_on_unmatched_files it only calls console.warn('Pattern … does not match any files'). One claim is wrong: `7za a -r x.zip /does-not-exist` exits 2 here and writes no file, not 'exits 0 with a 22-byte zip'. Also, the suggested .catch on the IIFE isn't needed, because Node ≥15 already exits 1 on an unhandled rejection. Low: 7za failing on a runner is rare, and the stale-append only affects local zips, since release runners start clean.

## build-ci-5

**Unit tests are never typechecked; 15 type errors in 6 test files, with fixtures that no longer match the real types** (low, confirmed, test-gap) · `tsconfig.json:16`

**Summary.** tsconfig.json excludes **/*.test.ts, and tests/tsconfig.json includes only e2e, playwright.config.ts and electron.vite.config.ts. tsx strips types without checking, so `yarn typecheck` and CI never see the unit tests' types. Their fixtures have drifted from the types they stand in for.

**Scenario.** Typechecking the unit tests today gives 15 errors. ipc.test.ts:17's LiveState lacks songVolume and mics. apiClient.test.ts:36 has songVolume possibly undefined, and :342's DownloadProgress lacks id, status and reason. jobs.test.ts (8 errors) mocks JoysoundMovieList without slc. api.test.ts:1283 casts an incompatible type. Two files import with a .ts extension (TS5097). The next refactor of LiveState or DownloadProgress won't show which tests rely on fields that changed shape.

**Suggested fix.** Add a tsconfig.unit.json that extends ./tsconfig.json with include ["src"], exclude [], noEmit and allowImportingTsExtensions. Append `&& tsc -p tsconfig.unit.json` to the typecheck script and fix the 15 errors, mostly by completing the fixtures.

**Verifier.** CONFIRMED: tsconfig.json excludes **/*.test.ts, and tests/tsconfig.json includes only e2e plus two config files. I ran tsc with a scratch config (verify-build-ci/tsconfig.unit.json, extending the repo's, include src, exclude []). It reproduced the same 15 errors in the same files: apiClient 3, externalResourcesPlan 1 and nicoVideoInfo 1 (TS5097 .ts imports), api.test 1, jobs.test 8 (JoysoundAPI mock), ipc.test 1 (LiveState fixture). It also gave 2 extra Server-type errors in httpServer.test.ts and server.test.ts, which come from my scratch config's location (it resolves a duplicate @types/node), not the repo. The tests pass at runtime, so this is fixture drift and a maintainability cost, not a live bug.

## build-ci-6

**Running Release by hand fails after the full build, and nothing ties the tag to package.json's version** (low, confirmed, build-ci) · `.github/workflows/release.yaml:5`

**Summary.** workflow_dispatch is enabled, but each job ends in softprops/action-gh-release with no tag_name. Run from a branch, that action fails with 'GitHub Releases requires a tag', and no job uploads its zip as a workflow artifact. A manual run from master builds all four zips, signs and notarizes both Macs, then fails and keeps nothing. Separately, the bundle and exe versions come from package.json (0.2.0), and nothing checks them against the tag being released.

**Scenario.** The maintainer runs Release on master to test the pipeline before tagging. About 20 minutes of runners and two Apple notarizations later, all four jobs are red and no zip is downloadable. Or a v0.2.1 release is published without bumping package.json, and the macOS CFBundleShortVersionString and the Windows FileVersion still read 0.2.0. Because jobs upload into an already-published release, the Releases page also shows no zips for the first ~20 minutes, and stays missing a platform for good if one job fails.

**Suggested fix.** Upload with actions/upload-artifact when `github.event_name == 'workflow_dispatch'`, and run gh-release only when `github.event_name == 'release'`. Add a step that fails unless `github.event.release.tag_name == 'v' + package.json version`. Optionally create the release as a draft and publish it after all four uploads finish.

**Verifier.** CONFIRMED: release.yaml:5 enables workflow_dispatch, and the four gh-release steps pass only `files`. In softprops/action-gh-release v3's run.ts, `if (!config.input_tag_name && !isTag(config.github_ref) && !config.input_draft) throw new Error('GitHub Releases requires a tag')`, so a dispatch from master builds, signs and notarizes, then fails without uploading any artifact. A dispatch from a tag ref works, though (it re-runs a release), so the trigger isn't useless. Nothing checks the tag against package.json's version (0.2.0). packager.js passes no appVersion, and @electron/packager defaults appVersion to package.json's version. Low: it wastes runner time, and a version mismatch only produces wrong metadata.

## build-ci-7

**Build caches the ASIO SDK indefinitely while Release downloads it fresh, so a dead Steinberg link breaks only the Windows release** (low, plausible, build-ci) · `.github/workflows/build.yaml:111`

**Summary.** In the Windows Build job, buildResources is cached under a key that changes only when scripts/getExternalResources.mjs changes. getAsioSdk() returns early when the header exists, so Build never contacts steinberg.net again. release-windows-x86_64 has no such cache and downloads https://www.steinberg.net/asiosdk on every release.

**Scenario.** Steinberg moves or rate-limits the SDK link, which is a redirect to a versioned zip, or changes the zip's top folder so asiosdk/common/asio.h isn't where the script expects it. Build stays green, since regular runs keep the cache from expiring. The next Windows release fails in `yarn build-prod` with 'The ASIO SDK wasn't successfully downloaded!'.

**Suggested fix.** Use the same actions/cache step in release-windows-x86_64 so a release builds against the SDK CI tested. Separately, run a weekly scheduled Build with the cache key salted so the download path stays tested.

**Verifier.** PLAUSIBLE: The facts hold. build.yaml:107-111 caches buildResources keyed on hashFiles('scripts/getExternalResources.mjs'). getAsioSdk returns early when asio.h exists (getExternalResources.mjs:87-88). release-windows-x86_64 has no cache step and downloads https://www.steinberg.net/asiosdk each time. Whether Steinberg moves or reshapes the link is speculative. If it does, the release fails loudly ('The ASIO SDK wasn't successfully downloaded!') and gets fixed, so a release is delayed but nothing broken ships. Also, adding the same cache to Release, as suggested, would hide a dead link there too. The real value is the scheduled cache-busting build, which is optional extra infrastructure.

## build-ci-8

**Build workflow: four copy-pasted jobs that repeat work, and x86_64 macOS code is never linted** (low, plausible, performance) · `.github/workflows/build.yaml:53`

**Summary.** The four Build jobs are near-identical copies. Nightly is installed in all four but used only by Linux's careful step. The macOS x86_64 job repeats the unit tests on the same arm64 runner, and its clippy, run without --target, lints aarch64 again. Windows and Linux compile the workspace crates twice (debug build-dev, then release build-prod). The two macOS release jobs repeat the keychain setup word for word. This costs some CI minutes per run; it causes no correctness gap.

**Scenario.** Every PR pays for an extra debug Rust build on Windows and Linux (including ASIO bindgen on Windows), about a minute of unused nightly install on three jobs, and a duplicate macOS job whose only unique work is a debug x86_64 cross-compile. A `#[cfg(target_arch = "x86_64")]` clippy error on macOS passes CI. Edits drift between the copies: Windows Build caches buildResources and Windows Release doesn't.

**Suggested fix.** Use one matrix job over {os, target, packager_arch}. Install nightly only when matrix.os is Linux, and run `cargo clippy --target ${{ matrix.target }} --all-targets`. Replace build-dev with `electron-vite build --mode development` after build-prod, which reuses the release index.node and still checks the dev bundle. Merge the two macOS Build jobs into one with an extra `cargo clippy --target x86_64-apple-darwin`. Use the same matrix in release.yaml. That removes roughly 100 lines of YAML, one Rust compile per Windows/Linux run and one macOS job.

**Verifier.** PLAUSIBLE: The duplication, the nightly install in all four jobs (only package.json:19's careful step on Linux uses it), clippy without --target on macOS (build.yaml:52,83), and build-dev plus build-prod (115-121, 166-172) are all as described. There is no native/.cargo target override. The 'x86_64 macOS code is never linted' claim has no practical effect: grep finds no target_arch cfgs in native/*/src, and build-dev with CARGO_ARGS --target x86_64-apple-darwin compiles x86_64 under setup-rust-toolchain's default -D warnings (the release.yaml comment confirms that default). Swatinem/rust-cache keeps dependencies for both profiles, so the extra debug build recompiles only the two workspace crates. Turning the jobs into a matrix is mostly a maintainability preference. The cheap wins are dropping nightly on three jobs and the duplicate unit-test run.

## build-ci-9

**The careful test step runs on an unpinned nightly and the latest cargo-careful, and continue-on-error hides install failures** (low, plausible, build-ci) · `.github/workflows/build.yaml:185`

**Summary.** `cargo +nightly careful test` uses whatever nightly is current (build.yaml:140), `cargo install cargo-careful` installs the latest release without --locked or --version, and the install step is continue-on-error. A nightly regression, or a cargo-careful release that needs a newer nightly or rust-src layout, turns master red with no code change. When the install itself fails, the error shows up one step later as 'no such command: careful'.

**Scenario.** A new nightly can't build std under careful, or cargo-careful bumps rustc-build-sysroot. Every PR's Linux job fails, which blocks merges until someone pins the toolchain. Fixing it means digging through the next step's error, because the install step is marked continue-on-error.

**Suggested fix.** Pin the nightly to a dated toolchain (for example nightly-2026-10-01) in both the setup step and package.json, or through an env var. Use `cargo install cargo-careful --locked --version <x.y.z>` and drop continue-on-error. Bump both on purpose, for example with Dependabot or a monthly PR.

**Verifier.** PLAUSIBLE: As stated, build.yaml:138-143 installs an unpinned `nightly`, :184 runs `cargo install cargo-careful` with no --locked or --version, :185 is continue-on-error, and package.json:19 uses `cargo +nightly careful test`. A nightly or cargo-careful release breaking the step is a generic future risk, not something observed. When the install fails, the build still goes red one step later with 'no such command: careful', so nothing is hidden; diagnosing it is just slightly less direct. Pinning nightly has its own upkeep cost, so this is a reasonable hardening suggestion and nothing more.

## build-ci-10

**lint-staged runs prettier --write and oxlint on the same .ts files at once, and CI never checks Rust formatting** (low, plausible, build-ci) · `lint-staged.config.mjs:3`

**Summary.** CI never runs `cargo fmt --check`. rustfmt runs only in the lint-staged pre-commit hook, so Rust committed with --no-verify or from the web editor goes through unformatted. The overlapping prettier and oxlint globs are a theoretical race only: oxlint doesn't write files, and it usually exits before prettier's Node process has started writing.

**Scenario.** oxlint reads a staged .ts file while prettier is truncating and rewriting it, then fails the commit spuriously or lints partial content. And a Rust change committed with --no-verify, or from the GitHub web editor, passes CI unformatted, so the next person's commit hook reformats unrelated code.

**Suggested fix.** Use `"**/*.{ts,tsx}": ["prettier --write", "oxlint --deny-warnings"]` and narrow the catch-all to `"**/*.!(ts|tsx)": "prettier --write --ignore-unknown"`, so each file's tasks run in order. Add `cargo fmt --manifest-path native/Cargo.toml --all --check` next to `yarn prettier --check .` in the Linux job.

**Verifier.** PLAUSIBLE: The README passage at node_modules/lint-staged/README.md:273/302 warns about overlapping globs where tasks _make edits_. Here only prettier --write edits, and oxlint (no --fix) only reads. oxlint is a native binary that finishes in tens of ms, while prettier has to start Node before it writes anything, so a partial read is very unlikely, and linting the pre-format content gives the same result. The .rs glob also overlaps `**/*`, but prettier --ignore-unknown doesn't touch .rs files. The CI part holds: grepping .github finds only `components: clippy, rustfmt` installs and no cargo fmt run. `cargo fmt --all --check` passes today (exit 0), so nothing has drifted yet. Adding one CI line is still worthwhile.

## native-exclusive-9

**CI never runs exclusive.rs's tests or compiles any Windows test code** (low, confirmed, build-ci) · `.github/workflows/build.yaml:132`

**Summary.** exclusive.rs is #[cfg(windows)], and its 14 hardware-free tests (sample conversion, frames_to_hns rounding, candidate order, WAVEFORMATEXTENSIBLE layout, channel masks, unknown endpoint) compile only on Windows. The Windows job runs `cargo clippy` without --all-targets and no `cargo test`, and the native tests run only in the Linux job. The ASIO branch of test_asio_status is in the same position. This review's baseline (clippy --all-targets and 32 cargo tests on Linux) never compiled exclusive.rs either.

**Scenario.** A change to convert() (e.g. the 24-in-32 scaling) or to candidates() breaks the exclusive mic's sound or format choice, and CI stays green because no CI job runs or even compiles those tests.

**Suggested fix.** Add to the Windows job: `cargo clippy --manifest-path native/Cargo.toml --all-targets` and `cargo test --manifest-path native/Cargo.toml -p karafriends-lib exclusive::`. Most of the cost is compiling the test binary; the filter keeps the slow resampler and pitch tests Linux-only.

**Earlier reviews.** New

**Verifier.** CONFIRMED: In build.yaml, the build-windows-x86_64 job runs only `cargo clippy --manifest-path native/Cargo.toml` (line 132), without --all-targets, so #[cfg(test)] code isn't compiled, and it never runs cargo test. `yarn test:native:careful` (cargo test) runs only in the Linux job (line 186). exclusive.rs is `#[cfg(windows)] mod exclusive` (lib.rs:54-55), so its hardware-free tests (convert, frames_to_hns, candidates, wave_format, channel_mask, unknown endpoint) never compile or run in CI. The asio branch of test_asio_status is in the same position. The header comment at build.yaml:15-20 reasons that one platform is enough, but that doesn't hold for Windows-only modules. yarn build-dev compiles exclusive.rs's non-test code, so only the tests are unchecked. Adding `--all-targets` and `cargo test … exclusive::` to the Windows job is cheap, since the two hardware tests are #[ignore]. Worth doing, low severity.

**Also reported as** (exclusive.rs's tests never compile or run in CI. Add cargo test for that module, and clippy --all-targets, to the Windows job.):

- tests-unit-2: exclusive.rs's 14 unit tests never compile or run in CI (`.github/workflows/build.yaml:132`). Its fix: After `yarn build-dev` in the Windows job, add `cargo test --manifest-path native/Cargo.toml -p karafriends-lib --lib exclusive`. The hardware tests stay #[ignore], and the dependencies are already built, so only the lib test binary is extra. At minimum, switch that job's step to `cargo clippy --all-targets` so the test code at least compiles.
- build-ci-4: The Windows-only Rust tests (exclusive.rs, ASIO branches) are never compiled or run in CI (`.github/workflows/build.yaml:132`). Its fix: In the Windows job, add `cargo test --manifest-path native/Cargo.toml -p karafriends-lib`, plain and not careful (the 1.5-2.5 min the comment cites came from careful's std rebuild). Make every clippy call `cargo clippy --all-targets` so test code is linted on each OS.

## tests-e2e-1

**jp.spec's queue tests need a seeded song that never ends, but seeded songs now play a 60-second video** (low, confirmed, bug) · `tests/e2e/jp.spec.ts:79`

**Summary.** The @jp "queueing" tests seed a Niconico placeholder that, per the comment, "the display starts at once and never finishes", so the DAM or Joysound song queued after it waits in the Queue until the test removes it. Since 662307c, seedVideos (fixtures.ts:593-607) gives every seeded nico or youtube song tests/fixtures/black.mp4, which ffprobe says is 60.0 s long. The placeholder now ends about a minute after launch, and the next song is popped the moment it joins the queue.

**Scenario.** KARAFRIENDS_E2E_JP=1, the Joysound test: the real download takes longer than about 50 s (the test allows 240 s at :171). By then the placeholder has ended and the display is WAITING. When the song joins the queue, useSongPlayer's hasQueue effect pops it at once, so it shows on the now-playing bar and never in the Queue region, which lists only waiting songs. `queue.getByText(title)` never appears, and the test fails after 240 s. If the download is quicker but the placeholder ends before removeFromQueue, the Remove button is gone. The DAM test hits the same one-minute limit whenever the DAM search and song page use up most of their 30-s waits (:32, :37).

**Suggested fix.** After waitForPlaceholder, pause the placeholder so it can't end: `displayCall(display, "setPlaybackState", { playbackState: "PAUSED" })`, which means adding `display` to the two tests. The queued song then waits for as long as the download takes. Correct the five stale comments.

**Verifier.** CONFIRMED: I traced it end to end. ffprobe: tests/fixtures/black.mp4 is 60.000 s, one h264 stream. seedVideos (fixtures.ts:593-607) copies it for nico and youtube songs. The hidden display really plays it: index.ts:173 sets backgroundThrottling false when HIDE_WINDOW is set, and other specs already assert currentTime > 0.5 on seeded songs (screenshotsDisplay.spec.ts:106, ipc.spec.ts:70). With the WAITING seed, the hasQueue effect (useSongPlayer.ts:391-394) pops the placeholder as soon as the first live state arrives. About 60 s later, onended (useSongPlayer.ts:340) leads to popSong returning null, then startSong(null) calls setPlaybackState("WAITING") and schedulePoll. A Joysound song joins the queue only after its download finishes (api.ts:648-660: deps.downloads.joysound → pushSongToQueue). The hasQueue effect then pops it at once, or the 5-s poll does at the latest. The remote's Queue region (NowPlayingSheet.tsx:138) wraps only QueueList, which lists waiting songs. So jp.spec.ts:166-171 can only pass if the searches, the song page, the real ffmpeg download (jobs.ts:272-306) and removeFromQueue all finish within about 60 s of the display loading. The test itself allows 240 s for the download alone. If the song arrives just before the placeholder ends, the Remove click races the pop instead. The DAM test has the same window but normally finishes well inside it. The stale comments are there as listed (api.spec.ts:2-3, :229-230, :648-649, live.spec.ts:2-4, screenshots.spec.ts:43). screenshots.spec is gated on KARAFRIENDS_SCREENSHOTS=1, so that part is a manual tool. Whether a given run fails depends on download speed over the VPN, which I couldn't measure. Re-rated to low: an opt-in @jp test that fails depending on timing, with no effect on users.

## tests-e2e-3

**Display console errors are collected in every test but checked in only three; a fake Joysound telop already throws unnoticed** (low, confirmed, test-gap) · `tests/e2e/remote.spec.ts:1665`

**Summary.** fixtures.ts:452-461 records the display's console errors and page errors for every launch, but only display.spec.ts:126, :390 and settings.spec.ts:629 assert on them. remote.spec's fakeJoysoundDownload writes a 32-byte telop with the metadata offset at 10 and the lyrics and timing offsets at 0. The display's parseJoysoundData therefore throws `RangeError: Invalid DataView length -10` for each of "the lyrics mode" test's songs, and the test still passes. settings.spec.ts:518 has a second fakeJoysoundDownload whose layout the parser accepts.

**Scenario.** A regression that throws in the display during playback (PianoRoll, JoysoundRenderer, Up next, any IPC failure logged with console.error) passes the player, ipc, live, api, remote and most settings tests, which all play songs without looking at displayErrors. Today, remote.spec:1700 plays e2e-romaji with a telop the parser rejects: no lyrics are drawn, and the error goes only to the console.

**Suggested fix.** In the karafriends fixture, expect displayErrors to be empty at teardown, next to the /api check at fixtures.ts:559. Add an option for tests that expect errors, e.g. `allowDisplayErrors: [/The video failed/, /Couldn't load the lyrics/, /DAM stream failed/]` for player.spec and downloadFailure.spec. Move settings.spec's valid fakeJoysoundDownload into fixtures.ts and use it from remote.spec.

**Verifier.** CONFIRMED: I ran a scratch script (scratchpad/review/verify-tests-e2e/telop.mts) that calls the real parseJoysoundData on both fake telops. remote.spec's 32-byte telop throws `RangeError: Invalid DataView length -10`: metadataOffset is 10, lyricsOffset 0, so parseJoy02Metadata gets size -10 (joysoundParser.ts:886-896, :690). getSongDuration still reads 60, so queueSong accepts the song. settings.spec's 68-byte telop parses without error (0 lyrics, 0 events). On the display, loadJoysound sets the telop and plays the video. JoysoundRenderer's refresh() rejects, and JoysoundRenderer.tsx:1006 only logs it with console.error, so the song plays with no lyrics. remote.spec "the lyrics mode" (:1707) never reads displayErrors. grep shows displayErrors asserted only at display.spec.ts:126, :390 and settings.spec.ts:629, while fixtures.ts:452-461 collects them for every launch. Low: a test gap plus broken fake data.

## tests-e2e-5

**No e2e plays a DAM or Joysound song with a mic open, so the mics' pitch on the bars never runs** (low, confirmed, test-gap) · `tests/e2e/settings.spec.ts:556`

**Summary.** For each mic, PianoRoll starts a 25-ms setInterval that calls inputDevice_getPitch and draws with its own PitchProgram (PianoRoll.tsx:535-548, :580-584). This setup is rebuilt whenever the mics, the melody or the key change. The pitch-bar tests (settings.spec.ts:443, :556) open no mic, and the mic tests (:691-1163) play no song. The fake getPitch always answers `{ midiNumber: 0, confidence: 0 }` (src/preload/index.ts:150-153), so even a test that combined them would draw nothing.

**Scenario.** A regression where the newest work overlaps passes every test. Examples: the Joysound guide roll rebuilt on a key change (pitchShiftSemis is an effect dependency) leaves a mic's poll interval running; pitch is buffered against the wrong melody after a seek; a mic removed mid-song keeps being polled. Out of slice: the same effect never deletes the WebGL programs and buffers it creates, so every key change or mic change during a song leaks a set on the same context. Worth a renderer look.

**Suggested fix.** Make the fake getPitch return a confident midiNumber that follows a script, e.g. the joysound-guide.mp4 notes at their times. In the Joysound pitch-bar test, add a fake mic from Settings, then use fakeAudioCalls counts to check that inputDevice_getPitch calls arrive about 40 times a second, that a key change twice leaves exactly one poller per mic, and that the calls stop once the mic is removed.

**Verifier.** CONFIRMED: The gap is real. The pitch-bar tests (settings.spec.ts:443, :556) add no mic. None of the mic tests (:645-1163) seeds or queues a song; grep shows queueSong only at :459 and :577. The fake inputDevice_getPitch (src/preload/index.ts:150-153) always returns confidence 0, which pollPitch (PianoRoll.tsx:504-526) discards. No unit test covers PianoRoll. So the mic pitch drawn over the bars, a headline feature, never runs in tests. One correction: the cleanup at PianoRoll.tsx:619-621 does clear every poller interval, so 'leaves a mic's poll interval running' is a possible future regression, not a current bug. The WebGL leak is real: grep finds no gl.delete* in src/renderer, and each effect rerun (key, mics or melody change) builds new Pitch, Note, Seek and FreeTime programs on the same context. It is small and bounded, though, since PianoRoll unmounts on any song without bars and the context goes with the canvas.

## tests-e2e-6

**settings.spec's @jp login test runs alongside jp.spec's, though both sign in to the same accounts** (low, plausible, build-ci) · `tests/e2e/settings.spec.ts:1273`

**Summary.** jp.spec.ts:67-69 runs its realCredentials tests one at a time because "they all sign in to the same DAM and Joysound accounts". `mode: "default"` orders only that describe, though. settings.spec's "testLogin signs in to DAM and Joysound @jp" is in another file, so with fullyParallel it runs in a parallel worker while a jp.spec test is signed in and searching or downloading.

**Scenario.** `KARAFRIENDS_E2E_JP=1 yarn test:e2e`: settings.spec:1276 signs in to DAM and Joysound while jp.spec's Joysound test is downloading with the same account. If either service ends the older session on a new sign-in, which is the reason jp.spec serializes, one of the two fails with an auth error that depends on scheduling.

**Suggested fix.** Give both describes `{ tag: "@jp", lock: "jp-accounts" }` (the lock replaces jp.spec's mode: "default"), or move testLogin into jp.spec's describe. youtube.spec's "one at a time" could use a lock the same way.

**Verifier.** PLAUSIBLE: The facts check out. playwright.config.ts:17 sets fullyParallel. jp.spec.ts:69 serializes only its own describe. settings.spec.ts:1273-1284 uses realCredentials and the @jp title with no configure or lock, so with KARAFRIENDS_E2E_JP=1 it can run in another worker alongside a jp.spec test. Playwright 1.64.1 is installed, and its types document describe-level `lock` across files (node_modules/playwright/types/test.d.ts:2881-2882, :3134-3141). The harm rests on jp.spec's own comment that concurrent sign-ins to the same accounts interfere. I couldn't check whether DAM or Joysound actually end older sessions.

## tests-e2e-7

**Five copies of the live-state reader, and several of the phone call, fake yt-dlp and fake Joysound download** (low, confirmed, maintainability) · `tests/e2e/api.spec.ts:37`

**Summary.** The reader that takes the first event of /api/events is written out five times: api.spec.ts:37, live.spec.ts:72, player.spec.ts:26, settings.spec.ts:31 and remote.spec.ts:1676. Other copies: the POST helper with identity headers three times (api.spec.ts:21, player.spec.ts:47, settings.spec.ts:538) plus about ten inline fetches with the same headers (e.g. display.spec.ts:241, ipc.spec.ts:78, downloadFailure.spec.ts:205, remote.spec.ts:1572); fakeYtdlp twice (downloadFailure.spec.ts:20, player.spec.ts:12); the display's onLive reader twice (downloadFailure.spec.ts:52, settings.spec.ts:119-146); the deviceId and nickname remote opener three times (api.spec.ts:255, :582-590, live.spec.ts:44); and fakeJoysoundDownload twice, with different telop layouts. fixtures.ts:195-204 also hand-mirrors resourcePathsFor, which is a pure module it could import.

**Scenario.** A change to the SSE framing (a keep-alive comment before the data, or multi-line data) or to the identity headers needs five or more edits, and the Joysound copies have already diverged so that one breaks the parser. None of the SSE readers has its own timeout. Where one is awaited outside expect.poll (e.g. api.spec.ts:365, settings.spec.ts:100), a stream that never sends data hangs until the 90-s test timeout instead of failing with a clear message.

**Suggested fix.** Export liveState(remoconUrl, deviceId?), phoneCall(remoconUrl, method, input, identity?), fakeTool(name), fakeJoysoundDownload(app, songId, video, seconds), displayLiveState(display) and openPhone(page, url, identity) from fixtures.ts, with one abort-after timeout in liveState, and import resourcePathsFor. That removes about 200 lines.

**Earlier reviews.** The 2026-10-27 product review moved five inline copies of displayCall into fixtures.ts. It left the liveState and phone-call copies.

**Verifier.** CONFIRMED: The duplication is there. Five SSE first-event readers are the same apart from what they return: api.spec.ts:37 (also checks the content type), live.spec.ts:72 (firstEvent, returns text), player.spec.ts:26, settings.spec.ts:31 (phoneLiveState) and remote.spec.ts:1676. fakeYtdlp is defined twice (player.spec.ts:12, downloadFailure.spec.ts:20). onLive readers appear in downloadFailure.spec.ts:46-58 and settings.spec.ts:128-138. There are two fakeJoysoundDownload functions with different telop layouts, and one of them breaks the parser (see tests-e2e-3). The identity-header POSTs repeat across specs. fixtures.ts:195-204 copies resourcePathsFor (src/common/externalResourcesPlan.ts:125-140), which imports only path, and fixtures.ts already imports src/common/adminPassword. None of the readers has its own timeout. 'About 200 lines' looks high; roughly 100-150 is more likely. Still worth doing, given the Joysound copies have already drifted apart.

## tests-e2e-8

**The remote's port is picked, released, and bound seconds later, and the readiness check accepts any server on it** (low, plausible, build-ci) · `tests/e2e/fixtures.ts:276`

**Summary.** freePort() binds 127.0.0.1:0, closes the listener, and the app binds that port only once Electron has started, seconds later. Nothing holds the port in between. The readiness poll (fixtures.ts:484-495) only requires `fetch(remoconUrl).status === 200`, so it is satisfied by whatever process holds the port.

**Scenario.** Two workers launch at once, and worker B's freePort() gets the port worker A just released (Linux picks ephemeral ports pseudo-randomly, so a recently freed one can come back). App A binds first. App B gets EADDRINUSE and shows "Phones can't connect", but B's poll gets 200 from A's server, so B's remote and fetches change A's queue. Both tests then fail in ways that point nowhere. Rare, but very hard to diagnose.

**Suggested fix.** Let the app take KARAFRIENDS_REMOCON_PORT=0 and read the bound port back (e.g. from window.karafriends.remoconPort() or a main-process global via app.evaluate). Or keep the port but have the poll check identity: pass a per-launch nonce in env and require the server to echo it in a response header.

**Verifier.** PLAUSIBLE: The mechanism is real. freePort (fixtures.ts:276-286) binds port 0 on 127.0.0.1, then closes it. The port stays free through config writes, media-tool copies (a large copy in installed mode) and electron.launch (:375-437) until startHttpServer binds it. The readiness poll (:484-495) only checks for status 200. Linux picks bind(0) ports at random. Node's listen sets SO_REUSEADDR, which on Linux narrows the choice to half the ephemeral range, about 7k odd ports. Another worker's freePort, or the debug ports Electron binds at launch, can therefore draw the same port while it is free. If another karafriends server takes it, the loser's poll gets 200 and the tests talk to the wrong app. If something else takes it, the fixture fails with 'the remote server never came up'. I couldn't measure how often this happens. It is rare per test but not zero across a full parallel run, and CI's single retry hides it.

## tests-e2e-9

**ipc.spec's 6-second wait checks nothing the fixture doesn't already check** (low, confirmed, maintainability) · `tests/e2e/ipc.spec.ts:56`

**Summary.** The comment says the display asks for the next song every 5 s during the wait. In fact song 1, a 60-s black video, is playing, so the poll isn't armed (useSongPlayer.ts:90-114, :345). fixtures.ts:559-562 already fails every test that sends an /api request. The wait adds 6 s to every run, and display.spec.ts:125 is the test that actually waits through the idle polls.

**Scenario.** Removing lines 54-57 loses no coverage. If the intent is to see polling traffic, the test has to run with an empty queue, and display.spec's idle test already does that.

**Suggested fix.** Delete the wait and its assertion and keep the probe check. Or, if idle polling matters here, run this test with no seeded songs.

**Verifier.** CONFIRMED: I traced it. expectSong1Started (ipc.spec.ts:44) returns once song 1, a 60-s black video, is playing. startSong with a song never calls schedulePoll, and pollQueue cleared pollTimeoutRef (useSongPlayer.ts:97-114, :285-333). So no popSong polling happens during the 6-s wait at :56. The only display traffic then is the occasional position report every 10 s. The assertion at :57 repeats the teardown check every test already gets (fixtures.ts:559-562). display.spec.ts:122-126 is the test that actually waits 11 s through the idle polls. The comment is misleading and the wait adds 6 s for no coverage. Deleting it, or running it with an empty queue, is a cheap fix.

## oe-build-tests-1

**build.yaml still installs and builds things nothing uses (nightly, rustfmt, build-dev, global yarn)** (over-engineering, KEEP, medium) · `.github/workflows/build.yaml:26`

**Now.** Every one of the 4 jobs runs setup-rust-toolchain twice (nightly and stable), each with `components: clippy, rustfmt` and an explicit `target`. Windows (l.115) and Linux (l.166) run `yarn build-dev` and then `yarn build-prod`. The two macOS jobs run `npm install -g yarn` (l.45, 76) after setup-node.

**Why it's more than needed.** Nightly is only used by `cargo +nightly careful` in `test:native:careful`, which only the Linux job runs (since 0b63534; that commit removed careful from mac/win but left their nightly installs). No CI step runs rustfmt or `cargo fmt --check`. `build-dev` before `build-prod` dates from when typecheck needed Relay's generated files from the dev build. Relay is gone (0ce23b6), typecheck now runs before both builds, and nothing reads build/dev afterwards: e2e uses build/prod, and Clippy has its own check artifacts. `npm install -g yarn` comes after `setup-node` with `cache: yarn`, which already needed yarn on the image, and release.yaml's macOS jobs run yarn without it. `target:` is the host default on Windows, Linux and macOS arm64.

**Simpler shape.** Install nightly only in the Linux job. Keep it before the stable step so stable stays the default, and give it no `components` (careful doesn't need clippy or rustfmt, and listing components can fail on a nightly that lacks one). Drop rustfmt from stable. Keep `target:` only in the mac x86_64 job. Delete `yarn build-dev` on Windows and Linux. Delete both `npm install -g yarn` steps. Switching the mac jobs from build-dev to build-prod is optional: it changes what CI checks and simplifies nothing.

**Saves.** Per CI run: 3 nightly toolchain installs, 2 full debug builds (native debug cdylib plus a vite dev build) and the debug half of rust-cache's native/target cache on Windows/Linux. About 25 YAML lines. It also removes the need to explain why nightly is everywhere.

**Risk.** Low. A compile error that shows only under cfg(debug_assertions) would go uncaught on Windows/Linux (grep finds no cfg(debug_assertions) in native/). The macOS jobs still build dev unless switched.

**Verifier.** The conclusions check out, but two of the reviewer's origin stories are wrong. (a) Nightly: `+nightly` appears only in `test:native:careful`, and only the Linux job runs it (since 0b63534). The mac and Windows nightly installs are dead. (b) rustfmt: no CI step uses it. It runs only locally, through lint-staged.config.mjs. (c) build-dev on Windows/Linux was not added for Relay or typecheck. It was the job's original build step. ec5a987 added build-prod for e2e next to it and never removed it. Either way nothing reads build/dev now: e2e uses build/prod, Clippy builds its own check artifacts, and grep finds no cfg(debug_assertions) in native/. (d) `npm install -g yarn` came from 605721a, when the mac x64 job ran on a self-hosted runner that had no yarn. Both jobs are on macos-latest now, setup-node `cache: yarn` already runs yarn before that step, and release.yaml's mac jobs work without it. (e) `target:` matches the host everywhere except x86_64-apple-darwin.

## oe-build-tests-3

**The remote's separate nested Vite build, where the review's suggested target/cssTarget would have done** (over-engineering, KEEP, medium) · `electron.vite.config.ts:72`

**Now.** `remoconBuild` is a plugin that, in the display build's writeBundle, starts a second `vite.build()` with its own config (root, base, publicDir:false, react(), outDir, emptyOutDir:false, target, minify, sourcemap, input). Supporting it: the `PAGES` map, `REMOCON_TARGET`, and `input: command === "serve" ? PAGES : { renderer }` (l.236), so dev and build see different inputs. About 45 lines, plus a header comment explaining the two-build model.

**Why it's more than needed.** It was added (517b65c) to fix review finding #18, -webkit-user-select being dropped from the remote's CSS. That finding's own suggested fix was to give the renderer build phone `target`/`cssTarget`. The second build was chosen so the display's CSS would stay "byte-for-byte the same", which nothing needs. The display loads from disk in Chromium 146, which runs safari15/chrome111-lowered JS and keeps extra -webkit- prefixes harmlessly. A grep of src/renderer finds no syntax (top-level await, class static blocks, regex v-flag) that can't be lowered to that target.

**Simpler shape.** As proposed: in the renderer config, set `build.target` and `cssTarget` to REMOCON_TARGET and `rolldownOptions.input: PAGES` in every mode. Delete remoconBuild, the `vite` build import and the serve/build input switch. Optionally add a unit or e2e assertion that the built remocon CSS contains -webkit-user-select, so the next target change can't silently undo review finding #18.

**Saves.** About 45 lines and one Vite build per `build-prod`/`build-dev`. Removes a plugin, a nested config that has to mirror the outer one (minify/sourcemap/base/plugins), and the dev-vs-build input difference.

**Risk.** Low. The display's JS gets slightly larger from lowering and its CSS gains prefixes. Shared chunks between the two pages come back, which is how Parcel and the first electron-vite config shipped. Check the remocon CSS still has -webkit-user-select and that e2e passes.

**Verifier.** I tested the proposed shape in a scratch build (plain vite 8.3.5, root src, both pages as inputs, target and cssTarget set to REMOCON_TARGET, the kuromoji alias, minify). It builds cleanly with no lowering errors, and the remote's CSS came out with the same hash as today's build/prod (remocon-Cv3Y1_Mh.css), so all 6 `-webkit-user-select:none` are still there. The remote's JS is 115 kB plus a 253 kB shared chunk, 367 kB in total, the same as the nested build's 367 kB. The display changes very little: CSS 16.3→16.7 kB, worklet 10.8→11.8 kB. color-mix(var()) and @container pass through untouched. The nested build also has a real cost the reviewer didn't mention. In dev the remote is served by the renderer config, but in prod it is built by a separate config that doesn't inherit the renderer's plugins, aliases or defines, so the two can quietly drift apart. What the current shape buys is that display-only code can use Chromium-146-only syntax or CSS that can't be lowered for Safari 15. Today nothing does. Note that my check used plain vite, not electron-vite's renderer defaults; still confirm with `yarn build-prod` and e2e.

## oe-build-tests-4

**Migration-era GraphQL guard still wraps every e2e test** (over-engineering, KEEP, medium) · `tests/e2e/fixtures.ts:158`

**Now.** `forbidGraphql` routes and aborts /graphql over HTTP and WebSocket and records attempts. It is wired in through a `graphqlRequests` fixture (asserts empty at teardown), an overridden `context` fixture, a parameter of `launchKarafriends` (applied to the Electron context) and a parameter threaded through live.spec.ts's `openPhone`. There are also comments in api.spec/youtube.spec and a `/graphql answers 404` test: 33 GraphQL lines across tests/e2e.

**Why it's more than needed.** It was added in 18758ac as a strangler-migration safety net, 30 minutes before the GraphQL server was removed (108f55f). The Apollo/Relay/graphql packages are gone too (eb5acc5). Nothing in src/ can issue a /graphql request: the only remaining mentions are comments and the legacy queue.json reader. Playwright documents that enabling `context.route` disables the HTTP cache, so every remote page in every test now loads uncached, unlike a real phone. Separately, the IPC-only check (`isApiRequest`) guards a live rule and should stay.

**Simpler shape.** Delete GRAPHQL_URL, forbidGraphql, the graphqlRequests fixture, the `context` override, the graphqlRequests parameter in launchKarafriends and openPhone, and the GraphQL comments in fixtures.ts header, youtube.spec and api.spec. Keep the isApiRequest IPC-only check. Keeping the cheap '/graphql answers 404' server test is reasonable, since phones may still have an old remote cached.

**Saves.** About 45 lines, one fixture and one fixture override. One fewer concept per test, and a route handler less on every context.

**Risk.** Very low. The only thing lost is a guard against reintroducing a protocol whose server, client and packages no longer exist.

**Verifier.** The history matches: 18758ac added the guard 29 minutes before 108f55f removed the server, and eb5acc5 removed the packages. src/ has no GraphQL client left, only comments and the legacy queue.json reader. PLAN-hard-fork 5e has no step that wants the guard kept. Removing it takes out the graphqlRequests fixture, the `context` override, a parameter threaded through launchKarafriends and live.spec's openPhone, and the comments. One argument is overstated: the HTTP-cache point. Every test gets a fresh context with a cold cache anyway, and many specs already call page.route or remote.route (remote.spec, downloadFailure, screenshots), so removing this won't make the tests behave like a real phone's cache. The case rests on removing a dead concept, not on caching.

## oe-build-tests-2

**Platform jobs copied out by hand instead of a matrix, in both build.yaml and release.yaml** (over-engineering, WEAK, low) · `.github/workflows/release.yaml:30`

**Now.** release.yaml has 4 near-identical jobs (151 lines). The 20-line macOS keychain/signing script is pasted verbatim into both mac jobs (l.30 and l.75), which differ only in `target` and `PACKAGER_ARCH`. build.yaml has 4 jobs (186 lines) that repeat checkout/toolchain/rust-cache/setup-node/install/test:unit/build blocks.

**Why it's more than needed.** The copies have already drifted: the mac build jobs have `npm install -g yarn` and the others don't. Every action bump or toolchain change has to be made 8 times. PLAN-hard-fork.md says upstream syncing stopped ("none of this has to stay merge-friendly"), so there's no upstream-diff reason to keep the shape. There has never been a matrix (`git log -S matrix` finds only codeql.yml).

**Simpler shape.** If anything, only release.yaml becomes a 4-entry matrix {os, target, arch, zip}, with `if: runner.os == 'macOS'` on signing and `if: runner.os == 'Linux'` on apt-get. Confirm it with a workflow_dispatch dry run. Leave build.yaml as explicit jobs, or at most move the Linux-only lint/format/typecheck into its own small job.

**Saves.** About 80 lines in release.yaml and about 80 in build.yaml. The signing script lives in one place, and each version bump is one edit per workflow instead of four.

**Risk.** Low to medium. `if:` conditions are easy to get wrong, and a release-only workflow is checked only by a real release or a workflow_dispatch dry run. Do the release matrix and confirm all 4 zips with workflow_dispatch.

**Verifier.** This is hand-copied duplication, which is the opposite of over-engineering. The proposed fix adds machinery: a matrix plus `if:` conditions. For release.yaml a matrix fits well. The two mac jobs differ only in target, PACKAGER_ARCH and zip name, so the 20-line signing script could live in one place, saving about 60–70 lines. build.yaml is a poor fit. Its jobs differ in apt-get (Linux), actions/cache for ASIO (Windows), prettier/lint/typecheck and careful (Linux), e2e and report upload (Windows/Linux), build-dev versus build-prod, and Xvfb. One matrix job would need six or more `if:` conditions and would read worse than four explicit jobs. The drift example (`npm install -g yarn`) goes away under finding 1. The '8 edits per bump' cost is real but rare in this repo.

## oe-architecture-8

**Migration-era leftovers from GraphQL and the old tunnel** (over-engineering, KEEP, low) · `src/main/httpServer.ts:55`

**Now.** (a) An 'upgrade' listener (refuseUpgrade) answers WebSocket upgrades with 400 'as graphql-ws did'. It introduced review finding #1, a High-severity crash, which a second fix then patched. (b) Every e2e test carries a graphqlRequests fixture plus forbidGraphql, which routes and aborts /graphql over HTTP and WebSocket, and api.spec has a '/graphql answers 404' test. (c) The README has a paragraph on deleting old **generated** folders. (d) queue.json parsing still reads `__typename` and `userIdentity` items (KIND_BY_TYPENAME), `isRomaji`, and adhoc lyrics keyed by video ID. (e) src/common/hash.ts (cyrb53) has no callers. (f) server.ts comments and an X-Accel-Buffering header cite a Cloudflare tunnel that phase E removed.

**Why it's more than needed.** I checked on Node 24: with no 'upgrade' listener, Node hands an upgrade request to the normal request handler, which answered 'normal handler: websocket', and the process survived a client reset. Express then answers it like any GET, so (a) adds nothing. The GraphQL guard tests a migration that finished on 2026-10-27, and no code can reintroduce /graphql by accident.

**Simpler shape.** Delete refuseUpgrade and its listener, and its unit test. Keep or keep the e2e test that an upgrade followed by a reset doesn't crash the app. Delete forbidGraphql, the graphqlRequests fixture (fixtures.ts and live.spec.ts), the /graphql 404 test, the README **generated** paragraph and src/common/hash.ts. In parseState, drop KIND_BY_TYPENAME/userIdentity and the video-ID lyrics reader (with a CHANGELOG line) but keep the isRomaji reader through at least 0.2.0. Reword the Cloudflare comments to 'a proxy on this machine (the dev server)'.

**Saves.** About 100 lines across 6 files, one fixture threaded through every e2e test, and a handler that once crashed the app.

**Risk.** A queue.json saved by an upstream (pre-0.1.0) build would lose items it can no longer read (they are logged and dropped, not fatal). No other behaviour changes.

**Verifier.** (a) is confirmed. The listener came in 54832da because Parcel's dev proxy logged a failure for each phone's HMR socket. Parcel is gone, and in dev phones load from the Vite server, not port 8080. I checked on Node 24: with no 'upgrade' listener the request reached the normal handler, and the process survived 5 client resets. Node has done this since v10, and Electron 43 is newer. (b), (c), (e): forbidGraphql guards a migration with no graphql, relay or apollo package left in package.json. The README note is for stale checkouts. hash.ts has had no callers since 1d7f000/f3f9131. (d) is partly wrong: the isRomaji reader must stay. The lyrics modes came in the 0.2.0 round (cf80c90, after the 0.2.0 bump in d4128c6), so a queue.json from 0.1.0, the fork's own released zips, still has isRomaji, and 0.2.0 is unreleased. The __typename/userIdentity and video-ID readers only serve upstream files, since 0.1.0 already wrote kind/user (38d24d2). Dropping them also drops upstream-era history entries, and 0.1.0's CHANGELOG promised that older queues still load, so say so in the CHANGELOG. (f): keep the loopback exemption and its reason in the STREAM_LIMITS and rate-limit comments (the dev server still proxies); only the Cloudflare wording should go. X-Accel-Buffering is one harmless line, and removing it is optional.

## oe-build-tests-5

**Copies of the same e2e/unit helpers (SSE first event, POST /api, fixture-bin path, media-tool names)** (over-engineering, WEAK, low) · `tests/e2e/api.spec.ts:37`

**Now.** Five 18-line copies of the 'read the first `data:` line of /api/events' reader: api.spec.ts:37 `liveState`, remote.spec.ts:1676 `liveState`, player.spec.ts:26 `liveState`, settings.spec.ts:31 `phoneLiveState`, live.spec.ts:72 `firstEvent`. Six inline 'POST api/<method> as JSON with identity headers' wrappers: api.spec.ts:21, player.spec.ts:47, settings.spec.ts:538/1170/1320, downloadFailure.spec.ts:175. Five 'tests/fixtures/bin/<name>[.cmd]' path builders: player.spec.ts:12, downloadFailure.spec.ts:20, jobs.test.ts:26, run.test.ts:~70, externalResourcesPlan.test.ts:101. fixtures.ts:196 `MEDIA_TOOL_FILES` hand-copies `resourcePathsFor()` ("Mirrors resourcePathsFor() in src/common/externalResourcesPlan.ts").

**Why it's more than needed.** The same logic is written by hand 5–6 times, differing only in `.state` vs whole event and in the header values. Every change to the SSE framing or the identity headers has to be made in each copy. fixtures.ts already imports from src/common (adminPassword), and externalResourcesPlan.ts is dependency-free, so the mirror isn't needed to avoid an import.

**Simpler shape.** Export one `firstLiveEvent(remoconUrl, deviceId?)` from fixtures.ts that returns the raw `data:` string. Callers JSON.parse it or take `.state`, and api.spec keeps its content-type assertion. Replace MEDIA_TOOL_FILES with resourcePathsFor(process.platform, dest). Optionally add one `apiCall` helper for the three real identity-header wrappers. Leave the raw 403 probes and the unit tests' tool paths as they are.

**Saves.** About 120 lines across 8 files, and one place to change when the SSE or identity-header format changes.

**Risk.** Low. These are mechanical replacements. api.spec's copy also asserts the content-type, so keep that as an option or a separate assertion.

**Verifier.** This is copy-paste duplication, not over-engineering, and parts of it are overcounted. The five SSE 'first data: line' readers are real copies of about 18 lines each, differing in `.state`, the deviceId param, the content-type assertion, and raw text in live.spec. Consolidating them saves about 70 lines and is the part worth doing. MEDIA_TOOL_FILES can import resourcePathsFor (externalResourcesPlan.ts imports only path and a type), though prepareMediaTools then needs path.dirname/basename. The rest is overcounted. externalResourcesPlan.test.ts:101 isn't a fake-tool builder: it deliberately passes a relative literal to test that toolOverrides resolves it to an absolute path. run.test.ts has a single inline use. downloadFailure:175 and settings.spec:1170/1320 are deliberately raw, header-less 403 probes, not identity-header wrappers. A shared tests/ helper imported from src/**/*.test.ts would also cross the src→tests boundary for about 2 call sites. Realistic saving is about 80 lines, not 120.

## oe-build-tests-8

**CodeQL workflow is GitHub's multi-language template running one language** (over-engineering, KEEP, low) · `.github/workflows/codeql.yml:44`

**Now.** A `strategy.matrix.include` with a single entry (javascript-typescript, build-mode none). A runs-on expression that picks macOS for 'swift'. A 'manual build mode' placeholder step that echoes template instructions and `exit 1`. About 60 lines of template comments. 94 lines in total.

**Why it's more than needed.** The matrix has one entry since Python was dropped (cd0f5f7). There is no Swift, and build-mode is never 'manual', so the runner expression and the placeholder step can't take their other branches.

**Simpler shape.** A single job: ubuntu-latest, the same permissions, checkout, codeql-action/init with `languages: javascript-typescript`, then analyze with `category: "/language:javascript-typescript"`, unchanged, so existing code-scanning alerts carry over. Keep the job's check name too if branch protection requires 'Analyze (javascript-typescript)'. Switching to default setup also works.

**Saves.** About 70 lines, and the matrix/conditional noise that suggests more languages than there are.

**Risk.** None to behaviour.

**Verifier.** Accurate. The matrix has one entry since cd0f5f7, the swift runner expression and the 'manual' placeholder step can never take their other branch, and about 60 lines are template comments. The cleanup changes no behaviour, provided the analysis category stays the same.
