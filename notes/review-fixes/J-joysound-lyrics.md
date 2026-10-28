# Phase J: Display: Joysound lyrics and parser

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/renderer/JoysoundRenderer.tsx, src/common/joysoundParser.ts, src/renderer/AdhocLyrics.tsx (+ .css), the kuromoji/Kuroshiro set-up in src/renderer/index.tsx.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                       | Severity                        | Title                                                                                                                                  |
| --------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [gap-long-party-gpu-2](#gap-long-party-gpu-2) | High                            | Each Joysound song uploads two device-resolution textures for every lyric block at song start: about 250 MB at 1080p, about 1 GB at 4K |
| [gap-long-party-gpu-3](#gap-long-party-gpu-3) | Low                             | Unmounting frees no GL objects, so after skips several dead songs' textures pile up until V8 collects the canvases                     |
| [renderer-joysound-2](#renderer-joysound-2)   | Low                             | A whitespace-only lyric block throws in the romaji pass and the whole song plays with no lyrics, in every mode, silently               |
| [renderer-joysound-3](#renderer-joysound-3)   | Low                             | Pitch bars on Joysound songs cover the title card's song name, under a 50% black free-time band                                        |
| [renderer-joysound-6](#renderer-joysound-6)   | Low                             | invariant(refreshTime) throws at refreshTime 0, and any throw in draw() ends the lyrics loop for the rest of the song                  |
| [renderer-joysound-9](#renderer-joysound-9)   | Low                             | The wipe is floored to whole 720-space units, so its edge moves in uneven jumps of 2.7-5.3 device pixels                               |
| [renderer-joysound-10](#renderer-joysound-10) | Low                             | The 900-line JOY-02 parser and its order-dependent romaji passes have no unit tests                                                    |
| [renderer-playback-10](#renderer-playback-10) | Low                             | The kuromoji dictionary (100 MB inflated) loads at every launch, on the display's main thread                                          |
| [renderer-playback-11](#renderer-playback-11) | Low                             | AdhocLyrics measures each line on a hidden canvas, in a font it doesn't render                                                         |
| [oe-display-4](#oe-display-4)                 | Over-engineering (KEEP, medium) | AdhocLyrics measures every line on a hidden DOM canvas in a font that is no longer the one shown                                       |
| [oe-display-5](#oe-display-5)                 | Over-engineering (WEAK, low)    | The Kuroshiro 'singleton' is passed as a prop through App and Player, which only forward it                                            |

## gap-long-party-gpu-2

**Each Joysound song uploads two device-resolution textures for every lyric block at song start: about 250 MB at 1080p, about 1 GB at 4K** (high, confirmed, performance) · `src/renderer/JoysoundRenderer.tsx:886`

**Summary.** createLyricsBlockTextures rasterises every lyric block twice (pre and post colour) at device-pixel resolution, and createTitleTexture adds a full-canvas title. All of it is uploaded synchronously before the first frame and kept for the whole song: about 190 MB of textures at 1080p and about 750 MB at 4K for a 60-line song. Only 2 to 4 blocks are ever visible at once.

**Scenario.** A laptop drives a 4K TV (or a 1080p laptop panel at 200% scaling feeds a 4K output), so the canvas is 3840x2160. A 60-line Joysound song then allocates 121 block textures of 2987x486 plus a 3840x2160 title, about 735 MB of texture, about 1 GB with the canvases. On an integrated GPU with shared memory that is a large share of the budget, and running out of GPU memory is one way into the context-loss crash above. The upload also blocks the main thread at every song start: about 0.4 s at 1080p and about 2.1 s at 4K under SwiftShader. The title and first lyrics appear that late.

**Suggested fix.** Create each block's textures lazily, for example when refreshTime passes fadeinTime - 1000 ms, and gl.deleteTexture them once refreshTime passes fadeoutTime. Do the same for the title after metadata.fadeoutTime. That keeps about 4 blocks resident, roughly 15x less memory, and removes the start-of-song stall. Separately, one coverage-mask texture per block with the pre and post colours as uniforms would halve whatever remains.

**Verifier.** CONFIRMED: The code does what the finding says. setupTextCanvas sizes each block canvas at getLyricsBlockWidth/Height × EXPAND_RATE_X/Y, and EXPAND_RATE comes from canvas device pixels / 720×480. createLyricsBlockTextures makes a pre and a post texture for every block up front, and the title is the full SCREEN×EXPAND size. All of it is uploaded synchronously before the first rAF and none of it is freed during the song. By arithmetic, a block is 110 logical px tall (44+8+20+6+32) and about 568 wide for 12 full-width characters. At a 1920×1080 canvas that is about 1.5 MB per texture, so 60 blocks cost about 180 MB plus 8 MB for the title (the reviewer measured about 240 MB of GPU-process RSS). At 3840×2160 it is about 6 MB per texture, about 720 MB plus 33 MB. The canvas fills the 16:9 .karaVidContainer, which is a little smaller than the screen while Up next shows, so real figures run about 10-20% lower. The 0.4 s and 2 s stalls were measured under SwiftShader. A real GPU uploads faster, and the title shows for several seconds anyway, so the late start is barely visible. The memory cost is real and noticeable at 4K, a common TV resolution, so I kept medium.

**Severity set at synthesis.** Seen together with gap-long-party-gpu-3 (no GL objects freed on unmount) and gap-long-party-gpu-1 (a lost context throws into the root ErrorBoundary), this holds about 1 GB per Joysound song on a 4K TV, and skipped songs pile up until GC. On an integrated GPU that ends in a lost context and a crashed display that drops the song on reload. The trigger is common: a 4K TV with Joysound songs.

**Also reported as** (Every lyric block's two textures are built at song start. Create them lazily around fadein and delete them after fadeout. Freeing on unmount is the separate gap-long-party-gpu-3.):

- renderer-joysound-1: Every lyric line's two textures are rasterised and uploaded at full canvas resolution when the song starts, and never freed (`src/renderer/JoysoundRenderer.tsx:886`). Its fix: Create a block's textures lazily, when refreshTime passes fadeinTime − ~1 s, and delete them after fadeoutTime. Only about 4-6 blocks are live at once (~10 MiB at 1080p), and lines made after a resize use the new rate. In cleanup, delete what is left and call getExtension('WEBGL_lose_context')?.loseContext().

## gap-long-party-gpu-3

**Unmounting frees no GL objects, so after skips several dead songs' textures pile up until V8 collects the canvases** (low, confirmed, performance) · `src/renderer/JoysoundRenderer.tsx:1008`

**Summary.** The cleanup only cancels the rAF and the resize listener. No deleteTexture, deleteBuffer, deleteProgram or deleteShader runs, and WEBGL_lose_context is never used. Player unmounts JoysoundRenderer and PianoRoll at every Joysound song (Player.tsx:48, 57), so the previous song's roughly 250 MB at 1080p (about 1 GB at 4K) stays resident until a major GC collects the detached canvas. V8 is never told about texture memory, only about canvas sizes.

**Scenario.** Guests skip four Joysound songs in quick succession (a few seconds each). Every skip mounts a fresh pair of contexts and a full texture set while the old sets wait for GC. At 4K the GPU process holds about 3.4 GB after 4 songs, against a flat 1.2 GB when the objects are released. With normal 4-minute songs the overlap lasts a few seconds per song change, which still briefly doubles the footprint. Chromium's 16-active-context cap never kicked in, so it does not save this case.

**Suggested fix.** Return the created objects from refresh() and release them in the effect cleanup. In JoysoundRenderer that means deleteTexture on the title and every pre/post texture, deleteBuffer ×4, deleteShader ×2 and deleteProgram, then `gl.getExtension('WEBGL_lose_context')?.loseContext()` on unmount. In PianoRoll it means program.delete() for each ShaderProgram, including on effect re-runs. Also set the scratch 2D canvases to width = 0 instead of `remove()` (they were never attached). A simpler shape is to keep one JoysoundRenderer canvas mounted across songs, which avoids churning contexts at all.

**Verifier.** CONFIRMED: The cleanup at 1008-1012 only sets cancelled, removes the resize listener and cancels the rAF. JoysoundRenderer and PianoRoll have no deleteTexture, deleteBuffer, deleteProgram or loseContext anywhere (grep). On every Joysound song, loadJoysound first does setOverlay({...overlay, telop: null}), which unmounts JoysoundRenderer before the await. useGuideMelody returns null until the new song's melody is read, which unmounts PianoRoll. So every Joysound song gets fresh canvases and contexts, and the old texture set lives until the detached canvas and context are collected. I re-rated it to low. The reviewer's own measurement shows the dead set is reclaimed within about 5 s of the next song in normal play. Large pile-ups need several quick Joysound skips in a row, ideally at 4K. In practice the cost is a transient multiplier on finding 2, and doing finding 2's lazy creation and deletion removes most of it.

## renderer-joysound-2

**A whitespace-only lyric block throws in the romaji pass and the whole song plays with no lyrics, in every mode, silently** (low, plausible, bug) · `src/common/joysoundParser.ts:281`

**Summary.** kuroshiro-analyzer-kuromoji's parse() returns [] when str.trim() === "". getMainRomajiBlocks and getNonKanaRomajiBlocks still walk every glyph and read tokenizedLyrics[tokenizedLyricsIndex].surface_form, which is undefined.surface_form. The throw rejects parseJoysoundData, and JoysoundRenderer's refresh().catch(console.error) never starts a draw loop. The romaji passes run even in "kana" mode, which never draws romaji, so one bad block costs the kana lyrics too. Other unguarded index walks fail the same way: processTimeline (850-875) reads lyricsData[-1] when an odd-coded scroll event (1 or 13) comes before an even one, and it also runs past the end on surplus scroll or fade-in events.

**Scenario.** A telop with a block whose glyphs are only full-width spaces (0x8140) or ASCII spaces is queued. The video and sound play, but the canvas stays empty for the whole song: no title card, no lines. Nothing appears on the TV and no announcement is made, only a console error.

**Suggested fix.** Skip the token advance when tokenizedLyrics[idx] is undefined (lines 241, 281, 346, 376). Compute romaji only when lyricsMode is "romaji" or "both", and wrap each block's romaji in try/catch, falling back to []. In JoysoundRenderer, report a failed parse to the host (announce) rather than only console.error.

**Verifier.** PLAUSIBLE: The mechanism is real, and I reproduced it with the real parser plus kuroshiro/kuromoji (scratch harness.ts and fuzz.ts, copied to verify-renderer-joysound). A block of only '　' or ' ' throws "Cannot read properties of undefined (reading 'surface_form')" at joysoundParser.ts:281. Kuromoji returns [] for a blank string, and a non-kana glyph still reaches the token-advance check. An odd scroll event (1 or 13) before any even one throws reading lyricsData[-1].scrollEvents. The throw rejects parseJoysoundData, and refresh().catch(console.error) never starts draw(), so nothing appears: no title card, no lines. parseJoysoundData never receives lyricsMode, so kana mode pays for it too. My extra fuzz cases (fuzz2.ts: leading or trailing full-width and ASCII spaces, '・', '…', '♪', '（　）', '－', and an empty block) all parse fine. Only blocks made entirely of whitespace crash. I couldn't establish that real JOY-02 telops contain whitespace-only blocks: no real telop is on disk. The parser has run on real songs upstream since 2023, and its real-world crash fixes (bb52de9, missing pronunciation) never touched this case. A whitespace-only block would also need its own wipe event. The timeline crashes need malformed event streams. So this is an edge case of unknown frequency. It would be medium if real telops do carry such blocks, since a whole song would lose its lyrics in silence.

## renderer-joysound-3

**Pitch bars on Joysound songs cover the title card's song name, under a 50% black free-time band** (low, confirmed, bug) · `src/renderer/JoysoundRenderer.tsx:382`

**Summary.** The J1 change mounts PianoRoll on Joysound songs about a second after they start. PianoRoll.css puts the roll at top 5%, height 30% of the 16:9 container. The title card, drawn until the telop's event 4, centres its block vertically in 720×480 space. A one-row title's text lands about 102-150 of 480 units down, 21-31% of the height, so it sits entirely inside the roll's band. The intro has no notes, so FreeTimeProgram shades [0, first note] with rgba(0,0,0,0.5) across the full roll, and the stripe gradient (2 px lines at 0.7 alpha) also crosses the title.

**Scenario.** Pitch bars are on by default, so this hits any Joysound song. Through the whole intro the song title on the TV is dimmed and striped behind the bars, while the artist line (about 47% down) stays clear. The plan's open list for J1 names the QR tile and 4-line lyrics reaching under the bars, but not the title card.

**Suggested fix.** Hold the roll back until the title card ends. For example, JoysoundRenderer could report metadata.fadeoutTime, and Player would show PianoRoll only once drawTime passes it. Or lay the title card out below 35% when the bars are shown.

**Verifier.** CONFIRMED: Checked against the code's arithmetic. The title texture covers the full 720×480 space, and the canvas fills the 16:9 container (JoysoundRenderer.css), so a y in 480-space maps straight to a fraction of the height. At 1080p, totalHeight ≈ 56+40+~21+~21+144 ≈ 282 units, so titleYPos ≈ (480−282)/2 − 16 ≈ 83. The text is drawn from about 103 to 155 units, 21-32% of the height. .pianoRollRoll covers 5-35% (top 5%, height 30%), and the artist line starts at about 223 units, below it. PianoRoll's canvas comes after the Joysound canvas in the DOM, both absolutely positioned with z-index auto, so the roll paints on top. freeTimeIntervals starts at [0, first note] and is drawn at [0,0,0,0.5], so the whole roll is shaded through the intro. pitchBars defaults to on (localStorage !== 'off'). The overlap is real, but it is cosmetic and limited to the intro. The white, stroked title stays legible: it is dimmed about 50% and crossed by the 2 px stripes, not hidden. It is of the same kind as the overlaps the plan already lists as open (the QR over the bars, 4-line lyrics under the bars). Low, not medium.

## renderer-joysound-6

**invariant(refreshTime) throws at refreshTime 0, and any throw in draw() ends the lyrics loop for the rest of the song** (low, confirmed, bug) · `src/renderer/JoysoundRenderer.tsx:934`

**Summary.** refreshTime = drawTime(t, offset)·1000 − 200 is a legitimate 0 when the video is at exactly 0.2 s with offset 0 (0.2*1000 === 200 in JS). ts-invariant then throws. draw() requests its next frame only on its last line (1000), so the throw ends the loop. The canvas keeps its last frame, so the lyrics freeze for the rest of the song with nothing to restart them.

**Scenario.** The host scrubs the video's controls to 0:00.2, or playback lands exactly on 200000 µs at a frame. The lyrics stop wiping and stay frozen until the next song. The same applies to any other exception inside draw().

**Suggested fix.** Drop the invariant: refreshTime is always a number. Request the next frame at the top of draw(), or wrap the body in try/finally, so a bad frame can't end the loop.

**Verifier.** CONFIRMED: refreshTime = drawTime(t, o)·1000 − 200. In node, (0.2+0)·1000 − 200 === 0, and so do (0.25, −50), (0.4, −200), (0.5, −300) and t = 0.2 with any non-negative offset. ts-invariant 0.10.3 throws on any falsy condition, 0 included. draw() re-arms the rAF only at its last line (1000), so one throw ends the loop. The effect deps (telop, lyricsMode) don't change mid-song, so nothing restarts it, and the canvas freezes on its last frame. Chrome's currentTime is microseconds divided by 1e6, so 200000 µs gives exactly 0.2. The trigger needs that exact sample in a frame, roughly 1 in 10^4 song starts, or a seek landing exactly there. Rare, so low. The invariant is useless and the re-arm-at-end pattern is fragile.

## renderer-joysound-9

**The wipe is floored to whole 720-space units, so its edge moves in uneven jumps of 2.7-5.3 device pixels** (low, plausible, bug) · `src/renderer/JoysoundRenderer.tsx:780`

**Summary.** scrollXPos = Math.floor(getScrollXPos(...)) floors in 720×480 telop units and only then multiplies by EXPAND_RATE_X (2.67 at 1080p, 5.33 at 4K). The colour change therefore steps by a whole number of units per frame instead of a steady fraction.

**Scenario.** A wipe at about 150 units/s on a 60 Hz 1080p TV advances 2.5 units a frame. Floored, it alternates 2 and 3 units (5.3 px and 8 px), a visible judder of the highlight. On a 120 Hz display it alternates 1 and 2 units, so frames move 2.7 px or 5.3 px. At 4K the jumps double.

**Suggested fix.** Floor in device pixels instead: Math.floor(getScrollXPos(...) * EXPAND_RATE_X), comparing against currX * EXPAND_RATE_X for the draw conditions.

**Verifier.** PLAUSIBLE: The mechanism is real. Line 780 floors getScrollXPos in 720-space units, and line 783 multiplies by EXPAND_RATE_X for the fragment shader's comparison against v_position.x in device px. So the wipe edge moves in quanta of 2.67 px at 1080p and 5.33 px at 4K, and a non-integer per-frame advance alternates between floor and ceil. The positional error is at most one unit, about 2.7 px at 1080p, on an edge moving a few hundred px/s. That is the same granularity as native 720×480 Joysound output, and most viewers are unlikely to see it as judder. The impact is smaller than claimed. Flooring in device pixels instead is a harmless polish.

## renderer-joysound-10

**The 900-line JOY-02 parser and its order-dependent romaji passes have no unit tests** (low, confirmed, test-gap) · `src/common/joysoundParser.ts:350`

**Summary.** There is no joysoundParser.test.ts; only getSongDuration is covered, through jobs.test.ts. The four romaji passes walk glyphs and kuromoji tokens independently. They talk to each other by mutating chars[].furiganaIndex with sentinels (6969 in getNonKanaRomajiBlocks, −1 in getFillerRomajiBlocks), so they must run in exactly the order at lines 621-630. Binary offsets, the timeline (fade-in/out and scroll assignment, skipping 0xff blocks) and the romaji are all unprotected, and the crashes above went unnoticed.

**Scenario.** Any refactor or kuroshiro bump that reorders the passes or changes token shapes quietly breaks romaji, or throws and loses a song's lyrics. Nothing fails until a guest sees it on the TV.

**Suggested fix.** Add a node --test file with a small JOY-02 builder (header offsets, 15-colour palette, blocks, events), like e2e's fakeJoysoundDownload, about 40 lines. Cover: block offsets and blockSize, fade-in/out, and scroll assignment with a 0xff block; romaji for a few lines (空港へ行く, 下げる, 君の　名は); and the whitespace-only and odd-first-scroll cases.

**Verifier.** CONFIRMED: I grepped the whole repo for joysoundParser. It is imported only by jobs.ts, index.tsx, JoysoundRenderer.tsx, Player.tsx and App.tsx, and no *.test.ts imports it. Only getSongDuration is exercised, indirectly, through jobs.test.ts. The e2e fixtures (remote.spec.ts fakeJoysoundDownload, settings.spec.ts) write a 32-byte telop with only the playtime, so blocks, timeline and romaji never run in any test. The passes really are order-coupled through mutations of chars[].furiganaIndex: 6969 at line 350, which getFillerRomajiBlocks's `furiganaIndex >= 0` skip depends on, and −1 at line 468, which deleteOverwrittenFuriganaRomaji reads. Upstream has already hit a real crash here (bb52de9). The finder's harness runs the real parser in Node in milliseconds, so a small builder-based test file is cheap and worth having for this risky logic.

## renderer-playback-10

**The kuromoji dictionary (100 MB inflated) loads at every launch, on the display's main thread** (low, confirmed, performance) · `src/renderer/index.tsx:21`

**Summary.** kuroshiro.init runs at module load. kuromoji's browser loader fetches 17 MB of .dat.gz and inflates about 100 MB with zlibjs (pure JS) on the renderer's main thread, then keeps it in memory. This happens even at a party with no Joysound songs; parseJoysoundData is the only user.

**Scenario.** Every launch, and every crash reload mid-party, the renderer's main thread spends its first moments inflating 100 MB, and a DAM/YouTube-only night still holds about 100 MB of dictionary.

**Suggested fix.** Make analyzerInitPromise lazy (a getter that starts kuroshiro.init on its first call). Start it from loadJoysound as soon as a Joysound song is popped, or in requestIdleCallback once the display is up, so Joysound users don't pay for it at the first lyrics.

**Verifier.** CONFIRMED: The facts hold. kuroshiro.init runs at module load (index.tsx:16-21). The only await on analyzerInitPromise is in joysoundParser.ts:610. kuromoji's BrowserDictionaryLoader inflates each .dat.gz with zlibjs Gunzip in the XHR onload, on the main thread (BrowserDictionaryLoader.js:40-50). gzip -l reports 17.4 MB to 100.3 MB. A scratch script (verify-renderer-playback/inflate.cjs) using the same zlibjs took 560 ms in Node to inflate all 12 files. The main-thread time is spread over 12 callbacks during startup, while the display waits 5 s for its first poll anyway, so nobody sees it. The real cost is about 100 MB held on nights with no Joysound songs. Low.

**Also reported as** (Load the kuromoji dictionary lazily, on the first Joysound song.):

- cross-performance-6: The display unpacks the 17.5 MB kuromoji dictionary on its main thread at every load, even with no Joysound song (`src/renderer/index.tsx:21`). Its fix: Make the KuroshiroSingleton lazy: create analyzerInitPromise on the first Joysound telop parse, or kick it off when a Joysound song is queued or popped. Ideally run tokenizing in a worker too. That saves ~0.6-2 s of main-thread work per load and ~100 MB when no Joysound song plays.

## renderer-playback-11

**AdhocLyrics measures each line on a hidden canvas, in a font it doesn't render** (low, plausible, maintainability) · `src/renderer/AdhocLyrics.tsx:29`

**Summary.** AdhocLyrics measures a line height on a hidden 100%-wide canvas in '4vw sans-serif'. The CSS renders 44px notoSerifJP, so the comment saying they match is stale. fontBoundingBox metrics come from the primary font, so the height is a constant and the line spacing is even but unrelated to the 44px text. The px sizes and offsets ignore the UI scale. CSS layout could replace the canvas measurement.

**Scenario.** Each push re-measures all lines (up to 400) on a canvas that's 100% wide and invisible. Line spacing has no fixed relation to the 44px text, and the ad-hoc lyrics don't follow Settings' UI scale the way the rest of the TV does.

**Suggested fix.** Drop the canvas and getTextHeight. Lay the lines out in CSS as a flex column anchored at the bottom, with a gap in em or rem, and keep lyric-fade-in on the last line. That removes about 40 lines and the hidden canvas, and the lyrics scale with --kf-ui-scale.

**Verifier.** PLAUSIBLE: These facts hold. The canvas font '4vw sans-serif' and its 'must match the CSS' comment (AdhocLyrics.tsx:29-33) don't match the CSS, which renders 44px notoSerifJP (AdhocLyrics.css:10, :21). A hidden 100%-wide canvas (:68) and invariants (:48-60) exist only to get a height. The px sizes (44px; 32px, 128px and +64 offsets at :75-79) ignore --kf-ui-scale. The 'uneven spacing in mixed scripts' claim is likely wrong: Chromium's TextMetrics takes fontBoundingBoxAscent/Descent from the primary font, and if '4vw' doesn't parse, the font stays at the default 10px sans-serif, which is also constant. Either way h is the same for every line, and lines are evenly spaced at (n−i)·h·3.4. The code is an elaborate way to compute a constant that bears no relation to the rendered size. Removing it is a reasonable cleanup in a niche feature (YouTube ad-hoc lyrics), and nothing visible breaks.

## oe-display-4

**AdhocLyrics measures every line on a hidden DOM canvas in a font that is no longer the one shown** (over-engineering, KEEP, medium) · `src/renderer/AdhocLyrics.tsx:48`

**Now.** A `<canvas>` in the DOM and its 2D context measure each line's height with the font "4vw sans-serif". The results are stored in state by an effect (handleNewLyrics → LyricEntry[] with an unused lyricIndex and displayIndex = index), then turned into an absolute `marginTop` per line. The render sends both branches through the same `wrapLyricElement` closure, and there are two `invariant` calls on the canvas.

**Why it's more than needed.** The comment says the font 'must match the width specified in AdhocLyrics.css'. But the CSS has drawn lines at 44px notoSerifJP since fee69fb (2023, 'fonts'), and the 4vw went then. So the measurement is of a font nobody sees. fontBoundingBoxAscent + Descent is a property of the font, not of the text, so it's about the same for every line. Wrapped lines aren't accounted for either. Plain CSS stacking does this job exactly.

**Simpler shape.** Keep the absolute positioning and the `transition: margin-top` in AdhocLyrics.css. Render straight from the live state: adhocLyrics.map((l, i) => <div key={i} className="entry-container" style={{marginTop: `calc(${-(n - i) * LINE_VW}vw + 64px)`}}>{i === n - 1 ? <div className="lyric-fade-in">{l.lyric}</div> : l.lyric}</div>). LINE_VW is the old constant (about 3.4 × the 4vw font box, around 15–16vw; check it by eye), and the static styles move into the CSS. Drop the canvas, useState, useEffect, handleNewLyrics, getTextHeight, LyricEntry and both invariants. The result is about 25 lines, and it now tracks window resizes. Use flex column with gap only if losing the slide is acceptable.

**Saves.** About 70 of the file's 101 lines, a DOM canvas, a state-plus-effect pair, and this file's use of ts-invariant.

**Risk.** The 0.25 s margin-top transition (older lines sliding up when a new one arrives) goes away unless it's replaced with a CSS animation. Check a YouTube song with adhoc lyrics by eye (youtube.spec.ts, screenshots).

**Verifier.** Verified. fee69fb (2023 'fonts') changed .entry-container from 4vw to 44px notoSerifJP and dropped its comment 'this must match the canvas width check'. The TSX still measures '4vw sans-serif' with a comment saying it must match. fontBoundingBoxAscent + fontBoundingBoxDescent depend on the font, not the text, so the per-line canvas measurement yields one constant (a function of the window width at the time the lyrics last changed). lyricIndex and displayIndex in LyricEntry go unused beyond the key. No test checks the layout: AdhocLyrics' classes appear in no spec, and screenshots.spec.ts seeds hasAdhocLyrics: false. The canvas also takes up layout space: width 100% at 300x150 intrinsic means its height is half the width, invisibly. One correction: the proposed flex/gap rewrite drops the margin-top 0.25 s slide of the older lines, which is visible on the TV. A simpler shape keeps it.

## oe-display-5

**The Kuroshiro 'singleton' is passed as a prop through App and Player, which only forward it** (over-engineering, WEAK, low) · `src/renderer/index.tsx:23`

**Now.** index.tsx builds a `KuroshiroSingleton` object `{kuroshiro, analyzer, analyzerInitPromise}` and passes it App → Player → JoysoundRenderer → parseJoysoundData. App (prop at line 183, passed on at 450) and Player (lines 16 and 52) only forward it, and each imports joysoundParser just for the type.

**Why it's more than needed.** A module-level singleton passed down as a prop is a pass-through layer: two components carry something they never use. JoysoundRenderer is the only consumer.

**Simpler shape.** If done: src/renderer/kuroshiro.ts creates Kuroshiro and the analyzer at import, starts init, and exports the KuroshiroSingleton. JoysoundRenderer imports it and keeps passing it to parseJoysoundData. index.tsx imports it for the side effect, or just leaves it to JoysoundRenderer's eager import. Drop the prop from App and Player.

**Saves.** About 12 lines, two pass-through props, and App and Player no longer depend on joysoundParser.

**Risk.** Keep creating it at startup, not lazily, so the first Joysound song doesn't wait for the kuromoji dictionary to load. parseJoysoundData must keep taking it as a parameter, because the main process imports joysoundParser (getSongDuration in downloads/jobs.ts).

**Verifier.** The facts are right. App and Player only forward the prop, JoysoundRenderer is the only consumer, and main imports only getSongDuration from joysoundParser, which takes no kuroshiro. But passing a dependency down two levels is ordinary React. It is about 10 lines and has never caused a bug. A module singleton would move creation of the kuromoji dictionary into JoysoundRenderer's import graph, which must stay eager (it is today, through Player → App → index). The saving is real but tiny.
