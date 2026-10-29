# macOS checks after the review fix round

A brief for a Claude Code session on a Mac, Apple Silicon by preference. The fix round of 2026-10-28 ([`PLAN-review-fixes.md`](PLAN-review-fixes.md)) and the dependency upgrade after it were built and tested on a Linux laptop. Everything macOS-only was compiled for macOS (`cargo clippy --target aarch64-apple-darwin`) but never run: the CoreAudio device code, the smaller mic buffer, the neon export registration, the arm64 ffmpeg download. CI builds on macOS but doesn't run the e2e suite there, so this is also its first run on a Mac. This brief runs the automated checks first, then walks the host through the manual ones, and ends with a report.

Give this to Claude with: "Run `notes/MACOS-CHECKS.md`, and ask me before each manual check that needs my hands." Read the whole file before starting.

## Rules for this session

- Build and test; don't fix. Report each failure with its exact error, the step it came from, and the finding id it belongs to if the plan names one. A one-line fix that makes a later step possible is fine as a separate commit, named in the report. Anything else goes in the report for the Linux session.
- Never print, copy or write `~/Library/Application Support/karafriends/config.yaml`: it holds the DAM and Joysound logins.
- The app opens a fullscreen display and plays sound when a song is queued. Run the automated checks hidden (`KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1`) with a throwaway profile (`--user-data-dir`), and run the manual checks only when the host says the TV and speakers are ready. A Mac's speakers feed its own mic: mute the output or use headphones for mic checks.
- The host is in the US; DAM and Joysound only work with the Japan VPN on. Say so before any step that needs them (`curl -s https://ipinfo.io/country`).
- macOS asks once for microphone access and, for an unsigned build, may refuse to open the packaged app (Gatekeeper). Ask the host to allow both; note it if the prompts don't appear where expected.

## 1. Get the code

```sh
git clone git@github.com:HyperBCS/karafriends.git && cd karafriends   # or git pull --ff-only on master
git log --oneline -1   # 2026-10-28 or later, after "Merge R"
xcode-select --install  # if there's no C toolchain yet
brew install node rustup   # or any Node 24 and rustup; then: rustup default stable (1.88 or newer)
npm install -g yarn
yarn install
```

No LLVM is needed on macOS (ASIO and PipeWire are Windows and Linux features; cpal uses CoreAudio). An Intel Mac can run everything below too; it just makes the `darwin-x64` build instead.

## 2. Automated checks

Run each and record its last lines. Expected results are in brackets.

1. `cargo fmt --manifest-path native/Cargo.toml --all --check` [clean]
2. `cargo clippy --manifest-path native/Cargo.toml --all-targets` [no warnings; first real compile of the macOS code paths with default features]
3. `cargo test --manifest-path native/Cargo.toml` [about 60 tests pass, device-free; the host's mics aren't opened]
4. `yarn typecheck` [clean; the project's TypeScript is 7, which needs nothing installed for the command]
5. `yarn lint` [clean]
6. `yarn build-prod` [builds; on Apple Silicon this builds `native/index.node` for arm64]
7. `yarn test:unit` [about 635 pass; `src/preload/native.test.ts` checks the built module's exports, so run after step 6]
8. `yarn test:e2e:install` once, then `yarn test:e2e:ci` [about 123 pass, 20 skipped (screenshot specs); this suite has never run on macOS. Every test fails on an unexpected display console error, so list any failure with its name and the error. Playwright's WebKit is installed too: `KARAFRIENDS_E2E_WEBKIT=1 yarn test:e2e tests/e2e/remote.spec.ts` runs the phone tests in Safari's engine, which is what iPhones use]
9. `PACKAGER_ARCH=arm64 yarn package-prod` (Intel Mac: `PACKAGER_ARCH=x64`) [prints "NOTARIZATION_KEY_PATH isn't set: the app is left unsigned" and makes `dist/karafriends-darwin-arm64.zip`, which unzips to `karafriends-darwin-arm64/`]
10. Launch the packaged app hidden with a throwaway profile: `KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1 dist/karafriends-darwin-arm64/karafriends.app/Contents/MacOS/karafriends --user-data-dir=$(mktemp -d)`; wait 30 s and stop it [it logs "Server is now running on http://localhost:8080" and no error. On first launch it downloads yt-dlp and ffmpeg into that profile and runs each with `-version` before keeping it; `file <profile>/externalResources/ffmpeg/ffmpeg` says `arm64` on Apple Silicon (before this round it was an Intel-only binary)]

## 3. Manual checks

Ask the host to set up before each group, do the steps, and record what they see. Each line names the phase that made the change.

### Launch and tools (O, B, A)

- Open the packaged `karafriends.app` by double-clicking: it starts (Gatekeeper may ask once), the display shows the QR code, and Settings › Sound lists the Mac's mics. Before this round the native exports were registered by hand; now neon registers them, and this is the first run of that on macOS.
- Settings › Advanced › Tools shows ffmpeg 9.x and a yt-dlp version. With the Japan VPN off, queue a YouTube song: it downloads and plays (needs the arm64 ffmpeg; with Rosetta not installed, the old build failed here).
- Start the app again while it runs: the running display comes to the front, no second copy opens.
- Leave the queue empty for 15 minutes with the display's sleep timer shorter than that: the screen stays on and the Mac doesn't lock. `pmset -g assertions | grep -i karafriends` lists a display-sleep assertion while it runs.

### Mics (O, F, H)

- Plug in a USB mic and add it in Settings › Microphones: its row opens, the meter moves, and "In use" says 128 samples (or the device's minimum if that is larger) at the device's rate. Before this round macOS mics opened at the device's smallest buffer. The built-in mic the same.
- Unplug the USB mic mid-song and plug it back in: its row says why it's down, then it comes back by itself within a few seconds. Before this round a replugged mic could stay dead until restart (CoreAudio gives it a new id).
- Mic output = a different output than the system default (headphones, or the TV). Unplug or turn it off mid-song: the mics fall back to the default with a note under Mic output; plug it back in: within about 10 s the mics move back and the note clears.
- A mic that's busy (another app holding it exclusively, if the host has one) shows why under its row and opens by itself once free.

### Song output over HDMI (H)

- Song output = the TV. Mid-song, put the TV on standby or switch its input: the video and lyrics keep moving with no sound, and Settings › Sound says the TV went away and the songs play silently until it's back. Turn the TV back on: the sound returns on the TV within a few seconds.
- Launch with the TV off and its output saved: the songs play on the default output; turn the TV on: they move to it without opening Settings.

### Party basics (A, G, I, J, K)

- Scan the QR code with an iPhone and an Android phone: `karafriends.local:8080` opens on both, with the Japan VPN off and on.
- Queue a bass-heavy song. Key +1 and +2: the bass moves with the chords (before, nothing under about 200 Hz moved). Key −5: no hiss. Tap 0 → +1 → 0 mid-song: no gap or click. Key 0 and a shifted key sound about as loud.
- Two mics on a DAM song: each singer's trace draws in its own pale colour and follows the bars; a key change mid-song keeps the trace on screen and lined up.
- Ten Joysound songs in a row (needs the VPN), skipping a few early, on the biggest display available: Activity Monitor's GPU memory for the app stays flat rather than climbing by hundreds of MB per song, and each song's lyrics appear without a stall.
- Let the queue run out: no lyrics or pitch bars linger behind the idle screen.

### On an iPhone (M, N)

- Search 恋, scroll far down, tap a row, then Back: the list lands where you were. Open Settings from a scrolled list: it opens at the top.
- The source button on the search screen opens the iOS wheel (All, DAM, Joysound); picking DAM shows "DAM" on the button and the page doesn't zoom. A long title in the results slides and rests at each end.

### With the Japan VPN and the real logins (D, K)

- DAM and Joysound log in, search, download and play; DAM scoring loads.
- Temporarily set a wrong Joysound password: a queued Joysound song fails within seconds (not 17 minutes), and a search shows "Couldn't search Joysound: … rejected" with Retry. Put the password back.
- While a DAM song streams (the first after idle), turn the VPN off and on: the song buffers and carries on rather than being skipped.

## 4. Report

Write the report to `notes/MACOS-CHECKS-REPORT.md` and commit it (author `Brandon S <atomicbcs@gmail.com>`). Three parts:

1. **Automated checks:** a table of the ten steps with pass/fail and the last lines of any failure; for step 8, the pass/skip/fail counts and the names of failing tests.
2. **Manual checks:** each line above with pass, fail or not tried, and what the host saw when it differs from the expected result.
3. **Fixes needed:** one entry per failure with the file and the finding id (from `PLAN-review-fixes.md`'s `review-fixes/` files) if it maps to one, so the Linux session can take them as a follow-up round.

Also tick the macOS lines in `PLAN-review-fixes.md`'s "Checks for you on real hardware" that passed.
