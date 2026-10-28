# Windows checks after the review fix round

A brief for a Claude Code session on the Windows PC. The fix round of 2026-10-28 ([`PLAN-review-fixes.md`](PLAN-review-fixes.md)) was built and tested on a Linux laptop. Everything Windows-only was compiled for Windows (`cargo clippy --target x86_64-pc-windows-msvc`) but never run: WASAPI exclusive mode, ASIO, the Windows console, Update tools while a tool runs, and the Windows e2e suite. This brief runs the automated checks first, then walks the host through the manual ones, and ends with a report.

Give this to Claude with: "Run `notes/WINDOWS-CHECKS.md`, and ask me before each manual check that needs my hands." Read the whole file before starting.

## Rules for this session

- Build and test; don't fix. Report each failure with its exact error, the step it came from, and the finding id it belongs to if the plan names one. A one-line fix that makes a later step possible (a path, a missing import) is fine as a separate commit, named in the report. Anything else goes in the report for the Linux session to fix.
- Nothing on the machine is sacred except `%APPDATA%\karafriends\config.yaml`, which holds the DAM and Joysound logins: never print it, copy it or write to it.
- The packaged app opens a fullscreen display window and plays sound when a song is queued. Run the automated checks hidden (`KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1`), and run the manual checks only when the host says the TV and speakers are ready.
- The host is in the US; DAM and Joysound only work with the Japan VPN on. Say so before any step that needs them, and check with `curl -s https://ipinfo.io/country`.
- The Claude desktop app on this PC may be the Microsoft Store build: global installs it makes land in a private folder, and terminal tabs keep the PATH from launch (see [`HANDOFF.md`](HANDOFF.md), Gotchas). If `yarn`, `cargo` or `node` is missing from your shell, ask the host to install it in their own terminal and restart the app.

## 1. Get the code

The round was merged into `master` locally on the Linux laptop and pushed afterwards. Make sure the push happened: `git fetch origin && git log --oneline -3 origin/master` should show "Merge R" or a close-out commit from 2026-10-28 or later. If it doesn't, stop and tell the host; nothing below is meaningful on older code.

```powershell
git checkout master
git pull --ff-only
rustup update stable          # 1.88 or newer
yarn install
yarn get-external-resources   # downloads the ASIO SDK into buildResources/asio and 7za
```

Dependencies the README's Building section lists: Node, any `yarn`, Rust, Visual Studio Build Tools (Desktop development with C++), and LLVM (`winget install LLVM.LLVM`; set `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin` if cargo can't find libclang).

## 2. Automated checks

Run each and record its last lines. Expected results are in brackets.

1. `cargo fmt --manifest-path native/Cargo.toml --all --check` [clean]
2. `cargo clippy --manifest-path native/Cargo.toml --all-targets` [no warnings; this is the first time the ASIO code (`#[cfg(all(windows, feature = "asio"))]`) is compiled since phase F rewrote device lookup, so a compile error here is the most likely finding of the whole session]
3. `cargo test --manifest-path native/Cargo.toml` [about 60 tests pass; the `exclusive.rs` and shared-stream tests run only on Windows, so this is their first run anywhere]
4. `yarn typecheck` [clean]
5. `yarn lint` [clean]
6. `yarn test:unit` [about 634 pass; `src/preload/native.test.ts` needs a built `native/index.node`, so run it after step 7 if it skips]
7. `yarn build-prod` [builds; this also builds `native/index.node` with ASIO and bundles the app into `build/prod`]
8. `yarn test:e2e:install` once, then `yarn test:e2e:ci` [about 123 pass, 20 skipped (the screenshot specs); every test now fails on an unexpected display console error, so note any that fail or flake, with their names and the error]
9. `yarn package-prod` [`dist/karafriends-win32-x64.zip`, which unzips to `karafriends-win32-x64/`; note its size. `packager.js` now exits non-zero if the zip step fails]
10. Unzip the package somewhere else and launch `karafriends.exe` from there with `KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1` set and a throwaway profile (`--user-data-dir=<temp folder>`); wait 20 s and close it [it logs "Server is now running on http://localhost:8080" and nothing that looks like an error; on first launch it downloads yt-dlp and ffmpeg into that profile and runs each with `-version` before keeping it]

## 3. Manual checks

Ask the host to set up before each group, do the steps, and record what they see. Each line names the phase that made the change.

### The console (O)

- Launch the packaged `karafriends.exe` by double-clicking it: a console window titled "karafriends native console" opens beside the display. Launch it from a terminal instead: no error about the console in the output.

### Exclusive mode (F)

Needs a 2-input USB audio interface (or two mics on one device). In Windows Sound settings, each mic's Properties › Advanced must allow exclusive control.

- Settings › Sound: Mic mode Exclusive. Microphones: Mic 1 on channel 1, Mic 2 on channel 2 of the interface. Both rows open, both meters move when spoken into, both "In use" lines say Exclusive. Before this round the second one failed as "Another program is using this mic".
- Restart the app: both still open.
- Change Mic buffer: both come back within a few seconds.
- Switch Mic mode to Shared: both work within 2 s.
- Each "In use" line shows "Packets lost: N" only if Windows dropped packets; a refused real-time priority says "Not real-time: MMCSS refused it".

### ASIO (F)

Needs an interface with a 64-bit ASIO driver.

- Mic output = the ASIO interface, Buffer 64; the mics = that interface's inputs. "In use" under the output and under each mic shows 64. Change Buffer to 128: the output and, once they reopen, the mics show 128. Before this round the mics' default buffer overrode the choice.
- With that setup, switch Mic output to the Windows speakers at 48 kHz: the interface's outputs go silent (no buzz, which they had before), and the mics play on the speakers within 2 s.
- Unplug and replug the interface, or change its sample rate in its own control panel: both mics come back within a few seconds.

### Devices that come and go (F, H, O)

- Unplug a USB mic mid-song, plug it back in: its row says why it's down, then it returns by itself. Before this round a replugged mic could stay dead until restart.
- Song output = the TV over HDMI. Mid-song, put the TV on standby or switch its input: the video and lyrics keep moving with no sound, and Settings › Sound says the TV went away and the songs play silently until it's back. Turn the TV back on: the sound returns on the TV within a few seconds, mid-song. Before this round the song froze until relaunch.
- Launch with the TV off and its output saved: the songs play on the default output; turn the TV on: they move to it without opening Settings.
- Mic output = the TV (not the system default). TV on standby mid-song: the mics fall back to the default output with a note under Mic output. TV back on: within about 10 s the mics move back and the note clears.
- Each mic's "In use" line (format, rate, buffer) reads the same as before this round for the same device, shared and exclusive.

### Tools (B)

- Queue a YouTube song and, while its download runs (ffmpeg.exe or yt-dlp.exe busy), press Settings › Advanced › Update tools: it answers ok instead of EPERM. After the next launch, no `ffmpeg.exe.<n>.old` file is left in `%APPDATA%\karafriends\externalResources\ffmpeg\`.

### Party basics (A, G, I, K)

- Leave the app idle with an empty queue for 15 minutes with the display's timeout shorter than that: the TV stays on, the QR code stays up, Windows doesn't lock or sleep.
- Scan the QR code with an Android phone: `karafriends.local:8080` opens, with the Japan VPN off and on. An iPhone too.
- Queue a bass-heavy song. Key +1 and +2: the bass moves with the chords (before, nothing under about 200 Hz moved). Key −5: no hiss. Tap 0 → +1 → 0 mid-song: no gap or click. Key 0 and a shifted key sound about as loud.
- Two mics on a DAM song: each singer's trace draws in its own pale colour and follows the bars; a key change mid-song keeps the trace on screen and lined up.
- Let the queue run out: no lyrics or pitch bars linger behind the idle screen.

### With the Japan VPN and the real logins (D, K)

- DAM and Joysound log in, search, download and play; DAM scoring loads.
- Temporarily set a wrong Joysound password: a queued Joysound song fails within seconds (not 17 minutes), and a search shows "Couldn't search Joysound: … rejected" with Retry. Put the password back.
- While a DAM song streams (the first after idle), turn the VPN off and on: the song buffers and carries on rather than being skipped.

## 4. Report

Write the report to `notes/WINDOWS-CHECKS-REPORT.md` and commit it (author `Brandon S <atomicbcs@gmail.com>`). It has three parts:

1. **Automated checks:** a table of the ten steps with pass/fail and the last lines of any failure.
2. **Manual checks:** each line above with pass, fail or not tried, and what the host saw when it differs from the expected result.
3. **Fixes needed:** one entry per failure with the file and the finding id (from `PLAN-review-fixes.md`'s `review-fixes/` files) if it maps to one, so the Linux session can take them as a follow-up round.

Also tick the Windows lines in `PLAN-review-fixes.md`'s "Checks for you on real hardware" that passed.
