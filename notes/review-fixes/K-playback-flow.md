# Phase K: Display: playback flow

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/renderer/useSongPlayer.ts, src/main/ipc.ts, and the smallest change in src/main/api.ts popSong needed to replay the current song.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                               | Severity | Title                                                                                               |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| [renderer-playback-1](#renderer-playback-1)           | Medium   | Joysound songs play at whatever gain the previous song set                                          |
| [renderer-playback-4](#renderer-playback-4)           | Medium   | After the queue runs dry, the last song's pitch bars and lyrics keep drawing behind the idle screen |
| [gap-sleep-resume-power-5](#gap-sleep-resume-power-5) | Medium   | One failed DAM fragment request ends the song, though up to 90 s are buffered                       |
| [main-state-1](#main-state-1)                         | Medium   | Reloading the display drops the song that was playing                                               |
| [renderer-playback-7](#renderer-playback-7)           | Low      | A DAM stream that ends without the video's 'ended' event leaves the display stuck on its last frame |

## renderer-playback-1

**Joysound songs play at whatever gain the previous song set** (medium, confirmed, bug) · `src/renderer/useSongPlayer.ts:258`

**Summary.** loadJoysound calls video.play() without audio.gain(), so the song gain node keeps the last song's value: 1.0 after DAM, 0.8 after Niconico, or a YouTube song's gainValue (10^(-loudnessDb/20), which validation allows from 0 to 100) after YouTube.

**Scenario.** In a mixed queue, a loud YouTube video (loudness_db +6, so gainValue 0.5) plays and then a Joysound song: the Joysound song comes out 6 dB quieter than it would after a DAM song. After a quiet YouTube upload (loudness_db −10, gainValue 3.16) the Joysound song plays at +10 dB and clips. The loudness of a Joysound song depends on what played before it.

**Suggested fix.** Give Joysound its own constant and set it: replace video.play() at :259 with play(video, JOYSOUND_GAIN). Pick DAM_GAIN or NON_DAM_GAIN by ear.

**Earlier reviews.** Not in the earlier reviews; pre-existing behaviour kept on purpose by the useSongPlayer refactor.

**Verifier.** CONFIRMED: loadJoysound ends with a bare video.play() (useSongPlayer.ts:258-259). The only place the song gain is set is play() at :131-134 (audio.gain), reached from loadDam :228, loadYoutube :273 and loadNico :282. A grep of src/renderer finds no other gain setter. In webAudio.ts the order is input → splitter/merger → delayNode → gainNode (:57-59, :74), so gainNode applies to Joysound too and keeps whatever value the last song left. YouTube's gainValue is 10^(-loudness_db/20) (api.ts:529). Typical loud uploads (+3 to +8 dB) leave 0.4-0.7, so a Joysound song after one plays 3-8 dB quieter than after DAM. The comment 'At the gain the previous song left, as always' shows this was carried over knowingly, but the loudness still depends on queue order. It is audible in a common mixed queue without breaking playback, so medium.

**Also reported as** (loadJoysound calls a bare video.play(), so a Joysound song plays at the previous song's gain. One line: play(video, JOYSOUND_GAIN).):

- renderer-audio-4: Joysound songs play at whatever gain the previous song left (`src/renderer/useSongPlayer.ts:258`). Its fix: `play(video, JOYSOUND_GAIN)` with a constant next to DAM_GAIN/NON_DAM_GAIN (1.0, or a level measured against DAM).
- cross-maintainability-2: A Joysound song plays at whatever gain the previous song left (`src/renderer/useSongPlayer.ts:259`). Its fix: `play(video, JOYSOUND_GAIN)` with a constant (1.0, matching DAM, unless measured otherwise), so every kind sets its own gain.

## renderer-playback-4

**After the queue runs dry, the last song's pitch bars and lyrics keep drawing behind the idle screen** (medium, confirmed, performance) · `src/renderer/useSongPlayer.ts:288`

**Summary.** startSong(null) only sets WAITING and re-arms the poll. The overlay, the hls.js instance and the ended <video>'s media all stay. Player keeps PianoRoll mounted: a WebGL requestAnimationFrame draw every frame, plus a 25 ms setInterval per mic that calls native getPitch, which allocates a buffer and runs pitch detection on each call. It also keeps JoysoundRenderer mounted, whose requestAnimationFrame loop clears a full-screen WebGL canvas every frame. Both run under the opaque IdleScreen until the next song starts.

**Scenario.** A DAM or Joysound song with pitch bars on (the default) ends and nothing is queued. For the whole idle stretch (between rounds, or overnight) the renderer draws two hidden WebGL canvases at 60 fps and runs 40 pitch detections a second per mic. A laptop driving the TV keeps its GPU and fans busy. A streamed DAM song also keeps its hls.js instance and MSE buffers.

**Suggested fix.** When no song follows, call setOverlay(null), destroy hlsRef, and release the video with video.removeAttribute("src"); video.load(). Doing the video release at the start of every song as well stops the PLAYING effect's video.play() (:403) from restarting the previous, ended video while a DAM song is still waiting on its HEAD check.

**Verifier.** CONFIRMED: startSong(null) only calls setPlaybackState('WAITING') and schedulePoll() (useSongPlayer.ts:288-291). setOverlay is called only in the loaders, pollQueue doesn't touch the overlay, and hlsRef is destroyed only in startSong for a new song, skipBroken and unmount. So after a DAM song, Player keeps rendering PianoRoll (Player.tsx:38-65). Its rAF draw keeps requesting frames, because the ended video's readyState stays ≥ HAVE_METADATA (PianoRoll.tsx:555-594). Its 25 ms pollers pass the readyState check and call mic.getPitch() before checking paused (:504-509). That is a 1200-sample FFT detection at 48 kHz, with a fresh Vec each call (lib.rs:659-662, :546). After a Joysound song, JoysoundRenderer's loop clears and blends a full-screen canvas every frame with no ended/paused guard (JoysoundRenderer.tsx:926-1003). All of this runs under the opaque IdleScreen (IdleScreen.css:10) while the queue is empty, and a streamed DAM song keeps its hls.js MSE buffers (maxBufferLength 90). The per-call pitch cost is small, but 60 fps WebGL loops keep the GPU and compositor busy through idle stretches that can last hours, so medium. The side claim holds too. After idle, startSong(DAM) sends PLAYING, and the effect at :403-404 calls video.play() on the previous ended video, which restarts it from 0 while loadDam awaits its HEAD check. That window is short.

**Also reported as** (startSong(null) leaves the overlay, hls and the video mounted. Call setOverlay(null), destroy hls and release the video.):

- renderer-joysound-7: After the last song ends, the Joysound draw loop (and the roll's) keeps running under the idle screen, holding the song's textures (`src/renderer/useSongPlayer.ts:288`). Its fix: setOverlay(null) when startSong gets no song (or on 'ended'). In draw(), skip the GL work when video.currentTime equals the last drawn time.
- gap-long-party-gpu-4: When the queue runs dry, the last song's draw loops, pitch pollers and hls buffers keep running under the idle screen (`src/renderer/useSongPlayer.ts:288`). Its fix: In startSong(null), destroy hls (hlsRef.current?.destroy(); hlsRef.current = null) and call setOverlay(null). The canvases then unmount, which clears their intervals and rAF loops. Pass `backBufferLength: 30` to new Hls(...) so a long stream doesn't keep its whole past buffered.
- gap-sleep-resume-power-6: After the last song, its pitch bars and lyrics keep drawing behind the idle screen (`src/renderer/useSongPlayer.ts:289`). Its fix: Call setOverlay(null) in startSong(null); it's a no-op on later empty polls. Optionally move the paused check in pollPitch before getPitch. This saves the whole render loop while idle.

## gap-sleep-resume-power-5

**One failed DAM fragment request ends the song, though up to 90 s are buffered** (medium, confirmed, bug) · `src/renderer/useSongPlayer.ts:168`

**Summary.** While a DAM song streams (it hasn't finished downloading, e.g. the first song queued onto an empty queue), one fragment request that fails with HTTP status 0 while navigator.onLine is true is fatal at once, and skipBroken ends the song even with up to 90 s buffered. Status 0 covers a reset connection, ERR_NETWORK_CHANGED on a VPN reconnect, a DNS failure or a TLS error.

**Scenario.** A DAM song streams from Japan through the host's VPN. 40 s in, the VPN reconnects (a Wi-Fi blip, the lid closed and opened, a router hiccup) and one fragment request is reset. hls.js has about 90 s buffered, but the error is fatal: skipBroken destroys hls, and the song stops mid-verse with "Couldn't play: skipping to the next song". After a suspend and resume, Wi-Fi is usually back before the VPN, so the first fragment requests fail in exactly this way.

**Suggested fix.** On a fatal NETWORK_ERROR, if video.buffered extends at least ~5 s past currentTime, don't skip. Instead wait a few seconds and call hls.startLoad(), counting attempts per song; skip after 5 or so, or once playback has stalled with nothing buffered. Alternatively, pass a fragLoadPolicy whose errorRetry.shouldRetry also retries status 0, up to about 10 times with an 8 s maximum delay. Keep skipping on fatal media or other errors, or try hls.recoverMediaError() once first.

**Earlier reviews.** Product review #1 (non-fatal errors skipped songs) was fixed by skipping only on fatal errors; this is the next case down.

**Verifier.** CONFIRMED: I traced it through hls.js 1.7.1. error-helper.ts:62-96: shouldRetry calls retryForHttpStatus, which retries status 0 only when navigator.onLine is false; xhr-loader.ts:224 applies the same check. error-controller.ts:307-352 then calls getLevelSwitchAction. With a single level it returns SendAlternateToPenaltyBox with MoveAllAlternatesMatchingHost. No branch of sendAlternateToPenaltyBox resolves that flag, switchLevel(undefined) does nothing, and onErrorOut (:477-500) sets data.fatal = true. useSongPlayer.ts:168-170 then skips on any fatal error. One condition narrows it: loadDam (:180-229) plays the downloaded file when it exists, and api.ts:617 starts a download for every queued DAM song. So this only hits songs that are still streaming, which is the common case of the first song after an idle stretch or a download slower than the queue.

## main-state-1

**Reloading the display drops the song that was playing** (medium, confirmed, bug) · `src/main/ipc.ts:128`

**Summary.** After a renderer crash (index.ts auto-reloads it) or the host's Ctrl+R/F5, the new page's first popSong replaces currentSong with the next song. The song that was being sung is never replayed. An app restart, by contrast, saves the current song at the head of the queue so it plays again.

**Scenario.** Queue [A, B]. The display pops A and Alice is singing it. The renderer crashes (GPU reset, OOM) or the host confirms Ctrl+R. index.ts:190-193 reloads, the preload re-subscribes (subscribeLive just swaps the subscription), and useSongPlayer's mount poll calls popSong 5 s later. A is overwritten by B, and with an empty queue currentSong just becomes null. Alice's song is gone and only shows in history.

**Suggested fix.** When a display page subscribes while currentSong is non-null, do one store.update that moves currentSong back to the head of songQueue and resets the timing (what serializeState does for a restart). Its adhoc lyrics survive, since popSong deletes them only when moving past it, and popSong's history dedupe prevents a duplicate entry. Pass the store (or an onDisplayLoad callback) into createDisplayIpc. Requeue a given songId@timestamp only once, so a song that crashes the renderer can't loop.

**Verifier.** CONFIRMED: I reproduced it with the real createApi, createStateStore, createLiveHub and createDisplayIpc (scratch reload.mts). Page 1 pops sm1, then a second subscribeLive stands in for the reload, then page 2 pops. The result is current sm2, queue [], history [sm2, sm1]: sm1 is never replayed. subscribeLive (ipc.ts:123-136) only runs endLive() and subscribe. popSong (api.ts:966-976) shifts the queue over the current song, and only serializeState requeues a current song. On the renderer side, Player's mount effect runs before LiveStateProvider's effect, because React runs child effects first. So at mount, usePlaybackState reads the empty store as WAITING and schedulePoll arms the 5 s poll. Then the live state arrives (PLAYING, current A), and the [playbackState] effect calls video.play() on an empty <video>. Five seconds later popSong drops A. Renderer crashes and a confirmed Ctrl+R are uncommon, so medium is right.

**Also reported as** (A display reload or crash drops the current song. Requeue currentSong once per songId@timestamp when a display subscribes, then extend the ipc.spec reload test (tests-e2e-2) to pin it. renderer-playback-3's extra idea, error boundaries inside Player, is covered by gap-long-party-gpu-1.):

- renderer-playback-3: Every renderer reload skips the song that was playing (`src/renderer/useSongPlayer.ts:345`). Its fix: On mount, ask for the current song rather than the next one: a popSong({resume:true}) or resumeSong that returns state.currentSong, built the way popSong builds it (DAM URLs, scoring data), when one is set. Then seek to the position the server last had (currentSongStartedAt and currentSongPausedMs). Also put error boundaries around Settings and the overlays (lyrics, pitch bars) inside Player, so their errors don't unmount the video.
- cross-performance-1: A display reload mid-song drops the song being sung instead of replaying it (`src/renderer/useSongPlayer.ts:345`). Its fix: When a second liveSubscribe arrives (a reloaded page, i.e. stopLive was non-null in ipc.ts:123-136), or through a small `resumeSong` API, put state.currentSong back at the head of songQueue. Clear its timing and set playbackState to WAITING, as serializeState does for restarts. popSong's duplicate-history check at api.ts:979-985 already keeps history clean. Also load playbackState as WAITING instead of saving it. Extend the ipc.spec reload test to expect song 1 to start again.
- tests-e2e-2: Reloading the display mid-song drops the current song, and ipc.spec's reload test doesn't notice (`tests/e2e/ipc.spec.ts:73`). Its fix: In the reload test, also assert that the video is playing nico-sm70001.mp4 again and that the live currentSong is still song 1 more than 6 s after the reload. That fails today and pins the renderer fix. The fix itself needs a resume path: the display, mounting with a live currentSong, loads that song instead of polling; a DAM song needs its streaming URLs again. Once that lands, settings.spec's reload check should assert the roll is absent while a song is playing.

## renderer-playback-7

**A DAM stream that ends without the video's 'ended' event leaves the display stuck on its last frame** (low, plausible, bug) · `src/renderer/useSongPlayer.ts:156`

**Summary.** The display moves on only on the video's 'ended' event (:340), and for HLS it listens only to Hls.Events.ERROR. hls.js 1.7.1 emits MEDIA_ENDED for the cases where the browser doesn't fire 'ended': playback stalled within a second of the end with the MediaSource ended, or media.ended true but no event dispatched.

**Scenario.** A streamed DAM song stalls just before its end, for example over a short gap in the last fragment. hls.js fires MEDIA_ENDED {stalled:true}, but no 'ended' arrives, so popSong is never called: the TV holds the last frame and the queue waits. Skip seeks to duration and then waits for the same 'ended'.

**Suggested fix.** In load(), add hls.on(Hls.Events.MEDIA_ENDED, () => { if (songRef.current === song) pollQueue(); }). The songRef and pollingRef guards already make a second call (from 'ended' as well) harmless.

**Verifier.** PLAUSIBLE: The mechanism is real. streamDam subscribes only to Hls.Events.ERROR (useSongPlayer.ts:156-171), and the display moves on only on the video's 'ended' (:340). The installed hls.js is 1.7.1, and its gap-controller fires MEDIA_ENDED in exactly the cases the browser doesn't signal: media.ended without an event (gap-controller.ts:224-230), and a stall within 1 s of the edge with MediaSource readyState 'ended' (:328-341). Chromium normally fires 'ended' after endOfStream, even with track-length mismatches, and nothing in the repo or notes reports a DAM song stuck at its end. So I couldn't show it happens with DAM's streams. If it does, the display freezes and the queue stalls until someone acts. The suggested one-line MEDIA_ENDED handler is safe given the songRef and pollingRef guards.
