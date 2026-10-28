# Phase G: Key change rewrite

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/renderer/audio/phazeAudioWorklet.ts, its new tests, and the pitch-shift part of src/renderer/webAudio.ts (pitchShift, the worklet load).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                                     | Severity                     | Title                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [renderer-audio-1](#renderer-audio-1)                       | High                         | Key change moves each peak by whole FFT bins, so low notes shift by the wrong interval or not at all                                              |
| [renderer-audio-2](#renderer-audio-2)                       | Medium                       | Key down reads the scratch half of the FFT buffer above Nyquist and adds loud high-frequency junk                                                 |
| [gap-song-output-lifecycle-5](#gap-song-output-lifecycle-5) | Medium                       | The vocoder gets about 3x slower on the audio thread over a party: timeCursor grows forever and its trig leaves V8's fast range                   |
| [renderer-audio-6](#renderer-audio-6)                       | Low                          | Moving the key off 0 drops ~37 ms of song; while shifted, the music runs ~40 ms behind the lyrics, pitch bars and scoring                         |
| [renderer-audio-8](#renderer-audio-8)                       | Low                          | Generic OLA wrapper for a fixed 1-in/1-out stereo node, with a dead branch, a debug log and no test                                               |
| [oe-display-9](#oe-display-9)                               | Over-engineering (WEAK, low) | Vendored phaze worklet: a general N-input/N-output overlap-add base with one subclass, and a type shim kept only to keep a @ts-expect-error valid |
| [oe-display-7](#oe-display-7)                               | Over-engineering (KEEP, low) | webAudio.ts wraps the one addModule promise in three error handlers                                                                               |

## renderer-audio-1

**Key change moves each peak by whole FFT bins, so low notes shift by the wrong interval or not at all** (high, confirmed, bug) · `src/renderer/audio/phazeAudioWorklet.ts:379`

**Summary.** The vocoder moves each spectral peak by a whole number of bins, Δ = round(k·factor) − k, and rotates its phase to match (:379, :409-412). Each output frequency is f + Δ·fs/2048 (23.4 Hz at 48 kHz) instead of factor·f. At ±1, nothing below about 199 Hz moves; at ±2, nothing below about 105 Hz moves, and notes just above that jump by far more than asked (110 Hz at +2 rises 3.34 st). The mids move by 1.2–1.9 st at ±1. The result is a key-changed backing track whose bass is out of key with its chords and whose harmonics are no longer harmonic. This applies to every source (DAM, Joysound, YouTube, Niconico) whenever the key is not 0.

**Scenario.** A guest sets the key to +1. Everything whose peak bin is ≤ 8 (≈ below 190–200 Hz: the bass line, low piano, low male voices) stays in the original key while the mids and highs move up a semitone. At +2, a 110 Hz bass note rises 3.35 semitones and its fifth (165 Hz) rises 2.26, so the fifth (ratio 1.5) comes out at a ratio of 1.412, close to a tritone. ±1 and ±2 are the most common key changes.

**Suggested fix.** Shift by the ratio, not by whole bins. Estimate each bin's (or peak's) true frequency from the frame-to-frame phase difference, then build the synthesis phase from factor × true frequency, accumulated per hop (the Bernsee smbPitchShift scheme, or Laroche–Dolson peak shifting with per-peak phase accumulators). Alternatively, use a proven shifter such as SoundTouch's AudioWorklet port or Rubber Band in WASM. A bigger FFT only halves the error. Add a node --test that runs 110/220/440 Hz tones through the processor and checks the shift in cents.

**Earlier reviews.** New. The earlier reviews only covered the vocoder's level and bypass (product review #1, fixed).

**Verifier.** CONFIRMED: shiftPeaks moves each region by the integer Δ = round(k·factor) − k, and the phase term 2π·Δ·timeCursor/fftSize, which advances 2π·Δ·128/2048 per hop, adds a fixed Δ·sr/N Hz. So output = f_in + Δ·23.4 Hz, not factor·f_in. I checked this with my own harness (scratch verify-renderer-audio/h.mts + shift.mts, real worklet with two fake globals, Hann-weighted DFT peak search). Semitones measured at ±1: 82.4/110/150/196 Hz → 0.00–0.01, so no shift at all below about 200 Hz. 110 Hz at +2 → +3.35 and at −2 → −4.16. 220 Hz at ±1 → ±1.76/−1.96. 440 Hz at ±1 → ±0.90/−0.95. 660 Hz at +1 → +1.18. The key resets to 0 for each song and is moved mid-song by guests, and ±1/±2 are the usual changes. At those, the bass and low harmonics stay put or move by the wrong interval while the mids move roughly right, so the backing track is out of tune with itself. No note or test mentions it. The rating stays high. | CONFIRMED: I tried to refute this and couldn't: the trigger is reachable and the defect is audible.

**Trigger path.** A guest taps ♯ or ♭ in the phone remote (`KeyStepper` in `PlaybackControls.tsx`), which calls `setPitchShiftSemis`. On the server, `api.ts:835` stores the value in live state without clamping it. On the display, `useSongPlayer.ts:423` calls `audio.pitchShift(semis)`, and `webAudio.ts:115-119` sets `pitchFactor = 2^(semis/12)` and routes the song through the vocoder whenever semis ≠ 0. This applies to every source: DAM, Joysound, YouTube and Niconico. No source has a server-side key change that would skip the vocoder.

**Mechanism.** At `phazeAudioWorklet.ts:379` the code computes `peakIndexShifted = Math.round(peakIndex * pitchFactor)`. At `:409-412` it rotates each moved bin's phase by `2π·(binIndexShifted − binIndex)·timeCursor/fftSize`, with timeCursor advancing 128 samples per hop. Each peak is therefore moved by a whole number of bins Δ, so its frequency becomes f + Δ·fs/2048 instead of factor·f. The worklet never uses sampleRate, so a bin is 23.44 Hz at 48 kHz and 21.53 Hz at 44.1 kHz.

**Thresholds.** At ±1, Δ = 0 for any peak bin ≤ 8, so nothing below about 199 Hz moves. At ±2, Δ = 0 for bins ≤ 4, so nothing below about 105 Hz moves.

**My own harness.** It is separate from the finder's: fake `AudioWorkletProcessor`/`registerProcessor` globals, the real module loaded through tsx, and output peaks measured with a 2^18-point Hann FFT with parabolic interpolation. The scripts are in /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-renderer-audio-1/ (`lib.mts`, `single.mts`, `complex.mts`); run them from the repo with `node --import tsx <file>`. As a control, factor 1 returns 110.00 Hz unchanged.

At 48 kHz, single tones:

- 82.4, 110, 146.8 and 196 Hz at ±1 move 0.00 st (should move 1).
- 82.4 Hz at ±2 moves 0.00 st.
- 110 Hz at +2 comes out at 133.4 Hz (+3.34 st); at −2 it comes out at 86.6 Hz (−4.15 st).
- 220 Hz at −1 comes out at 196.6 Hz (−1.95 st); at +1, 243.4 Hz (+1.75 st).
- 440 Hz and above land within about 5–25 cents.

44.1 kHz behaves the same way: for example, 196 Hz at −1 moves −2.01 st.

Two realistic signals:

- **A2 bass with 8 harmonics at +1.** The fundamental stays at 110 Hz while the harmonics go to 243.4, 353.4, 463.4… Hz, so the note is no longer harmonic (2nd harmonic at 2.21× the fundamental).
- **A2 under an A major triad (A3, C#4, E4).** At +1 the bass stays put and the chord tones move by 1.75, 1.41 and 1.19 st. The bass-to-A3 octave becomes 13.75 st, and the triad's own intervals are 22–34 cents off. At +2 the bass rises 3.34 st while A3 rises 1.75 st, so the octave becomes 10.41 st.

The finder's figures match mine; I measured 3.34 st where they report 3.35.

**Severity.** Key changes of ±1 and ±2 are the main use of this feature, and they leave the bass a semitone or more out of key with the band and the chords detuned by tens of cents. That is "a feature audibly breaks in a common situation", so high stands.

**Context.**

- The code comes from upstream phaze (commit 4409694), so this is a long-standing limitation, not a regression from recent work.
- Neither earlier review mentions it.
- No test covers the worklet.
- The file and line are correct: :379, with the phase rotation at :409-412.
- The summary is accurate. Its "per sample" phrasing is equivalent to the code's per-hop `omegaDelta·timeCursor`.
- The suggested fix is sound: estimate each bin's true frequency from the frame-to-frame phase difference and accumulate synthesis phase at factor × that frequency, either Bernsee-style or Laroche–Dolson with fractional shifts and per-peak phase accumulators. The 16× overlap already in the code suits this. Or use a proven library such as SoundTouch or Rubber Band. Add a cents-accuracy test over 82–440 Hz.

**Also reported as** (The vocoder shifts by whole bins. gap-song-output-lifecycle-4 adds pinning the context to 48 kHz as a cheap first step.):

- gap-song-output-lifecycle-4: Key change leaves the bass in the old key at ±1 semitone and mistunes 200-600 Hz; at a 96/192 kHz context it barely shifts the melody (`src/renderer/audio/phazeAudioWorklet.ts:379`). Its fix: Two levels.
- Cheap: pin the context, `new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })`, so the vocoder never runs coarser than at 48 kHz. Chromium resamples to the device. The alternative is to scale BUFFERED_BLOCK_SIZE by sampleRate/48000, rounded to a power of two.
- Real fix for the quantisation: estimate each peak's true frequency from the phase advance between hops, and synthesise at that frequency times pitchFactor (the standard phase-locked vocoder, Laroche-Dolson) instead of rounding to whole bins. Or swap in a proven shifter (SoundTouch, Rubber Band as WASM).
  Add a node unit test like the sweep above, asserting each tone lands within, say, ±15 cents.

## renderer-audio-2

**Key down reads the scratch half of the FFT buffer above Nyquist and adds loud high-frequency junk** (medium, confirmed, bug) · `src/renderer/audio/phazeAudioWorklet.ts:387`

**Summary.** For the last peak, endIndex = fftSize (2048), and with pitchFactor < 1 the only break (binIndexShifted ≥ 1025) lets binIndex reach 1024+|Δ|. That reads bins of freqComplexBuffer that fft.js's realTransform never finalises (they hold partial butterfly sums carrying full-band energy) and copies them just above the shifted last peak. The first peak's region also writes NaN to negative named keys on the plain Array. With a full-band noise floor (last peak near bin 1022), the junk is at about −13 to −15 dB relative to the music: in 20–24 kHz at −1 to −3, 19–20 kHz at −4, 18–19 kHz at −5, 17–18 kHz at −6, 16–17 kHz at −7 and 12–16 kHz at −12. It is audible from about −5/−6 downward, depending on the listener's age. Smaller key-downs send it to the tweeters as ultrasonic noise.

**Scenario.** A male guest sets −5 or −7 for a female song. The output gains junk at −13/−14 dB relative to the music, in 17–20 kHz (−5) or 14–17 kHz (−7): an audible hiss or whine that wasn't in the song (the input sits at −53 dB in those bands). At −12 the junk is in 12–16 kHz. At −1 to −3 it sits at 20–24 kHz, about 40 dB above the input: inaudible to most but sent to the TV's tweeters. It also costs about 35% more CPU at key down.

**Suggested fix.** `let endIndex = this.magnitudes.length;`, and inside the j loop `if (binIndexShifted < 0) continue;`. Both are verified in the scratch patched.ts. The test proposed in the first finding should also check that band energy above the input's bandwidth stays put at key down.

**Earlier reviews.** New.

**Verifier.** CONFIRMED: Traced: line 387 sets endIndex = this.fftSize. The j loop only breaks on binIndexShifted >= magnitudes.length, so with factor < 1 binIndex passes 1024. fft.js _realTransform4 only finalises the lower half, and completeSpectrum later overwrites only the shifted buffer's upper half, so the junk reaches the output. My harness (bands.mts, bands_fine.mts: 220 Hz sawtooth to 8 kHz plus a −60 dB floor) gave these levels relative to <8 kHz. Input: about −58 to −64 dB in every high band. −1: 20–24k −12.4. −3: 20–24k −12.9. −4: 19–20k −13.8. −5: 18–19k −14.1. −6: 17–18k −14.3. −7: 16–17k −14.7. −12: 12–16k −14.7. Negative-index keys numbered 38 at −1 and 336 at −12. With the two-line patch (endIndex = magnitudes.length; continue when binIndexShifted < 0, scratch patched.ts), every band went back to the input level or below. Timing also matches the claim: at −2 the original costs 190–209 µs per stereo quantum against 143–156 patched. The finding's 17–20k/14–17k bands are a little low but the mechanism and levels hold. Key-downs of −5 to −7 (men singing female songs) are common. The rating stays high, though −1 to −4 key-downs only send ultrasonic energy. | CONFIRMED: I traced it by hand and then measured it with my own harness. The harness runs the real worklet module in Node with fake AudioWorkletProcessor/registerProcessor globals, fed in 128-sample quanta, next to a sed-patched copy with the two-line fix.

Why it happens: webAudio.ts sends the song through the vocoder whenever semitones ≠ 0, with pitchFactor = 2^(s/12). The remocon KeyStepper has no clamp, and validate.ts allows ±24, so −12 is reachable. At line 387, the last peak's endIndex is this.fftSize, so endOffset = 2048 − P. In the loop at lines 400–406, binIndexShifted = round(P·f) + j < binIndex. It breaks only at binIndexShifted ≥ 1025, which leaves binIndex = P + j up to 1024 + P(1−f). That is past Nyquist on every frame that has any peak, because noise and window leakage make peaks near bin 1020 in practice.

fft.js 4.0.4: fftSize 2048 gives width 11 and len=4 initial butterflies, then radix-4 stages. In every stage after the first, each block's loop writes only offsets 0..len/2 (A, B, the C midpoint, SA, SB). So final bins 1025–1280 keep the step-8 stage's 512-point sub-DFTs of the input decimated by 4. Those are aliased copies of the song's main 0–6 kHz energy at about −12 dB. The finder's "144 nonzero bins" came from a two-sine test input, which is sparse by construction. Real music fills these bins.

Measured, with scripts bands.mts and extra.mts in scratchpad/review/repro-renderer-audio-2. Inputs were a real 48 kHz recording (victory.wav from the pulseaudio crate's test files), the AAC soundtrack of a local mp4, and a synthetic pop mix low-passed at 16 kHz. All three gave the same pattern. The current code adds a band about −22 dB relative to the input total, while the vocoder output itself sits at about −9 dB. It lands at 20–24k for −1 to −3, 18–20k for −4/−5, 16–18k for −7 and 12–14k for −12, with weaker spill above each. The fixed copy leaves those bands at −100 to −160 dB, the same as or lower than the input. Junk RMS relative to the fixed output is −13.0 to −13.4 dB at −3, −5, −7 and −12, and it raises the peak by about 8%. Key up (+2, +5) is identical in both versions. The negative-index properties are confirmed: 8, 34 and 66 keys at −1, −5 and −12, all NaN. The FFT never reads them, so they are hygiene only. Stereo timing: 242 vs 208 µs per quantum at −5 and 256 vs 204 at −12, about 15–25% more, not 35%.

Severity: medium rather than high. The common key-down settings, −1 to −5, put the junk at 18–24 kHz on a typical 48 kHz output, which most adults can't hear and many TV speakers roll off. It becomes audible as a music-correlated sizzle at about −6/−7 for younger guests (16 kHz+). At −12 (12–14 kHz) nearly everyone would hear it. So it is a real, always-present corruption of the output that is clearly audible only on the less common deeper key-downs, plus a modest CPU cost that stays within budget.

Corrections to the finding: the band edges for −5 and −7 are wrong for 48 kHz. The junk starts at f·Nyquist (−5 → 18 kHz, −7 → 16 kHz). The negative-index writes don't affect the audio. The CPU overhead is about 15–25%.

## gap-song-output-lifecycle-5

**The vocoder gets about 3x slower on the audio thread over a party: timeCursor grows forever and its trig leaves V8's fast range** (medium, confirmed, performance) · `src/renderer/audio/phazeAudioWorklet.ts:316`

**Summary.** timeCursor grows forever from launch (the worklet is pulled every quantum even at key 0). Within about 10 minutes the shiftPeaks cos/sin arguments exceed V8's fast range, and the trig cost per quantum rises from about 0.04 to about 0.33 ms (stereo), so the vocoder costs about 3x while a key change is on. `timeCursor %= fftSize` gives identical output.

**Scenario.** An hour into the party, a key change makes each 128-frame quantum (2.67 ms of budget at 48 kHz) cost about 0.41 ms instead of 0.14 ms for stereo on this Alder Lake laptop. On a low-end mini PC driving the TV, that is a real slice of the real-time thread, on top of the rest of the graph, so crackles become more likely the longer the app has run.

**Suggested fix.** `this.timeCursor = (this.timeCursor + this.hopSize) % this.fftSize;` is a one-line change with identical output. Optionally go further: the angle is 2π·((Δbin·timeCursor) mod N)/N, so a 2048-entry cos/sin table indexed by that removes every trig call from shiftPeaks.

**Earlier reviews.** New.

**Verifier.** CONFIRMED: timeCursor += hopSize at line 316 never wraps. The vocoder node is always connected to the destination and process() returns true, so it is pulled every quantum and the cursor advances from launch even at key 0, when it has no inputs.

V8's fdlibm sin and cos switch to slow argument reduction beyond about 2^19·π/2 rad, and arguments of 2πΔ·t/2048 with Δ up to about 60 cross that within minutes.

I benchmarked just the shiftPeaks trig (stereo, 1023 bins, key +2, ms per quantum; scratch script trig.mjs):

- fresh: 0.038
- 2 min: 0.127
- 10 min: 0.296
- 1 h: 0.330
- 4 h: 0.338
- wrapped (t % 2048): 0.038 at every uptime
  That is about +0.29 ms of a 2.67 ms quantum on the real-time thread, consistent with the finder's 0.14 → 0.41 ms for the whole process().

Wrapping is exact, because Δ is an integer and t is a multiple of 128, so the phase is periodic with period 2048.

Timing correction: the slow regime is reached about 10 minutes after launch, not gradually over a party. 'Crackles become more likely' is speculative on decent hardware, but a 3x cost on the audio thread with a one-line fix counts as noticeable.

## renderer-audio-6

**Moving the key off 0 drops ~37 ms of song; while shifted, the music runs ~40 ms behind the lyrics, pitch bars and scoring** (low, confirmed, realtime-audio) · `src/renderer/webAudio.ts:117`

**Summary.** pitchShift() hard-swaps songVolumeNode between bypassGain and the vocoder. While bypassed, the worklet's input has 0 channels, so reallocateChannelsIfNeeded throws its history away (and allocates about 35 KB of new buffers on the audio thread). The first shift therefore plays silence until 2048 samples have filled. The vocoder's ~40 ms latency is then not accounted for anywhere, and going back to 0 skips 40 ms.

**Scenario.** A guest taps +1 mid-song: about 37 ms of silence and a click, then the music continues 40 ms later than the video, the lyric wipe, the pitch bars and pitchTime's scoring window, which still use avOffsetMs alone. Tapping back to 0 skips 40 ms of the song with a click.

**Suggested fix.** While semis ≠ 0, subtract the vocoder latency (≈ (2048 − 128)/sampleRate) from the offset passed to drawTime/pitchTime. Switch with two gains: connect the vocoder, let it prime for one window, then crossfade over ~10 ms. On empty input, have the worklet write silence and keep its buffers instead of reallocating. Also skip the disconnect/connect when the target node is unchanged (±1 → ±2 rewires the graph needlessly).

**Earlier reviews.** The bypass came from product review #1 (level part fixed). The switch's dropout and the latency compensation weren't covered.

**Verifier.** CONFIRMED: pitchShift() disconnects songVolumeNode and connects either the vocoder or bypassGain. In bypass the vocoder's input is unconnected, so inputs[0] is [] and reallocateChannelsIfNeeded rebuilds the buffers (about 34 KB of input plus 33 KB of output Float32Arrays, on the audio thread, on both edges). On reconnect it starts from zeros. My harness (switch.mts: 40 connected quanta, 20 with inputs [[]] and a 1-channel output, then reconnected at +1) printed peaks 0.00 for 14 quanta (about 37 ms), then 0.06 and 0.20 at steady level. That is a hard cut to silence, then the music resumes about 40 ms (1920 samples) late. playback.ts drawTime and pitchTime use only offsetMs, and nothing else compensates the vocoder (webAudio.ts:107-109 acknowledges 44 ms). Going back to 0 cuts the vocoder and jumps the bypass about 40 ms ahead. The key resets to 0 for each song, so every key change happens mid-song. The impact is small: a short gap and click, and an A/V lag under the usual lip-sync tolerance.

## renderer-audio-8

**Generic OLA wrapper for a fixed 1-in/1-out stereo node, with a dead branch, a debug log and no test** (low, confirmed, maintainability) · `src/renderer/audio/phazeAudioWorklet.ts:120`

**Summary.** No unit test runs a signal through phazeAudioWorklet.ts, although it runs under Node with two fake globals (AudioWorkletProcessor, registerProcessor). Both DSP bugs above (renderer-audio-1, -2) went unnoticed for that reason. The rest is small cleanup. readInputs' 'paused' branch (:122) is dead: channel arrays are always 128 frames, and an unconnected input is [], which the `inputs[0].length &&` guard skips. The constructor's 'audio worklet module loaded haha' log (:279) ships. The generic N-input/N-output OLA wrapper, with a reallocation check on every process() call, serves a node the app only builds 1-in/1-out, and that reallocation is part of renderer-audio-6.

**Scenario.** Both high-severity bugs above, the pitch error and the above-Nyquist read, survived because nothing runs a tone through the processor. The generic paths also add the audio-thread reallocation behind the key-switch dropout.

**Suggested fix.** Fold OLAProcessor into one class with 2-channel buffers preallocated in the constructor. Create the AudioWorkletNode with `outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit"` (webAudio.ts:83) so the channel count never changes. On an empty input, write silence and return. That removes roughly 100 of the 433 lines. Add phazeAudioWorklet.test.ts built on the harness: tones in, check the shift in cents and the band energy.

**Verifier.** CONFIRMED: I checked each fact. A repo-wide grep (src, tests, native, configs, excluding build, dist and node_modules) finds phazeAudioWorklet or phase-vocoder only in webAudio.ts, audioworklet.d.ts and the worklet itself, so no test touches it. My harness needed only the two fake globals. :122's condition can't be true per the Web Audio spec. :279's console.log runs in the constructor (my harness printed it for every node). writeOutputs (:143-150) loops over nbInputs and inputBuffers to write outputs[i][j], as stated. webAudio.ts:83 creates the node with default options, so channel counts follow the input and the reallocation path runs on every bypass toggle. A regression test (tones in, shift in cents and band energy checked) is clearly worth adding given the two confirmed DSP bugs. The class fold is optional tidying, best done alongside that fix.

## oe-display-9

**Vendored phaze worklet: a general N-input/N-output overlap-add base with one subclass, and a type shim kept only to keep a @ts-expect-error valid** (over-engineering, WEAK, low) · `src/renderer/audio/phazeAudioWorklet.ts:9`

**Now.** OLAProcessor loops over nbInputs × nbOutputs, reallocates buffers when channel counts change, keeps head/to-send copies, and has an abstract processOLA (`console.assert(false, "Not overriden")`). There is one subclass, which feeds blockSize back to it through processorOptions. A leftover `console.log("audio worklet module loaded haha")` sits at line 279. audioworklet.d.ts declares AudioWorkletProcessor without a constructor on purpose, so that the `@ts-expect-error` on `super(options)` stays valid.

**Why it's more than needed.** webAudio.ts creates exactly one 'phase-vocoder' node with one input and one output, so the base class's generality is never used. The shim and the expect-error exist only to keep each other compiling.

**Simpler shape.** Now: change `super(options)` to `super()`, drop the @ts-expect-error and the shim comment's sentence about keeping it valid, and drop console.log("audio worklet module loaded haha"). Leave OLAProcessor alone unless the DSP is being reworked anyway, and then only with a listening test at keys 0 and ±n, keeping the /nbOverlaps scaling that VOCODER_LEVEL is calibrated on.

**Saves.** 3 lines now; about 60 lines if the base class is merged in.

**Risk.** This is the real-time audio path. Merging must keep all allocation out of process() and keep the /nbOverlaps scaling, because VOCODER_LEVEL (0.375) in webAudio.ts is calibrated on it. Only do it with a listening test at keys 0 and ±n.

**Verifier.** True, but these are the vendored generalities of olvb/phaze on a real-time audio path that nobody is changing. Merging the OLA base would save about 60 lines of stable code and cost a listening test, so it isn't worth doing on its own, as the finding itself says. One correction to the 'now' fix. In the Web Audio spec, the AudioWorkletProcessor constructor takes no arguments (`constructor()`), and the options go only to the subclass. So the shim's parameterless declaration is correct, and widening it to constructor(options) would misstate the platform.

## oe-display-7

**webAudio.ts wraps the one addModule promise in three error handlers** (over-engineering, KEEP, low) · `src/renderer/webAudio.ts:77`

**Now.** `try { audioWorklet.addModule(url).then(() => { try { new AudioWorkletNode…; connect; pitchShift } catch {…} }).catch(…) } catch {…}`. That is a synchronous try, a try inside .then, and a .catch, each logging a different message.

**Why it's more than needed.** An error thrown inside .then already ends up in the .catch. The outer synchronous try could only fire if `audioWorklet` were missing, and Electron's Chromium always has it on the display's page.

**Simpler shape.** As proposed: audioWorklet.addModule(url).then(() => { this.vocoderNode = new AudioWorkletNode(this.audioContext, "phase-vocoder"); this.vocoderNode.connect(this.audioContext.destination); this.pitchShift(this.semitones); }).catch((e) => console.error("Couldn't load the pitch shift worklet; key changes won't work:", e));

**Saves.** About 15 lines and two meaningless log messages ('An unexpected error occurred').

**Risk.** None known. If audioWorklet were ever missing, the constructor would throw instead of logging, and that can't happen in this Electron build.

**Verifier.** Verified. A throw inside .then already reaches .catch. The outer synchronous try came from 0fb3fc8 (2023, 'Fix crashes when joysound/dam not available'), which wrapped many calls defensively. The only worklet-specific fix, 6f12cc4 (2024), changed the worklet URL, not the error handling. audioWorklet exists only in secure contexts, and the display always runs in one: production loads file:// (pathToFileURL in src/main/index.ts:108), dev loads the localhost Vite server, and e2e uses Electron's firstWindow. So the outer catch can't fire. Error behaviour stays the same: either way, a failure in AudioWorkletNode or pitchShift leaves the song on the bypass path.
