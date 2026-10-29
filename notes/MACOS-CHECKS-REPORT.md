# macOS checks: report

The run of [`MACOS-CHECKS.md`](MACOS-CHECKS.md) on 2026-10-28, on an Apple Silicon MacBook Pro (macOS 26.6, Rosetta installed), with the built-in mic and speakers. No USB mic, TV or phones were at hand. Toolchain: Node 26.13, Rust 1.99.1, Yarn 4.18.1. The host asked for fixes to be made in this session rather than left for the Linux one, so they're on the branch `macos-checks`, one commit each (listed under Fixes).

## 1. Automated checks

| Step                                        | Result                                    | Notes                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `cargo fmt --check`                      | pass                                      |                                                                                                                                                                                                                                                                                                                                                 |
| 2. `cargo clippy --all-targets`             | pass                                      | No warnings.                                                                                                                                                                                                                                                                                                                                    |
| 3. `cargo test`                             | pass                                      | 49 passed. The brief's "about 60" counts the Linux-only tests (`linux.rs`, 11) and Windows-only ones, which don't build on macOS.                                                                                                                                                                                                               |
| 4. `yarn typecheck`                         | pass                                      |                                                                                                                                                                                                                                                                                                                                                 |
| 5. `yarn lint`                              | pass                                      |                                                                                                                                                                                                                                                                                                                                                 |
| 6. `yarn build-prod`                        | pass                                      | `native/index.node` is arm64.                                                                                                                                                                                                                                                                                                                   |
| 7. `yarn test:unit`                         | pass                                      | 635 passed (636 with the new certificate test).                                                                                                                                                                                                                                                                                                 |
| 8. `yarn test:e2e:ci`                       | fail, then pass after `dbe4eb5`           | First run: 121 failed, 1 passed, 20 skipped, 1 didn't run. Every test failed at the fixture's isolation check: `The app isn't isolated and muted: {"userData":"…/user-data","temp":"/var/folders/…/T/","muted":true}`. Chromium on macOS ignores `TMPDIR` and reads `MAC_CHROMIUM_TMPDIR`. After the fix: **123 passed, 20 skipped, 0 failed.** |
| 8b. WebKit (`remote.spec.ts`)               | 1 failure, then pass after `e36bc31`      | `the now-playing bar › is the only place the current song shows, and a toggle anywhere but its link`: `expect(toggle).toBeFocused()` got "inactive" after `Tab` from the link. WebKit on macOS tabs to form fields only, as Safari does by default. With Option-Tab there: 97 + 1 passed, 2 skipped.                                            |
| 9. `PACKAGER_ARCH=arm64 yarn package-prod`  | pass (with `NOTARIZATION_KEY_PATH` unset) | The host's shell exports `NOTARIZATION_KEY_PATH` pointing at a `.p8` that isn't there, so the first run signed and then failed in notarytool ("The file couldn't be opened because it doesn't exist"). With it unset: "NOTARIZATION_KEY_PATH isn't set: the app is left unsigned", `dist/karafriends-darwin-arm64.zip`. Not a code bug.         |
| 10. Packaged app, hidden, throwaway profile | pass                                      | "Server is now running on http://localhost:8080", no error. ffmpeg 9.0.2 (martin-riedl.de) downloaded as `Mach-O 64-bit executable arm64`; yt-dlp 2026.10.26 is universal.                                                                                                                                                                      |

## 2. Manual checks

The host did the launch, built-in mic and VPN groups with the real profile; the app was the packaged build from this branch.

**Launch and tools (O, B, A)**

- Opens, display shows the QR code, Settings › Sound lists the Mac's mics: **pass**. Opened with `open` rather than a double-click: a local unsigned build has no quarantine flag, so Gatekeeper didn't ask.
- Settings › Advanced › Tools shows ffmpeg 9.x and a yt-dlp version: **pass**. A YouTube song downloaded and played (with the VPN on, not off).
- Second launch: the second copy exits 0, one display, no second window: **pass**.
- 15 minutes idle: **not watched for 15 minutes**. `pmset -g assertions` lists `pid …(karafriends): NoDisplaySleepAssertion named: "Electron"` while it runs.

**Mics (O, F, H)**

- Built-in mic: the row opens, the meter moves, "In use" says "System, 44.1 kHz, 128 samples (2.9 ms)"; it sounds clean in headphones, with a song playing too: **pass**. No "mic fell behind" in the log.
- USB mic (a Blue Yeti, the next day): unplugged, its row says why it's down; plugged back in, it comes back by itself: **pass**. The row said `Error: Could not find device: coreaudio:AppleUSBAudioEngine:Blue Microphones:Yeti Stereo Microphone:<serial>:2 (USB)`, the mic's key; it now says "The mic isn't connected", as Windows' exclusive mode does (fix 6). Removing the mic prints one "mic fell behind" line to the console, as its stream stops a moment before it leaves the mixer; nothing is heard.
- Mic output on another device, a busy mic: **not tried** (no TV, no app holding a mic).

**Song output over HDMI (H):** not tried (no TV).

**Party basics (A, G, I, J, K):** not tried (no phones; the key and trace checks weren't asked for this session).

**On an iPhone (M, N):** not tried. The WebKit e2e run above covers the remote in Safari's engine.

**With the Japan VPN and the real logins (D, K)**

- DAM and Joysound log in, search, download and play; DAM scoring loads: **fail, then pass after `bbec812`**. DAM songs played and scored, but only because the display streams them: both DAM downloads failed (`ffmpeg (DAM …) exited with code=251`, `[tls] error:0A000086:SSL routines::certificate verify failed`). After the fix, a DAM song (3:45) downloaded to the end. Joysound: pass.
- Wrong Joysound password: **not tried**.
- VPN off and on mid DAM stream: **not tried**.

**Niconico** (from the plan's macOS line): not queued in the app. Downloading sm9 with the profile's yt-dlp and ffmpeg and the app's arguments works, even without the certificate fix: yt-dlp fetches the HLS segments itself, and ffmpeg only merges local files.

## 3. Fixes

On `macos-checks`, each with its test or measurement:

1. **e2e isolation on macOS** (`dbe4eb5`, `tests/e2e/fixtures.ts`). Sets `MAC_CHROMIUM_TMPDIR` beside `TMPDIR`. Test-only; it was the first e2e run on a Mac.
2. **WebKit on macOS tabs past buttons** (`e36bc31`, `tests/e2e/remote.spec.ts`). Option-Tab there. Test-only.
3. **Pre-commit rustfmt refused let chains** (`772c55e`, `lint-staged.config.mjs`). lint-staged ran plain `rustfmt`, which parses edition 2015, so any commit touching `lib.rs`, `mixer.rs` or `exclusive.rs` failed its hook since the move to edition 2024 (`7c4ece3`). Now `rustfmt --edition 2024`. Not a review finding; it came with the edition move.
4. **DAM downloads fail on macOS: certificate verify failed** (`bbec812`, `src/main/downloads/run.ts`, `src/main/index.ts`). Comes from B (B's switch to martin-riedl.de's signed arm64 ffmpeg). That build links OpenSSL statically with `OPENSSLDIR` at its build machine's `/Volumes/ffmpeg_arm64/tool/openssl`, and FFmpeg 9 verifies TLS, so no HTTPS input opens. The app now sets `SSL_CERT_FILE=/etc/ssl/cert.pem` at launch on macOS unless it's set, which ffmpeg and the ffmpeg yt-dlp starts inherit (Node and Chromium don't read it). Unit test in `run.test.ts`. Worth checking on Linux: BtbN's static ffmpeg there might have the same problem; DAM downloads on Linux would show it.
5. **Lower mic delay on macOS** (`1e27385`, `native/karafriends-lib/src/{lib,mixer}.rs`; the host asked for it). The mic output opened at the device's own buffer (512 frames on a Mac's speakers), and each mic's buffer keeps one output read ahead, so that size counted twice. The output now asks for the mics' `MIC_BUFFER` (128) within the device's range, through one `mic_buffer_size` shared with the mic config. Settings' "In use" under Mic output now says 128 samples. Measured with the new example `native/karafriends-lib/examples/mic_latency.rs` (`8171553`), which plays a noise burst through the speakers and finds it again where the mic output plays it back:

   | Mic and mic output buffer | Mic to speaker (8 trials each) | Underruns  |
   | ------------------------- | ------------------------------ | ---------- |
   | 128 / 512 (before)        | 77.6 ms, every trial           | none       |
   | 128 / 128 (now)           | 60.5 ms (60.4 to 60.5)         | none       |
   | 64 / 64 (tried, not kept) | 56.8 ms, every trial           | one refill |

   Those are the MacBook Pro's own mic and speakers. The next day, a Blue Yeti (USB) into the same speakers, at 128 / 128: **32.6 ms** (8 of 8 trials within 1 ms, 32.3 to 33.4; the Yeti's clock drifts against the speakers'). The example takes a mic's name for that (`… --example mic_latency Yeti`), averages the trials, and plays the echo at gain 2, since a mic farther from the speakers hears much less of it.

   What's left is mostly the devices' own processing. The Yeti's 32.6 ms is about its 6.0 ms (buffer, latency, safety offset) + the mic's buffer's 7 + the speakers' 6.1 + their stream latency, 639 frames (14.5 ms). The built-in mic adds about 28 ms more of its own processing (CoreAudio says 2210 frames, 50 ms, which overstates it). A wired mic output (the Yeti's headphone jack, the TV) has no such stream latency, so a USB mic through one should be under 20 ms; not measured. The mic output's Fixed buffer has no fallback to the device's own if a device refuses it, the same as the mics have had; worth a check with Bluetooth or AirPlay as the mic output.

6. **An unplugged mic's row showed its key** (`native/karafriends-lib/src/lib.rs`, `find_input`). "Could not find device: coreaudio:AppleUSBAudioEngine:…:2 (USB)" is now "The mic isn't connected": the row already names the mic. Only the text changed; the new wording hasn't been seen with a mic unplugged yet.

Not fixed, for the host: the shell's `NOTARIZATION_KEY_PATH` points at a missing key, so `yarn package-prod` fails until it's unset or the key is put back.

Still to do on a Mac: the busy mic and the mic output going away (F), the TV checks (H), the phones (A, M, N), the key, trace and GPU-memory checks (G, I, J), the wrong Joysound password and the VPN drop (D, K), and the 15-minute idle (A).
