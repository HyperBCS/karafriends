# Phase L: Commands, playback state and the clock

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 2; starts after: A, C, H, K.

Files: src/main/api.ts (playback handlers), src/main/state.ts, src/main/live.ts (throttle), src/common/api.ts, src/common/hooks/*, src/common/apiClient.ts (clock), the display's src/renderer/index.tsx QueryClient, and the phone and display callers of these hooks.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                                 | Severity                        | Title                                                                                                                             |
| ------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [main-api-1](#main-api-1)                               | Medium                          | Skip, pause, restart, key and lyric commands don't say which song they target, so a late one hits the next song                   |
| [main-state-3](#main-state-3)                           | Medium                          | During popSong's DAM wait, phones' controls act on the previous, ended video                                                      |
| [remocon-queue-1](#remocon-queue-1)                     | Medium                          | Quick ♯/♭ taps get lost: the echo of an earlier tap wipes out the later pending value                                             |
| [main-api-2](#main-api-2)                               | Low                             | A phone's Pause/Play/Skip/WAITING is accepted while no song is current; Play then replays the last video and no phone can stop it |
| [main-api-4](#main-api-4)                               | Low                             | queueSong's eta for an admin's head-of-queue song is the end-of-queue wait                                                        |
| [main-state-4](#main-state-4)                           | Low                             | A restart during a download silently drops the song, and the phone says 'Finished Downloading'                                    |
| [main-state-5](#main-state-5)                           | Low                             | The saved playbackState is restored after a restart, when nothing is playing                                                      |
| [main-state-9](#main-state-9)                           | Low                             | Phones' clock offset never recovers from a backward step of the host's clock                                                      |
| [remocon-queue-9](#remocon-queue-9)                     | Low                             | The pattern of a live value, an optimistic value and a mutation is written five times                                             |
| [remocon-queue-10](#remocon-queue-10)                   | Low                             | The server re-implements the phones' 'how much of the song is left' formula                                                       |
| [cross-performance-9](#cross-performance-9)             | Low                             | Each queue row runs its own 1 s timer and four store subscriptions, out of phase, even with the sheet folded                      |
| [gap-sleep-resume-power-10](#gap-sleep-resume-power-10) | Low                             | The state throttle runs on the wall clock: a backward clock step holds back every state event                                     |
| [oe-architecture-4](#oe-architecture-4)                 | Over-engineering (KEEP, medium) | The current song's clock has two writers, and one field becomes dead once the display reports                                     |
| [oe-phone-5](#oe-phone-5)                               | Over-engineering (KEEP, low)    | withETAs keeps a timing/now branch that only tests call                                                                           |
| [oe-phone-6](#oe-phone-6)                               | Over-engineering (KEEP, low)    | useGuideMelodyLevel is a shared hook with one caller left                                                                         |
| [oe-architecture-10](#oe-architecture-10)               | Over-engineering (KEEP, low)    | The display carries a TanStack Query client only so that two shared hooks can fire mutations                                      |

## main-api-1

**Skip, pause, restart, key and lyric commands don't say which song they target, so a late one hits the next song** (medium, confirmed, bug) · `src/main/api.ts:762`

**Summary.** setPlaybackState, setPitchShiftSemis and pushAdhocLyrics apply to whatever song is current when they arrive. A Skip, Pause or key tap sent just before a phone sees the song change therefore lands on the next song. When a second guest's Skip lands in the same 250 ms hub window as B's PLAYING, the display's optimistic PLAYING hides it: B keeps playing, but the server and every phone stay on SKIPPING, so the transport and key are disabled for all of B. When it lands later, or a Skip races A's natural end, B is skipped too. The window is about one phone round trip, not the hub interval.

**Scenario.** Song A (any kind) is playing and the next song B is a YouTube, Joysound or Niconico song. Two guests both tap Skip about 0.2 s apart. Guest 1's SKIPPING reaches the display, which seeks A to its end; 'ended' fires, popSong returns B at once and the display sends PLAYING, all in roughly 100–200 ms. Guest 2 pressed before their phone got the SKIPPING state (the hub sends at most once every 250 ms), so their SKIPPING lands after B's PLAYING and skips B too. The party loses two songs. The same thing happens when the last singer's late key tap lands after the display's setPitchShiftSemis(0) for B (B plays in the wrong key), or a lyric line pushed as A ends lands in B's adhoc lyrics.

**Suggested fix.** Add songId and timestamp to the setPlaybackState, setPitchShiftSemis and pushAdhocLyrics inputs, as reportSongPosition has, and return false when they don't match state.currentSong. The remote sends the live currentSong's. The display's own calls can skip the check (isDisplay). This also removes the adhoc-lyrics case where the same video is queued twice with different lyrics, since lookups currently go by video ID only (api.ts:546-553).

**Verifier.** CONFIRMED: Server side reproduced in a scratch test: after the display's popSong and PLAYING for song 2, bob's SKIPPING is accepted, leaving currentSong sm2 and playbackState SKIPPING. requirePlaybackControl is the only guard at api.ts:762-795, and setPitchShiftSemis (835) and pushAdhocLyrics (876) have no song check either. I traced the display side: useOptimisticValue keeps the display's own pending PLAYING from startSong (useSongPlayer.ts:332), and it is cleared only when the live value changes. useLiveState is useSyncExternalStore with a selector. One correction: the hub's 250 ms throttle does not widen the window, because phones and the display get the same flush. A late tap only gets through if it is sent before that phone draws SKIPPING (the buttons have pointer-events:none once aria-disabled) and arrives after B's PLAYING, so the window is roughly the phone's Wi-Fi round trip minus the display's skip turnaround. Two outcomes follow. (a) The late SKIPPING arrives before the next flush (the likelier case). The live value goes SKIPPING→SKIPPING, so the display keeps its pending PLAYING and B plays on. But the server and every phone stay on SKIPPING. PlaybackControls is active only for PLAYING/PAUSED, so nobody can pause, skip or change the key for the whole of B, until the display sets PLAYING for song C. (b) It arrives after the next flush, or a Skip is tapped in A's last moments and A ends on its own first. Then the live value moves PLAYING→SKIPPING and B is skipped (useSongPlayer.ts:410-418). The pitch case is real but rare. The lyrics case applies lyricIndex to B's own lyrics, so it only shows one of B's lines early, and only when B is a YouTube song with adhoc lyrics. The fix still stands: setPlaybackState, setPitchShiftSemis and pushAdhocLyrics should name the song (songId and timestamp), as reportSongPosition does.

## main-state-3

**During popSong's DAM wait, phones' controls act on the previous, ended video** (medium, confirmed, bug) · `src/main/api.ts:966`

**Summary.** popSong makes the next song current but leaves playbackState as the last song's PLAYING while it waits up to 10 s for DAM. Phones show the new song as playing with live Skip/Restart/Play buttons. The display applies them to the old video, which has already ended, and play() on an ended video restarts it from 0.

**Scenario.** A song ends and the next is a DAM song, with DAM slow or flaky (up to DAM_POP_TIMEOUT_MS = 10 s). The phone shows the new song 'playing' while the TV is frozen, so a guest taps Skip (or Restart, or Pause then Play). setPlaybackState accepts it. The display's effect (useSongPlayer.ts:406-418) seeks the ended old video to its end and calls play(), which per spec/Chromium seeks to 0. The previous song plays audibly again until popSong resolves and loadDam swaps the source, and the skip meant for the stuck song is lost.

**Suggested fix.** In popSong's update, also set state.playbackState = "WAITING". The display's PLAYING from startSong follows and starts the clock as it does now, and phones disable the transport until then. Optionally, have setPlaybackState ignore phone PAUSED/SKIPPING/RESTARTING while currentSongStartedAt === null, and have useSongPlayer ignore playback changes while songRef.current is null.

**Earlier reviews.** Related to the earlier popSong DAM-wait finding (code-review-2026-10-27.md, fixed by the 10 s timeout). The controls during the remaining wait were not covered.

**Verifier.** CONFIRMED: Scratch reload.mts, with the real API: after the display's PLAYING, popSong of a DAM song whose streamingUrls call is still pending leaves current = the DAM song, playbackState = PLAYING and currentSongStartedAt = null. A phone's setPlaybackState(SKIPPING) is accepted during the wait. PlaybackControls enables the transport for PLAYING and PAUSED. In useSongPlayer, the [playbackState] effect acts on the ended previous video with no guard on songRef/pollingRef: SKIPPING seeks to the duration and calls play(), RESTARTING sets currentTime=0 and the display then sends PLAYING, and PLAYING calls play(). Per the HTML spec, play() on an ended media element seeks to the start, so the previous song audibly restarts until startSong(B)/loadDam swaps the source. startSong then sets PLAYING, so the skip is lost. The window is popSong's two uncached DAM calls (getMusicStreamingUrls and getScoringData, each with promiseRetry, capped at 10 s). That is usually under about a second, but up to 10 s when DAM is slow, which is when a guest is most likely to tap. A real bug on a less common path: medium.

**Also reported as** (The same window while popSong waits on DAM. The two proposed fixes differ (WAITING vs PLAYING), but either way popSong must set a fresh state, and startSong must honour a SKIPPING or PAUSED that arrives during the wait.):

- renderer-playback-6: Skip or Pause pressed while a DAM song is being fetched is overridden, and the song plays anyway (`src/renderer/useSongPlayer.ts:332`). Its fix: Have popSong set playbackState to PLAYING when it shifts a song; the clock still starts on the display's PLAYING. Then a SKIPPING or PAUSED that arrives while the pop is in flight can only be about the new song. startSong then checks the live state: on SKIPPING it calls pollQueue() instead of loading; on PAUSED it loads without playing and doesn't send PLAYING.

## remocon-queue-1

**Quick ♯/♭ taps get lost: the echo of an earlier tap wipes out the later pending value** (medium, confirmed, bug) · `src/common/hooks/useOptimisticValue.ts:12`

**Summary.** useOptimisticValue drops the pending value on any change of the live value, including the echo of this phone's own earlier request. The live hub sends at most one state event per 250 ms, and each event carries the state as of that moment. So while a singer taps ♯ quickly, the echo of tap n−1 can land after tap n was sent. The stepper then falls back to the older value, and the next tap works from it and sends a value that was already sent.

**Scenario.** The key is at 0 and the singer taps ♯ five times, about 150–200 ms apart, on phone Wi-Fi (20–80 ms each way). Tap 2 shows and sends +2. Then the delayed echo of +1 arrives, the pending value is cleared and the phone shows +1. Tap 3 computes +1+1 = +2 and sends +2 again, which changes nothing on the server. The key ends at +3 or +4 instead of +5, and the number flickers +2→+1→+2 along the way. A model of the hub's throttle (scratchpad/review/find-remocon-queue/sim2.mjs) ends short in 48% of 5-tap runs at ~200 ms gaps and 86% at ~150 ms. Second effect: if the server's value returns to what this phone last saw within one 250 ms window, the hub sends no change and the pending value sticks. Examples: the display's startSong resets the key to 0, or sets PLAYING right after this phone's Pause. The phone then shows +1, or Paused, while the TV is at 0, or playing, until something else changes the value.

**Suggested fix.** Tie pending to this phone's own requests. Count in-flight requests. Clear pending when live equals the pending value, or on the first live change after the last request has settled, with a ~1 s fallback timer so a merged no-change can't leave it stuck. Run each setter's mutations one at a time with TanStack's `scope: { id }`, so concurrent POSTs can't arrive out of order. For the key, sending a delta (the server does semis += n, clamped) also removes the stale starting value.

**Earlier reviews.** Round 2 #6 (the guide-melody slider settling on a stale echo) had this root cause. The fix made the sliders send on release, but useOptimisticValue still clears on any echo, so the key stepper's quick taps still hit it.

**Verifier.** CONFIRMED: useOptimisticValue.ts:12 clears pending on any change of `live`. KeyStepper (PlaybackControls.tsx:77/95) computes from the shown value, and usePitchShiftSemis sends absolute values with no mutation scope. I drove the real createLiveHub (live.ts, 250 ms throttle) with node mock timers, a fake StateStore, a model of the phone's pending/live logic and 20–80 ms each way (scratchpad/review/verify-remocon-queue/sim.test.ts). For 5 ♯ taps, the key ended short in 0/200 runs at ~300 ms gaps, 112/200 at ~200 ms and 169/200 at ~150 ms. Sample trace: tap→1, tap→2, echo1 (shows 1), tap→2 again. The display would end at +4. The second effect (pending sticks when the server returns to the same value within one window, e.g. startSong's setPitchShiftSemis(0)) is real but needs a tap in the ~250 ms before a song change, so it's rare. Prior review: product round 2 #6 (guide-melody slider settles on a stale echo) is the same mechanism. Its fix (LevelSlider's `held`, sending only on `change`) covers the sliders only. The hook is unchanged, so the bug is still present for the key stepper and playback. Medium: the final shown value matches the server, so the singer can see the miss and correct it.

## main-api-2

**A phone's Pause/Play/Skip/WAITING is accepted while no song is current; Play then replays the last video and no phone can stop it** (low, confirmed, bug) · `src/main/api.ts:786`

**Summary.** When currentSong is null, setPlaybackState from a phone still sets playbackState (only the clock is guarded). PLAYING, PAUSED and SKIPPING then reach a display whose <video> still holds the previous, ended song. A phone may also set WAITING in the middle of a song.

**Scenario.** A guest taps Pause in the last second of a song. The display has just popped an empty queue and sent WAITING, and the guest's PAUSED lands after it. Every phone now shows 'Nothing playing' with the transport enabled (PlaybackControls is active for PLAYING/PAUSED, whatever the current song). Someone taps Play: the display runs video.play() on the ended video, which per the HTML spec starts it again from 0, so the previous song plays again. The next idle poll sets WAITING, which disables every phone's controls while the ghost plays to its end. Separately, a crafted WAITING sent mid-song disables everyone's controls until the song ends.

**Suggested fix.** In setPlaybackState, for non-display callers: return false when state.currentSong is null, and refuse WAITING (it is the display's own state). Optionally drop playbackState from serializeState (state.ts:302), which restores a stale PLAYING/PAUSED with no current song after a restart; the display sets it again on its first poll anyway.

**Verifier.** CONFIRMED: Reproduced: after popSong returns null and the display sends WAITING, alice's PAUSED is accepted with currentSong null (api.ts:771-793 only skips the clock). On the display, startSong(null) at useSongPlayer.ts:288-291 never clears video.src. PLAYING then runs video.play() on the ended video, which per the HTML spec seeks to 0, so the last song replays. The next idle poll (at most 5 s later) sends WAITING, which the playbackState effect ignores (no case for it), so the replay plays out while every phone's transport is disabled. PlaybackControls (active only for PLAYING/PAUSED) and NowPlayingSheet, which always renders the controls, match the finding. A second path probably needs no second tap: a late SKIPPING after the last song ends makes the display set currentTime = duration and call play() on the already ended video, which should also restart it (not checked in a browser). Both paths need a request that crosses the display's WAITING within about one phone round trip, so they are rare. The mid-song WAITING case needs a crafted request, and in supervised mode only those already allowed to skip can send one, so it adds nothing.

## main-api-4

**queueSong's eta for an admin's head-of-queue song is the end-of-queue wait** (low, confirmed, bug) · `src/main/api.ts:599`

**Summary.** eta is always queueEta(): what is left of the current song plus every queued song's playtime. When pushToHead is set, the song goes in at index 1 (splice(1, 0) at api.ts:302), so the phone is told a wait several songs too long.

**Scenario.** An admin shift-queues a DAM song while 8 songs of about 4 minutes are waiting. The button shows 'Queued: ~32:00', but the song starts after the current song and one more, in about 6 minutes.

**Suggested fix.** `const eta = currentSongSecondsLeft(state, now()) + (pushToHead ? (state.songQueue[0]?.playtime ?? 0) : sum)`. In other words, queueEta takes the insert index and sums songQueue.slice(0, index).

**Verifier.** CONFIRMED: Reproduced: with four 100 s songs queued, an admin's DAM queueSong with tryHeadOfQueue lands at songQueue[1] and returns {ok: true, eta: 400}. queueEta (api.ts:266-272) ignores pushToHead, and QueueButtons.tsx:53-57 shows the eta for DAM songs. It is reachable even less often than the finding suggests: useQueueSong.ts:26 sets tryHeadOfQueue only from e.shiftKey. So only an admin shift-clicking in a browser with a keyboard gets there, never from a phone. The only effect is a wrong number on a button label for a moment.

## main-state-4

**A restart during a download silently drops the song, and the phone says 'Finished Downloading'** (low, confirmed, bug) · `src/main/state.ts:321`

**Summary.** A YouTube/Niconico/Joysound song exists only in its download's closure until onReady. serializeState saves downloadQueue as [], so a crash or Settings → Restart mid-download loses the request. When the phone reconnects, its download has vanished, which its button reads as success.

**Scenario.** Bob queues a YouTube song and his button shows 'Downloading -- 45%'. The main process crashes, or the host restarts after a port change. EventSource reconnects and the new state has downloads [] and no song in the queue. nextDownloadText (useDownloadButtonText.ts:47-48, 'It was downloading and now it's gone: done') shows 'Finished Downloading'. Bob thinks he's queued, and he isn't.

**Suggested fix.** Save the in-flight downloads' QueueItems (with captionCode, lyrics and pushToHead) in queue.json and restart those downloads at launch from services.ts. At least, give the live state a per-launch bootId, and have the button treat a changed bootId with its download gone as an error, not 'Finished'.

**Verifier.** CONFIRMED: serializeState writes downloadQueue: [] (state.ts:321). A YouTube, Niconico or Joysound QueueItem exists only in the download's closure until onReady calls pushSongToQueue (api.ts:676-716), and nothing saves or resumes pending downloads. After a relaunch (Settings → Restart calls app.relaunch()+app.exit(0) in services.ts:173-176, or a crash and manual relaunch), the phone's EventSource reconnects and gets downloads []. nextDownloadText then turns 'Downloading -- 45%' with progress null into FINISHED ('It was downloading and now it's gone: done'). The song is silently lost and the button says Downloaded. A restart or crash mid-download is uncommon, so low.

## main-state-5

**The saved playbackState is restored after a restart, when nothing is playing** (low, confirmed, bug) · `src/main/state.ts:393`

**Summary.** parseState restores playbackState (PLAYING/PAUSED/...) even though a launch never restores a current song. Phones see an active transport with no song, and the display's 'start at once when a song is queued while WAITING' path doesn't fire. The saved head-of-queue song then waits for the 5 s poll.

**Scenario.** The app crashes mid-song (playbackState PLAYING) and relaunches with the old current song at the head of the queue. The display mounts and the live state says PLAYING. useSongPlayer.ts:391-394 needs WAITING to pop at once, so the first song starts only after the 5 s poll. Meanwhile phones show PLAYING with enabled controls and no song, and the display's effect calls video.play() on an empty <video>, an uncaught rejection.

**Suggested fix.** Leave playbackState out of serializeState and parseState so every launch starts at WAITING. Drop the dead restores, putting any currentSong found in an old file at the head of the queue instead. That is about 15 fewer lines.

**Verifier.** CONFIRMED: serializeState's `...saved` keeps playbackState, and parseState restores it (state.ts:393-395) while a launch never has a current song. After a mid-song crash or restart (saved PLAYING), the display mounts with the empty store read as WAITING and arms the 5 s poll. When the restored PLAYING arrives, the WAITING+hasQueue fast path (useSongPlayer.ts:391-394) doesn't fire, and the PLAYING effect calls video.play() on an empty <video>, an unhandled rejection that is only logged (the renderer has no handler). The first song starts after up to 5 s instead of at once, and phones show an active transport with no song. The dead-code part is accurate too: git history shows every saving version since queue persistence was added (#207, then 38d24d2) wrote currentSong: null and currentSongAdhocLyrics: [] (and pitchShiftSemis 0 since 38d24d2). So parseState's restores of those fields, including currentSong in the adhoc-lyrics loop, never see real data. The impact is small: low.

## main-state-9

**Phones' clock offset never recovers from a backward step of the host's clock** (low, plausible, bug) · `src/common/apiClient.ts:235`

**Summary.** noteStateSentAt keeps the smallest (arrival − sentAt) for the life of the page. If the host's clock is stepped backward (a w32time/NTP correction, often after sleep), every later offset is larger and ignored. serverNow() then runs ahead of the server by the step, and every countdown and progress line on that phone is off until the page reloads.

**Scenario.** The host laptop's clock runs 4 s fast and Windows time sync corrects it mid-party. The server re-anchors the current song on the next reportSongPosition (POSITION_SLACK_MS). But every open phone keeps its old minimum offset, so its ETAs read 4 s short and the progress line runs ahead, until the guest reloads.

**Suggested fix.** Take the minimum over a sliding window (the last ~20 state events or ~5 minutes), or reset clockOffset on each stream (re)open's first state event.

**Verifier.** PLAUSIBLE: The mechanism is accurate (apiClient.ts:229-241). clockOffset is a module-level minimum of arrival − sentAt, never reset on reconnect. After a backward step of X in the host's clock, every later offset is X larger and ignored, so serverNow() runs X ahead of the server. useQueue.ts:80 and the progress line then read X off, even after reportSongPosition re-anchors the server's timing, until the page reloads. A forward step in the phone's own clock has the same effect. Forward host steps are adopted at once. Reachability is low: the host is awake and playing video all party, so there's no resume-from-sleep RTC step, and NTP-style corrections are usually sub-second slews. Countdowns shown in m:ss shift by that amount. Rare and small.

**Also reported as** (The clock offset is a lifetime minimum. Reset it on stream reopen, or take the minimum over a window.):

- gap-sleep-resume-power-9: serverNow's clock offset never forgets, so one clock step skews every countdown until reload (`src/common/apiClient.ts:235`). Its fix: Reset clockOffset to null in the onOpen of each (re)connect, and/or take the minimum over a recent window (for example the last 20 state events) so the offset can rise again.

## remocon-queue-9

**The pattern of a live value, an optimistic value and a mutation is written five times** (low, confirmed, maintainability) · `src/common/hooks/usePitchShiftSemis.ts:6`

**Summary.** The pattern of a live value, an optimistic value and a mutation is copied in five places (three hooks and two SettingsPage sliders). Changes to the clearing rule alone can stay in useOptimisticValue, but tracking requests in flight or adding a mutation scope for finding 1 would have to be repeated in each copy.

**Scenario.** Fixing the stale-echo bug or adding a mutation `scope` in useOptimisticValue alone isn't enough: each copy creates its own mutation and calls setPending itself, so the request tracking would be missing in four places.

**Suggested fix.** Write one `useLiveSetter(live, method, toInput, what)` that returns [value, set], owns the mutation (with `scope`) and the optimistic state, and tracks requests in flight. Each caller becomes 2–4 lines, saving about 45 lines, and the fix for finding 1 lives in one place.

**Verifier.** CONFIRMED: Grepping the whole repo confirms five copies of live → useOptimisticValue → useApiMutation(onError: log + clearPending) → setPending, then mutate: usePlaybackState.ts, usePitchShiftSemis.ts, useGuideMelodyLevel.ts, and SettingsPage.tsx's SongVolumeSlider (≈279-300) and MicLevelSlider (≈303-330). QueueList is a sixth, variant use. One part is overstated: a fix that only changes the clearing rule (clear when live equals pending, a fallback timer) lives in useOptimisticValue alone. Request counting and mutation `scope` do need every caller, so with finding 1 a single useLiveSetter is worth doing. Low maintainability.

**Also reported as** (The useLiveSetter hook. remocon-queue-1's fix belongs in it.):

- cross-maintainability-10: The live-value-plus-optimistic-setter hook is written out five times (`src/common/hooks/usePitchShiftSemis.ts:5`). Its fix: Add `useLiveSetter(select, method, toInput, what)` in common/hooks, returning [value, set]. The three hooks become one-liners, and the two sliders call it. About 50 fewer lines.

## remocon-queue-10

**The server re-implements the phones' 'how much of the song is left' formula** (low, confirmed, maintainability) · `src/main/state.ts:207`

**Summary.** currentSongSecondsLeft copies left() from useQueue.ts line for line, and its comment says it is "rounded as the phones' queue rounds it". A change to the rounding or clamping in one copy would quietly make the button's "Queued, up in m:ss" disagree with the queue's countdown beside it.

**Scenario.** Someone changes left()'s Math.round to Math.floor, or its clamp, for the phone's countdown. queueSong's ETA (api.ts:266, :599) keeps the old rule, so a DAM button says "up in 4:13" while the queue row says +4:12.

**Suggested fix.** Export left(), as secondsLeft(playtime, timing, now), from src/common (useQueue.ts has no Electron imports) and call it from state.ts with `(currentSongLength ?? currentSong.playtime) || 0`. This removes about 8 lines and one thing to keep in sync.

**Verifier.** CONFIRMED: state.ts:207-225 currentSongSecondsLeft repeats useQueue.ts:18-24 left() line for line: the same until/playedMs and Math.max(0, Math.round(playtime - Math.max(0, playedMs)/1000)). Only the state.ts comment points at the other copy, and the two are tested separately (useQueue.test.ts, state.test.ts), so a change to one wouldn't fail the other's tests. Drift would cost at most a second or a clamping edge, so this is lowest priority. Correction to the suggested fix: main shouldn't import src/common/hooks/useQueue.ts, which pulls React and apiClient into the main bundle. Move left() into a plain module (e.g. src/common/songTiming.ts) that both import.

**Also reported as** (One shared secondsLeft() in a React-free src/common module.):

- tests-unit-6: The countdown maths is written twice, with two test suites pinning the same numbers (`src/common/hooks/useQueue.ts:18`). Its fix: Export one `secondsLeft(playtime, timing, now)` from src/common; useQueue.ts can host it, since that function uses no React. Make currentSongSecondsLeft call it with `(state.currentSongLength ?? state.currentSong.playtime) || 0`, and keep one state.test case for the length-or-playtime choice. That removes about 10 lines of code and 30 of duplicated tests.

## cross-performance-9

**Each queue row runs its own 1 s timer and four store subscriptions, out of phase, even with the sheet folded** (low, plausible, maintainability) · `src/common/hooks/useQueue.ts:71`

**Summary.** Every <Wait> row calls usePlayed, which subscribes 4 selectors and starts its own setInterval. The phone's root QueueNotifications runs one more. The Sheet only sets `hidden` on its body, so all of them tick while the queue is folded away. Because each timer starts when its row mounts, rows round 'played' at different moments, and two rows' waits can disagree by a second.

**Scenario.** With a 30-song queue, each phone runs 31 one-second intervals and about 120 extra store subscriptions for the whole song, sheet open or not. A row added later ticks half a second after the others, so the gap between two adjacent waits (e.g. +4:00 / +8:01, then +8:00) jitters each second.

**Suggested fix.** Use one shared clock: a module-level ticker that starts with its first subscriber, read through useSyncExternalStore. usePlayed reads it, and Wait passes live={expanded}. That gives one timer per page, all rows in phase, and no ticking while folded.

**Earlier reviews.** code-review-2026-10-27-product.md round 2 #10 (marked fixed): partly addressed. Only Wait re-renders now, but each row still has its own timer and they keep ticking while the sheet is folded.

**Verifier.** PLAUSIBLE: The facts are right. Wait leads to useWait and then usePlayed, which subscribes 4 selectors and starts its own setInterval. The root QueueNotifications calls useQueue() with live=true, which adds one more. Sheet only sets hidden on its body (Sheet.tsx:57), so the rows stay mounted and keep ticking while folded. The performance cost is negligible, though: about 31 tiny one-second re-renders of text nodes, inside a hidden subtree when folded. The phase claim is narrower than stated. Rows that mount in the same commit start their intervals together, and every row re-phases when ticking toggles (a new song, a pause or a resume). Only rows added mid-song tick out of phase, and then two rows' rounded waits can briefly differ by 1 s until the next song or pause. This is a small cosmetic issue, and a shared clock is a reasonable cleanup but not urgent.

## gap-sleep-resume-power-10

**The state throttle runs on the wall clock: a backward clock step holds back every state event** (low, plausible, bug) · `src/main/live.ts:247`

**Summary.** scheduleFlush waits `lastSentAt + intervalMs − Date.now()`. After the clock steps back by X, that wait becomes X + 250 ms, and every later change sees the pending timer and returns. The display (over IPC) and every phone then get no state until the timer fires or a publish or subscribe forces a flush.

**Scenario.** The host's clock is stepped back 90 s, by NTP after resume or by Windows time sync. For up to 90 s, a phone's Skip or Pause reaches the store but not the display, because useSongPlayer acts on playbackState from the live state, and phones see nothing change. It ends sooner only if someone happens to queue a song, send an emote, or connect.

**Suggested fix.** Use a monotonic clock for the throttle: performance.now() for lastSentAt and the wait. Or clamp it: `const wait = Math.min(intervalMs, lastSentAt + intervalMs - Date.now())`. Keep Date.now() only for sentAt.

**Earlier reviews.** New

**Verifier.** PLAUSIBLE: live.ts:245-253 computes wait = lastSentAt + intervalMs − Date.now() on the wall clock. My scratch test ran createLiveHub with a 50 ms interval, stepped Date.now back 3 s after a flush, then made two store updates (pitch, then PAUSED). Nothing was delivered after 500 ms; the state arrived only after about 3 s. So a backward step of X holds every state event for about X, unless a publish or a subscribe forces a flush (:268-279). That would delay a phone's Pause or Skip reaching useSongPlayer (:396-421). The usual corrections after resume are small, so the stall is a second or two. Long stalls need a big backward step while the app runs, such as a dual-boot RTC timezone mismatch corrected after launch, which is rare. The clamp fix is trivial and worth taking, but the impact is low.

## oe-architecture-4

**The current song's clock has two writers, and one field becomes dead once the display reports** (over-engineering, KEEP, medium) · `src/main/api.ts:762`

**Now.** setPlaybackState keeps a clock: it starts on the display's PLAYING, adds up pauses into currentSongPausedMs, and resets on RESTARTING. reportSongPosition (added later, in U1) then rebases the same three fields from the display's video, within POSITION_SLACK_MS. The display reports on loadedmetadata, playing, pause, waiting and seeked, and every 10 s. The remaining-time formula exists twice, as currentSongSecondsLeft (state.ts:207) for queueSong's eta and left() in src/common/hooks/useQueue.ts.

**Why it's more than needed.** Every playback change that setPlaybackState times (pause, resume, restart, start) makes the display's video fire an event that reportSongPosition already handles. Each report rebases with currentSongPausedMs = 0, so the paused total only matters between a setPlaybackState and the report that follows a few milliseconds later. Git history shows the second mechanism layered over the first (dfba8bd and e3179b4, then 4210c2e). The progress line U1 was built for has since been removed (PLAN-ui-round.md).

**Simpler shape.** setPlaybackState only sets playbackState. reportSongPosition is the only writer of currentSongStartedAt and currentSongPausedSince, and its in-step check becomes |(pausedSince ?? at) − startedAt − positionMs| < slack. Remove currentSongPausedMs from State, LiveState, live.ts, useQueue's Timing and currentSongSecondsLeft, and update the setPlaybackState timing tests. Keep queueSong's server-side eta and currentSongSecondsLeft.

**Saves.** About 30 lines in setPlaybackState and one field across 5 files, plus 4 timing tests in api.test.ts. With the eta change, also currentSongSecondsLeft, queueEta and about 45 lines of state.test.

**Risk.** A pause from a phone stops the countdowns when the display's 'pause' report lands (milliseconds later), not when main receives the command. With the display hung, countdowns keep running, which is arguably more accurate.

**Verifier.** The core holds. All four sources play through the one video element (useSongPlayer.ts). Every timing transition that setPlaybackState handles (start, pause, resume, restart via currentTime=0 → 'seeked') makes the video fire an event that report() already sends. reportSongPosition also sets the clock from scratch when currentSongStartedAt is null. One fact is off: today a report usually finds the clock within POSITION_SLACK_MS and returns without rebasing (api.ts:798-817). So currentSongPausedMs is not dead now. setPlaybackState's clock keeps it, and it becomes always 0 only once setPlaybackState stops writing the timing. Making reports the only writer also starts a DAM song's clock at loadedmetadata instead of before the HLS load, which is more accurate. Drop the optional part about the phone computing the eta. queueSong's eta is computed as the item is appended, and the phone's live state may not have the item when the HTTP response arrives (SSE and the POST are separate connections), so a phone-side eta would race.

## oe-phone-5

**withETAs keeps a timing/now branch that only tests call** (over-engineering, KEEP, low) · `src/common/hooks/useQueue.ts:39`

**Now.** withETAs(currentSong, queue, timing?, now?) subtracts the time already played when it is given timing and now. Its comment and secondsPlayed's comment ("the progress line shows it") describe callers that are gone. useQueue.test.ts:35-71 tests that branch.

**Why it's more than needed.** Since 7aa5327, every production call passes two arguments: useQueue.ts:102 and QueueList.tsx:169. The countdown now comes from usePlayed and useWait, and the progress line was removed in dcbfcd4. The same formula is also written out again in main/state.ts:207 (currentSongSecondsLeft).

**Simpler shape.** withETAs(currentSong, queue) with no timing or now. Delete the timing-based etas tests and keep the secondsPlayed tests. Fix the stale comments in useQueue.ts:26-28 and 37-38 and state.ts:204-206. Optionally, move left() to a React-free src/common module and have currentSongSecondsLeft call it with (currentSongLength ?? playtime).

**Saves.** About 5 lines of code and about 37 lines of tests. One formula fewer if it is shared with the server.

**Risk.** None. No production caller passes the extra arguments.

**Verifier.** Confirmed. The only production calls are useQueue.ts:102 and QueueList.tsx:169, and both pass two arguments. 7aa5327 moved the countdown to usePlayed/useWait, and dcbfcd4 removed the progress line, so secondsPlayed's 'the progress line shows it' comment is stale. left() must stay, because secondsPlayed and usePlayed use it. Only the timing/now parameters and the 'takes off / stands still / never below 0' etas tests go, and the secondsPlayed tests already cover the same clamping. One extra comment to fix: main/state.ts:204-206 says currentSongSecondsLeft rounds 'as withETAs rounds it'. After the change that rounding lives in left(). main already imports runtime code from src/common (adminPassword, configStore), so sharing the formula is possible, but useQueue.ts imports React and apiClient, so left() would have to move to a plain module first.

## oe-phone-6

**useGuideMelodyLevel is a shared hook with one caller left** (over-engineering, KEEP, low) · `src/common/hooks/useGuideMelodyLevel.ts:7`

**Now.** A 23-line file in src/common/hooks wraps live value, optimistic value, mutation and onError for the guide-melody level. Its only importer is SettingsPage.tsx:12. The same page writes the identical pattern inline for song volume (SettingsPage.tsx:279-301) and mic levels (304-332).

**Why it's more than needed.** It lived in common because the display used it. c920115 switched the display to useLiveState, which left a one-caller 'shared' hook, and the same page now does the same job two different ways.

**Simpler shape.** As proposed. Inline the hook into GuideMelodySlider the way SongVolumeSlider is written, and delete src/common/hooks/useGuideMelodyLevel.ts.

**Saves.** One file, and one way to do the same job instead of two.

**Risk.** None. It is a pure move of 10 lines.

**Verifier.** Confirmed. The only importer is SettingsPage.tsx:12/261. c920115 removed the display's unused use of it. SongVolumeSlider (SettingsPage.tsx:279-301) and MicLevelSlider write the same optimistic-value-plus-mutation pattern inline, so the page does one job two ways. Nothing in the renderer, tests or notes uses the hook.

## oe-architecture-10

**The display carries a TanStack Query client only so that two shared hooks can fire mutations** (over-engineering, KEEP, low) · `src/renderer/index.tsx:39`

**Now.** The renderer creates a QueryClient and wraps the app in QueryClientProvider. Its only uses are usePlaybackState and usePitchShiftSemis (src/common/hooks), which call useApiMutation for a fire-and-forget call() with an onError that clears the optimistic value. Every display lookup and settings call uses call() directly.

**Why it's more than needed.** The display makes no queries. It gets live state over IPC and runs commands as one-shot calls. Mutation retries are off (retry: false), and the hooks don't use isPending or caching, so the client and provider bring nothing to the display.

**Simpler shape.** In usePlaybackState, usePitchShiftSemis and useGuideMelodyLevel: setPending(v); call(method, input).catch(err => { console.error(...); clearPending(); }). Remove createQueryClient and QueryClientProvider from src/renderer/index.tsx. The phone keeps its QueryClient for lookups and useApiMutation for the other commands.

**Saves.** A provider and client in the display, and TanStack Query in the display's bundle. The shared hooks get simpler too, which also helps the phone.

**Risk.** Very low. The phone's PlaybackControls uses the same hooks and behaves the same with call().

**Verifier.** Confirmed. The renderer's only TanStack uses are usePlaybackState and usePitchShiftSemis, both through useApiMutation with retry off. No isPending, caching or queries are used, and Settings and the other display lookups use call() directly. The reviewer missed two things. useGuideMelodyLevel (phone only) has the same shape and should change with the other two, so all three shared hooks match. And useMutation re-renders its host on each status change (pending, then success), so the display component hosting useSongPlayer re-renders for every setPlaybackState and setPitchShiftSemis. call() avoids that. After the change the renderer no longer imports apiQueries at all.
