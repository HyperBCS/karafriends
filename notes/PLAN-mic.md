# Plan: mic round (after the polish round)

The polish round ([`PLAN-polish.md`](PLAN-polish.md)) is landing. The user then listed eight more things, below, most about the microphones. Same way of working as before: Fable coordinates, every build, fix and review subagent runs on Opus (`model: opus`) in its own worktree, the coordinator reviews, re-runs checks, merges into master and pushes without asking; the "Keep it simple" rule and the design brief from `PLAN-product.md` bind every phase. This round starts once the polish round's P4 fixes are merged.

**This computer has no mic or ASIO interface worth testing on, and no `libclang` for the ASIO build.** The native work is written to be right by construction (cargo tests on the callbacks, clippy, careful reading) and the user tests it on the other machine (the "Final" section). Nothing in this round may play sound on this computer.

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                                         | State                            | Branch / commit                    | Notes |
| ------------------------------------------------------------ | -------------------------------- | ---------------------------------- | ----- |
| N1: native: one output, device choice, gain/echo, no cutout  | not started                      |                                    |       |
| S1: server: song volume, mic list and levels over the API    | done in worktree, awaiting merge | `worktree-agent-ad50ee1e2486e954c` |       |
| R1: remote: Home rightmost, song volume and mic sliders      | not started                      |                                    |       |
| D1: display: QR always, mic rows, output device, song volume | not started                      |                                    |       |
| N2: review and fixes                                         | not started                      |                                    |       |
| Final: mic and ASIO check by the user on the other machine   | not started                      |                                    |       |

## The list (2026-10-28) and the decisions from Q&A

1. **Home page: rightmost icon.** Decision: the top bar's order becomes History, Profile, Home, so Home is always the far-right icon (the polish round made the three fixed; only the order changes).
2. **Show the QR code at all times.** Decision: while a song plays, a small QR code with the address under it sits in the bottom-left corner, above the up-next strip. Announcements stay top-right; the piano roll on the left edge is unaffected. The idle screen keeps its big one.
3. **Gain control.** Decision: this is the **song's volume**: an admin slider on the phone (the profile's Admin section, next to the guide melody slider) that sets the display's song gain, 0 to 100 %, default 100, applied to every source (the vocoder level and the Joysound guide level are unchanged by it). It is live state, not config: a launch starts at 100.
4. **Check the Rust code.** The native mic path (`native/karafriends-lib/src/lib.rs`) was read for this plan. Found, to fix in N1:
   - **The resampler drops samples every callback.** When the mic's rate differs from the output's, the callback feeds `rubato::Fft` with `chunks(resampler_chunk_size)`; the last chunk of every callback is short, rubato refuses it ("resampling error") and those samples are lost. Fewer samples go out than come in, the output ring buffer drains, and from then on every output callback prints "input fell behind". That matches the report: a USB mic (often 44.1 or 96 kHz) with HDMI/TV speakers (48 kHz), fine for a while, then gone.
   - **The chunk size is nonsense on Windows.** With `BufferSize::Default` (always, on WASAPI) the chunk size is `input_rate / output_rate` as an integer: 0 (a panic in `chunks(0)`) for 44.1 → 48 kHz, 1 for 48 → 44.1 (an FFT per sample), 2 or 4 for 96 or 192 kHz.
   - **The mic opens at its highest rate** (`compare_configs` prefers the highest sample rate), so resampling happens even when the mic could run at the output's rate.
   - **Errors kill the stream silently.** The cpal error callback is `panic!`; a stream error (a device glitch, a format change, the TV going to sleep) ends the thread and the mic is dead until re-selected, with no sign in the UI.
   - **Underruns play stale samples.** When the ring buffer has fewer samples than the output asks for, the rest of the output buffer is left as it was (a repeat of the last block), not silence.
   - **Clock drift has no remedy.** Two devices on two clocks drift by a few samples a second; the buffer eventually runs dry (choppy) or full (every push drops samples and the latency is the whole buffer). Nothing re-centres it.
   - **One output stream per mic**, each opened on the default output device; and the preload's `outputDevices` calls a native function that doesn't exist.
   - Smaller: allocations and `eprintln!` in the real-time callbacks (acceptable for now; rate-limit the prints), `unsafe impl Send for Stream` (cpal streams aren't `Send` on purpose; it stays, with a comment on why it is sound here: the stream is only paused and dropped from the JS thread), the reverb test is `#[ignore]`d.
5. **Mic settings for a real karaoke experience: echo and gain.** Decision: per mic, on the display's Settings screen and on the phone's Admin section, live. **Gain** 0 to 200 %, default 100. **Echo** is the amount of the existing reverb, 0 to 100 %, default 40 (which is today's fixed level: the wet signal at 0.2 of the dry); no new effect.
6. **Remove individual mics instead of "Clear mics".** Each mic row gets its own remove button; the "Clear mics" button goes.
7. **The mic cuts out after a short while with "input fell behind".** The setup: a USB mic, sound through the TV over HDMI, the song kept playing; only the mic went silent. See item 4 for the likely causes; N1 fixes all of them, and adds a way back: the display notices a dead stream and reopens it.
8. **ASIO output.** Decision: the output device for the mics becomes **selectable** on the display's Settings screen: one list of every output device cpal offers, WASAPI (labelled "Windows", or "Mac" / "Linux") and, in builds with the `asio` feature, ASIO; all mics go out through the chosen device (one output stream, which is also what ASIO requires). The song keeps playing through the Chromium default output, as today. The help line under the setting says so, and that an ASIO interface whose driver refuses a second client can't play the song and the mics at once (FlexASIO, ASIO4ALL, RME and MOTU drivers share; many others don't). The Windows CI build already passes `--features asio`; nothing changes in the build.

## How this plan is run

- Lanes: N1 (native) and S1 (server) run alongside each other; R1 (remote) starts with S1 since its API types are fixed in this plan; D1 (display) starts after N1 and S1 merge. Then N2, then the user's check.
- Checks for every phase as in `PLAN-polish.md`: `yarn typecheck`, `yarn lint`, `yarn prettier --check .`, `yarn test:unit`, `yarn build-prod`, `yarn test:e2e:ci`, the WebKit run for the remote phase (`KARAFRIENDS_E2E_WEBKIT=1 yarn test:e2e remote`), `yarn test:native` for the native phase (clippy and the cargo tests; `cargo +nightly careful` only if nightly is installed, else plain `cargo test`), a real launch with `KARAFRIENDS_LOCAL_ONLY=1 KARAFRIENDS_HIDE_WINDOW=1`, and screenshots into `notes/ui-refresh-screenshots/n-*.png` for anything visual, reviewed against the design brief.
- **No sound.** No phase opens a mic or an output stream on this computer: the mic path goes to the speakers, so a "test" would be audible. The native callbacks are tested in cargo tests with generated signals, as the existing tests do. The e2e tests stub `window.karafriends.nativeAudio` (the fixture already runs with no mic).
- **Unattended** as in `PLAN-polish.md`: hidden, local-only, muted; questions go in the report.
- The Windows/MSIX notes from `PLAN-product.md` apply unchanged.

## API and state fixed by this plan (so S1, R1 and D1 agree)

In `src/common/api.ts`:

```ts
// A mic the display has open, as the phones see it.
export interface MicInfo {
  id: string; // `${name}#${channel}`: stable while the mic stays plugged in
  label: string; // "Blue Yeti (Windows), channel 1"
  gain: number; // 0..200, percent
  echo: number; // 0..100, percent of the full reverb
}
// State: songVolume: number (0..100, default 100); mics: MicInfo[] (default []).
// Methods:
//   setSongVolume { input: { volume: number }; output: boolean }  admin
//   setMicLevels  { input: { id: string; gain?: number; echo?: number }; output: boolean }  admin; false if no such mic
//   setMics       { input: { mics: MicInfo[] }; output: boolean }  display only (DISPLAY_ONLY_METHODS)
```

The display owns the mic list: it calls `setMics` whenever a mic is added, removed or its levels change on the display, and applies `songVolume` and the `mics` levels it reads from live state (an admin's `setMicLevels` lands in state, the display applies it to the native device and saves it in `localStorage`, as the guide melody level flows today). Both numbers are integers; the server clamps nothing and rejects out-of-range values with a 400, like `setGuideMelodyLevel`.

Native (neon) functions, fixed by this plan:

```ts
outputDevices(): string[]; // every output device, with the host in parentheses
setOutputDevice(name: string | null): void; // null: the default; reopens the one output stream
inputDevice_new(name: string, channel: number): handle; // as today
inputDevice_setGain(handle, gain: number): void; // linear, 0..2
inputDevice_setEcho(handle, amount: number): void; // 0..1
inputDevice_status(handle): "ok" | string; // the error that stopped it, if any
inputDevice_getPitch / inputDevice_stop: as today
```

## Phases

### N1: native: one output, device choice, gain and echo, no cutout (branch `native-mixer`)

Files: `native/karafriends-lib/src/lib.rs`, `reverb_module.rs`, a new `mixer.rs` if it keeps `lib.rs` readable, `native/karafriends/src/lib.rs`, `src/preload/index.ts` (the `nativeAudio` bridge), `src/renderer/global.ts` and `nativeAudio.ts` (the typings and the `InputDevice` wrapper: `setGain`, `setEcho`, `status`), `README.md` (a short "Microphones" note), `CHANGELOG.md`.

- **One output stream for all mics.** A process-wide output (`Mixer`): the chosen output device, one stream, one callback that sums every open mic's ring buffer into the output frames (mono to every output channel, as today). Each `InputDevice` keeps its input stream, its pitch ring buffer and its own output ring buffer, and registers it with the mixer; `stop` and drop deregister it. `setOutputDevice` reopens the stream on the new device and keeps the registered mics. The default (`null`) is the host's default output device; when the chosen device is gone at launch, fall back to the default and say so in `status`.
- **Device lists.** `outputDevices` lists the default host's output devices as `"Name (Windows)"` (or Mac / Linux) and, with the `asio` feature, the ASIO host's as `"Name (ASIO)"`. Input names keep today's `"Name (USB)"` form so saved mics still match (the suffix means "default host"; it is not renamed).
- **Resampling that doesn't lose samples.** Open the mic at the output's sample rate when it supports it (prefer the output's rate in `compare_configs`; the highest rate only when it doesn't). When the rates still differ, carry the remainder between callbacks: a small accumulator feeds rubato whole chunks of a fixed, sane size (1024 frames; `BufferSize::Default` no longer decides it), and nothing is dropped. The same for the mixer: each mic resamples to the output rate in its own input callback, as today.
- **Gain and echo live.** Two `AtomicU32`s (f32 bits) per mic, read once per callback; gain multiplies the dry signal before the reverb, echo scales the wet signal (today's constant 0.2 becomes `0.5 * echo`, so 40 % is today's sound). Defaults 1.0 and 0.4.
- **No cutouts.** The error callback records the error in the device's `status` (an `Arc<Mutex<Option<String>>>`) instead of panicking, and the mixer logs it once. Underruns write silence for the missing frames. The ring buffers are 200 ms at the output rate with a target fill of 50 ms: when one runs dry, it refills to the target before it plays again (one short gap instead of permanent choppiness); when one is full, the oldest samples go. Prints in callbacks are rate-limited to one a second per kind.
- **Watchdog in the display.** `nativeAudio.ts` polls `status` every 2 s for each open mic; on an error it stops and recreates the device with the same name and channel and logs why, and after three failures in a minute it gives up and leaves the error in the Settings row (D1 shows it). Keep this in the wrapper, not React.
- **Tests:** `cargo test` on the callbacks with generated sine waves: no sample loss across callbacks of odd sizes at 44.1 → 48 kHz and 96 → 48 kHz (count in = count out × ratio, within one chunk), gain and echo values change the output as expected, the underrun path writes zeros, the refill logic (as a pure function over occupancy) behaves. Un-ignore the reverb test or replace it with one that holds. `cargo clippy` clean. A cargo test that lists devices is fine (no stream is opened). `yarn build-prod` and `yarn test:e2e:ci` still pass (the e2e stub gains the new functions).
- Report whether anything here depends on behaviour only a real device shows (ASIO duplex on one driver, WASAPI's callback sizes) so the Final section lists it.

### S1: server: song volume, the mic list and levels over the API (branch `mic-api`)

Files: `src/common/api.ts`, `src/main/api.ts`, `validate.ts`, `state.ts`, `dispatch.ts` or wherever `DISPLAY_ONLY_METHODS` lives, `live.ts` (the two fields reach the live state), `api.test.ts`, `state.test.ts`, `tests/e2e/api.spec.ts`, `CHANGELOG.md`.

- Exactly the three methods and two state fields above. `setMicLevels` on an unknown id answers `false` without an error. `setMics` from a phone is 403 like the other display-only methods. `songVolume` and `mics` are not persisted (`queue.json` ignores them); a launch starts at 100 and `[]`.
- Tests: unit for the handlers and validation (ranges, non-integers, unknown id, display-only); e2e: an admin's `setSongVolume` reaches another phone's live state, a non-admin gets 403, the display's `setMics` list reaches the phone, and `setMicLevels` changes it there.

### R1: remote: Home rightmost, song volume and mic sliders (branch `remote-mic`)

Files: `src/remocon/App.tsx` (the top bar order), `pages/ProfilePage.tsx` and `.module.scss` (the Admin section), the i18n files, `tests/e2e/remote.spec.ts`, the remote screenshot spec, `CHANGELOG.md`.

- Top bar: History, Profile, Home, left to right; nothing else about it changes.
- Admin section: a "Song volume" slider (0–100 %) above the guide melody slider, and under them a "Microphones" list from live state: each mic's label and two sliders, Gain (0–200 %) and Echo (0–100 %), sending on release like the key slider; "No microphones" when the list is empty. The same slider primitive as the guide melody. Both languages.
- Screenshots `n-remote-admin.png` in dark and light. Tests: e2e: the order of the three icons; the volume slider calls `setSongVolume`; a seeded `mics` state (through the display-only `setMics` from the fixture's display page) shows the rows and a slider calls `setMicLevels`. WebKit run.

### D1: display: QR always, mic rows, output device, song volume (branch `display-mic`)

Files: `src/renderer/App.tsx`, `Player.tsx` or a new small `JoinCorner.tsx` and `.css` (the QR corner), `QRCode.tsx`, `Settings.tsx` and `.css`, `MicrophoneSetting.tsx`, `nativeAudio.ts`, `useSongPlayer.ts` and `webAudio.ts` (song volume), `tests/e2e/display.spec.ts`, `settings.spec.ts`, the display screenshot spec, `CHANGELOG.md`.

- **QR corner:** while a song plays, the QR code (about 8 rem) with the address under it in the bottom-left, above the up-next strip, in the display's surface colour with the usual border and radius; hidden while Settings is open. One component for the idle screen's big one and this small one. Screenshot `n-display-qr.png`.
- **Song volume:** `webAudio.ts` gets a `songVolume(0..1)` on a separate gain node after the existing one (the existing `gain()` keeps meaning the per-song loudness), applied from live state like the guide melody level.
- **Mic rows:** each row shows the device select, the Gain and Echo sliders, the status ("Reopened after: <error>" or the final error in the problem colour, nothing when fine) and a remove button; "Clear mics" goes. Levels persist in `localStorage` with the mic (`{ name, channel, gain, echo }`; old entries without them get the defaults). The display calls `setMics` after every change and applies `setMicLevels` changes from live state to the native device and to `localStorage`.
- **Output device:** in the Microphones section, a "Mic output" select over `outputDevices()` with "System default" first, saved in `localStorage` (`micOutput`), applied with `setOutputDevice` at launch and on change, with the help line from item 8.
- Tests: e2e with the fixture's stubbed `nativeAudio` (extend the stub: two fake input devices, two outputs, the new functions recording their calls): add a mic, set its levels, see `setMics` land in a phone's live state; remove one mic and the other stays; pick an output and see the stub called; a `setMicLevels` from an admin page reaches the stub; the QR corner is visible while a seeded song plays and not on the idle screen.

### N2: review and fixes

Two reviewers (native + display; server + remote) over `git diff <start of this round>..HEAD` with the same brief as the earlier rounds, a Fable verification pass, findings appended to `notes/code-review-2026-10-27-product.md` under "Mic round", one fix session per area. The native reviewer reads the callbacks for real-time safety (no locks held across the sum, no unbounded allocation per callback) and for the sample-count arithmetic, since no device test is possible here.

### Final: mic and ASIO check by the user on the other machine

With the USB mic and the TV: sing for ten minutes at the default output (the old cutout came "after a short while"); change gain and echo from the phone while singing; unplug and replug the mic (the row should show the error, then recover or say it gave up); remove one of two mics. With the ASIO interface: pick it as the mic output, check the song still plays through the default output, and note whether the driver let both run; if the ASIO device also appears as an input, pick a channel of it as a mic. On the phone: the Home icon at the far right, the song volume slider. On the TV: the small QR code during a song. Anything that fails goes into a "Mic round, from the test" list for a fix session; the two-device clock drift behaviour over a long session is the thing most likely to need a second pass.
