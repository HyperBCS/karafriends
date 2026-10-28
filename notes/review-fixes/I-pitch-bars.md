# Phase I: Display: pitch bars and guide melody

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/renderer/PianoRoll.tsx, src/renderer/Player.tsx, src/renderer/shaders/_, src/renderer/useGuideMelody.ts, guideMelody_.ts, melody.ts, package.json (two dependencies out).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                         | Severity                        | Title                                                                                                                                   |
| ----------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [gap-long-party-gpu-1](#gap-long-party-gpu-1)   | Medium                          | A lost or missing WebGL2 context makes PianoRoll's effect throw, and the ErrorBoundary takes the whole display down                     |
| [renderer-pianoroll-3](#renderer-pianoroll-3)   | Medium                          | Reading a Joysound guide melody fetches the whole video file and decodes every channel at full rate at song start, with no cancellation |
| [renderer-pianoroll-4](#renderer-pianoroll-4)   | Medium                          | A DAM song without scoring data still shows the pitch bars as an empty, dimmed band over the top of the video for the whole song        |
| [renderer-pianoroll-2](#renderer-pianoroll-2)   | Low                             | The mic trace grows without bound while the video stalls, and the whole trace is re-converted and re-uploaded every frame               |
| [renderer-pianoroll-5](#renderer-pianoroll-5)   | Low                             | The roll's drawing buffer follows only window resizes, not resizes of its container                                                     |
| [renderer-pianoroll-6](#renderer-pianoroll-6)   | Low                             | The song's last note never becomes the current note, so its trace can fold an octave off                                                |
| [renderer-pianoroll-7](#renderer-pianoroll-7)   | Low                             | median() sorts MIDI numbers as strings                                                                                                  |
| [renderer-pianoroll-9](#renderer-pianoroll-9)   | Low                             | Four copy-pasted program classes, a state cache that never caches, and a full GL rebuild on every key change                            |
| [renderer-pianoroll-10](#renderer-pianoroll-10) | Low                             | PianoRoll's pure logic has no tests                                                                                                     |
| [oe-display-2](#oe-display-2)                   | Over-engineering (KEEP, medium) | PianoRoll: an abstract generic ShaderProgram class with four one-instance subclasses, and a bind-once check that never hits             |
| [oe-display-8](#oe-display-8)                   | Over-engineering (KEEP, low)    | Two runtime dependencies (plus a types package) are used for three one-line maths calls in PianoRoll                                    |

## gap-long-party-gpu-1

**A lost or missing WebGL2 context makes PianoRoll's effect throw, and the ErrorBoundary takes the whole display down** (medium, confirmed, bug) · `src/renderer/PianoRoll.tsx:530`

**Summary.** PianoRoll assumes getContext("webgl2") gives a live context. It uses `gl!` at 530-533 and `loadShader(...)!`, and nothing handles webglcontextlost or webglcontextrestored. With no WebGL2 (blocklisted or software GL), the effect throws on the first DAM song at `gl.VERTEX_SHADER`. After a GPU-process crash the canvas's context stays lost. The next effect run on the same mounted canvas (DAM→DAM, Joysound→DAM, a key change or a mic change) gets null from loadShader and throws at gl.attachShader (line 100). Both throws reach the root ErrorBoundary, which unmounts the display and the video. Reproduced in Electron 43.4.1 with the real component.

**Scenario.** The GPU process crashes or resets during a DAM song (driver TDR, GPU out of memory, display hot-plug). The pitch bars go blank and are never restored. Then the next DAM song in a row (PianoRoll stays mounted, `melody` changes), a guest's key change (pitchShiftSemis) or a mic added in Settings re-runs the effect on the same lost context. It throws, the song stops, and the TV shows 'Something went wrong' with a Reload button. The other case is a machine where Chromium offers no WebGL2: a blocklisted driver, VM or RDP, software rendering, or GPU disabled after repeated GPU-process crashes, since the app does not pass --enable-unsafe-swiftshader. There the first DAM song crashes the display, because pitch bars are on by default. A Joysound song whose context is lost loses its lyrics for the rest of the song, and with no WebGL2 every Joysound song plays without lyrics (invariant at JoysoundRenderer.tsx:857, caught and logged).

**Suggested fix.** In PianoRoll (and likewise JoysoundRenderer), return early when `gl` is null or `gl.isContextLost()`, so the canvas just stays empty. Add a webglcontextlost listener that calls preventDefault, and on webglcontextrestored bump a `contextGeneration` state that is part of the effect deps, or key the <canvas> on it so React makes a fresh one. Also stop using `loadShader(...)!`: skip the program when a shader is null. Optionally log `app.on('child-process-gone')` for type 'GPU' in main.

**Verifier.** CONFIRMED: I traced it end to end. The repo has no webglcontextlost, webglcontextrestored or isContextLost handling (I grepped src and tests), and nothing appends a GPU or SwiftShader switch. tests/e2e/fixtures.ts:430 is the only --enable-unsafe-swiftshader. On a DAM to DAM change, loadDam calls setOverlay({kind:'dam', melody: damMelody(...)}) right away, so PianoRoll stays mounted on the same canvas while props.melody changes identity, and the effect re-runs. setPitchShiftSemis(0) on each song, a guest key change, or a mic add/remove re-runs it too. Without preventDefault on webglcontextlost, Chromium never restores the context. On a lost context getShaderParameter(COMPILE_STATUS) returns null, so loadShader returns null. attachShader's WebGLShader parameter is non-nullable, so it throws a TypeError. NoteProgram does this even with zero mics. With gl null (no WebGL2), `gl.VERTEX_SHADER` in the loadShader arguments throws. The throw happens synchronously in the effect body, and React 19.2.7 sends passive-effect errors to the nearest error boundary: the root ErrorBoundary in index.tsx unmounts App, Player and the video. JoysoundRenderer's failure is async (refresh().catch), so it only loses lyrics, as the finding says. I re-rated it to medium because both triggers are uncommon paths: GPU process crash or TDR mid-party, or a host machine with no WebGL2. The impact on that path is a display crash during the song that needs a manual Reload, and with no WebGL2 it recurs on every DAM song, and on Joysound songs once the guide melody loads, while pitch bars are on. | CONFIRMED: I reproduced this using the real PianoRoll.tsx and ErrorBoundary.tsx, bundled with esbuild into a scratch Electron 43.4.1 page under xvfb. The harness is at /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-gap-long-party-gpu-1/ (harness.tsx, build.mjs, main.js). It wraps the harness in StrictMode and the root ErrorBoundary, the same way index.tsx does, and puts a <video> next to the canvas.

Results:

- Control (--use-angle=swiftshader, live context): changing pitchShiftSemis re-runs the effect without any error.
- WEBGL_lose_context.loseContext(), then a key change: webglcontextlost fires. The effect logs "Error compiling shader: null" twice and then throws "Failed to execute 'attachShader' on 'WebGL2RenderingContext': parameter 2 is not of type 'WebGLShader'". The ErrorBoundary catches it, the canvas and video are unmounted, and the page shows "Something went wrong".
- SIGKILL of the real GPU process (child-process-gone {type:'GPU', reason:'killed'}), then a melody change (DAM→DAM), and separately a key change with no mics: the result is the same throw and the same boundary. No webglcontextrestored event fired, which is expected because nothing calls preventDefault.
- Without the swiftshader switches: Chromium logs "ContextResult::kFatalFailure: WebGL2 blocklisted", getContext returns null, and the first mount throws "Cannot read properties of null (reading 'VERTEX_SHADER')" into the boundary. Pitch bars are on by default (App.tsx:206, on unless localStorage says "off"), so the first DAM song takes the display down.

The path in the app matches the finding. Player.tsx renders <PianoRoll> with no key and no inner boundary, and the only ErrorBoundary is the root one in index.tsx. loadDam calls setOverlay({kind:'dam', melody}) straight from one DAM song to the next, and Joysound→DAM goes straight through as well, so PianoRoll stays mounted on the same canvas and its lost context. The effect deps [melody, mics, pitchShiftSemis] re-run on the next song, on a guest's key change or on a mic change. If a non-DAM song comes in between, PianoRoll remounts with a fresh canvas and recovers, which is consistent with the finding. The Joysound part is also correct. With a null context, invariant(gl) at JoysoundRenderer.tsx:857 throws inside the async refresh, which is caught and logged, so the lyrics are missing. A lost context only blanks the current song, because each Joysound song first sets telop to null, which unmounts the renderer. The file and lines cited (530-533, 100, 129-130 and so on) are correct.

One small correction: with a null context the first throw is at `gl.VERTEX_SHADER` in the loadShader argument list, not at createProgram or createShader.

Re-rated from high to medium. The crash is real and severe when it happens: the display goes to "Something went wrong", the song stops, and that popped song is lost. But both triggers are uncommon in real use:

- (a) A GPU-process crash or device reset mid-party, from a TDR, a driver update or GPU switching, followed by DAM→DAM, a key change or a mic change.
- (b) A machine where Chromium gives no WebGL2: a blocklisted driver, software GL or a VM. src/main passes no --enable-unsafe-swiftshader or ignore-gpu-blocklist, so on such a machine every DAM song crashes the display.

A typical party PC with a working GPU never hits either trigger, which puts this at "a real bug on a less common path" on the scale. The suggested fix holds up: guard against null or isContextLost() and skip a program whose shader is null, call preventDefault on webglcontextlost, and remount the canvas when the context is restored.

**Also reported as** (A null or lost WebGL2 context throws into the root ErrorBoundary. Guard the context, handle context loss and restore, and give the overlays their own boundary.):

- renderer-pianoroll-1: A lost or missing WebGL context throws in PianoRoll's effect and takes down the whole display (`src/renderer/PianoRoll.tsx:530`). Its fix: `if (!gl || gl.isContextLost()) return;` (no bars). Have loadShader and the program constructor return null instead of asserting, bail out of the effect on null, and check LINK_STATUS. Add canvas listeners: webglcontextlost calls preventDefault and cancels the rAF; webglcontextrestored bumps a state counter that is in the effect deps, so the effect rebuilds. Optionally give PianoRoll its own small error boundary so a bars failure can never remove the video.
- gap-sleep-resume-power-7: PianoRoll reuses one WebGL context for every DAM song: GL objects leak, and a lost context is never noticed (`src/renderer/PianoRoll.tsx:530`). Its fix: Key PianoRoll by song (e.g. the popped song's timestamp) so each song gets a fresh canvas and context. In cleanup, delete the programs and buffers, or call gl.getExtension('WEBGL_lose_context')?.loseContext(). Listen for webglcontextlost (with preventDefault) and webglcontextrestored, and re-run the effect on restore.

## renderer-pianoroll-3

**Reading a Joysound guide melody fetches the whole video file and decodes every channel at full rate at song start, with no cancellation** (medium, confirmed, performance) · `src/renderer/useGuideMelody.ts:38`

**Summary.** readMelody fetches the whole Joysound mp4 into the renderer, background video included, and decodeAudioData decodes all 3 channels at the file's rate before resampling to 11025 Hz. Measured: +238 MB peak renderer RSS for a 270 s 3-channel 44.1 kHz file, plus the file's own size, on every Joysound song start. Nothing cancels the work on a skip, but the cache keeps the result.

**Scenario.** Each Joysound song start (pitch bars on by default) holds the whole mp4 (tens to hundreds of MB) plus about 150 MB of decoded 3-channel float audio for a 4–5 min song at 44.1/48 kHz, plus the 11 kHz copy. This happens while the same file starts playing and the lyrics parse. A host skipping through several Joysound songs stacks one such read per song, because each keeps running after its skip, so the peaks add up. The cache is in memory only, so every app restart reads everything again.

**Suggested fix.** Compute the notes once at download time in main. composeJoysoundVideoPromise already holds oggBuffer: pipe it through ffmpeg `-af pan=mono|c0=c2 -ar 11025 -f f32le -` (about 13 MB for 5 min), run guideMelodyNotes (pure; move it to src/common) and write `joysound-<id>.melody.json` next to the .joy_02. The display then fetches a few KB. Short of that, keep the ogg on disk and decode it instead of the mp4, and abort the fetch and terminate the worker when the effect cleans up and nothing else awaits the promise.

**Verifier.** CONFIRMED: The code fetches the whole karafriends:// mp4 (useGuideMelody.ts:38). jobs.ts muxes the background video into it, looped with -stream_loop -1 -shortest for the whole song. The code then decodes every channel. I measured this in headless Chrome 156, run through playwright-core against a local server. The test file was a 270 s mp4 with a tiny 320x180 video and 3-channel 44.1 kHz Vorbis, like the fixture. Peak renderer RSS went from 142 MB to 380 MB (+238 MB), while the final 11025 Hz buffer is only about 36 MB. That supports the finding: Chromium decodes at the file's rate and resamples afterwards, and the 'quarter of the memory' comment holds only for the result. A real file adds its full video size on top. The decode took about 0.4 s off the main thread, so the lyrics don't stutter; the cost is a few hundred MB of transient memory on every Joysound song start, with bars on by default. Nothing cancels the work, which is true but minor: the result is cached by songId, so the work isn't wasted, and overlap only happens on quick skips.

**Also reported as** (The guide melody decodes the whole Joysound mp4 in the renderer. Compute the notes (or save the guide channel) at download time.):

- renderer-joysound-4: The guide melody reads the whole video file and decodes all three channels to get one (`src/renderer/useGuideMelody.ts:38`). Its fix: Do it once, at download time, in main. Either run guideMelodyNotes (it's pure) on the ogg's FC channel, using ffmpeg `-af pan=mono|c0=FC -ar 11025 -f f32le -`, and write joysound-<id>.notes.json next to the .joy_02. Or at least save the 3 MB ogg and decode that rather than the mp4. The display then fetches a few KB, and the worker and the 8-song cache go away.
- cross-maintainability-9: The pitch bars for a Joysound song load the whole video file into the renderer to read its guide channel (`src/renderer/useGuideMelody.ts:38`). Its fix: Have joysoundJob write the ogg (or just its third channel) next to the telop as joysound-<id>.ogg; folder.ts's `joysound-<id>.` prefix already keeps such a file. Point useGuideMelody at that file. Alternatively, run guideMelodyNotes once in the download and save the notes as JSON.
- cross-performance-5: Joysound pitch bars read the whole song video into the display's memory to get its audio (`src/renderer/useGuideMelody.ts:38`). Its fix: Have the Joysound job write the ogg it already has (a few MB) as joysound-<id>.ogg and decode only that. Better still, run guideMelodyNotes once at download time and save the notes as JSON next to the .joy_02. The display then reads a few KB instead of decoding about 60 MB per song.
- gap-long-party-gpu-7: The guide melody is read by fetching the whole video file into the renderer for every Joysound song (`src/renderer/useGuideMelody.ts:38`). Its fix: Have joysoundJob also write the ogg, or just its guide channel downmixed to mono 11 kHz, as joysound-<id>.guide.ogg, and decode that. It is a few MB, with no video demux and no 3-channel decode.

## renderer-pianoroll-4

**A DAM song without scoring data still shows the pitch bars as an empty, dimmed band over the top of the video for the whole song** (medium, confirmed, bug) · `src/renderer/Player.tsx:57`

**Summary.** popSong falls back to scoringData [] on DAM errors and timeouts. damMelody([]) returns a Melody with no notes, and Player mounts PianoRoll for any truthy melody. With no lyrics intervals, the free-time quad covers 0–9999 s, so the whole roll is 50% black over its striped background, with the seek line sweeping and no trace (pollPitch returns early). joysoundMelody returns null when there are no notes, so a Joysound song shows no bars in the same situation.

**Scenario.** DAM's scoring endpoint (marked 'flaky' in damApi.ts) times out after 10 s, the DAM session expires, or the song has no scoring reference, and the downloaded file plays anyway. The band from 5% to 35% of the TV's height is a dark, empty strip for the whole song.

**Suggested fix.** Have damMelody return null when there are no notes (Melody | null, like joysoundMelody, and update the test), or gate in Player with `melody && melody.notes.length > 0`.

**Earlier reviews.** code-review-2026-10-27.md added the [] fallback for scoring data. The empty band itself was never reported, and the DAM-only roll already did this before the Melody refactor.

**Verifier.** CONFIRMED: I traced it end to end. On any failure, timeout or non-binary reply, api.ts:1005-1011 falls back to scoringData []. damMelody([]) returns {notes:[], lyricsIntervals:[], pogIntervals:[]}, and melody.test.ts:35-40 asserts exactly that. The melody object is truthy, so Player.tsx:57 mounts PianoRoll. The free-time reduce on empty intervals gives [[0, 9999]], a 50% black quad over the whole roll, while pollPitch bails out at line 505 and the seek line keeps sweeping. joysoundMelody returns null for no notes, so the two paths behave differently. The behaviour predates the Joysound commit: the old Player also mounted the roll for any DAM overlay. The impact is cosmetic, an empty dark band over the top 5–35% of the video, on a less common path, the flaky scoring endpoint (damApi.ts:129).

**Also reported as** (damMelody([]) should return null, as joysoundMelody does.):

- renderer-playback-8: A DAM song without scoring data shows an empty pitch-bar band for the whole song (`src/renderer/Player.tsx:40`). Its fix: Make damMelody return null when noteCount is 0 (Overlay's dam melody becomes Melody | null), matching joysoundMelody. Player's existing `melody ?` check then hides the bars.

## renderer-pianoroll-2

**The mic trace grows without bound while the video stalls, and the whole trace is re-converted and re-uploaded every frame** (low, confirmed, performance) · `src/renderer/PianoRoll.tsx:322`

**Summary.** While a song's time doesn't advance (for example an HLS stall with pitched mic input), push() overwrites the last buffer point but still appends an 84-float segment, so `positions` grows past 200 segments and stays that size until a seek or the next song. Every frame also re-converts the whole trace into a new Float32Array and uploads it: about 57 µs per mic per frame normally, about 235 µs after a 20 s stall.

**Scenario.** A DAM HLS stream stalls for 20 s: the video isn't paused, readyState is HAVE_CURRENT_DATA, currentTime is frozen. The singer keeps singing or talking, so pitch confidence stays at or above 0.8. positions goes from 16,800 to 84,000 floats and stays there until a seek or the next song. From then on, every frame allocates a 336 KB Float32Array per mic and uploads it: about 20 MB/s per mic at 60 Hz, more on a 120/144 Hz TV or with more mics. That is GC churn on the thread that also draws the lyrics. Even the steady state is 67 KB per mic per frame, paused or not.

**Suggested fix.** Keep exactly one fixed-stride segment per buffer point. In the else branch, replace the last segment instead of appending, or skip the push when time hasn't advanced. Hold the trace in a preallocated Float32Array (200 × 84) ring, or in a segments array parallel to buffer. Set a dirty flag in push/clear and upload only when it is set (bufferSubData into a buffer allocated once). The rAF loop can also skip GL work when neither time nor dirty has changed.

**Verifier.** CONFIRMED: I reproduced the growth with a harness built from the class's own source (scratch verify-renderer-pianoroll/buf.ts, run.ts). After 10 s of playing: buffer 200, positions 16,800. After 20 s with time frozen: buffer 200, positions 84,000. 10 s later it is still 84,000. Both branches append 84 floats, but the overwrite branch doesn't grow the buffer, so the trim never catches up. The scenario is reachable: during an HLS stall paused stays false and readyState is at least HAVE_METADATA, so pollPitch keeps pushing at the same time. The cost is smaller than claimed, though. new Float32Array(16,800) takes about 57 µs and (84,000) about 235 µs in Node, per mic per frame, against a 16.7 ms frame. The growth needs pitched sound during the stall, and speech gives it only now and then. Downloaded DAM files don't stall, and after 3 stalls DAM moves to the low bitrate. The extra length goes at the next seek or song. So this is a small cost, not a noticeable one.

**Also reported as** (The trace keeps adding a segment when time doesn't advance. Keep one segment per point in a preallocated ring and upload with bufferSubData.):

- gap-long-party-gpu-5: The pitch trace's vertex array grows during every buffering stall and is never trimmed back until a seek (`src/renderer/PianoRoll.tsx:322`). Its fix: Push only when `time` advanced (return early otherwise), or pop the last segment when replacing the last point. Better still, keep the trace in a preallocated Float32Array ring and bufferSubData only the new segment, instead of re-uploading up to 67 KB per mic per frame.

## renderer-pianoroll-5

**The roll's drawing buffer follows only window resizes, not resizes of its container** (low, confirmed, bug) · `src/renderer/PianoRoll.tsx:609`

**Summary.** updateSize runs on mount and on window 'resize'. The canvas is sized from .karaVidContainer, which is sized in container-query units of .appStage. That box's height changes when the Up next strip is toggled, when the UI scale changes (the strip's height is in rem), or when the notice bar appears, and none of these fire 'resize'.

**Scenario.** The host turns off Up next or changes the UI scale mid-song. The canvas's CSS box grows or shrinks by a few percent, but its width, height and gl.viewport stay as they were, so the bars and the 0.03-high trace are stretched and soft until the effect next runs (the next DAM song or a key change). For a Joysound song it lasts the rest of the song.

**Suggested fix.** Replace the window listener with a ResizeObserver on the canvas (devicePixelContentBoxSize where available), as QRCode.tsx does.

**Verifier.** CONFIRMED: updateSize runs only on mount and on window 'resize' (PianoRoll.tsx:599-609). .karaVidContainer is sized from .appStage's container-query units (Player.css:5). .appStage is flex: 1 with container-type: size (App.css), and the Up next strip is a sibling in .appScreen (App.tsx:460). So toggling the strip (key 'q'), the strip appearing when idle turns false, a UI-scale change or the NoticeBar all resize the canvas's CSS box without a window resize. The drawing buffer and viewport stay as they were. The strip appearing can also race the first DAM song's mount, which leaves that whole song stale. The mismatch is a few percent of size, so the bars are slightly stretched or soft. Low.

## renderer-pianoroll-6

**The song's last note never becomes the current note, so its trace can fold an octave off** (low, confirmed, bug) · `src/renderer/PianoRoll.tsx:521`

**Summary.** The note index stops advancing at notes.length - 2. While the last note is sung, the octave fold in PitchDetectionBuffer.push therefore aims at the second-to-last note.

**Scenario.** A song ends on a leap of 7 or more semitones (say a penultimate E4 = 64 and a final E5 = 76). The singer hits 76, the fold picks the octave nearest 64, and the trace is drawn at 64, an octave below the final bar, as if they had missed it.

**Suggested fix.** `currentNoteIndex < notes.length - 1`.

**Verifier.** CONFIRMED: The loop condition at 519-524 is `currentNoteIndex < notes.length - 2`, so the index never passes n-2 and notes[n-1] never becomes the current note. `< notes.length - 1` is safe, since notes[n-1] exists, so the -2 isn't needed as a guard; with n = 1 the loop simply doesn't run. The fold at 307-310 is Math.round((current − pitch)/12)*12, so a singer who hits the final note correctly gets folded by an octave only when the last note is 7 or more semitones from the penultimate one. That's a rare melodic shape, so the impact is low.

## renderer-pianoroll-7

**median() sorts MIDI numbers as strings** (low, confirmed, bug) · `src/renderer/PianoRoll.tsx:75`

**Summary.** numsSorted.sort() has no comparator, so it sorts lexicographically. Any note at MIDI 100 or above sorts before every two-digit note, which skews the median that centres the roll vertically.

**Scenario.** Joysound's guide notes sit an octave above DAM's (up to MIDI 96 in guideMelody.ts), and the key can go up to +24 (validate.ts:315). A high Joysound song at key +5 has notes at 100–101 that sort first, so the median comes out low and the bars sit off-centre, with the top of the range closer to clipping at +18 semitones. In Node, [100, 60, 72, 99, 101].sort() gives [100, 101, 60, 72, 99].

**Suggested fix.** `numsSorted.sort((a, b) => a - b)`.

**Verifier.** CONFIRMED: In the harness, the median() source from PianoRoll.tsx sorts [100,60,72,99,101] as [100,101,60,72,99] and returns 60 for [100,101,60,72,99] (true median 99) and 60 for [100,60,72] (true 72). To be reachable, the shifted notes must reach MIDI 100 or more. DAM notes are sung pitches (roughly 48–80), so that would take keys around +20. Joysound guide notes run an octave up (HIGHEST_MIDI 96) and typically top out around 88–93, so it takes a positive key of several semitones on a high song. The server allows ±24. When only a few notes reach 100, the median moves down by that many positions and the roll sits slightly off-centre. Low.

**Also reported as** (median() sorts numbers as strings. One-line comparator.):

- renderer-joysound-5: The pitch bars' median sorts MIDI numbers as strings, so Joysound guide notes plus a key change move the bars off-centre (`src/renderer/PianoRoll.tsx:75`). Its fix: numsSorted.sort((a, b) => a - b).

## renderer-pianoroll-9

**Four copy-pasted program classes, a state cache that never caches, and a full GL rebuild on every key change** (low, confirmed, maintainability) · `src/renderer/PianoRoll.tsx:142`

**Summary.** NoteProgram, SeekProgram, PitchProgram and FreeTimeProgram (122-294) repeat the same setup in draw(). Their guard `this.gl.CURRENT_PROGRAM !== this.program` compares the enum constant 0x8B8D with a program object, so it is always true and the 'set up once' branch runs every frame. FreeTime and Pitch ask for a canvasWidth uniform that their shaders don't declare. The one effect (449-632), keyed on melody, mics and pitchShiftSemis, compiles 6+2N shaders (each with a synchronous COMPILE_STATUS query) and links 3+N programs on every key press and every DAM-to-DAM song change, and cleanup deletes none of them; they wait for GC on the same context.

**Scenario.** A guest taps key +1 three times. Each tap rebuilds the whole pipeline on the display's main thread and wipes the mic trace; with 2 mics that is 10 shader compiles and 5 links per tap. The old programs and buffers, each pitch buffer holding up to 67 KB or more of trace, stay on the context until GC.

**Suggested fix.** Use one Layer class (program, buffer, vertexCount, color, static or dynamic) with a single draw(). Compile midi.vert + singleColor.frag once and share it between free time and every mic through the color uniform. Split the effect into three: GL setup once per canvas (programs, ResizeObserver, context-loss handlers, the rAF loop); a melody/key effect that only re-uploads the note and free-time buffers; and a mics effect for the pollers. This removes about 150 lines and the per-tap recompiles, and makes cleanup explicit.

**Verifier.** CONFIRMED: The facts check out. gl.CURRENT_PROGRAM is the enum 35725 (printed in my Chrome test), so `this.gl.CURRENT_PROGRAM !== this.program` is always true at 142/185/225/273. That is harmless: the programs alternate every frame, so they must rebind anyway. The guard is misleading dead logic, not a performance bug. FreeTimeProgram asks for canvasWidth, which neither of its shaders declares, so the location is null. PitchProgram doesn't list canvasWidth at all, so its location is undefined. uniform1f on null or undefined is a silent no-op. Each effect run compiles 6+2N shaders and links 3+N programs. midi.vert + singleColor.frag is compiled 1+N times. The cleanup at 621-631 deletes nothing; the objects wait for GC. A key tap therefore rebuilds the whole pipeline and wipes the trace. Chromium's program cache softens the repeat compiles, so the runtime cost is small. The refactor is worthwhile mainly because it removes about 150 duplicated lines, makes cleanup explicit, and gives a place for the context-loss handling in finding 1.

**Also reported as** (The CURRENT_PROGRAM guard is dead, there are four copy-paste program classes, and every key, mic or song change rebuilds all of GL. cross-maintainability-8 also adds JoysoundRenderer's per-frame bufferData calls; do those with the same refactor.):

- gap-long-party-gpu-9: PianoRoll's 'only on program switch' check is dead code, and every effect re-run recompiles identical programs (`src/renderer/PianoRoll.tsx:142`). Its fix: Remove the guard and put the shared setup in one ShaderProgram.use(). Compile the four programs once per canvas (a ref created on mount) and have the effect only re-fill the note and free-time buffers. That cuts about 40 duplicated lines and makes the cleanup in the previous finding a single loop.
- cross-performance-7: PianoRoll copies each mic's trace into a new Float32Array every frame, rebuilds all of WebGL on a key change, and never frees GL objects (`src/renderer/PianoRoll.tsx:245`). Its fix: Keep each trace in a preallocated Float32Array, and upload with bufferSubData only when pollPitch added points. Create the programs once per canvas, and apply the key as a uniform offset in the vertex shader, so a key change touches nothing. Delete GL objects in the cleanup. Drop the CURRENT_PROGRAM checks.
- cross-maintainability-8: Both WebGL overlays rebuild and re-upload vertex data every frame, and PianoRoll's per-program guard is always true (`src/renderer/PianoRoll.tsx:142`). Its fix: In JoysoundRenderer, upload a unit quad and its texture coordinates once, and pass the block's rect, scroll position and scroll type as uniforms, so each draw is a few uniform sets and a drawArrays. In PianoRoll, put one use() method in ShaderProgram (about 40 fewer lines), and keep each mic's trace in a preallocated Float32Array ring, uploading only the new segment with bufferSubData. Share one shader compile-and-link helper, with status checks, between the two files.

## renderer-pianoroll-10

**PianoRoll's pure logic has no tests** (low, confirmed, test-gap) · `src/renderer/PianoRoll.tsx:296`

**Summary.** These all live inside the component with no tests: PitchDetectionBuffer (whose two branches must both append exactly 84 floats for the splice at 331 to stay aligned), the free-time interval merge (474-502), median, and the current-note lookup. The stall growth, the last-note off-by-one and the string sort in median all sit in that code.

**Scenario.** All three of those bugs pass typecheck, lint and the 417 unit tests. A future change that breaks the stride invariant would silently misalign the trace's trim.

**Suggested fix.** Move PitchDetectionBuffer, the free-time intervals, median and the note lookup into a pure module like melody.ts, and add node tests: the stride under repeated and backward times, merging of gaps of 10 s or less, the median of [100, 60, 72], and lookup of the last note.

**Verifier.** CONFIRMED: The only references to PianoRoll outside the component are Player.tsx, melody.ts and two e2e checks that the canvas is visible (tests/e2e/settings.spec.ts:477 and :595). No unit test covers PitchDetectionBuffer, the free-time interval merge, median or the note lookup. The harness confirmed three real bugs in that code (findings 2, 6 and 7), none of which the existing suite catches, and the 84-float stride the trim depends on isn't asserted anywhere. Moving it into a pure module with node tests is worth it, and the fixes for 2, 6 and 7 would naturally add those tests.

## oe-display-2

**PianoRoll: an abstract generic ShaderProgram class with four one-instance subclasses, and a bind-once check that never hits** (over-engineering, KEEP, medium) · `src/renderer/PianoRoll.tsx:84`

**Now.** `abstract class ShaderProgram<T extends unknown[]>` keeps string-keyed maps of attribute, uniform and buffer locations and has an `abstract draw(...args: T)`. NoteProgram, SeekProgram, PitchProgram and FreeTimeProgram are each created once, and each repeats the same ~15-line useProgram/bindBuffer/vertexAttribPointer/uniform block inside `if (this.gl.CURRENT_PROGRAM !== this.program)` (lines 142, 185, 225, 273).

**Why it's more than needed.** `gl.CURRENT_PROGRAM` is the GLenum constant 0x8B8D, never a program object, so the 'bind only once' optimisation never applies and the block runs every frame anyway. Every program has the same single attribute ("position") and buffer ("positions"), so the name maps generalise nothing, and they hide mistakes. PitchProgram sets `uniformLocations.canvasWidth`, which it never looked up (undefined). FreeTimeProgram looks up a `canvasWidth` its shaders don't have and asserts it with `!` (it's null). The generic `T` only types draw() arguments that the effect passes directly. JoysoundRenderer.tsx has a second, separate copy of createShader/createProgram. The class layer dates from 2021, and the file has had 8 commits since 10-20.

**Simpler shape.** As proposed: a makeProgram(gl, vert, frag) helper returning {program, position, buffer, uniform(name)}, and a draw helper that does useProgram, bindBuffer, vertexAttribPointer, the uniforms and drawArrays on every call. Build plain objects in the effect, uploading the note, free-time and seek positions once and the mic trace with DYNAMIC_DRAW per draw. Optionally compile one single-colour program for all mic traces and set `color` per mic, rather than one program per mic. Keep the draw order (free time, notes, traces, seek) and premultipliedAlpha:false. Sharing the helpers with JoysoundRenderer through a gl.ts is optional.

**Saves.** About 150 of PianoRoll's 635 lines. It removes a class hierarchy, a generic type, three string-keyed maps per program and the dead cache check.

**Risk.** Low, since it's a mechanical change to the draw calls, but the e2e pitch-bar tests only check that the bars are there. Compare a screenshot (screenshotsDisplay.spec.ts) of the free-time shading, the notes' green progress fill, the seek line and the per-mic colours. Keep the clear and draw order the same.

**Verifier.** Verified. gl.CURRENT_PROGRAM is the enum 0x8B8D, so `!== this.program` is always true and the 'bind once' block runs on every draw. Every program has one attribute ('position') and one buffer ('positions'). FreeTimeProgram looks up a canvasWidth uniform that its shaders don't declare (null, asserted with !). PitchProgram writes uniformLocations.canvasWidth, which it never looked up (undefined, so a no-op). Neither shader pair uses canvasWidth except PianoRollNote.frag. JoysoundRenderer.tsx:146-170 has its own createShader/createProgram. Two corrections. First, PitchProgram is created once per mic, not once. Second, it isn't high: the class layer dates from 2021 (7e4451c, 5566072, abdd674) and hasn't been touched since. The recent PianoRoll commits (7d04ed6, 136739a, 561c60f, c6d404e) changed the effect, pollPitch and draw timing, not the programs. So this simplifies one module and doesn't ease a hot spot.

## oe-display-8

**Two runtime dependencies (plus a types package) are used for three one-line maths calls in PianoRoll** (over-engineering, KEEP, low) · `src/renderer/PianoRoll.tsx:1`

**Now.** `color-convert` is imported for one `convert.hsv.rgb([(360 / n) * i, 30, 100])` call (the mic trace colours, line 542). `gl-vec2` and `@types/gl-vec2` are imported for two `vec.scaleAndAdd(tmp, point, normal, s)` calls in createEdges.

**Why it's more than needed.** package.json carries dependencies whose whole job here is a 2-vector multiply-add and one colour conversion. color-convert@3.1.3 is pulled in only by this import; the other entry in yarn.lock is 2.x, used by other packages.

**Simpler shape.** Inline scaleAndAdd as [p[0] + n[0] * s, p[1] + n[1] * s]. Write a small hsvToRgb(h, 30, 100) that rounds each channel to 0–255 the way color-convert does (then /255), so the colours match exactly, or use a fixed list of four colours. Remove color-convert, gl-vec2 and @types/gl-vec2 from package.json.

**Saves.** Two direct dependencies and one @types package in package.json, and color-convert leaves the display bundle. gl-vec2 stays installed as a dependency of polyline-normals (through polyline-miter-util), so only the direct entry goes.

**Risk.** The trace colours must stay the same (saturation 30%, value 100%, hues spaced evenly by mic count). This is easy to check on the pitch-bar screenshot.

**Verifier.** Verified. color-convert and gl-vec2 are imported only in PianoRoll.tsx (one hsv.rgb call, two scaleAndAdd calls), and @types/gl-vec2 exists only for that import. gl-vec2 stays installed through polyline-normals → polyline-miter-util. The dependency has a cost: color-convert has had five Dependabot or manual bumps (ae7e598 2→3 major, af47199, 6c4613e, plus two @types bumps). Inlining is about 8 lines.
