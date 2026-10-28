# Phase P: Server: live stream, admin, API cleanup

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 3; starts after: L.

Files: src/main/api.ts, live.ts, server.ts, dispatch.ts, adminAuth.ts, settings.ts, paging.ts, validate.ts, state.ts, src/common/api.ts, src/common/apiClient.ts, src/preload/index.ts (phones' problem), src/renderer/NoticeBar.tsx, the mic-level parts of src/renderer/App.tsx, src/remocon/components/NowPlayingSheet/QueueList.tsx (moves by id).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                               | Severity                        | Title                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [common-contract-2](#common-contract-2)               | Medium                          | nicoInfo reports every transient failure as 'Maybe an invalid VideoID?', and the remote caches that answer as a good lookup for 10 minutes with no retry     |
| [main-api-3](#main-api-3)                             | Low                             | An admin sign-in still running when the host changes the password ends with a live session                                                                   |
| [main-api-5](#main-api-5)                             | Low                             | songHistory grows forever, and every state change re-serializes it (twice every 5 s while idle)                                                              |
| [main-api-6](#main-api-6)                             | Low                             | A Joysound song with a YouTube background never raises or clears the yt-dlp tools problem                                                                    |
| [main-api-9](#main-api-9)                             | Low                             | Untested: popSong's no-duplicate-history rule after a restart, and youtubeInfo's success mapping                                                             |
| [main-state-8](#main-state-8)                         | Low                             | Phones get emote and queueAdded events they never use; a state of 64 KB or more makes the writer drop the next event                                         |
| [main-settings-tools-8](#main-settings-tools-8)       | Low                             | Re-entering the same admin password says phones are signed out, but no one is                                                                                |
| [common-contract-3](#common-contract-3)               | Low                             | A signed-in admin phone keeps 'Signed in' and its admin sliders after the host changes or imports the admin password; every admin action then fails silently |
| [common-contract-6](#common-contract-6)               | Low                             | No unit test covers the phone's live-stream restart or LiveStateProvider's whoami ordering and automatic sign-out                                            |
| [cross-performance-2](#cross-performance-2)           | Low                             | Every download progress tick resends the whole live state to every phone, about 4 times a second                                                             |
| [gap-sleep-resume-power-8](#gap-sleep-resume-power-8) | Low                             | Phones can't tell a dead live stream from a quiet one                                                                                                        |
| [remocon-queue-5](#remocon-queue-5)                   | Low                             | Moving a song (drag or arrow keys) sends a position in this phone's view of the queue; a change above that spot lands the song one place off                 |
| [tests-unit-7](#tests-unit-7)                         | Low                             | api.test.ts's default fakes are cast past the type checker, and each downloads override drops the other fakes                                                |
| [cross-maintainability-12](#cross-maintainability-12) | Low                             | Promise timeouts and HTTP silence/retry logic are hand-rolled five times                                                                                     |
| [oe-display-1](#oe-display-1)                         | Over-engineering (KEEP, high)   | The mic-level echo guard: App.tsx works out an admin's setMicLevels by diffing the live state against a ring of lists it sent                                |
| [oe-architecture-2](#oe-architecture-2)               | Over-engineering (KEEP, medium) | Mic levels have two owners (the display's localStorage and main's State.mics), reconciled by an echo guard                                                   |
| [oe-architecture-5](#oe-architecture-5)               | Over-engineering (KEEP, medium) | 'Phones can't connect' has its own IPC channel, caches and listeners, while the tools problem rides the live state                                           |
| [oe-main-2](#oe-main-2)                               | Over-engineering (KEEP, medium) | Display-only access, and song ID checks, are each made in two places                                                                                         |
| [oe-architecture-3](#oe-architecture-3)               | Over-engineering (WEAK, low)    | Display-only methods live in the phone API and are refused twice                                                                                             |
| [oe-main-5](#oe-main-5)                               | Over-engineering (WEAK, low)    | The general DAM paging window and the `limit` input are never used by any client                                                                             |
| [oe-main-7](#oe-main-7)                               | Over-engineering (WEAK, low)    | Small async helpers are written two or three times, and one comes with an option bag for a single caller                                                     |
| [oe-main-8](#oe-main-8)                               | Over-engineering (KEEP, low)    | The setAdminPassword factory and its dependency only pass data through                                                                                       |
| [oe-main-4](#oe-main-4)                               | Over-engineering (WEAK, low)    | Live events are shared and cached between phones, an optimisation nobody measured                                                                            |
| [oe-architecture-6](#oe-architecture-6)               | Over-engineering (WEAK, low)    | Live-state fan-out is tuned for a scale a home party doesn't reach                                                                                           |
| [oe-architecture-7](#oe-architecture-7)               | Over-engineering (WEAK, low)    | Downloads change the shared state outside the store, so the live hub polls for them                                                                          |

## common-contract-2

**nicoInfo reports every transient failure as 'Maybe an invalid VideoID?', and the remote caches that answer as a good lookup for 10 minutes with no retry** (medium, confirmed, bug) · `src/main/api.ts:539`

**Summary.** The nicoInfo handler catches every error from getNicoVideoInfo and returns {ok:false, reason:'Failed getting video info. Maybe an invalid VideoID?'} as data. That covers limitLookups' 'Too many lookups at once; try again', yt-dlp's 30 s execFile timeout, tools still being fetched, and yt-dlp being out of date for Niconico. Because it's a successful response, useApiQuery stores it under the default staleTime and gcTime of LOOKUP_STALE_MS (10 min). NiconicoInfo shows an InlineError with no onRetry, and withLoader's Try again only appears for thrown errors.

**Scenario.** A guest pastes a valid nicovideo link while the yt-dlp lookup is slow: the first run on Windows unpacks the PyInstaller exe, and Niconico is slow from outside Japan, so it can pass 30 s. Or yt-dlp needs an update for a Niconico site change, or 10 lookups are already in flight. The phone says the video ID is probably invalid. Going back and opening the same link again shows the same cached failure for 10 minutes, with no request to the server, even after the host runs Update tools. The only way out is reloading the page. A yt-dlp failure here also never sets the tools problem the display shows, unlike the download path. youtubeInfo has the same caching for transient non-OK playability, such as LOGIN_REQUIRED 'confirm you're not a bot'.

**Suggested fix.** Return ok:false only for answers that are really about the video (isNicoVideoId false; yt-dlp 'Video unavailable', 404 or geo-block). Rethrow everything else so it becomes a 500 and withLoader shows it with Try again. Run the reason through isToolProblem as the download path does. On the client, also make a failed lookup stale at once: TanStack v5 accepts `staleTime: (q) => q.state.data?.ok === false ? 0 : LOOKUP_STALE_MS` in useApiQuery for nicoInfo and youtubeInfo.

**Earlier reviews.** Related to 2026-10-27 #12 (nicoInfo had no cache or limit), which limitLookups fixed. This is new: the limiter's busy error and other transient failures come back as an 'invalid ID' and get cached on the phone.

**Verifier.** CONFIRMED: api.ts:534-544 catches every error from getNicoVideoInfo and returns {ok:false, reason:'…Maybe an invalid VideoID?'} as a normal response. That includes the limiter's 'Too many lookups' error, the execFile 30 s timeout, and yt-dlp failures. apiQueries.ts:28-30 sets staleTime and gcTime to 10 min, and useApiQuery('nicoInfo') at NiconicoInfo.tsx:17 passes no override. Because the response succeeded, the ok:false data is cached. LoadError's onReset (QueryErrorResetBoundary) only resets queries that threw, and the InlineError at NiconicoInfo.tsx:21 has no onRetry. Remounting within 10 min reuses the cached failure without asking the server. The server-side limitLookups does not cache failures, but that doesn't help, because the client never asks again. This path also never runs isToolProblem (api.ts:326 is the download path only). Two details are overstated. ensureExternalResources waits for tools being fetched rather than failing. And unpacking the PyInstaller exe takes seconds, not 30 s. The realistic triggers are an outdated or broken yt-dlp for Niconico, a network or Niconico hiccup, or rate limiting. Each one gives a misleading 'invalid VideoID' message that sticks for 10 minutes unless the page is reloaded. It is a real bug on a less common path (Niconico), so medium.

## main-api-3

**An admin sign-in still running when the host changes the password ends with a live session** (low, confirmed, bug) · `src/main/api.ts:1034`

**Summary.** adminLogin awaits scrypt (isAdminPassword takes the hash and salt when it is called), then creates a session without checking that the password is still the same. When the host changes the password, every session is cleared (endSessionsOnPasswordChange), but a login that was waiting on scrypt with the old password resolves true afterwards and creates a fresh session that survives the change.

**Scenario.** The host changes the admin password to sign everyone out (for example, a guest learned it). A phone that submitted the old password a moment earlier, while scrypt (~50 ms) was running, gets a token. It stays an admin under the new password until it signs out or 500 newer sessions push it out.

**Suggested fix.** Take `const hash = config.adminPasswordHash` before the await, and after it throw ApiError(403) if `config.adminPasswordHash !== hash`. Alternatively, give AdminSessions a generation counter that clear() bumps, and have create() take the generation read before the await and refuse a stale one.

**Verifier.** CONFIRMED: Reproduced: I started adminLogin('old'), changed config.adminPasswordHash to hash('new'), called adminSessions.clear(), and awaited. The token came back and adminSessions.has(token) is true. isAdminPassword reads the hash and salt into locals before its async scrypt, and api.ts:1034-1038 creates the session without checking the password again. endSessionsOnPasswordChange (adminAuth.ts:103-115) clears sessions synchronously, so a login finishing afterwards outlives the change. The window is one scrypt (about 50 ms, N=16384), and server.ts rate-limits tries, so it needs a sign-in in flight at the exact moment the host changes the password. That is rare, but the fix (compare the hash before and after the await) is two lines.

## main-api-5

**songHistory grows forever, and every state change re-serializes it (twice every 5 s while idle)** (low, plausible, performance) · `src/main/api.ts:986`

**Summary.** popSong unshifts every song into songHistory and nothing ever trims it. serializeState saves it in queue.json, and store.update() JSON.stringifies the whole state on every call to compare with the last save. That includes the display's idle popSong and setPlaybackState('WAITING') every 5 s, each phone slider step (setSongVolume and setMicLevels, even though neither is saved), every pushAdhocLyrics, and so on. Every queue change rewrites the whole file synchronously on the main thread.

**Scenario.** After a year of weekly parties (~6,000 songs) queue.json holds 1.85 MB of history. Each store.update costs ~5–6 ms of stringify plus a 1.85 MB string compare, and each pop, queue or remove adds a 1.85 MB writeFileSync + rename. That is main-thread time taken from the SSE stream, IPC and the API, and it keeps growing (20k songs ≈ 21 ms per update). The phone only ever pages through the history 30 at a time.

**Suggested fix.** Cap the history in popSong, e.g. `state.songHistory.length = Math.min(state.songHistory.length, 500)` after the unshift, and trim the same way in parseState. It is a one-line change and keeps queue.json small. A cheaper idle path, such as popSong not calling store.update when the queue is empty and nothing is current, would also skip the needless saves.

**Verifier.** PLAUSIBLE: The facts hold: popSong unshifts with no cap (api.ts:986), nothing else trims songHistory (grep), and store.update serializes the whole state on every call (state.ts:251-275). The cost is smaller than claimed for realistic use, though. My serializeState benchmark with realistic YouTube entries gave 2,600 entries (a year of weekly ~50-song parties): 0.83 MB, 1.45 ms; 6,000: 1.93 MB, 3.1 ms; 20,000: 6.4 MB, 13 ms. Updates come a few times a second at most. The real write happens only when the serialized text changes; the idle popSong/WAITING calls reserialize but skip the write. So this takes several years to become noticeable. The suggested 500-entry cap would also delete history the History page is built to page through ('history pages through every song', api.test.ts:1106). A separate history file, or not reserializing history that hasn't changed, would fix the growth without losing data.

**Also reported as** (Same fix for all: songHistory has no cap, and every store.update re-serializes all of it. Cap it in popSong and parseState, and skip the idle saves.):

- main-state-7: songHistory grows forever and is re-serialized on every update (`src/main/api.ts:986`). Its fix: Cap songHistory in popSong (e.g., keep the newest 500), or keep history in its own file appended once per song so routine updates don't serialize it.
- common-contract-5: Song history grows forever and is re-serialized into queue.json on every state update (`src/main/api.ts:986`). Its fix: Cap the history in popSong, e.g. `if (state.songHistory.length > 1000) state.songHistory.length = 1000;` (one line plus a constant). The history API already pages over whatever is kept. A larger change would be to save history separately and only on popSong.
- cross-maintainability-7: The song history grows forever and is re-serialized on every state update (`src/main/api.ts:986`). Its fix: Cap the history, e.g. trim to 1,000 entries after the unshift in popSong and in parseState. Optionally skip save() for updates that touch only unsaved fields (mics, songVolume, the timing fields): setMics and reportSongPosition could notify listeners without saving.
- cross-performance-4: queue.json keeps every song ever sung, and every state change re-stringifies all of it (`src/main/state.ts:258`). Its fix: Cap songHistory, e.g. keep the newest 500-1,000 entries, or move history to its own file that only popSong writes. In startSong(null), skip setPlaybackState('WAITING') when it's already WAITING. Optionally let update() skip serializeState when the mutator touched only unsaved fields.

## main-api-6

**A Joysound song with a YouTube background never raises or clears the yt-dlp tools problem** (low, confirmed, bug) · `src/main/api.ts:654`

**Summary.** The YouTube and Niconico cases wire ytdlpFailed/ytdlpWorked so that a yt-dlp breakage shows 'try Update tools' on the display. The Joysound case passes plain queueFailed(item) and pushSongToQueue, but a Joysound song with youtubeVideoId runs yt-dlp too (jobs.ts:309-341, using the same ytdlpFailureReason).

**Scenario.** YouTube changes something and yt-dlp starts failing. Guests mostly queue Joysound songs with YouTube backgrounds. Every one fails with a tools reason on the guest's phone, but the host's display never shows the notice that tells them to run Update tools. A later working background download doesn't clear a notice set by a YouTube song either.

**Suggested fix.** When `item.youtubeVideoId !== null`, pass `ytdlpFailed(item)` and an onReady that calls `ytdlpWorked()` before `pushSongToQueue(item, pushToHead)`.

**Verifier.** CONFIRMED: api.ts:654-659 passes queueFailed(item) and pushSongToQueue for Joysound. joysoundJob runs downloadJoysoundYoutubeVideoPromise (jobs.ts:309-341) when youtubeVideoId is set, with reasonForExit: ytdlpFailureReason. runDownload's failDownloadItem passes that reason to onFailed, and queue.ts runsYtdlp counts the job as a yt-dlp job. So a yt-dlp breakage on a YouTube background never sets toolsProblem, and a working background never clears one. A caveat on the suggested fix: isToolProblem is true for every reason outside VIDEO_REASONS, including REASONS.joysound ('Couldn't get the song from Joysound') and videoProcessing. Wiring ytdlpFailed in unchanged would raise 'YouTube downloads are failing; try Update tools' when Joysound itself fails. The fix should exclude REASONS.joysound, or classify by which step failed.

## main-api-9

**Untested: popSong's no-duplicate-history rule after a restart, and youtubeInfo's success mapping** (low, confirmed, test-gap) · `src/main/api.ts:979`

**Summary.** No unit test covers popSong's no-duplicate-history rule for the song a restart puts back at the head of the queue (api.ts:978-988), or youtubeInfo's success mapping (507-531). A fixture test for the latter would check the mapping logic but could not detect a youtubei.js shape change.

**Scenario.** A refactor of popSong drops or changes the history check, and every restart mid-song puts that song in History twice. Or a youtubei.js upgrade renames caption_tracks/name.text, and every YouTube lookup becomes a 500 or loses its captions, with no failing unit test.

**Suggested fix.** Add a test: save a state with currentSong X and history [X], reload with createStateStore, popSong → history still [X]. Add a youtubeInfo test fed a recorded getBasicInfo fixture (one manual and one auto caption track, loudness_db set) asserting captionLanguages and gainValue.

**Verifier.** CONFIRMED: Grep confirms both gaps. No unit test pops a song that is already songHistory[0]. History is asserted only at api.test.ts:383 for a plain pop and in the paging tests, and state.test.ts covers only round-tripping history. That check (api.ts:978-988) is what keeps a mid-song restart from listing the song twice, and a test is cheap. youtubeInfo's success mapping has no unit test (only LOGIN_REQUIRED at api.test.ts:2016), and the e2e specs mock /api/youtubeInfo in the browser, so they never reach the handler either. A recorded fixture would cover the vss_id filter, name.text and gain math, but it would not catch the stated failure: a fixture recorded once doesn't change when a youtubei.js upgrade renames fields. That half is worth less than claimed.

## main-state-8

**Phones get emote and queueAdded events they never use; a state of 64 KB or more makes the writer drop the next event** (low, confirmed, bug) · `src/main/server.ts:113`

**Summary.** Phones receive emote and queueAdded events they never use. Separately, any single state write of 64 KB or more makes res.write return false, so eventWriter marks even a fast phone 'behind' and drops the queueFailed published in the same tick. The phone then misses the failure notification, though its download button still shows the failure from the state.

**Scenario.** With a large state (a long queue plus long adhoc lyrics), the first tool-problem failure runs ytdlpFailed: store.update(toolsProblem) flushes the state, then queueFailed goes out in the same tick and is dropped for the owner's phone, so the phone shows no failure notification. Verified with the real eventWriter over a real HTTP socket (scratch sse.ts): a 63 KB state followed by an event delivers it, a 70 KB state drops it.

**Suggested fix.** In messageEvents, return null for non-display viewers on emote/queueAdded, which also deletes the per-owner queueAdded code. In eventWriter, count a phone as behind only when more than a state's worth is still queued (e.g. res.writableLength above twice the last state's size), or check on the next tick, so one big write doesn't swallow the event after it.

**Verifier.** CONFIRMED: Unused events: useLiveEvent appears only in remocon useQueueNotifications (queueFailed) and renderer App.tsx (queueAdded, queueFailed) and Effects.tsx (emote). Phones never consume emote or queueAdded, yet live.ts:148-172 builds them for every viewer, with a per-owner queueAdded copy. Only unit tests (live.test.ts, server.test.ts) assert that phones get them, and server.ts's header documents them as part of /api/events. The drop: in Node 24 a single res.write of 64 KB or more returns false (the Writable computes the return value against the 64 KiB default highWaterMark before writing), so eventWriter sets behindSince and drops non-state events until 'drain'. I reproduced it with the real eventWriter over a real HTTP socket (scratch sse.mts): with a state then an event in one tick, the event arrives with 16/40/63 KB states and is dropped with 64/70/120 KB states. ytdlpFailed's store.update(toolsProblem), or publish's pending-flush path, writes the state synchronously right before queueFailed, so the owner's queueFailed is dropped. Reaching 64 KB needs about 250+ queued songs or long shown adhoc lyrics. Only the OS notification is lost, since the download button reads the failure (status failed plus reason, kept 30 s) from the state. Low.

**Also reported as** (Don't send emote and queueAdded to phones. main-state-8 also covers the 64 KB writer drop.):

- cross-performance-8: Emote and queueAdded events go to every phone, though only the display uses them (`src/main/live.ts:149`). Its fix: In messageEvents, return null for non-display viewers on 'emote' and 'queueAdded', which is a two-line change, and update the comments in api.ts/server.ts. That saves all of that traffic.

## main-settings-tools-8

**Re-entering the same admin password says phones are signed out, but no one is** (low, confirmed, bug) · `src/main/adminAuth.ts:130`

**Summary.** createSetAdminPassword keeps the existing salt, so the same password gives the identical hash. configStore.update sees no changed key and returns early (configStore.ts:131), so endSessionsOnPasswordChange's listener never fires. Since the last review's cut, that listener is the only path that clears sessions.

**Scenario.** The host wants to kick every admin phone and re-saves the current admin password. Settings shows 'Saved. Phones signed in as admins must sign in again.' (Settings.tsx:572-581), and the README says changing it signs every phone out. In fact every admin token stays valid.

**Suggested fix.** Make a new salt on every setAdminPassword (`newAdminSalt()` always). The hash then always changes and the existing listener fires, a one-line change. The alternative is to call sessions.clear() explicitly again.

**Earlier reviews.** Follows from the product review's simplification 'keep the listener, drop the call in createSetAdminPassword' (notes/code-review-2026-10-27-product.md:48); not a re-report of a finding.

**Verifier.** CONFIRMED: Scratch probe with the real createConfigStore, createAdminSessions, endSessionsOnPasswordChange and createSetAdminPassword. After set('hunter2') and sessions.create(), set('hunter2') again leaves the token valid (has() stays true), and a different password clears it. The cause: createSetAdminPassword (adminAuth.ts:128-136) keeps the salt, so the hash is identical. configStore.update filters unchanged keys and returns at :131, so the listener at adminAuth.ts:103-115 never fires (the finding's ':170-182' is wrong; the file has 137 lines). Settings.tsx:572-581 still says 'Saved. Phones signed in as admins must sign in again.' prior_review: this is a regression from notes/code-review-2026-10-27-product.md:48, which dropped the explicit clear in createSetAdminPassword. Always using a new salt (or calling sessions.clear()) fixes it.

## common-contract-3

**A signed-in admin phone keeps 'Signed in' and its admin sliders after the host changes or imports the admin password; every admin action then fails silently** (low, confirmed, bug) · `src/common/apiClient.ts:376`

**Summary.** LiveStateProvider asks whoami only when the stream (re)connects, when this phone's token changes, and when config.everyoneIsAdmin flips. setAdminPassword and importConfig clear every session on the server (adminAuth.ts:107-114), but nothing in the live state changes. So useIsAdmin() stays true on phones that were signed in, and the stored token is never dropped.

**Scenario.** An admin guest is signed in. The host changes the admin password in Settings, or imports a config with another one. The phone still says 'Signed in' and shows the song volume, guide melody and mic sliders, plus move-to-top and drag handles in the queue. Each slider move gets a 403, logs it to the console, and snaps back (SettingsPage.tsx:282-287, 313-318). A queue move shows 'Only an admin can reorder the queue'. This lasts until the phone reloads or its SSE connection drops.

**Suggested fix.** Add a counter to LiveState.config (say adminEpoch) that goes up whenever sessions are cleared, and re-ask whoami when it changes, as the provider already does for everyoneIsAdmin. Alternatively, in call(), notify adminTokenListeners when a call made with a stored token gets a 403, so whoami runs and the existing sign-out path drops the dead token. Either is about 6 lines.

**Verifier.** CONFIRMED: askWhoami (apiClient.ts:361) runs only from onAdminTokenChange (377), the stream's onOpen (381), and an everyoneIsAdmin flip (387-396). endSessionsOnPasswordChange (adminAuth.ts:103-114) clears sessions when adminPasswordHash or adminPasswordSalt changes. That covers setAdminPassword and importConfig, wired in services.ts:56. The live state's config (live.ts:96-98) holds only supervisedMode and everyoneIsAdmin, so nothing a signed-in phone sees changes and it never re-asks. useIsAdmin() stays true, Admin shows the signed-in controls, and each mutation gets a 403 that is only logged and rolled back. call() does not notify token listeners on a 403. This needs the host to change or import the password while admins are signed in, which is uncommon, and a reload fixes it. Low is right.

## common-contract-6

**No unit test covers the phone's live-stream restart or LiveStateProvider's whoami ordering and automatic sign-out** (low, confirmed, test-gap) · `src/common/apiClient.ts:322`

**Summary.** apiClient.test.ts tests only the IPC branch of openLiveStream. The EventSource branch is untested. That covers restarting 5 s after the stream goes CLOSED (502/503), not restarting once closed, re-reading the device ID on reconnect, and calling onOpen on each reconnect. LiveStateProvider's askWhoami is also untested: only the latest answer counts, and a stale token is dropped only if it is still the stored one. A regression in any of these would leave phones on a frozen state or wrongly signed in or out. None of this would show in typecheck or lint, and the e2e tests never cause a 503 or a stale token.

**Scenario.** Someone changes the onerror guard, say to restart on any error. Each automatic reconnect would then open a second EventSource while the first keeps retrying, and streams per phone would pile up toward the 10-per-address limit (server.ts:59), at which point the phone gets 503s. No test would catch it.

**Suggested fix.** Put a small fake EventSource class (readyState, onopen, onerror, close) on globalThis and use node:test mock timers. Check that a CLOSED error makes a new EventSource after 5000 ms, that closing during the wait prevents it, and that a CONNECTING error doesn't. Move askWhoami's answer handling into a pure function and test the cases: an out-of-order answer, and a false answer with the same or a different stored token.

**Verifier.** CONFIRMED: apiClient.test.ts only has 'openLiveStream on the display' (IPC branch, line 174). Nothing exercises the EventSource branch (apiClient.ts:299-334): the restart after CLOSED at 322-326, the stopped guard, re-reading the device ID in connect. LiveStateProvider's askWhoami logic (361-375) is untested too: latest answer wins, a stale token is cleared only if it's still the stored one. Grepping tests/e2e found no test that toggles everyoneIsAdmin mid-session, ends a session under a signed-in phone, or makes the stream fail with a 5xx. The logic is subtle, and a regression would leave phones frozen or with the wrong admin state, which typecheck and lint can't catch. A fake EventSource with mock timers is cheap, so the gap is worth filling, but it's low priority.

## cross-performance-2

**Every download progress tick resends the whole live state to every phone, about 4 times a second** (low, confirmed, performance) · `src/main/live.ts:260`

**Summary.** Downloads change progress in place, and watchDownloads flushes every 250 ms. Each flush sends the full LiveState (queue, adhoc lyrics, mics, config) to every phone and the display. Only a phone that has that song's page open reads `downloads` (useDownloadButtonText.ts:88). On top of that, each phone that owns a song gets its own separately serialized copy.

**Scenario.** Party of 20 phones, 30 songs queued, and a guest queues a YouTube song (yt-dlp takes 30-120 s). Measured with the real toLiveState/serializeEvent: 8.2 KB per phone per event, 164 KB per flush, or about 0.65 MB/s (about 5 Mbit/s) of unicast SSE for the whole download. If a YouTube-with-lyrics song is playing with 60 lines pushed, it is 16.7 KB per phone, about 1.3 MB/s (about 10 Mbit/s). adhocLyrics is display-only and can reach 30,000 characters. Downloads run for much of a party, and this traffic shares the WiFi airtime with the TV PC's DAM HLS stream, which drops to low bitrate after its third stall. It also keeps every phone's radio and JS awake 4 times a second.

**Suggested fix.** Send progress as its own small event (e.g. {type:'downloads', downloads}, a few hundred bytes) from watchDownloads, and keep full-state flushes for store changes. Alternatively, throttle progress-only flushes to 1/s. Leave adhocLyrics and toolsProblem out of the state phones get (toLiveState for a non-display viewer). Optionally send ownership as a per-viewer list of the viewer's song keys next to one shared state, so serializeEvent's sharing works when most phones own a song. That cuts the ~0.65-1.3 MB/s down to well under 10 KB/s.

**Verifier.** CONFIRMED: The mechanism is real. watchDownloads calls scheduleFlush every 250 ms while any download is in the queue. flush sends only when the serialized shared state changed, but progress moves on every tick: yt-dlp prints 0.1% steps and ffmpeg prints frame= about every 0.5 s. Each phone that owns a song gets its own toLiveState and serialization (live.ts:131-136). adhocLyrics and toolsProblem go to every phone, and the only phone reader of downloads is useDownloadButtonText.ts:88. Every queued DAM song also starts an ffmpeg download of about 80 s (api.ts:622-635; the dam-7610-20.log shows 80 s at 3.3x), so downloads run for much of a party. My scratch run of the real hub (verify-cross-performance/hub2.ts) gave 9.2 KB per phone and 184 KB per flush for 20 owning phones with 30 songs, about 0.7 MB/s at 4 flushes a second. A more typical party is much smaller: 10 phones with 10 songs is 3.6 KB per phone and about 143 KB/s, and 8 phones with 6 songs is about 78 KB/s. DAM progress flushes only about 2 times a second. For scale, the PC's own DAM download moves about 7.8 Mbit/s. Nothing shows this traffic causing HLS stalls. The cost is real and easy to cut, but it is modest at normal party sizes, so I rate it low rather than medium.

**Also reported as** (Download progress resends the full state to every phone. Send a small downloads event instead.):

- main-state-6: Every download-progress tick rebuilds and sends the whole state to every phone (`src/main/live.ts:262`). Its fix: When a tick finds only downloads changed, send a small {type:"downloads", downloads} event (with isMine per owner) and leave the rest of the client state alone. Build the SSE line from flush's existing `serialized` string instead of stringifying again. That cuts about 90% of the bytes and work during downloads.

## gap-sleep-resume-power-8

**Phones can't tell a dead live stream from a quiet one** (low, plausible, bug) · `src/main/server.ts:174`

**Summary.** The 20 s heartbeat is an SSE comment, which EventSource never passes to the page's script, and openLiveStream has no inactivity check. A connection that dies without a FIN or RST therefore leaves the phone waiting forever, with a frozen queue and now-playing.

**Scenario.** The laptop sleeps and wakes with a new DHCP address, or reconnects to another AP or subnet. The phones' connections to the old address are now half-open. The phones send nothing on them, so their TCP stacks never notice, EventSource stays OPEN, and each phone shows the old queue and never sees songs it queues afterwards. This lasts until the page is reloaded or the phone kills the socket.

**Suggested fix.** Send the heartbeat as an event the page can see, e.g. `event: ping\ndata: {}\n\n`, or a {type:"ping"} LiveEvent that listeners ignore. In connect(), restart the stream when nothing (message or ping) has arrived for about 45 s. Also restart on window 'online', and on visibilitychange to visible after the page has been hidden for a long time.

**Earlier reviews.** New

**Verifier.** PLAUSIBLE: server.ts:137 writes the heartbeat as an SSE comment (": heartbeat"), which EventSource never passes to script. openLiveStream (apiClient.ts:303-327) restarts only from onerror after CLOSED, with no inactivity timer and no online or visibilitychange handling. A phone holding a half-open connection therefore waits forever. The server cuts off stalled streams (heartbeat, :135-140), but its FIN won't reach a phone across a broken path. Reaching the scenario takes the host's IP changing across a suspend, or a network partition longer than TCP's retransmission timeout. DHCP usually gives a returning client the same address, and when the address is unchanged the frozen sockets resume fine after wake. Phones also queue songs over fresh POST connections, which still work, and a reload fixes the view. The mechanism is real but the scenario is uncommon, so low.

## remocon-queue-5

**Moving a song (drag or arrow keys) sends a position in this phone's view of the queue; a change above that spot lands the song one place off** (low, confirmed, bug) · `src/remocon/components/NowPlayingSheet/QueueList.tsx:174`

**Summary.** moveSong carries a toIndex computed against the phone's copy of the queue, which can be up to 250 ms (plus network time) behind. The server inserts at that index in its own current queue. If a song above was removed or started playing, or one was put at the head, in the meantime, the song lands somewhere other than where it was dropped.

**Scenario.** The queue is [A,B,C,D]. The admin drops D just above B (toIndex 1) at the moment A starts playing, or A's singer removes A. The server's queue is [B,C,D], so inserting at 1 gives [B,D,C], but the admin meant D before B. The phone shows its pending [A,D,B,C], then the echo [B,D,C].

**Suggested fix.** Send the neighbour instead of the index: `before: { songId, timestamp } | null` (the row it now sits above; null for the end). The server looks up that row's index, falling back to toIndex if it's gone. Move to top (toIndex 0) is already safe.

**Verifier.** CONFIRMED: QueueList.tsx:164-175 sends `toIndex: to`, computed against the phone's queue (live, up to one 250 ms flush plus network behind, or the pending order). moveSong (api.ts:745-758) removes the item from the server's current queue and splices it at toIndex. Traced: phone [A,B,C,D], drop D at index 1 while the server has already popped A → server [B,C,D] → [B,D,C], not the intended [D,B,C]. The code does what the finding says. It only needs an admin's move to land inside that ~300 ms window around a head change, so it's rare, and the admin can see the result and redo it. Low.

## tests-unit-7

**api.test.ts's default fakes are cast past the type checker, and each downloads override drops the other fakes** (low, plausible, maintainability) · `src/main/api.test.ts:212`

**Summary.** makeApi builds its deps as an untyped literal and returns `createApi(deps as unknown as ApiDeps)`, so the default fakes' signatures are never checked against ApiDeps. Six tests pass `downloads: { youtube: ... } as ApiDeps["downloads"]` (lines 1282-1286, 1495-1498, 1520-1523, 1543-1546, 1601-1607), and because the spread replaces downloads whole, the dam, nico, joysound, info, clear and clearDam fakes vanish in those APIs.

**Scenario.** Take one of those APIs and queue a DAM song in it. queueSong calls deps.downloads.dam inside a .then whose .catch only console.errors (api.ts:590-610), so the TypeError 'deps.downloads.dam is not a function' is logged and the test still passes, with the download never started. Separately, a change to an ApiDeps download signature isn't flagged against makeApi's default fakes, because those go through `as unknown`.

**Suggested fix.** Declare the defaults as `const defaultDownloads = { ... } satisfies ApiDeps["downloads"]`. Type the overrides as `Partial<Omit<ApiDeps, "downloads">> & { downloads?: Partial<ApiDeps["downloads"]> }` and merge `downloads: { ...defaultDownloads, ...overrides.downloads }`. That removes the seven casts, and typecheck then catches a fake that no longer matches.

**Verifier.** PLAUSIBLE: The mechanism is real. makeApi (api.test.ts:116-213) returns `createApi(deps as unknown as ApiDeps)`, so the default fakes are never type-checked against ApiDeps. `...overrides` replaces downloads whole, and five overrides (lines 1283, 1495, 1520, 1543, 1601; two use `as unknown as`) drop the other download fakes. A missing dam fake would fail silently, because api.ts:623-642 calls deps.downloads.dam inside a .then/.catch that only logs. The cited api.ts lines are off: it's 623-642, not 590-610. The failure scenario doesn't happen today, though: every one of those tests calls only the functions it overrides (the 1538 and 1586 tests queue Joysound and override joysound, and none queue DAM or call info, clear or clearDam). So the harm is limited to future tests and to fakes drifting from the real signatures. The suggested satisfies-and-merge fix is a reasonable small cleanup, not a fix for an existing problem.

## cross-maintainability-12

**Promise timeouts and HTTP silence/retry logic are hand-rolled five times** (low, plausible, maintainability) · `src/main/services.ts:84`

**Summary.** api.ts:157-163 and services.ts:84-99 hold two near-identical withTimeout helpers, and settings.ts:143-160 has an inline Promise.race with a TIMED_OUT sentinel. src/common/externalResources.ts (not src/main) hand-rolls on node-fetch the request timeout, backoff and body-stall watchdog that http.ts's httpFetch and promise-retry provide.

**Scenario.** The copies already disagree. api.ts's error says 'timed out after 10000ms', services.ts's names the call, and settings.ts rejects with a shared sentinel object that loginFailureReason matches by identity. A fix made to one, such as aborting the losing request with an AbortSignal or a consistent message, doesn't reach the others.

**Suggested fix.** Export one `withTimeout(promise, ms, error = …)` from a shared module (e.g. src/common/timeout.ts) for the three callers. Have externalResources download through httpFetch(url, { timeoutMs: 60_000 }) inside promiseRetry. About 60 fewer lines.

**Verifier.** PLAUSIBLE: The duplication exists. The two withTimeout functions differ only by the label, and settings.ts races inline against TIMED_OUT, which loginFailureReason matches by identity on purpose to word the host's message. externalResources.ts is in src/common, not src/main. Its fetchAsset (30 s header timeout, accepts 304, exponential backoff) and streamToFile (60 s stall watchdog) overlap httpFetch, but httpFetch uses one timeout for both phases. The swap would change behaviour slightly, so it is not free. Merging the two withTimeout copies into one shared helper is a cheap, sensible cleanup. Rewriting externalResources is a judgment call. The differing error texts are not a bug.

## oe-display-1

**The mic-level echo guard: App.tsx works out an admin's setMicLevels by diffing the live state against a ring of lists it sent** (over-engineering, KEEP, high) · `src/renderer/App.tsx:276`

**Now.** Each mic list the display sends with setMics goes into a 10-entry ring of string keys (`levelsKey`, `sentMics`). An effect with no deps compares every live-state `mics` (`liveMics`, `seenLiveMics`) with the display's own levels. It skips lists found in the ring, trims the ring, and clears it after applying a change. All of this is there to tell an admin's setMicLevels apart from the display's own setMics coming back. That is about 40 lines and four refs/helpers.

**Why it's more than needed.** The display only needs one fact: an admin changed mic X's levels. That is a one-shot event, but the code infers it from a state stream with a heuristic, and the heuristic has already shipped a bug. afd24a3 (#3): a 100→150→100 change was taken for an echo, so the mic stayed at 150 while every phone showed 100. It was patched by adding rules (the ring is cleared on apply). The server already has a per-viewer event channel that does this kind of thing: deps.publish → messageEvents in src/main/live.ts, and queueFailed already goes only to the display and the song's owner.

**Simpler shape.** Publish only the fields the admin gave, not the merged mic: in setMicLevels, once store.update returns true, call deps.publish({type: "micLevels", id, gain?, echo?}), delivered only to viewer.isDisplay. The merged version would revert a host change still in flight on the other field. Example: the host moves gain 100→120 while setMics is still in flight, and an admin sets only echo. The server's merged {gain: 100, echo: 30} would put the host back at 100. On the display, add useLiveEvent("micLevels", ...) that skips ids not in `mics` and merges the given fields onto the display's current levels. Read those levels from a levelsRef kept in step with `levels`, not from a functional setLevels updater. changeLevels has side effects (mic.setGain/setEcho, saveMics), and StrictMode runs updaters twice. The ref is needed because useLiveEvent updates its callback in an effect, so two events before a re-render would see stale levels: that is the #7 bug, which the 'two mics changed at once' e2e test (two concurrent setMicLevels) exercises. Then delete levelsKey, sentMics, seenLiveMics, liveMics and the diff effect. An admin change made during a display reload is already overwritten by the display's saved levels in practice, so nothing is lost.

**Saves.** About 40 lines and the whole echo-detection idea leave App.tsx (20 commits since 10-20). The cost is about 12 lines across common/api.ts (LiveEvent), main/live.ts (HubMessage plus one messageEvents case) and main/api.ts (one publish).

**Risk.** changeLevels reads `levels` from the render closure. Two events before a re-render would bring back the stale-levels bug fixed in the same commit (#7), so changeLevels needs a functional setLevels updater or a ref. The e2e test "an admin's return to an earlier level lands; two mics changed at once both land" (settings.spec.ts:839) tests behaviour and should pass unchanged, so it guards this change. A level an admin changes while the display page is reloading would be missed, but on load the display re-sends its saved levels anyway.

**Verifier.** The facts hold. levelsKey, sentMics, seenLiveMics and liveMics have no use outside App.tsx (grep: src, tests). The guard came in with 5204e61 and was patched in afd24a3 (#3/#7). The 10-27 product review (notes/code-review-2026-10-27-product.md:146) weighed only one alternative, diffing against the previous live list, and turned it down because the display's own in-flight changes would be misapplied. Nobody considered a display-only event, and that removes the echo problem altogether, since the display would stop reading `mics` from the live state. The plumbing is already in place: deps.publish is used by sendEmote, messageEvents already sends queueFailed only to the display, ipc.ts subscribes the display with isDisplay: true, and App already uses useLiveEvent for queueAdded and queueFailed. PLAN-mic.md:64 says the display 'applies the mics levels it reads from live state'. That describes a mechanism, not a requirement, and the behaviour stays the same. App.tsx has had 20 commits since 10-20, and this heuristic is hard to reason about. Tracing it also turns up a narrow race today: the host changes gain while an admin changes echo, and the host's gain is reverted. That keeps it at high.

## oe-architecture-2

**Mic levels have two owners (the display's localStorage and main's State.mics), reconciled by an echo guard** (over-engineering, KEEP, medium) · `src/renderer/App.tsx:178`

**Now.** The display keeps each mic's gain and echo in React state (`levels`) and in localStorage. Every change goes to main with setMics, and main stores it in State.mics (not saved). An admin phone's setMicLevels changes State.mics. The display then compares the live list with a ring of the last 10 lists it sent itself (levelsKey, sentMics, seenLiveMics), applies the difference to the devices, saves it, and sends setMics again.

**Why it's more than needed.** guideMelodyLevel and songVolume solve the same problem (a level that the display applies and admins change) with one owner: main's state, applied from live state, with useOptimisticValue on the client (src/common/hooks/useGuideMelodyLevel.ts). Mic levels alone have two copies, and the guard that keeps them apart has already caused review bugs #3 and #7 (commit afd24a3: an admin's 100→150→100 was taken for an echo, and two mics changed at once lost one). App.tsx has 45 commits, the most of any file in this area.

**Simpler shape.** Keep the display as owner and keep localStorage. setMicLevels checks that the id is in state.mics, then publishes a display-only hub message {type:'micLevels', id, gain?, echo?} (queueFailed already shows how to send to the display only) instead of writing state.mics. The display handles it with useLiveEvent('micLevels', ...) → changeLevels. Its setMics effect then updates state.mics for the phones, and their useOptimisticValue clears as it does today. Delete levelsKey, sentMics, seenLiveMics and the echo-guard effect (about 30 lines). No migration, and TV sliders stay instant.

**Saves.** About 70 lines in App.tsx (savedLevels, levelsKey, sentMics, seenLiveMics, the echo effect, the levels state and the double save). It also removes the regression e2e test written for the guard, and a whole class of sync bugs.

**Risk.** A slider on the TV briefly waits on an IPC round trip plus the hub's 250 ms throttle, which useOptimisticValue covers as it already does on phones. Levels saved in localStorage before the change need a one-time copy into main, or they reset to the defaults (100/40) once. A mic's levels follow its id even while it is unplugged.

**Verifier.** PLAN-mic.md:64 and :114 do specify this flow: the display owns the list, keeps the levels in localStorage, and applies admins' setMicLevels from live state. So the ownership is planned. Detecting admin changes by diffing live state against a ring of lists the display sent itself is not part of the plan, though. It follows from the plan, and it produced review finding #3 (rated High: 100→150→100 was ignored) and #7 (code-review-2026-10-27-product.md:132,136; fixed in afd24a3). The reviewer's main-owned version works, but it brings in a queue.json field and a one-time localStorage migration. It also makes the TV's own sliders wait on IPC plus the 250 ms hub throttle before the native gain changes, unless the display also applies the change locally. A cheaper shape keeps the plan's ownership and removes the guard.

## oe-architecture-5

**'Phones can't connect' has its own IPC channel, caches and listeners, while the tools problem rides the live state** (over-engineering, KEEP, medium) · `src/preload/index.ts:70`

**Now.** NoticeBar shows two problems. toolsProblem comes from State through the live state, like everything else. remoconProblem has its own path: IPC_CHANNELS.remoconProblem as both an invoke and a push, a cached copy plus report and query methods in createDisplayIpc, a second cached copy, listener Set and dedupe in the preload, the onRemoconProblem type in global.ts, three ipcMain lines in index.ts, and its own ipc.test block.

**Why it's more than needed.** The display already has a channel that sends the current state on subscribe and every change after it, which is the 'ask on load, then push' behaviour this side channel rebuilds by hand. The listen error happens in the same process that owns the store.

**Simpler shape.** State gets remoconProblem: string | null, not saved, stripped beside toolsProblem. services.ts exposes a function that runs store.update(s => { s.remoconProblem = message }), and index.ts passes it as onProblem. toLiveState sends it to everyone. NoticeBar reads it with useLiveState. Delete IPC_CHANNELS.remoconProblem, the cache and the report/query methods in ipc.ts, the preload's cache, listener Set and invoke, onRemoconProblem in global.ts, the ipcMain.handle in index.ts and the ipc.test block.

**Saves.** About 80 lines across 7 files, one IPC channel, and two hand-written cache-and-listener pairs.

**Risk.** The message would also reach phones in LiveState. A phone that receives it is by definition connected, and phones already ignore toolsProblem. Alternatively, filter it out for non-display viewers in toLiveState.

**Verifier.** This is a leftover, not a requirement. remoconProblem's channel (461aecf, 11:58) was added 14 minutes after the display got live state over IPC (99b0c61, 11:44). toolsProblem later set the pattern of a problem that lives in State and isn't saved (83e2531). The ask-on-load plus push that the preload rebuilds by hand is exactly what hub.subscribe already does: the current state at once, then every change. The listen error fires asynchronously after listen(), so the store exists by then. Two details for the change. index.ts imports only api and hub from services.ts, so the store, or a small reportRemoconProblem in services.ts, has to be exported. The new field must also be left out of queue.json the way toolsProblem is (state.ts:304). Don't filter it per viewer: toLiveState's shared copy for deviceId null goes both to the display and to phones without an ID.

## oe-main-2

**Display-only access, and song ID checks, are each made in two places** (over-engineering, KEEP, medium) · `src/main/server.ts:39`

**Now.** server.ts keeps DISPLAY_ONLY_METHODS, a set of 14 methods, and refuses them to HTTP callers (server.ts:35-46, 277-282). Every one of those handlers checks again: requireDisplay is defined twice (api.ts:227, settings.ts:106) and called 13 times. setMics and popSong use inline `!caller.isDisplay` checks. popSong is display-only but isn't in the set ('api.ts checks'), so the two lists already disagree. All three layers are tested: server.test.ts:105-133, settings.test.ts:137-160, and the api tests. The same doubling applies to IDs. validate.ts already refuses any songId or youtubeVideoId outside /^[A-Za-z0-9_-]+$/ with at most 64 characters (validate.ts:182-189, 195, 233). queueSong then re-tests the same regex as SONG_ID (api.ts:184, 568-575). youtubeJob re-checks a captionCode that validate.ts already refused (jobs.ts:741-748).

**Why it's more than needed.** Phones are the only HTTP callers (callerFromHeaders always sets isDisplay:false), and IPC is display-only. So one check per method is enough. Two lists that must be kept in step for every new display method (the settings methods were added this month) are a maintenance trap, and popSong already shows the drift. SONG_ID predates validate.ts's SAFE_ID (75f887c) and was left behind when SAFE_ID was added.

**Simpler shape.** Keep one DISPLAY_ONLY set (add popSong). runMethod throws 403 for it before validating input when !caller.isDisplay, and server.ts keeps its early pre-body refusal using the same set. Delete both requireDisplay helpers, their 13 calls and the two inline checks, and move the per-handler 403 tests into one dispatch test. Delete SONG_ID from queueSong (validate.ts already covers it), and use safeId for clearDownload in validate.ts. Keep youtubeJob's captionCode check.

**Saves.** Two helper definitions, about 20 guard lines, one of the two display-only lists and its drift, about 12 lines of repeated ID checks, and two of the three test groups for the same rule.

**Risk.** Low. A handler called directly, without runMethod, would lose its guard. Only the unit tests do that, and they'd test the guard through runMethod instead.

**Verifier.** Display-only part: confirmed. Both transports go through dispatch.runMethod (server.ts:304, ipc.ts:113). HTTP callers are always isDisplay:false and IPC is always DISPLAY_CALLER. requireDisplay is defined twice (api.ts:227, settings.ts:106) and called 13 times, plus two inline checks. popSong is display-only in api.ts but missing from DISPLAY_ONLY_METHODS. It was admin-allowed in 1772def and tightened later without joining the set. The settings methods were added this month, and each new one needs two edits. SONG_ID in queueSong duplicates safeId plus string(…,64) in validate.ts (SAFE_ID's '+' already requires one character). Part of the ID cleanup is wrong, though. youtubeJob's captionCode re-check (jobs.ts:741-748) is a deliberate boundary check from 6296800 ('the downloader keeps its own check'). toolCommand sends arguments through cmd.exe on Windows when yt-dlp is a .cmd override and relies on 'checked IDs' (downloadFailure.ts:116-120). It is 7 lines at an injection boundary, so keep it. Moving clearDownload's check into validate.ts is a sideways move with no saving. Two small notes: check the display rule before validation, so a phone gets 403 rather than 400. server.test.ts:203 uses popSong over HTTP to test a 500 and would need another method. e2e api.spec.ts:821 checks server.ts's message, which stays.

## oe-architecture-3

**Display-only methods live in the phone API and are refused twice** (over-engineering, WEAK, low) · `src/main/server.ts:39`

**Now.** Fifteen methods only the display may call (9 settings methods, setMics, reportSongPosition, downloadsInfo, clearDownloads, clearDownload, popSong) sit in the same Api type, validator map and handler map that POST /api/<method> serves. server.ts refuses 14 of them with DISPLAY_ONLY_METHODS. Each handler checks again with requireDisplay or an inline caller.isDisplay, 15 guards across api.ts and settings.ts. popSong is in neither list and relies on its own check, and the server.ts header comment no longer matches the list.

**Why it's more than needed.** The display never uses HTTP: its calls arrive only over IPC (ipc.ts), and the e2e fixture fails any test in which the display requests /api. The methods are put on the LAN-facing router only so that it can refuse them, and the double check exists because nothing structural keeps them off it.

**Simpler shape.** Keep a single DISPLAY_ONLY set: add popSong and fix the header comment. Enforce it once in runMethod (dispatch.ts), so both transports check it. server.ts keeps using the set for the early 403 before the body is parsed. Delete requireDisplay and the inline isDisplay checks in api.ts and settings.ts. Keep caller.isDisplay for isAdmin and adminLogin. No change to the Api type.

**Saves.** Removes DISPLAY_ONLY_METHODS and its test, about 15 guard sites, and the requireDisplay helper in two files. Phone-facing validation and tests then cover only what phones can reach.

**Risk.** Phones get 404 instead of 403 for those names, so api.spec and settings.spec assertions need updating. Caller.isDisplay is still needed (the display counts as an admin, and adminLogin refuses it).

**Verifier.** The double refusal is deliberate defense in depth. notes/A3-settings-handover.md:7 says a phone gets 403 before its body is read and that each handler also refuses any caller that isn't the display. PLAN-mobile.md:60 restates both. These methods are reachable from the LAN (setAdminPassword, importConfig, restartApp, updateTools), and the server.ts refusal also stops a 1 MB JSON parse. The facts are right: popSong is checked only in its handler (deliberately, per product review #10), and the server.ts header comment is stale. But the proposed fix splits Api, the validators, the handlers and both clients' call() typing across common/api.ts, validate.ts, dispatch.ts and ipc.ts. That is more churn than the 15 one-line guards it removes, in a stable area.

## oe-main-5

**The general DAM paging window and the `limit` input are never used by any client** (over-engineering, WEAK, low) · `src/main/paging.ts:9`

**Now.** Every paged method takes {offset, limit}. validate.ts allows limit 1-100 (validate.ts:121-128), and api.ts has per-method DEFAULT_LIMIT values (api.ts:186). For DAM, damPageWindow works out which 30-result pages cover any [offset, offset+limit) window. getPages fetches all of them in parallel, joins them and slices out the window (paging.ts, damApi.ts:303-330). A 45-line test covers windows like (10,30), (29,2) and (0,100) (api.test.ts:1021-1060).

**Why it's more than needed.** No client ever sends limit. usePagedApiQuery's input type omits it, and it only sends offset taken from the previous nextOffset (apiQueries.ts:76-90). A grep of src/remocon, src/renderer and tests/e2e finds no limit. So DAM offsets are always multiples of 30 with limit 30, and every call fetches exactly one page. The window maths was a fix (3ce1be3) for odd offsets that only a hand-made request can produce. Its stated reason for a separate file ('so unit tests can load it under plain Node') doesn't hold either: upstreamApis.test.ts already imports damApi.ts.

**Simpler shape.** Optional: drop `limit` from PageInput and the validators, use fixed page sizes (DAM 30, Joysound 100, history 30), and have getPages fetch the single page floor(offset / 30) + 1, with no offset % 30 rule. Keep nextOffset, inlined or where it is.

**Saves.** paging.ts (36 lines) and its test (about 45 lines), the multi-page Promise.all join and slice in getPages, the limit field and DEFAULT_LIMIT threaded through 7 handlers and validate.ts, and one concept: arbitrary windows.

**Risk.** A hand-crafted request with an unaligned offset would be refused, or get the page it falls in. No shipped client does that. apiClient.test.ts:137 passes limit:5 only to test serialization and can use offset alone.

**Verifier.** The facts hold. usePagedApiQuery and SearchResults send only offset taken from nextOffset, and the e2e test sees DAM offsets [0, 0, 30, 30] (remote.spec.ts:535). No client sends limit (only apiClient.test.ts:137 and the validator tests do), and upstreamApis.test.ts already imports damApi.ts. But the code is tiny, correct and stable: paging.ts has one commit, and the window maths came from a real fix (3ce1be3). Removing `limit` touches the shared PageInput type, validate.ts and 7 handlers to save about 20 production lines of window maths plus a test. That's true but marginal, not a medium. No validation rule is needed for unaligned offsets either: nextOffset is always aligned, and usePagedApiQuery's keyOf already de-duplicates overlap.

## oe-main-7

**Small async helpers are written two or three times, and one comes with an option bag for a single caller** (over-engineering, WEAK, low) · `src/main/services.ts:84`

**Now.** withTimeout exists twice (api.ts:157-163 and services.ts:84-99), and settings.ts:143-160 writes the same Promise.race inline a third time. innertubeApiProvider (services.ts:101-118) hand-writes a 'memoize, but forget a failure' singleton, which is exactly memoizeSuccess in credentials.ts:21-38. There are two semaphores: queue.ts's yt-dlp slots (queue.ts:298-316) and limitLookups' takeSlot/releaseSlot (nicoVideoInfo.ts:64-79). limitLookups also has a 4-field LookupLimits option bag and an injectable clock, has one caller (downloads/index.ts:222), and about 115 lines of tests.

**Why it's more than needed.** Each helper is reimplemented where it's used instead of being shared. limitLookups' options are only ever set once, as constants.

**Simpler shape.** Put one withTimeout in an Electron-free module that api.ts can import (for example next to memoizeSuccess), and make `innertubeApiProvider = memoizeSuccess(() => withTimeout(Innertube.create(), 30_000, 'Innertube.create'))`. Leave limitLookups, its options and tests, and queue.ts's yt-dlp slots as they are.

**Saves.** About 50 lines of duplicates, the LookupLimits interface, and roughly half of limitLookups' tests.

**Risk.** Low. Keep separate semaphore instances so Niconico info lookups don't queue behind downloads.

**Verifier.** Partly right. The two withTimeout copies (api.ts:157, services.ts:84) and the hand-written Innertube singleton can share code: memoizeSuccess (credentials.ts:21) does exactly 'memoize, forget a failure'. That saves about 20 lines. The rest of the proposal would lose things. limitLookups' option bag isn't only set once: nicoVideoInfo.test.ts passes small LIMITS and an injected clock to test maxWaiting rejection, TTL and cache eviction. limitLookups lives in src/common so plain Node can load it, and its call site (downloads/index.ts) imports electron, so inlining it there drops those tests. The two semaphores also behave differently. The yt-dlp download slots queue without limit (downloads wait, shown at 0%). The lookup slots reject past maxWaiting, which is the point of #12 (1826bb5): a script can't swamp the PC. A shared semaphore(n) would need that option back. settings.ts's inline race uses a TIMED_OUT sentinel for its own error message, so a shared helper would need a recognisable timeout error.

## oe-main-8

**The setAdminPassword factory and its dependency only pass data through** (over-engineering, KEEP, low) · `src/main/adminAuth.ts:128`

**Now.** adminAuth.ts has SetAdminPasswordDeps and createSetAdminPassword (117-137). services.ts builds it with {config, saveConfig: configStore.update} and exports it (services.ts:47-52). settings.ts takes it as SettingsDeps.setAdminPassword (settings.ts:61-62) and just calls it (194-198). settings.test.ts:243-255 tests that it 'calls services' setAdminPassword'.

**Why it's more than needed.** There's one caller. settings.ts already has the config store with saved() and update(), which is everything the factory needs. Signing phones out is handled separately by endSessionsOnPasswordChange through configStore.onChange.

**Simpler shape.** In settings.ts's setAdminPassword handler: `const salt = store.saved().adminPasswordSalt || newAdminSalt(); store.update({ adminPasswordSalt: salt, adminPasswordHash: password === '' ? '' : hashAdminPassword(password, salt) });`. Delete SetAdminPasswordDeps, createSetAdminPassword, the services.ts export and SettingsDeps.setAdminPassword, and move the salt tests to settings.test.ts.

**Saves.** About 25 lines, one dependency on SettingsDeps, one export from services.ts, and a test that only checks a pass-through.

**Risk.** Low. Sessions still end through the configStore listener. The salt isn't subject to environment overrides, so reading it from saved() gives the same value.

**Verifier.** Confirmed. createSetAdminPassword has one caller (services.ts:49 → SettingsDeps → settings.ts:196), and nothing else imports services' setAdminPassword. It existed as the hand-over point between parallel work: A2's note says 'Nothing calls it yet', and PLAN-product says it has no caller until A3. That reason is gone. settings.ts already holds the config store with saved() and update(). Signing phones out is done by endSessionsOnPasswordChange through configStore.onChange, and the only environment override is remoconPort, so saved().adminPasswordSalt equals the running value. The settings test then checks the stored hash and salt instead of a pass-through fake. It's a small win, so low.

## oe-main-4

**Live events are shared and cached between phones, an optimisation nobody measured** (over-engineering, WEAK, low) · `src/main/live.ts:116`

**Now.** For each change, stateEvents builds one shared state event and a per-device Map. ownsAny then decides whether a phone gets the shared object or its own (live.ts:104-142). messageEvents returns closure factories with lazily cached `mine` / `forDisplay` / `forOwner` events for each message type (live.ts:144-197). server.ts keeps a WeakMap from event objects to their JSON so each object is serialized only once (server.ts:150-161). Tests check object identity: live.test.ts:246-253 and server.test.ts:420-434.

**Why it's more than needed.** It came in with 387167b ('so per-connection work stays small'), with no profile behind it. A home party has a handful to a few dozen phones, and the state is small: adhoc lyrics are now capped at 30k characters shown. The requirement is that each phone sees isMine for its own items and that no device IDs leave the server. Sharing objects between phones isn't part of that.

**Simpler shape.** stateEvents returns `viewer.deviceId !== null && ownsAny(state, viewer.deviceId) ? { type: 'state', state: toLiveState(state, config, viewer.deviceId), sentAt } : sharedEvent` with no byDevice Map. messageEvents builds the queueAdded and queueFailed events directly per viewer with shareQueueItem, with no ??= caches. Keep serializeEvent's WeakMap for the shared state and emote events, and drop the identity assertions that only test the message caches.

**Saves.** About 60 of live.ts's 90 lines of event-building (ownsAny, the byDevice map, three cached closures), the WeakMap cache in server.ts, and the identity assertions in two test files.

**Risk.** CPU now grows with the number of phones times the state size. At the cap of 200 streams and 4 flushes a second, that could matter. At realistic party sizes it won't. If needed, keep only the 'owns nothing → shared event' shortcut, which is about 3 lines.

**Verifier.** It's true that 387167b added the sharing with no profile behind it. At party sizes, a per-viewer toLiveState plus stringify costs about 0.15 ms per phone per flush, so 30 phones at 4 flushes a second is a few ms a second. Still, the state-event sharing isn't pointless. It keeps the hot path (every flush, every stream) flat as streams are added, up to STREAM_LIMITS.total of 200, which a script can open. The 'owns nothing → shared' fallback that keeps this is most of what makes the WeakMap worthwhile. The clearly overbuilt parts are smaller: the lazily cached mine / forDisplay / forOwner closures in messageEvents are for queueAdded and queueFailed, which fire once per queued song, and the byDevice Map only dedupes several streams from one device. So the real saving is closer to 30-35 lines than 60.

## oe-architecture-6

**Live-state fan-out is tuned for a scale a home party doesn't reach** (over-engineering, WEAK, low) · `src/main/live.ts:118`

**Now.** Each flush builds one shared LiveEvent for every viewer that owns nothing, plus a per-device copy only for devices that own something (ownsAny, a byDevice Map). messageEvents caches per-audience objects (shared or mine for queueAdded, forDisplay or forOwner for queueFailed), so that server.ts can serialize each event once through a WeakMap (serializeEvent). Tests pin the object identity ('phones with none share one event', 'serializes an event once').

**Why it's more than needed.** Commit 387167b added the sharing 'so per-connection work stays small', with no measurement. A party has perhaps 5 to 30 phones, and state flushes are capped at 4 a second (250 ms). Running toLiveState and JSON.stringify per viewer is a few hundred small stringifies a second at most, which costs well under a millisecond each. The device-ID hiding these maps serve is a real requirement; the sharing on top of it isn't.

**Simpler shape.** Leave it. If oe-architecture-1 lands, queueFailed becomes display-only, and its forDisplay/forOwner cache shrinks to a single event. That is the only cheap win here.

**Saves.** About 60 lines (stateEvents, ownsAny, the per-audience caches, serializeEvent and its WeakMap) and 2 or 3 identity-pinning tests. It also removes a concept the next change to LiveState would otherwise have to keep intact.

**Risk.** CPU per flush grows linearly with phones, which is negligible at party sizes. A script opening the 200 streams STREAM_LIMITS allows still costs about 800 stringifies a second.

**Verifier.** True that the sharing in 387167b was never measured, and at party scale per-viewer toLiveState plus JSON.stringify would cost nothing noticeable. But the code is about 50 stable lines. The 16 commits to live.ts since then added fields inside toLiveState, which the sharing never touched, and it has caused no bugs. It also bounds the cost in the case the reviews did take seriously: a hostile LAN guest. STREAM_LIMITS allows 200 streams, and each state can carry up to 30k characters of shown adhoc lyrics plus the queue, flushed 4 times a second during downloads (review #4 and the unbounded-buffer finding). Per-viewer serialization would multiply that by the stream count. The 'public owner key' option would rework the device-ID privacy model from 387167b for no gain. Worth simplifying only if LiveState sharing gets in the way of a real change.

## oe-architecture-7

**Downloads change the shared state outside the store, so the live hub polls for them** (over-engineering, WEAK, low) · `src/main/live.ts:260`

**Now.** src/main/downloads mutates State.downloadQueue in place (progress parsed from yt-dlp and ffmpeg output, failures, removals 30 s later), using array helpers exported from state.ts. To notice, the hub runs a 250 ms setInterval while anyone listens (watchDownloads, downloadsSent). services.ts adapts each download function by passing `store.getState().downloadQueue` as its first argument (about 25 lines of adapters), and state.ts documents this as 'the one exception' to update().

**Why it's more than needed.** This is a holdover from the GraphQL-era videoDownloader, which mutated the array (commit 9b458d3). The A6 rewrite into src/main/downloads kept that convention. Polling stands in for a change notification the code could send itself. Going through update() per progress line is the likely reason it wasn't done, since save() would serialize the whole uncapped history.

**Simpler shape.** Keep the poll. At most, reword the 'one exception' comment in state.ts so it says the hub polls for these changes.

**Saves.** The interval and its lifecycle, the 'one exception' concept, the raw-array parameter on 4 download functions and in queue.ts, and most of the adapters in services.ts.

**Risk.** A mutation site that forgets to call changed() would leave stale progress on phones. Those sites are few (jobs.ts progress, queue.ts fail and remove, state.ts startDownload).

**Verifier.** The poll is about 10 lines and costs a length check every 250 ms, and it can't miss a mutation. A changed() callback would have to be threaded through jobs.ts's progress parsers (handleYoutubeDownloadLog, handleFFmpegDownloadLog and their callers, about 6 functions), queue.ts's fail and 30 s removal timers, and startDownload. Every one of those sites could forget to call it, which is the risk the reviewer names. The services.ts adapters would still pass something (the callback instead of the array), so 'most of the adapters' is not saved. Option B (src/main/downloads owns its list) moves the complexity rather than removing it. api.ts reads downloadQueue in 4 places (lines 244, 588, 931 and the isDownloading guard), and toLiveState and ownsAny read it too, so all of them would go through a new list() dependency, and the hub would need a second change source.
