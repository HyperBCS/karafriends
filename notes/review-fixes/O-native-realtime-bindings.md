# Phase O: Native: real time, pitch window, bindings, cleanups

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 2; starts after: E, F.

Files: native/karafriends-lib/src/lib.rs, pitch_detector.rs, reverb_module.rs, native/karafriends/** (bindings, Cargo.toml), native/karafriends-lib/Cargo.toml, src/vite-env.d.ts, src/renderer/global.ts, the native parts of src/preload/index.ts and src/renderer/nativeAudio.ts.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                             | Severity                     | Title                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [tests-unit-1](#tests-unit-1)                       | Medium                       | get_pitch gives the pitch detector a part-empty or stale window, and the tests only ever feed it whole ones                                            |
| [cross-maintainability-1](#cross-maintainability-1) | Low                          | Every mic callback makes about 21 heap allocations (the reverb chain returns new Vecs)                                                                 |
| [native-core-5](#native-core-5)                     | Low                          | macOS mics open at the device's smallest buffer, so the input callback runs thousands of times a second                                                |
| [native-core-6](#native-core-6)                     | Low                          | compare_configs is 50 hand-written lines of lexicographic comparison with no tests, and two functions sort and take the last                           |
| [native-bindings-8](#native-bindings-8)             | Low                          | The native module is typed `any`, so nothing ties the Rust exports, the preload and the fakes together                                                 |
| [native-bindings-7](#native-bindings-7)             | Low                          | The fake audio never fails, so no test reaches the mic error paths                                                                                     |
| [oe-native-3](#oe-native-3)                         | Over-engineering (KEEP, low) | Stream configs are chosen three ways: a 52-line 5-tier comparator whose buffer tiers can't decide anything, and the same rate-match test written twice |
| [oe-native-4](#oe-native-4)                         | Over-engineering (WEAK, low) | Device listing computes full configs nobody reads, is generic over a collector with one type, and keeps a cache that Linux empties before every lookup |
| [oe-native-7](#oe-native-7)                         | Over-engineering (KEEP, low) | Results that can never be Err: `get_pitch` and `ReverbModule::new`                                                                                     |
| [oe-native-1](#oe-native-1)                         | Over-engineering (KEEP, low) | The neon binding layer marshals every argument and return value by hand, but neon 1.1.1 (already in Cargo.lock) does this itself                       |
| [oe-native-5](#oe-native-5)                         | Over-engineering (WEAK, low) | Two crates and a workspace, but the 'pure' lib depends on neon anyway, and both features are declared twice                                            |
| [oe-native-6](#oe-native-6)                         | Over-engineering (KEEP, low) | `win32console` (and `winapi` through it) is pulled in for two calls the `windows` crate already provides                                               |
| [oe-display-3](#oe-display-3)                       | Over-engineering (WEAK, low) | nativeAudio.ts: eight one-line pass-throughs to window.karafriends.nativeAudio, each with one caller, that re-declare global.ts's types and comments   |
| [oe-architecture-9](#oe-architecture-9)             | Over-engineering (WEAK, low) | The native audio API goes through four hand-written layers, so one new native function touches seven places                                            |

## tests-unit-1

**get_pitch gives the pitch detector a part-empty or stale window, and the tests only ever feed it whole ones** (medium, confirmed, bug) · `native/karafriends-lib/src/lib.rs:659`

**Summary.** The pitch ring holds exactly one window (rate/40 = 25 ms, lib.rs:546-547). get_pitch pops whatever the ring holds into a zeroed Vec (lib.rs:660-662). A poll that comes before a full 25 ms has arrived therefore runs detect on a window that ends in zeros. A poll that comes late gets the oldest 25 ms instead, because push_slice (lib.rs:781) drops the newest samples once the ring is full. Every test (pitch_detector.rs:137-150, lib.rs:1288) calls detect directly with exactly sample_count fresh samples, and nothing tests get_pitch.

**Scenario.** On Windows shared mode, the default, WASAPI delivers 10 ms callbacks; macOS CoreAudio delivers about 10.7 ms. PianoRoll polls every 25 ms (PianoRoll.tsx:546), so successive polls find either 2 callbacks (20 ms of sound plus 5 ms of zeros) or 3 (25 ms kept, the newest 5 ms dropped). I ported PitchDetector::detect to JS and fed it 20 ms of sound plus 5 ms of zeros: 32 of 50 sine tones between 81 and 130 Hz came out more than 0.1 semitone sharp, the worst by 0.63 semitone, all with confidence >= 0.8, so PitchDetectionBuffer draws them. Full windows were exact, and tones above 130 Hz were barely affected. A bass singer's trace on the pitch bars therefore zigzags by up to two-thirds of a semitone. Separately, a poll that a busy renderer runs 50 ms late plots audio from about 50 ms earlier at the current video time.

**Suggested fix.** Keep a sliding window. Make the ring two windows long, keep a persistent `pitch_window: Vec<f32>` in InputDevice, and in get_pitch skip anything older than one window, shift pitch_window left by the number of new samples (copy_within), pop them into its tail, and run detect on that. Detection then always uses the latest full 25 ms, and the per-call Vec goes away. Add a test that runs a 100 Hz tone through input_data_callback in 20 ms and 30 ms pushes, calls the get_pitch logic after each, and asserts the result stays within 0.05 semitone.

**Verifier.** CONFIRMED: I checked the code. lib.rs:546-547 sizes the pitch ring to exactly one window (rate.div_ceil(40)). get_pitch (lib.rs:659-662) pops into a zeroed Vec, so a short ring leaves zeros at the end. push_slice at lib.rs:781 drops whatever doesn't fit. PianoRoll.tsx:546 polls every 25 ms and draws anything with confidence >= 0.8 as a continuous spline (PitchDetectionBuffer, no snapping). To rule out errors in the finder's JS port, I copied the real pitch_detector.rs into a scratch crate (realfft 3.5.0, offline) and ran it: scratchpad/review/verify-tests-unit/yinrs. At 48 kHz and 44.1 kHz, full windows were exact. With 20 ms filled and 5 ms of zeros, 48 of 50 tones from 81-130 Hz were drawn and 32 were more than 0.1 semitone off, worst 0.63. For 131-260 Hz, 2 were off, worst 0.15. Above 261 Hz none were off. With 21.33 ms filled (macOS 512-frame callbacks), 26 of 50 low tones were off. With 10 ms callbacks against 25 ms polls, polls alternate between 2 callbacks (a short window) and 3 (the newest 5 ms dropped), so the zigzag on low notes happens in the default Windows shared mode and on macOS. Linux's 128-frame default lowers the gap but doesn't remove it. Nothing tests get_pitch: the only detect() callers are pitch_detector.rs:146 and lib.rs:1288, both with full fresh windows. Medium fits: it is a visible pitch-bar error, but only for notes below about C3.

**Also reported as** (The pitch ring is exactly one window deep. Use a sliding persistent window plus a get_pitch test.):

- native-core-3: The pitch ring holds exactly one window: when full it drops the newest audio, and when short it zero-pads (`native/karafriends-lib/src/lib.rs:547`). Its fix: Make the ring a few windows deep (for example 4×N). In get_pitch, drain everything into a persistent N-sample window that keeps the newest N, and return (0, 0) when nothing new has arrived. That removes zero-padding, stale windows and the per-call `vec!`. Add a unit test with a short, an exact and an overfull ring.

## cross-maintainability-1

**Every mic callback makes about 21 heap allocations (the reverb chain returns new Vecs)** (low, confirmed, realtime-audio) · `native/karafriends-lib/src/lib.rs:788`

**Summary.** input_data_callback collects the wet signal into a new Vec on every callback. Each of the five ReverbModule::process calls then allocates its output, plus three more Vecs per chunk in process_chunk. All of this malloc/free runs on the real-time capture thread.

**Scenario.** Take the Linux default of 128 frames at 48 kHz (linux.rs:23), which is 375 callbacks a second, or a 128-frame exclusive WASAPI mic. At about 21 allocations per callback that is roughly 7,900 malloc/free a second per mic on the audio thread, and about 16k with two mics. Under memory pressure or allocator contention (the renderer process also hosts V8 and Chromium), one slow malloc can overrun a 2.7 ms period and cause an xrun or a crackle.

**Suggested fix.** Process in place: `fn process(&mut self, samples: &mut [f32])` over a fixed Vec<f32> delay line with a write index (no ringbuf, no temporaries). Keep one `wet: Vec<f32>` in the closure, reserved once and cleared and extended per callback the way `mono` is. Hoist the five (delay, amplitude) taps into a `const REVERB_TAPS`, shared with the copy in the test at lib.rs:1241-1247. That is about 20 fewer lines and no allocations per callback, and test_echo_is_the_reverb still pins the sound.

**Earlier reviews.** The mic round in code-review-2026-10-27-product.md checked the callbacks for locks, not for allocation. Not reported before.

**Verifier.** CONFIRMED: The allocation count is right. lib.rs:788 collects reverb_samples into a new Vec. Each of the five ReverbModule::process calls (reverb_module.rs:28-55) allocates its output Vec, and each chunk allocates three more (delayed_samples vec!, samples_with_delayed collect, the final collect). The shortest delay is 0.02196 s, which is 1054 samples at 48 kHz, so any callback of 1054 frames or fewer is a single chunk: 1 + 5×4 = 21 allocations per callback. mono, pending and resampled are preallocated, so the reverb is the only allocator. The impact is smaller than claimed, though. These are small blocks (512 B at 128 frames) that glibc serves from the thread's tcache in tens of nanoseconds, and the crackle-on-a-slow-malloc scenario was not shown. It is a real-time-hygiene issue on the audio thread. The in-place fix is simple and also deduplicates the taps with the copy in the test at lib.rs:1241-1247. That makes it worth doing, but as low severity, not medium.

**Also reported as** (Reverb allocates about 21 Vecs per callback. A delay line processed in place fixes it. Measured at under 1 µs per callback, so it is hygiene, not a heard glitch.):

- native-mixer-5: Reverb allocates about 21 Vecs per mic callback; one in-place delay line would replace it (`native/karafriends-lib/src/reverb_module.rs:28`). Its fix: Use `struct ReverbModule { amplitude: f32, delay: Vec<f32>, pos: usize }` with `fn process(&mut self, samples: &mut [f32])` that, for each sample, sets `let d = self.delay[self.pos]; let w = *s + self.amplitude * d; self.delay[self.pos] = w; *s = d - self.amplitude * w;` and advances and wraps pos. The arithmetic is the same, with zero allocations, no chunking, no ringbuf and an infallible new(). The module shrinks from about 55 lines to about 25, and lib.rs:788-791 becomes one reused scratch Vec processed in place. Pin the current impulse response in a test first: test_echo_is_the_reverb builds its expected values with ReverbModule itself, so it can't catch a change in the module's own arithmetic.
- native-exclusive-6: The mic callback allocates about 21 times per call on the exclusive MMCSS thread (`native/karafriends-lib/src/lib.rs:788`). Its fix: Keep scratch buffers in the closure and make ReverbModule process in place, e.g. process(&mut self, buf: &mut [f32]) over a fixed delay line, with the wet buffer allocated once at the callback's maximum size.
- native-core-1: The mic's input callback makes 21 heap allocations per callback (the reverb chain) on the real-time audio thread (`native/karafriends-lib/src/lib.rs:788`). Its fix: Make the delay line per-sample and in place, with no allocation. For each sample: `let d = rb.try_pop().unwrap_or(0.0); let v = x + a*d; rb.try_push(v); *x = d - a*v;`. The output is identical to the chunked version, the chunking goes away, and test_echo_is_the_reverb still pins it. Keep one `wet` scratch Vec in the closure (grow-only, like `mono`) instead of collecting at line 788, and skip the chain while echo is 0. Put the five (delay, amplitude) pairs in one const that both the callback (lib.rs:738-744) and the test (lib.rs:1241-1247) use; today the test repeats the table.

## native-core-5

**macOS mics open at the device's smallest buffer, so the input callback runs thousands of times a second** (low, plausible, performance) · `native/karafriends-lib/src/lib.rs:982`

**Summary.** Outside Windows and Linux, supported_config_to_config turns the device's buffer range into `BufferSize::Fixed(*min)`. cpal reports CoreAudio's kAudioDevicePropertyBufferFrameSizeRange, whose minimum is typically a few dozen frames or less on Apple hardware. The mic then runs at that size, while the mic output stays at its default buffer, so the tiny input buffer buys little latency.

**Scenario.** A Mac's built-in or USB mic opens at roughly 15 frames, which is 0.3 ms and over 3,000 callbacks/s at 48 kHz. Each callback pays the fixed per-callback cost: the 21 allocations above, five reverb passes, a boxed closure call and atomics. That raises CPU use, and with a 0.3 ms deadline, any stall during video decoding or WebGL drawing becomes an audible dropout. Linux clamps to a chosen size (128 by default) for this reason.

**Suggested fix.** Use `BufferSize::Default`, or a floor such as `min.max(128)`, on macOS. Better, share linux::buffer_size's clamp-to-a-chosen-size logic so every platform gets the same rule.

**Earlier reviews.** Not in earlier reviews (pre-existing upstream behaviour).

**Verifier.** PLAUSIBLE: The code is as described. lib.rs:979-984 maps SupportedBufferSize::Range{min,..} to BufferSize::Fixed(*min) everywhere except Windows. On macOS, cpal-0.18.2 then really applies it: it checks the size against the range and sets kAudioDevicePropertyBufferFrameSize at device level (coreaudio/macos/device.rs:1009-1036), from kAudioDevicePropertyBufferFrameSizeRange (258-283). So a Mac mic opens at the HAL's minimum buffer. Not verified: the actual minimum on Apple hardware (no Mac here; commonly reported as about 14-15 frames). Overstated: the CPU claim. I measured the per-callback reverb chain with its 21 allocations at about 0.3 µs, so even 3,200 callbacks/s cost about 0.1% of a core. The dropout risk at a ~0.3 ms deadline is real in principle but unquantified. The setting is device-level, so a USB interface serving as both the mic and the mic output could also pull the output's IO cycle down. The code is from 2023 (Connor Worley) and has shipped in the darwin builds without a known report. The fix, a floor such as min.max(128) or Default, is cheap and sensible, but this stays low and unconfirmed.

## native-core-6

**compare_configs is 50 hand-written lines of lexicographic comparison with no tests, and two functions sort and take the last** (low, plausible, maintainability) · `native/karafriends-lib/src/lib.rs:914`

**Summary.** The Windows/macOS config choice (compare_configs, lib.rs:914-964) has no tests, although this round moved the desired-rate-in-range check to the top priority. It is cfg'd out on Linux, the only CI job that runs cargo tests, so a test also needs that cfg relaxed. The key-function/max_by rewrite is equivalent but mostly cosmetic.

**Scenario.** A change to the priority order, for example making channels outrank rate, silently changes which config every Windows and macOS mic opens with. No test catches it, and CI has no audio devices.

**Suggested fix.** Use a key function `(in_range, buffer_known, Reverse(min_buffer_or_0), max_rate, channels)` and one helper: `configs.max_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.cmp_default_heuristics(b)))`. max_by returns the last of equal maxima, as sort and last do. That is about 40 lines shorter, needs no Vec or sort, and gets two or three unit tests (the rate-in-range preference, Unknown losing to Range, smaller minimum buffer winning).

**Earlier reviews.** Not in earlier reviews.

**Verifier.** PLAUSIBLE: The facts check out. compare_configs is lib.rs:914-964. listed_config (858-862) and input_stream_config (899-906) each collect, sort_by and take last(). Nothing tests it (grep across native finds only those call sites). The suggested key tuple orders configs the same way, and Iterator::max_by returns the last of equal maxima, like a stable sort followed by last(). The rewrite itself is mostly style: 4 duplicated lines and a comparator that works. What is worth doing is the test. This round (c5fe1152) moved the desired-rate-in-range check from after the buffer-size comparison to first, so the logic that picks every Windows/macOS mic's format did change, untested. But compare_configs and supported_config_to_config are #[cfg(not(target_os = "linux"))], and CI runs cargo tests only in the Linux job (build.yaml:183-186; the Windows and macOS jobs run only clippy). Tests as suggested would never run in CI unless the cfg is relaxed: the function uses only cpal types, which build on Linux, so #[cfg(any(test, not(target_os = "linux")))] or no cfg would do.

## native-bindings-8

**The native module is typed `any`, so nothing ties the Rust exports, the preload and the fakes together** (low, plausible, maintainability) · `src/vite-env.d.ts:30`

**Summary.** `declare module "*.node" { const native: any }` (src/vite-env.d.ts:29-32) leaves the preload's calls into index.node untyped, and neither the real nativeAudio object nor the two fakes is annotated against Window["karafriends"]["nativeAudio"] (global.ts). So the preload or a fake can drift from the type the renderer relies on without typecheck noticing. Annotating those three objects is cheap and catches that drift. A hand-written d.ts for the Rust exports can't catch a rename or a same-typed argument swap in lib.rs, because nothing ties it to the Rust code. Only a runtime check would, such as a test that loads index.node and checks that the export names exist.

**Scenario.** Someone renames inputDevice_getPitch in lib.rs or swaps setOutputDevice's rate and buffer arguments. yarn typecheck and every e2e test pass, and the bug only shows on the host's machine.

**Suggested fix.** Declare the 18 raw exports once in about 30 lines: a native/index.d.ts or a type in src/common, with an opaque `MicHandle` brand for the JsBox. Annotate the real object and both fakes as `Window["karafriends"]["nativeAudio"]`. Typecheck then catches drift between the four copies.

**Verifier.** PLAUSIBLE: The facts are right. The `*.node` declaration is `any`, and the preload's real object (:233-297) and both fakes (:110-209) are unannotated. One tsconfig includes all of src, so annotating them against the global Window type works. But the stated failure scenario (renaming inputDevice_getPitch in lib.rs, or swapping setOutputDevice's rate and buffer arguments) wouldn't be caught by the suggested fix. The d.ts would be one more hand-kept copy with no link to the Rust side, and rate and buffer are both number|null, so a swap still typechecks. The part that works is annotating the preload and fakes, which catches preload or fake drift from global.ts. That is a small, low-value improvement.

## native-bindings-7

**The fake audio never fails, so no test reaches the mic error paths** (low, confirmed, test-gap) · `src/preload/index.ts:145`

**Summary.** In both fakes, inputDevice_new always succeeds and inputDevice_status always returns "ok". The e2e suite therefore can't reach any of these paths: a mic that won't open from Settings, a saved mic missing at launch, the watchdog's down-then-back retry, or a listing call that throws. The first four findings above all sit on those paths. The product review already noted the missing coverage, and nothing was added.

**Scenario.** Any of the findings above can regress, or ship, with the whole e2e suite green.

**Suggested fix.** Add a fake knob, such as window.karafriendsFakeAudio.fail(id, reason) or KARAFRIENDS_FAKE_AUDIO_FAIL=<id>, that makes inputDevice_new throw and inputDevice_status report the reason for that id. Add three tests. First, picking that mic in Settings shows a message and keeps the old mic. Second, a saved mic that fails at launch is still saved after a level change. Third, a mic that goes down and comes back reopens on its own.

**Verifier.** CONFIRMED: In fakeWindowsAudio, inputDevice_new always returns nextDeviceId++ (preload/index.ts:145) and inputDevice_status always returns "ok" (:149). fakeLinuxAudio spreads those and overrides only new/format (:203). There is no unit test of nativeAudio.ts, and the only e2e references to inputDevice_new (settings.spec.ts) check call order on success. The product review's closing note also says "the fake audio device always opens and always reports ok" and that those paths weren't tested. So the error paths in findings 1-4 can't be reached by any test.

## oe-native-3

**Stream configs are chosen three ways: a 52-line 5-tier comparator whose buffer tiers can't decide anything, and the same rate-match test written twice** (over-engineering, KEEP, low) · `native/karafriends-lib/src/lib.rs:914`

**Now.** Non-Linux inputs sort every supported range with `compare_configs` (lib.rs:913-964). Its tiers are: has the output rate, buffer size known vs Unknown, smaller minimum buffer, higher max rate, more channels, then cpal's heuristics. Then `supported_config_to_config` (968-986) runs, with twin `listed_config`/`input_stream_config` per platform. Linux inputs use `linux::stream_config` (linux.rs:375-393): the default config, at the output's rate if a range with the same channels and format has it. The mixer's output repeats that exact predicate inline (mixer.rs:251-259).

**Why it's more than needed.** The two buffer tiers never change the result on the hosts that reach this path. cpal gives every range of a CoreAudio device the same `get_io_buffer_frame_size_range` (coreaudio/macos/device.rs:574-584). Every ASIO range carries the driver's single range (asio/device.rs:103). On Windows the chosen buffer is discarded anyway (`BufferSize::Default`, lib.rs:979-984). The comparator dates from 2021 (#30, 341d10a), before those cfgs. The `range.channels() == … && range.sample_format() == … && contains(rate)` test is duplicated verbatim (mixer.rs:252-256 vs linux.rs:383-387).

**Simpler shape.** For non-Linux inputs: `ranges.filter(has channel).max_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.cmp_default_heuristics(b)))` with `key = (rate.is_some_and(|x| r.contains_rate(x)), r.max_sample_rate(), r.channels())`. Put one non-cfg'd helper in lib.rs for the 'same channels and format, contains rate' test, used by mixer.rs and linux::stream_config. Keep macOS's Fixed(min) in supported_config_to_config.

**Saves.** About 40 lines and the 5-tier ordering concept. The rate-match logic exists once.

**Risk.** WASAPI ranges for different formats could carry different GetBufferSizeLimits, so ties could break differently, but the buffer is ignored there anyway. Windows, macOS and ASIO behaviour can't be checked on this machine, so it needs the user's device check.

**Verifier.** I confirmed the buffer tiers can't decide anything in cpal 0.18.2. CoreAudio gives every range the same `get_io_buffer_frame_size_range` (macos/device.rs:574), and ASIO's `configs_for` copies the default buffer_size into every range. WASAPI reports one range per rate, with frames equal to period × rate, so the tier would favour the lowest rate. But shared-mode capture only accepts S_OK from IsFormatSupported at the mix rate, so in practice there is one rate, and Windows discards the buffer anyway (lib.rs:979-984). The comparator comes from #30 (341d10a, 2021), written for an older cpal, and no note asks for it. The rate predicate is duplicated as claimed (mixer.rs:251-256 and linux.rs:383-387). One correction: the proposed `max_by_key` tuple drops `cmp_default_heuristics`. That function also ranks sample formats (F32 first) and prefers 48 kHz, and on WASAPI several formats can share a rate. Keep it as the final tie-break, which costs one line. Re-rated to low: it is about 40 lines of stable code that is rarely touched, and the Windows, macOS and ASIO behaviour can only be checked on the user's devices.

## oe-native-4

**Device listing computes full configs nobody reads, is generic over a collector with one type, and keeps a cache that Linux empties before every lookup** (over-engineering, WEAK, low) · `native/karafriends-lib/src/lib.rs:417`

**Now.** `collect_devices<Collector: FromIterator<(String, String, cpal::StreamConfig)>>` returns a whole StreamConfig per input. On Linux, `listed_config` (845-854) calls `linux::stream_config(&default, std::iter::empty(), None, linux_buffer())`, locking MIC_MODE to compute a buffer size. Elsewhere (856-867) it sorts every supported config. `INPUT_DEVICES` (230) caches name → device, but on Linux `open` removes the entry first (453-455), so it is written and never read there.

**Why it's more than needed.** The only consumer, the binding (karafriends/src/lib.rs:27-30), reads `config.channels` alone, and both callers (that binding and the test at lib.rs:1372) pick `Vec`. The `empty()`/`None` call is the only reason `stream_config` takes an `Option` rate and an iterator it may not need.

**Simpler shape.** `collect_devices() -> Result<Vec<(String, String, u16)>>`. On Linux use `default_input_config()?.channels()`; elsewhere use the channels of the best range under the same rule. stream_config takes a plain `rate`. Leave INPUT_DEVICES and the Linux `remove` as they are.

**Saves.** About 20 lines, a generic parameter, the `std::iter::empty()` / `None` path, and a mutex lock per listing.

**Risk.** Low. The channel count Settings offers stays the same if the 'best range' rule is kept. Keep the map on Windows/macOS: the preload comment about cpal listing breakage and ASIO driver loading is a plausible reason for it there.

**Verifier.** Mostly true. The `Collector: FromIterator` parameter came in with the 2023 split (6914390), and both callers use Vec. The binding reads only `config.channels`. On Linux, `listed_config` calls `stream_config(&default, empty(), None, linux_buffer())` just to get channels, and that call is the only reason stream_config takes an `Option` rate. The INPUT_DEVICES part of the simpler shape doesn't simplify anything, though. `open` holds a borrow into the locked map for the rest of the function, including inside the stream-building closure. A Linux-only `_input_devices()?.find(..)` path would need an owned device on Linux and a borrowed one elsewhere, which means more branching than the current three lines of `if cfg!(linux) { remove }`, and those reuse the insert path. The rest saves about 12 lines.

## oe-native-7

**Results that can never be Err: `get_pitch` and `ReverbModule::new`** (over-engineering, KEEP, low) · `native/karafriends-lib/src/lib.rs:659`

**Now.** `InputDevice::get_pitch -> Result<(f32, f32)>` always returns `Ok(...)`, and the binding still matches an `Err` arm (karafriends/src/lib.rs:172-175). `ReverbModule::new -> Result<Self>` (reverb_module.rs:12-25) maps a `try_push` failure to "Failed to pre-populate the reverb buffer", then 10 call sites use `?` (lib.rs:739-743, 1242-1246).

**Why it's more than needed.** The detector can't fail. The reverb pushes n zeros into a ring of capacity 2n, which can't be full. The one real failure, n == 0, panics in `HeapRb::new(0)` and `chunks(0)` before any Result could help, and it needs a rate under ~45 Hz.

**Simpler shape.** `get_pitch(&mut self) -> (f32, f32)`, and `ReverbModule::new(..) -> Self` using `rb.push_slice(&vec![0.0; n])` or `push_iter(repeat_n(0.0, n))`. Drop the 10 `?`s, 5 in input_data_callback and 5 in the test.

**Saves.** About 15 lines, and an error path and message that can't happen.

**Risk.** None. `input_data_callback` stays fallible because of rubato's constructor.

**Verifier.** Confirmed. `PitchDetector::detect` returns `(f32, f32)` (pitch_detector.rs:20), so `get_pitch` is always Ok and the binding's Err arm is dead. ReverbModule::new pushes n zeros into a HeapRb of capacity 2n, so try_push can't fail; the error message came from #1594 (3e01f5a) as defensive code and doesn't fix any bug. `input_data_callback` stays fallible because of rubato's constructor. This is a free local cleanup.

## oe-native-1

**The neon binding layer marshals every argument and return value by hand, but neon 1.1.1 (already in Cargo.lock) does this itself** (over-engineering, KEEP, low) · `native/karafriends/src/lib.rs:57`

**Now.** 244 lines. Each of the 18 exports is a `fn(FunctionContext) -> JsResult` that pulls `cx.argument`s, matches `Err(e) => cx.throw_error(e.to_string())`, and builds results by hand. There are 5 hand-written `JsArray::new` + `set` loops (input_devices, output_devices, output_options ×2, linux_audio), two `optional_string`/`optional_u32` helpers (4 uses), and a separate 18-line `export_function` list in `main`. `exclusiveAvailable` is a whole export that returns `cfg!(windows)`, a constant the preload already gets from `process.platform` (preload/index.ts:241).

**Why it's more than needed.** neon 1.1.1 is the locked version (Cargo.lock:739) and ships `#[neon::export]` (neon-1.1.1/src/macros.rs:334) with extractors. `Option<T>` maps null/undefined to None (types_impl/extract/try_from_js.rs:55). `String`, `f64` and `bool` convert both ways. `Result<T, extract::Error>` throws, and `extract::Error` converts from any `Into<Box<dyn Error+Send+Sync>>` (extract/error.rs:143), which is the lib's error type. `Boxed<T>` returns a JsBox. `linkme`, which the macro uses, is already locked. This file changed in 5 of the last 6 native commits (c5fe115, 111a11a, 529761a, 34e7608, 96b39bc), each adding marshalling by hand. PLAN-product.md:53 also says no helper for a single caller.

**Simpler shape.** Use `#[neon::export(name = "...")]` only on scalar functions: allocConsole, asioStatus, setOutputDevice(Option<String>, Option<f64>, Option<f64>), setMicMode(bool, Option<f64>), outputFormat -> Option<String> (it now returns undefined, so make the global.ts type `string | undefined`), and inputDevice_new(String, f64) -> Result<Boxed<RefCell<InputDevice>>, Error>. The device methods take `Handle<JsBox<RefCell<InputDevice>>>`, not `Boxed`, because RefCell isn't Clone. Keep every array and object return hand-built (or behind `Json` if adding serde_json is acceptable), and never return a `Vec<u32>` through TryIntoJs. Replace `main` with `neon::registered().export(&mut cx)`. Answer exclusiveAvailable in the preload with `process.platform === "win32"`; the e2e fakes keep their own answers.

**Saves.** About half of the 244-line file. It drops `optional_string`/`optional_u32`, the 18-line export list and one native export. Each new native function becomes one annotated fn instead of fn + marshalling + export line. If merged with the lib crate (see the two-crate finding), the annotations can sit on the lib's functions and the binding file goes away.

**Risk.** `Option` returned through `TryIntoJs` becomes `undefined`, not `null`. The consumers of outputFormat, outputOptions and linuxAudio test truthiness (MicrophoneSetting.tsx:124,170; Settings.tsx:932), so they keep working, but the global.ts types should say `| undefined`. Error messages keep their Display text. The e2e fake in the preload is unaffected. The JS names must be kept exactly with `name = "..."`.

**Verifier.** The facts hold. neon 1.1.1 is locked, linkme is a required dependency of neon, `#[neon::export]` exists, `Option<T>` extraction maps null/undefined to None, and `extract::Error` throws the cause's Display text, so the "os error 5" check in src/main/index.ts:69 still matches. Nothing in notes/ or git history explains the hand-written style: it is neon's pre-1.0 API, carried over from the 2023 split (6914390). The saving is overstated, though. `TryIntoJs for Vec<T>` (types_impl/extract/buffer.rs:84) only covers typed arrays: `Vec<u32>` becomes a Uint32Array and `Vec<String>` has no impl. MicrophoneSetting.tsx:96 renders `choices.map(v => <option>)`, and on a Uint32Array that map returns a typed array, which breaks the rate and buffer selects. `Boxed<T>` extraction needs `T: Clone`, which `RefCell<InputDevice>` is not. So inputDevices, outputDevices, outputOptions, linuxAudio and getPitch all stay hand-built (about 80 lines) unless the serde feature is turned on, and that adds serde_json, which is not in Cargo.lock. The real saving is about 70 lines (about 30%): the two optional_* helpers, the 18-line export list, exclusiveAvailable, and short bodies for the setters and getters. The parts that actually changed recently (linuxAudio, outputOptions) are objects that stay hand-built. The change is worth making but small, hence low.

## oe-native-5

**Two crates and a workspace, but the 'pure' lib depends on neon anyway, and both features are declared twice** (over-engineering, WEAK, low) · `native/karafriends-lib/Cargo.toml:13`

**Now.** `karafriends-lib` (rlib, all logic and tests) and `karafriends` (cdylib, bindings), joined by a workspace. The lib depends on neon only to `impl Finalize for InputDevice` (lib.rs:73, 405). `asio` and `pipewire` are defined in both manifests (karafriends/Cargo.toml:22-26 forwarding to karafriends-lib/Cargo.toml:49-57), and so is `default`.

**Why it's more than needed.** The split (6914390, 2023) doesn't keep neon out of the lib. neon 1.1 loads N-API at runtime with `libloading::Library::this()` (neon-1.1.1/src/sys/bindings/functions.rs:432-436), so a crate that links neon already runs `cargo test` fine, as the lib's tests show today. The second crate only adds a boundary: everything is `pub`, and each feature is forwarded.

**Simpler shape.** One crate with `crate-type = ["cdylib", "rlib"]` (or just cdylib) and the bindings as a `neon.rs` module. Features are declared once, and items become `pub(crate)`. At the least, move `Finalize` into the binding crate with a newtype so the lib drops neon.

**Saves.** One Cargo.toml (26 lines), the workspace, the duplicated feature and default lists, and the public API surface between the crates.

**Risk.** The `cargo-cp-artifact --npm cdylib` name and the CI `rust-cache` `workspaces: native` path need checking. Test build time rises slightly because the cdylib is also built.

**Verifier.** True: the lib uses neon only for `impl Finalize for InputDevice` (lib.rs:73 and 405), and the asio, pipewire and default features are each declared twice. The cost is small: one 26-line manifest, a 7-line workspace file and three forwarding lines. Splitting into a tested lib plus a thin binding crate is a common neon layout, and the split doesn't get in the way of anything. A merge has to keep the crate name `karafriends`, because `cargo-cp-artifact --npm cdylib` picks the cdylib by the npm package name. The `-Wl,-z,lazy` build.rs, the clippy/test/careful scripts and rust-cache's `workspaces: native` would all keep working. The newtype alternative adds a type to save one dependency line. It is marginal churn for a small conceptual gain.

## oe-native-6

**`win32console` (and `winapi` through it) is pulled in for two calls the `windows` crate already provides** (over-engineering, KEEP, low) · `native/karafriends/Cargo.toml:17`

**Now.** The binding crate depends on `win32console 0.1.5` for `WinConsole::alloc_console()` and `set_title()` (karafriends/src/lib.rs:8-19). Cargo.lock shows win32console as the only dependent of `winapi`.

**Why it's more than needed.** `windows 0.62` is already a Windows dependency of karafriends-lib (Cargo.toml:21-31). `AllocConsole` and `SetConsoleTitleW` are in its `Win32_System_Console` feature.

**Simpler shape.** Add `Win32_System_Console` to the existing `windows` features and call `unsafe { AllocConsole()?; SetConsoleTitleW(w!("karafriends native console"))? }`, from a lib function or with `windows` in the binding crate.

**Saves.** Two crates (win32console and all of winapi's compile) in the Windows build.

**Risk.** src/main/index.ts:69 ignores the error by matching "os error 5". A `windows::core::Error` prints "Access is denied. (0x80070005)", so either map it through `std::io::Error::last_os_error()` or change that check.

**Verifier.** Confirmed. Cargo.lock shows win32console as the only dependent of winapi. win32console's alloc_console and set_title are thin wrappers that return `io::Error::last_os_error()` on failure (console.rs:527-619). windows 0.62 is already built for the lib, and AllocConsole and SetConsoleTitleW are in `Win32_System_Console`. The code stays the same size and the Windows build drops two third-party crates. The reviewer's risk note is right and is the only care needed: keep the "os error 5" text (src/main/index.ts:69), either by mapping the error with `std::io::Error::last_os_error()` or by matching "Access is denied" in JS. This can't be built here for MSVC with the feature, so it needs a Windows check.

## oe-display-3

**nativeAudio.ts: eight one-line pass-throughs to window.karafriends.nativeAudio, each with one caller, that re-declare global.ts's types and comments** (over-engineering, WEAK, low) · `src/renderer/nativeAudio.ts:9`

**Now.** outputDevices, setOutputDevice, setMicMode, exclusiveAvailable, linuxAudio, refreshInputDevices, outputOptions, outputFormat and asioStatus each just call `native.x()`. The file also re-declares the `LinuxAudio` interface and the outputOptions return type that global.ts already types, and repeats each doc comment from global.ts (and from src/preload/index.ts).

**Why it's more than needed.** grep shows each wrapper has exactly one caller (Settings.tsx, MicrophoneSetting.tsx or App.tsx). They add nothing except unpacking MicOutput and MicMode into arguments. The layer isn't used consistently either: App.tsx:151 and MicrophoneSetting.tsx:47 call `window.karafriends.nativeAudio.inputDevices()` directly. Adding one native call today means editing lib.rs, the preload (real and fake), global.ts and nativeAudio.ts.

**Simpler shape.** At most: keep the doc comments only in global.ts, name LinuxAudio and OutputOptions there and re-export them, and either call native.x() directly or leave the one-liners in place. Keep InputDevice, channelLabel, inputLabel, setOutputDevice and setMicMode.

**Saves.** About 50 lines, one of the three copies of every native-API comment, and one fewer file to touch per native call.

**Risk.** Low, because the types are checked at compile time. The e2e tests fake audio at the preload (KARAFRIENDS_FAKE_AUDIO), so they're unaffected.

**Verifier.** True, but marginal. setOutputDevice and setMicMode each have two call sites (App.tsx 148/306 and 149/344) and turn the MicOutput/MicMode objects that App's saved state uses into arguments, so they earn their place, as the finding allows. That leaves seven one-line wrappers: about 35 lines of trivial code with no behaviour and no bugs. The real cost is the duplicated comments, which have already drifted ('buffer size in frames' in global.ts against 'samples' in nativeAudio.ts). The types LinuxAudio, MicOutput and MicMode are imported by App.tsx and MicrophoneSetting.tsx, so one named home is still needed whichever file it is. Saving one file per new native call is small next to lib.rs, the real and fake preloads and global.ts.

## oe-architecture-9

**The native audio API goes through four hand-written layers, so one new native function touches seven places** (over-engineering, WEAK, low) · `src/renderer/nativeAudio.ts:9`

**Now.** Each native function is written as a Rust neon binding (native/karafriends/src/lib.rs), a preload pass-through (some are bare references, others rewrap the same arguments, e.g. setOutputDevice(name, rate, bufferSize) { return nativeAudio.setOutputDevice(name, rate, bufferSize) }), a Windows fake and a Linux fake in the preload, a global.ts type with the same comment again, and a renderer free function that only forwards (outputDevices, setMicMode, exclusiveAvailable, linuxAudio, refreshInputDevices, outputOptions, outputFormat, asioStatus, setOutputDevice).

**Why it's more than needed.** Adding linuxAudio and refreshInputDevices (commits 96b39bc and 782e659) meant editing the binding, the preload's real object and both fakes, global.ts and nativeAudio.ts. Nine of the renderer wrappers add nothing beyond renaming an object into positional arguments. The preload's integer-handle table for InputDevice is needed, since boxed native handles can't cross contextBridge. The pass-throughs are not.

**Simpler shape.** At most: make the preload's setOutputDevice and setMicMode bare references like the others, and have callers use window.karafriends.nativeAudio (or a typed `native` export) for the 7 pure forwarders. Keep the explicit preload object, InputDevice, channelLabel and the two object-taking helpers.

**Saves.** About 70 lines of forwarding in nativeAudio.ts and about 20 in the preload. A new native function then touches about 4 places instead of 7.

**Risk.** Callers of setOutputDevice and setMicMode change from an object argument to positional arguments, or keep two small helpers. The behaviour is unchanged.

**Verifier.** The pass-throughs are real but marginal. The 7 pure forwarders in nativeAudio.ts (outputDevices, exclusiveAvailable, linuxAudio, refreshInputDevices, outputOptions, outputFormat, asioStatus) and the preload's setOutputDevice/setMicMode rewraps are about 50 lines with their comments. The global.ts types, the Windows fake, the Linux fake (when it differs) and the Rust binding all stay. So a new native function goes from about 6 places to about 5, not 4: 782e659 touched nativeAudio.ts for 24 of its 278 lines. The proposed 'spread the native module' is wrong for a contextBridge. It would expose allocConsole and the raw inputDevice_* functions, whose boxed handles can't cross the bridge. The preload's explicit allow-list is the right shape. setOutputDevice and setMicMode take the MicOutput/MicMode objects that App.tsx keeps in state and localStorage, so those two small helpers earn their place.
