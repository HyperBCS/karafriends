# Phase N: Phone: components, UI kit, i18n

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 2; starts after: A.

Files: src/remocon/components/** (not Loader), src/remocon/hooks/useDownloadButtonText.ts, useQueueSong.ts, useUserIdentity.ts, src/remocon/i18n/*, index.html, index.tsx, tokens.scss, dev/DevUiPage.tsx, src/common/hash.ts.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                               | Severity                        | Title                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [remocon-queue-4](#remocon-queue-4)                   | Low                             | Queue button says 'Downloading', then 'Downloaded', for 7.5 s on a Joysound song that was queued at once; says 'Downloaded' at 100% before the song is ready   |
| [remocon-components-10](#remocon-components-10)       | Low                             | /dev/ui copies the now-playing bar and the singer initial instead of using the real ones, and they've drifted; ListRow's `current` is now used only by /dev/ui |
| [cross-maintainability-11](#cross-maintainability-11) | Low                             | The remote guards localStorage in six places but not in the three that run first, so blocked storage still blanks the page                                     |
| [remocon-components-2](#remocon-components-2)         | Low                             | Search results are ranked and rendered again on every keystroke                                                                                                |
| [remocon-components-3](#remocon-components-3)         | Low                             | The remote's page waits for three Google Fonts stylesheets that nothing uses                                                                                   |
| [remocon-components-4](#remocon-components-4)         | Low                             | The adhoc-lyrics help tells the singer to tap the song in the queue, which doesn't work                                                                        |
| [remocon-components-5](#remocon-components-5)         | Low                             | IconButton's aria-disabled state blocks only pointer taps; keyboard and screen-reader activation still run onClick                                             |
| [remocon-components-6](#remocon-components-6)         | Low                             | Marquee's pause at each end needs CSS linear() easing, which the remote's iOS 15 target doesn't support                                                        |
| [remocon-components-7](#remocon-components-7)         | Low                             | English counts don't use plurals: "1 songs", "1 views"                                                                                                         |
| [remocon-components-8](#remocon-components-8)         | Low                             | A YouTube video with no view count crashes the whole video page                                                                                                |
| [remocon-components-9](#remocon-components-9)         | Low                             | Server-made English reasons appear inside Japanese sentences on the phone                                                                                      |
| [remocon-components-11](#remocon-components-11)       | Low                             | YouTubeInfo and JoysoundYouTubeInfo duplicate the player setup, which has a dead branch, a global element id and no cleanup                                    |
| [remocon-queue-7](#remocon-queue-7)                   | Low                             | Custom emotes split flags, skin tones and joined emoji into separate buttons                                                                                   |
| [cross-performance-10](#cross-performance-10)         | Low                             | The iOS 15 bounce guard makes scrolling on every phone wait for JavaScript                                                                                     |
| [common-contract-7](#common-contract-7)               | Low                             | Dead and duplicate code in the slice: hash.ts is unused, and NicoVideoMetadata repeats api.ts's NicoVideoInfo                                                  |
| [oe-phone-1](#oe-phone-1)                             | Over-engineering (KEEP, medium) | Queue button state is a protocol of English strings, parsed back with a regex to translate it                                                                  |
| [oe-phone-2](#oe-phone-2)                             | Over-engineering (KEEP, medium) | SourceMenu hand-rolls an ARIA menu button for a 3-option choice                                                                                                |
| [oe-phone-3](#oe-phone-3)                             | Over-engineering (KEEP, low)    | UI-kit variants and props whose only caller is /dev/ui                                                                                                         |
| [oe-phone-4](#oe-phone-4)                             | Over-engineering (KEEP, low)    | tokens.scss emits 17 non-color custom properties that nothing reads                                                                                            |
| [oe-phone-7](#oe-phone-7)                             | Over-engineering (WEAK, low)    | Adhoc lyrics screen: a pass-through page, a one-button file and a redundant index ref                                                                          |
| [oe-phone-8](#oe-phone-8)                             | Over-engineering (KEEP, low)    | The device ID is created in a React effect and read in apiClient, which depends on effect order                                                                |
| [oe-phone-9](#oe-phone-9)                             | Over-engineering (WEAK, low)    | Seven one-line barrel files for single-component folders                                                                                                       |

## remocon-queue-4

**Queue button says 'Downloading', then 'Downloaded', for 7.5 s on a Joysound song that was queued at once; says 'Downloaded' at 100% before the song is ready** (low, confirmed, bug) · `src/remocon/hooks/useDownloadButtonText.ts:50`

**Summary.** nextDownloadText treats progress ≥ 1 or 5 s without a download entry as finished. A re-queued Joysound song that was already downloaded (queued at once, no entry) shows 'Downloading' for 5 s and 'Downloaded' for 2.5 s, its one button disabled throughout. A YouTube (bv*+ba) or Joysound download shows 'Downloaded' as soon as one stage reaches 100%, a few seconds before the song is queued.

**Scenario.** (a) A Joysound song sung earlier in the night is queued again. The server finds the file and queues it at once, with no download entry. The button still says "Downloading" for 5 s, then "Downloaded" for 2.5 s, and the page's other buttons stay disabled for the whole 7.5 s while the song already sits in Up next. (b) A YouTube video downloads yt-dlp's default bv*+ba (separate video and audio). The server keeps the highest progress seen, so it reaches 1.0 at the end of the video stream. The button says "Downloaded" and resets 2.5 s later while the audio stream and the merge are still running. A second tap gets "Someone is already adding this song".

**Suggested fix.** Show progress ≥ 1 as "Downloading 100%", and switch to FINISHED only when the entry disappears after it was seen. Have queueSong answer `{ ok: true, eta, queued: true }` when it queued without downloading, so the button goes straight to the "Queued" result.

**Verifier.** CONFIRMED: (a) downloadJoysoundData (downloads/index.ts:126-133) queues an already-downloaded song through queueDownloadedJoysoundSong with no runDownload, so no download entry ever exists. queueSong still answers {ok:true, eta}. QueueButton's onQueued maps a non-DAM song to DOWNLOADING. nextDownloadText(DOWNLOADING, null) gives FINISHED after START_GRACE_MS (line 50), then the default after RESULT_MS. Result: 'Downloading' for 5 s, then 'Downloaded' for 2.5 s, with the button disabled for 7.5 s. (b) progress is Math.max over all stages (jobs.ts:106/119). The YouTube yt-dlp args (765-776) have no -f, so the default bv*+ba downloads two streams. Joysound tracks only its video stage, then runs compose and pad with no progress. Progress can therefore reach 1.0 → FINISHED a few seconds before the song queues. Correction: a Joysound page has a single queue button (the lyrics-mode choice isn't disabled), so 'the page's other buttons stay disabled' applies only to DAM, which this path doesn't hit. Cosmetic, a few seconds long, so low.

## remocon-components-10

**/dev/ui copies the now-playing bar and the singer initial instead of using the real ones, and they've drifted; ListRow's `current` is now used only by /dev/ui** (low, confirmed, maintainability) · `src/remocon/dev/DevUiPage.tsx:165`

**Summary.** /dev/ui keeps its own copy of the now-playing bar (DevUiPage.tsx:164-176, with about 40 lines of SCSS at DevUiPage.module.scss:62-101), which uses plain spans with an ellipsis where the real NowPlaying uses Marquees and a source label when open. It also keeps its own Initial. ListRow's `current` prop and its .current accent styles have no caller outside /dev/ui. Smaller leftovers: the TopBar.tsx:17 comment mentions a language control, MdTranslate is used only by /dev/ui, and en.ts:97-98 is an orphaned comment.

**Scenario.** Screenshots of /dev/ui (tests/e2e/screenshots.spec.ts) are what get reviewed against the design brief, yet they show a bar and rows the app no longer renders. A change to the real bar or queue rows won't show up there, and an emoji nickname's initial renders as half a surrogate pair only on the review page.

**Suggested fix.** Split NowPlaying into a presentational `NowPlayingBar({ song, expanded })` and render it in /dev/ui with a sample song. Export QueueList's `Initial` and use it in /dev/ui. Remove ListRow's `current` and its CSS along with the dev demo. That deletes about 60 lines of SCSS and TSX, and the review page then shows the real components.

**Earlier reviews.** Same class as product review items that were fixed (dev-only primitive props removed; the /dev/ui sheet sample corrected). This is a new drift of the same kind.

**Verifier.** CONFIRMED: I checked each fact by grepping src and tests. `current` on ListRow appears only at DevUiPage.tsx:379. MdTranslate appears only at DevUiPage.tsx:36/224. The en.ts:97-98 comment describes a progress-line key that no longer exists, and the key after it is queue.label. tests/e2e/screenshots.spec.ts screenshots /dev/ui, so the drift matters for design review. One sub-claim is moot: the dev Initial gets only fixed sample names (あやか, Mio, Taro, Ken), so `slice(0,1)` never splits an emoji there. Removing `current` and reusing the real bar is a worthwhile cleanup, but small.

## cross-maintainability-11

**The remote guards localStorage in six places but not in the three that run first, so blocked storage still blanks the page** (low, confirmed, bug) · `src/remocon/hooks/useUserIdentity.ts:37`

**Summary.** Six modules wrap localStorage in try/catch for 'storage blocked'. useUserIdentity, NowPlayingSheet and EmoteButtons call it bare, and they run first, so those guards never get a chance to matter.

**Scenario.** A phone browser with storage blocked for the site (for example Chrome with cookies blocked for it, where reading window.localStorage throws SecurityError) opens the remote. On the first visit, useUserIdentity's effect (:37-38) throws. There is no error boundary above Shell (remocon/index.tsx:47-62), so React unmounts the app and the page goes blank. Even with that caught, saveNickname (:28) throws, so the guest can never get past the nickname screen. After that, NowPlayingSheet's useState initializer (NowPlayingSheet.tsx:19) would throw during render.

**Suggested fix.** Add one remocon/storage.ts whose getItem and setItem never throw and fall back to an in-memory Map for the session, and use it at all 15 call sites. That is about 30 fewer lines of try/catch, and a phone with blocked storage works until it reloads, as the existing guards intend.

**Verifier.** CONFIRMED: useUserIdentity.ts:37-39 calls localStorage.getItem/setItem bare in a useEffect, and saveNickname (:27-30) calls setItem bare. storedNickname (:14-20) is guarded, so the inconsistency is within one file. useUserIdentity runs from App.tsx:148, which renders unconditionally. There is no error boundary anywhere in src/remocon (grep), and React 19.2.7 unmounts the root on an uncaught error thrown in an effect. A browser where reading localStorage throws (site cookies or storage blocked) therefore gets a blank remote on its first visit. Even with that caught, saveNickname throws, so the guest can't get past the nickname screen. NowPlayingSheet's useStoredFlag (:17-28) and EmoteButtons (:17-20, :47) are also bare, while useReadings, theme, i18n, QueueButtons and apiClient guard. Low severity because blocked first-party storage is an uncommon browser setting.

**Also reported as** (One localStorage wrapper that never throws, used at every call site in the remote.):

- remocon-pages-8: With site storage blocked, the first visit crashes to a blank page (`src/remocon/hooks/useUserIdentity.ts:37`). Its fix: Guard both like the other stores (try/catch, keep an in-memory deviceId and nickname for the session), and guard useStoredFlag. Then a storage-blocked phone works until it reloads, as the theme and language code already promise.

## remocon-components-2

**Search results are ranked and rendered again on every keystroke** (low, confirmed, performance) · `src/remocon/components/SearchResults.tsx:71`

**Summary.** SearchPage keeps the typed text in state and renders SearchResults as a plain child, so every keystroke and IME update redoes all of the results work. That means the per-catalog dedupe, `rank()` (four wanakana `normalize` calls per row), building every ListRow, and every WithReading `reading()`, even though SearchResults' props (the debounced query, by, source) haven't changed.

**Scenario.** With "All" selected, the first page is 30 DAM rows plus 100 Joysound rows, and 260 rows after one "More". While the guest types the next search, each input event (including each step of Japanese kana composition) re-ranks all of them and re-renders 130–260 rows: Link, two Marquees and two WithReadings each. On a low-end phone that costs tens of ms per input event, so typing visibly lags.

**Suggested fix.** `export default React.memo(SearchResults)`: its props are three strings, so keystrokes stop reaching it. Also wrap the `found`/`rank` computation in `useMemo` keyed on the two queries' `data` and on `query`, so that a "More" or a Readings change doesn't re-rank pages that haven't changed. That's about 3 lines.

**Verifier.** CONFIRMED: The mechanism is certain. SearchPage holds `text` in state, and SearchResults isn't memoized, so every keystroke or IME update re-runs the dedupe, rank() and the building of all rows while the old results stay on screen until the debounce fires. The cost is smaller than claimed, though. My bench on this laptop with 30 DAM + 100 Joysound rows: rank() takes 1.2 ms (2.35 ms for 260 rows). Server-rendering 130 real ListRows (Link, Marquee, WithReading) takes 1.2 ms (2.0 ms for 260). WithReading's reading() is about free in the default "written" mode (0.006 ms), and 0.46 ms in kana mode. Marquee's layout effect has [] deps, so re-renders don't re-observe. That is about 2.5–5 ms per keystroke on a laptop and perhaps 8–25 ms on a low-end phone: a frame or two, not clearly visible lag. The fix (React.memo) is trivial and worth doing, but it's low.

**Also reported as** (React.memo(SearchResults), plus useMemo for the ranking.):

- remocon-pages-7: Every keystroke in the search box re-renders and re-ranks all loaded results (`src/remocon/pages/SearchPage.tsx:123`). Its fix: `export default React.memo(SearchResults)` (its props are three strings), so typing renders only the field until the debounced q changes. Optionally useMemo the dedupe and rank on [query, the two data objects].

## remocon-components-3

**The remote's page waits for three Google Fonts stylesheets that nothing uses** (low, plausible, performance) · `src/remocon/index.html:5`

**Summary.** index.html has render-blocking Google Fonts stylesheets. Two of them do nothing: Material Icons (no `material-icons` class anywhere; the icons are inline SVG) and Roboto (system-ui comes first in $kf-font and covers Latin). Noto Sans JP IS used: system-ui fonts on Android, Windows and Linux lack kanji, so Chrome falls through the stack to the Noto Sans JP webfont for Japanese text. Removing it would switch those phones to the system CJK font, which the tokens.scss comment already intends. Every first load waits on these cross-origin CSS fetches, and a network that silently drops Google traffic delays first paint until they time out.

**Scenario.** Every guest's first load waits for DNS, TLS and three cross-origin CSS fetches before the first paint; the Noto Sans JP CSS alone is a large unicode-range file. On a party network where Google is slow, filtered or unreachable (a travel router, a venue LAN, or a region where Google is blocked), the remote stays blank until those requests fail.

**Suggested fix.** Delete the two preconnects and the three Google Fonts links from src/remocon/index.html (about 15 lines). If Noto Sans JP is ever wanted as a fallback, bundle it with the remote rather than fetching it from Google at render time.

**Verifier.** PLAUSIBLE: The links are in src/remocon/index.html:5-19 and ship in the build. Nothing in src/remocon uses Material Icons or sets any font-family but $kf-font. In headless Chrome, a page with the same font stack and local @font-face stand-ins never requested the Roboto face for Latin text but did request the Noto Sans JP face for 夜に駆ける, so "none of these fonts is ever used" is wrong for Noto Sans JP. Render-blocking is real. In the common case it is a few hundred ms on first load, and Google Fonts CSS is then cached. A blank page only happens on networks that drop Google traffic, which is uncommon for this app's users. Low.

## remocon-components-4

**The adhoc-lyrics help tells the singer to tap the song in the queue, which doesn't work** (low, confirmed, bug) · `src/remocon/i18n/en.ts:72`

**Summary.** `lyrics.adhocHelp` says "While your song plays, tap it in the queue to show these line by line", and ja.ts:65 says the same. The song that is playing isn't in the queue, though: it appears only on the now-playing bar, which becomes a link only when the sheet is open. Tapping a queue row just expands it.

**Scenario.** A guest pastes lyrics, queues the video, and goes back to searching. When their song starts, they follow the hint and open the queue, but their song isn't under "Up next". If they tap their song before it plays, the row expands with Remove/Move to top. The lyrics controls are reachable only by staying on the video's page (YouTubePage redirects to /adhocLyrics) or by opening the sheet and tapping the now-playing title.

**Suggested fix.** Reword both strings to describe the paths that work, for example "When your song starts, this page turns into the lyrics controls. From elsewhere, open Now playing and tap your song." (and the matching ja).

**Verifier.** CONFIRMED: en.ts:72-73 and ja.ts:65-66 both say to tap the song in the queue. QueueList now lists only the songs waiting, and the comment at QueueList.tsx:143-144 says the current song is on the now-playing bar only. A tap on a queue row toggles it (QueueList.tsx:122). What works is the now-playing title, which is a Link only when the sheet is expanded (NowPlayingSheet.tsx:70-77), or staying on the video page, which YouTubePage redirects. Impact is small: a guest who opens the sheet sees their song at its top, and a tap or two gets them there. So this is stale copy, low.

## remocon-components-5

**IconButton's aria-disabled state blocks only pointer taps; keyboard and screen-reader activation still run onClick** (low, confirmed, bug) · `src/remocon/components/ui/Button.tsx:51`

**Summary.** The UI kit documents aria-disabled IconButtons as "stays focusable, and a tap does nothing", but the only thing enforcing that is `pointer-events: none` in CSS. Enter, Space and an accessibility click action (TalkBack, Switch Access) still fire the button's onClick, and IconButton doesn't swallow it.

**Scenario.** While nothing plays (state WAITING), the transport is aria-disabled. A guest on a Bluetooth keyboard or TalkBack activates "Play": setPlaybackState("PLAYING") goes to the server, which accepts it outside supervised mode. The display then sits in PLAYING with no song, which turns off its start-at-once for the next queued song (useSongPlayer.ts:392 waits for WAITING), so the next song starts only at the 5 s poll. ♭/♯ change the key in the same way while they look disabled. In supervised mode a non-singer gets a silent 403 after an optimistic flash.

**Suggested fix.** In IconButton, read `rest["aria-disabled"]` and, when it is true, call `e.preventDefault()` and skip `onClick`, so that every input path behaves like the pointer. That's about 4 lines in one place instead of a guard in each caller.

**Verifier.** CONFIRMED: IconButton spreads ...rest, including onClick, onto a focusable <button>. Only `pointer-events: none` (Button.module.scss:111-113) blocks activation, and that does nothing for Enter, Space or an accessibility click. PlaybackControls passes unguarded onClick handlers with aria-disabled. The server's requirePlaybackControl only checks supervised mode. The effect is a little worse than described: while WAITING, the display's video still holds the last song's src (nothing clears it). A keyboard "Play" or "Restart" therefore runs video.play() or currentTime=0, which by the HTML rules restarts the ended video, so the previous song plays again on the TV with no current song. The idle WAITING poll doesn't pause it. It is still low because it needs keyboard or TalkBack activation of a control that looks disabled, which is rare at a party.

**Also reported as** (aria-disabled buttons still fire onClick from the keyboard or a screen reader. Guard it once in IconButton. The server-side refusal is main-api-2.):

- remocon-queue-3: Dimmed playback controls still work from Enter/Space or a screen reader; with nothing playing, Restart or Play replays the last song on the TV (`src/remocon/components/NowPlayingSheet/PlaybackControls.tsx:122`). Its fix: Skip the handler when disabled (`onClick={disabled ? undefined : onRestart}`, and the same for the others and the key). Have setPlaybackState and setPitchShiftSemis refuse phone callers while currentSong is null.

## remocon-components-6

**Marquee's pause at each end needs CSS linear() easing, which the remote's iOS 15 target doesn't support** (low, confirmed, bug) · `src/remocon/components/ui/Marquee.module.scss:30`

**Summary.** The hold at each end of the slide is encoded in `animation-timing-function: linear(0, 0 var(--kf-marquee-hold), 1 calc(100% - …), 1)`. Safari before 17.2 has no linear() easing. Because the value contains var(), it becomes invalid at computed-value time and falls back to `ease`, so long titles slide back and forth with no 2 s rest at either end.

**Scenario.** A guest on iOS 15 or 16 (iPhone 8 and X stop at 16) or on iOS 17.0–17.1 sees every long title in the results, the queue and the top bar keep moving, with only ease's slowdown at the ends. Long Japanese titles are hard to read when they never stop.

**Suggested fix.** Run the slide with the Web Animations API from useMarquee's `show()` (`text.animate([{transform:'none',offset:0},{transform:'none',offset:h},{transform:`translateX(-${shift}px)`,offset:1-h},{transform:…,offset:1}], {duration, iterations:Infinity, direction:'alternate', delay})`), which works on iOS 13.4+. Or add an `@supports not (animation-timing-function: linear(0, 1))` fallback that uses fixed keyframe holds.

**Verifier.** CONFIRMED: Marquee.module.scss:30-35 uses linear() easing with var(), and the built remocon-Cv3Y1_Mh.css contains `linear(0, 0 var(--kf-marquee-hold), …)` unchanged. linear() needs Safari 17.2 or Chrome 113, but REMOCON_TARGET includes ios15/safari15 and also chrome111. On those browsers the value is invalid at computed-value time, so the property falls back to its initial `ease`: the title slides back and forth with no 2 s rest at either end. It is cosmetic, on a shrinking share of phones (iOS before 17.2, Chrome 111-112).

## remocon-components-7

**English counts don't use plurals: "1 songs", "1 views"** (low, confirmed, bug) · `src/remocon/i18n/en.ts:50`

**Summary.** The i18n layer has no plural forms. `search.songCount` is "{count} songs" and `video.views` is "{count} views", so a count of 1 reads "1 songs" or "1 views". Japanese has no plural, so only English is affected.

**Scenario.** A DAM artist search lists many artists with a single song, and each of those rows' subtitle reads "1 songs" (SearchResults.tsx:101). The same text appears in an ArtistPage header (" · 1 songs").

**Suggested fix.** Add `search.songCountOne` and `video.viewsOne` keys and pick between them by count. Alternatively, add a tiny plural helper on Intl.PluralRules(language) to translate() for keys with a `{count}`. The parity test then covers the new keys.

**Verifier.** CONFIRMED: en.ts:50 is "{count} songs" and en.ts:62 is "{count} views". translate() (i18n/index.ts:60-71) only substitutes placeholders and has no plural forms. SearchResults.tsx:101 and ArtistPage.tsx:64 pass DAM's songCount, so an artist with one song reads "1 songs". This is cosmetic and English-only.

## remocon-components-8

**A YouTube video with no view count crashes the whole video page** (low, plausible, bug) · `src/remocon/components/VideoMetadata/VideoMetadata.tsx:44`

**Summary.** VideoMetadata calls `videoInfo.viewCount.toLocaleString(language)` unguarded. The server copies youtubei.js's `basic_info.view_count`, typed `number | undefined` and NaN when YouTube omits it, into a field declared `number`. Over JSON, NaN arrives as `null` and undefined arrives as a missing key, so the call throws.

**Scenario.** YouTube returns a playable video whose videoDetails/microformat lack viewCount. The phone receives `viewCount: null`, VideoMetadata throws during render, and withLoader replaces the whole YouTubeInfo block (player, details, queue button, lyrics) with "Couldn't load this: Cannot read properties of null (reading 'toLocaleString')". "Try again" throws the same way, so the video can't be queued from the phone.

**Suggested fix.** Guard on the server with `viewCount: Number.isFinite(data.basic_info.view_count) ? data.basic_info.view_count : 0`, and `?? 0` for duration. Optionally, drop the views part in VideoMetadata when the count is not a finite number.

**Verifier.** PLAUSIBLE: The crash path is real. youtubei.js 18 sets view_count = parseInt(videoDetails.viewCount) and falls back to the microformat's only when that is NaN (MediaInfo.js:48). If both are missing it is NaN, which JSON turns into null. api.ts:528 copies it unguarded, and VideoMetadata.tsx:44 calls .toLocaleString on it, which throws inside withLoader and replaces YouTubeInfo (or the Joysound background-video block) with the load error, and "Try again" throws again. I couldn't confirm that YouTube ever returns a playable (status OK) video without viewCount in both videoDetails and microformat; normal videos and live streams include it. The trigger is unproven, so low.

## remocon-components-9

**Server-made English reasons appear inside Japanese sentences on the phone** (low, confirmed, bug) · `src/remocon/components/NiconicoInfo/NiconicoInfo.tsx:22`

**Summary.** The phone's error strings wrap a free-text `{reason}`, and the server writes several of those reasons in English. A Japanese phone therefore shows mixed sentences such as 動画の情報を取得できませんでした：Failed getting video info. Maybe an invalid VideoID?

**Scenario.** A guest with the remote in Japanese pastes a bad Niconico ID and sees the English reason inside the Japanese error. Queueing a song someone else is downloading shows 予約できませんでした：Someone is already adding this song, and the per-guest queue limit shows "ken already has 3 song(s) in the queue or downloading".

**Suggested fix.** For the reasons the server itself writes, return a code (for example `{ ok:false, code:"alreadyAdding" }` or `"queueLimit", limit`) and translate it on the phone with new en/ja keys. Keep the free-text `reason` only for text passed through from YouTube or yt-dlp.

**Verifier.** CONFIRMED: The ja templates wrap a free-text {reason} (ja.ts:56 video.infoFailed, :80 queueButton.error, :138 queue.moveFailed). The server writes English reasons: api.ts:541 "Failed getting video info. Maybe an invalid VideoID?", :580 "<nick> already has N song(s) in the queue or downloading", :594 "Someone is already adding this song". The queue-limit one comes up at real parties, but the effect is a mixed-language message, not a broken feature. Low.

## remocon-components-11

**YouTubeInfo and JoysoundYouTubeInfo duplicate the player setup, which has a dead branch, a global element id and no cleanup** (low, confirmed, maintainability) · `src/remocon/components/JoysoundYouTubeInfo/JoysoundYouTubeInfo.tsx:22`

**Summary.** Both components create a player with `YouTubePlayer("youtube-player", …)` against a hard-coded DOM id and never call `destroy()` on unmount. JoysoundYouTubeInfo's `loadVideoById` + `stopVideo` branch can't run: JoysoundQueue mounts it only after leaving the edit form or with an initial id, and both ways of changing the video (submit, Remove) unmount it first. JoysoundYouTubeInfo also creates the player for a video whose lookup failed, then just hides it.

**Scenario.** Each video page a guest opens leaves behind a YT.Player and the window message listener it registers. Opening a Joysound song with an unavailable background video still loads YouTube's embed (about 1 MB of script) into a hidden box. Anyone changing the player code has to change it in two places, one of which never runs.

**Suggested fix.** Add one `useYouTubePlayer(ref, videoId)` hook that creates the player on a ref'd element (no global id), returns `() => player.destroy()`, and is called only when `videoInfo.ok`. Use it from both components and drop the dead else branch. That saves about 15 lines and the leak.

**Verifier.** CONFIRMED: Both components call YouTubePlayer("youtube-player", …) against a hard-coded id, and neither effect returns a cleanup with destroy(). JoysoundQueue mounts JoysoundYouTubeInfo only when `!editing && videoId`, and it is keyed by song.id. Submit happens in the editing branch and Remove sets the id to "", so videoId never changes while it is mounted, and the loadVideoById/stopVideo branch never runs in production. It runs only in dev, where StrictMode invokes the effect twice, and is harmless there. JoysoundYouTubeInfo creates the player even when videoInfo.ok is false and then hides the box, so the embed loads for nothing. React removes the iframe on unmount, so the leak is a small JS object and its listener per page opened. This is a modest maintainability cleanup.

## remocon-queue-7

**Custom emotes split flags, skin tones and joined emoji into separate buttons** (low, confirmed, bug) · `src/remocon/components/NowPlayingSheet/EmoteButtons.tsx:45`

**Summary.** editEmotes pulls emoji out with /\p{Emoji_Presentation}|\p{Emoji}️/gu, which matches one code point at a time. Multi-code-point emoji are split into their parts, and each part becomes its own button.

**Scenario.** A guest enters "🇯🇵👍🏽👨‍👩‍👧". They get buttons 🇯, 🇵, 👍, 🏽, 👨, 👩 and 👧. Holding 🇯 floats a lone regional-indicator letter up the TV, and the skin-tone swatch is a button of its own.

**Suggested fix.** Split into whole emoji with `new Intl.Segmenter(undefined, { granularity: "grapheme" })` and keep the segments that match /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.

**Verifier.** CONFIRMED: I ran the regex extracted from EmoteButtons.tsx:45 in node. "🇯🇵👍🏽👨‍👩‍👧" gives ["🇯","🇵","👍","🏽","👨","👩","👧"] and "🏳️‍🌈" gives ["🏳️","🌈"]. Each part becomes its own button and sends a lone regional-indicator letter or skin-tone swatch to the TV. It only affects custom emote lists, and flags like 🇯🇵 are a plausible choice at a karaoke party. Low.

## cross-performance-10

**The iOS 15 bounce guard makes scrolling on every phone wait for JavaScript** (low, plausible, performance) · `src/remocon/index.tsx:42`

**Summary.** A document-level touchmove listener registered with {passive:false} runs on every phone. Android and iOS 16+ already honour overscroll-behavior. Every touchmove then blocks scrolling on the main thread while the handler walks the ancestors calling getComputedStyle.

**Scenario.** A guest scrolls search results or the queue while a download runs. The phone's main thread is parsing state events 4 times a second and re-rendering. Each touchmove has to wait for that work before the compositor may scroll, which shows up as dropped scroll frames on mid-range Android phones, which never needed the guard.

**Suggested fix.** Register the listener only when `!CSS.supports('overscroll-behavior', 'none')` (iOS 15). Every other phone keeps passive, compositor-driven scrolling.

**Verifier.** PLAUSIBLE: The listener does run unconditionally (src/remocon/index.tsx:24-42) with {passive:false}, and index.scss already sets overscroll-behavior: none, so phones other than iOS 15 don't need it. Gating it with CSS.supports is correct and cheap. The claimed cost is overstated, though. Chrome (Android) waits for the main thread only on a gesture's first touchmove. Once scrolling starts, it sends later touchmoves asynchronously as uncancelable, so the handler can't hold up each frame; it delays only the start of the scroll, by whatever main-thread task is running (a few ms for a state event). The ancestor walk with getComputedStyle is cheap when styles are clean. There is a side effect: at a scroller's edge mid-scroll, preventDefault on those uncancelable events does nothing and logs an intervention warning. The cost is real but small.

## common-contract-7

**Dead and duplicate code in the slice: hash.ts is unused, and NicoVideoMetadata repeats api.ts's NicoVideoInfo** (low, confirmed, maintainability) · `src/common/hash.ts:1`

**Summary.** cyrb53 in src/common/hash.ts is imported nowhere in the repo. NicoVideoMetadata in nicoVideoInfo.ts duplicates api.ts's NicoVideoInfo field for field. The compiler would catch a new required field through deps.getNicoVideoInfo's type, but optional or removed fields could drift, and one type-only import would remove the copy.

**Scenario.** Someone adds a field to NicoVideoInfo in api.ts, such as uploadDate. parseNicoVideoInfo keeps returning the old shape, the handler's return type fails, and the fix gets made in the wrong one of the two types. hash.ts is just code to read for nothing.

**Suggested fix.** Delete src/common/hash.ts (16 lines). In nicoVideoInfo.ts, `import type { NicoVideoInfo } from './api'` (type-only, so it stays free of Electron) and return that from parseNicoVideoInfo; drop NicoVideoMetadata and its uses in downloads/index.ts (about 12 lines).

**Verifier.** CONFIRMED: I grepped the whole repo outside node_modules (ts, tsx, js, cjs, mjs, json) for cyrb53 and common/hash, and the only hit is the definition in src/common/hash.ts. It's dead code, and deleting it is trivially worth it. NicoVideoMetadata (nicoVideoInfo.ts:4-12) has exactly NicoVideoInfo's fields: VideoInfo's six plus thumbnailUrl (api.ts:317-335; the interface itself is at 333). It's used only in nicoVideoInfo.ts:113 and downloads/index.ts:22,200, and flows into deps.getNicoVideoInfo typed Promise<NicoVideoInfo> (api.ts:102). The summary's claim that they 'can drift without the compiler noticing' is overstated. Adding a required field to NicoVideoInfo would fail to typecheck where getNicoVideoInfo is passed into deps. Only an optional field, or a field removed from NicoVideoInfo, would drift silently. api.ts imports only types, so `import type { NicoVideoInfo }` keeps nicoVideoInfo.ts free of Electron. A small, low-value cleanup.

## oe-phone-1

**Queue button state is a protocol of English strings, parsed back with a regex to translate it** (over-engineering, KEEP, medium) · `src/remocon/hooks/useDownloadButtonText.ts:9`

**Now.** The button's state is a plain string. The six exported sentinels are WAITING_FOR_SERVER, DOWNLOADING, FINISHED, FAILED, ERROR and QUEUED. Other states are built strings: "Downloading -- 42.6%", "Error: <reason>" (built in useQueueSong.ts:17-18) and "Queued: 4:12" (built in QueueButtons.tsx:55 with formatDuration). The button's own label stands for idle, so nextDownloadText needs a defaultText argument, and QueueButton checks busy with `text !== label`. downloadButtonLabel() then parses the string back: a regex `/^Downloading -- (.*)%$/` and `split(": ")` with `rest.join(": ")`, then calls t(). "Downloading" against "Downloading -- x%" also encodes whether the download has shown up yet. useQueueSong.ts is a 31-line hook with one caller (QueueButton) that mostly formats those "Error:" strings.

**Why it's more than needed.** The strings were the upstream display text. When i18n arrived (f0866d3), translation was added by parsing them back instead of typing the state, so every state now exists twice: once as a string to build and once as a pattern to parse. This module changed in 4 commits in 2 days (f792889, 88c49fc, bb91ae3, f0866d3). The 118-line test file mostly checks string round-trips.

**Simpler shape.** As proposed. Status = idle | waiting | downloading{progress:number|null} | finished | failed{reason} | error{reason} | queued{eta:number}. nextStatus(status, progress, failure) returns {status, afterMs} or null. label(status, idleLabel) is a switch over t(), and the toFixed(1) and formatDuration formatting move into it. Busy is status.is !== "idle". Fold useQueueSong (the mutation plus useReadings) into QueueButton. Keep the failedId/staleFailedId refs.

**Saves.** About 40 lines across the hook, QueueButtons.tsx and useQueueSong.ts. Gone: 6 exported constants, the regex and split parsing, the defaultText parameter, and one file (useQueueSong.ts). The tests become plain object comparisons.

**Risk.** The unit tests need a rewrite. The e2e tests read the translated button text, which stays the same. Low risk if the label strings are kept exactly as they are.

**Verifier.** The facts check out. The state is English strings: it is set with WAITING_FOR_SERVER, DOWNLOADING and the built "Downloading -- x%", "Error: …" and "Queued: m:ss" strings, and downloadButtonLabel turns them back into labels with a regex and split(": ") (useDownloadButtonText.ts:55-69). The idle state is the button's own label, which is why defaultText exists and why busy is `text !== label` (QueueButtons.tsx:69). useQueueSong (31 lines) has one caller and mostly builds the "Error:" strings. The earlier review already named this exact item: code-review-2026-10-27-product.md:55 says to store the state and the percentage instead. Line 68 says it was left out on purpose only because the rewrite would go over the budget, not because anything needs the strings. No bug fix depends on the string form. bb91ae3's staleFailedId logic carries over unchanged. Every e2e check reads the translated text (downloadFailure.spec.ts:103,152; remote.spec.ts:1057,1098; jp.spec.ts:128,162), and that text stays the same. The proposed union covers the one subtle case: progress:null means the download hasn't shown up yet (wait START_GRACE_MS), and a number means it was seen (finish at once when it disappears). The unit tests become plain object comparisons.

## oe-phone-2

**SourceMenu hand-rolls an ARIA menu button for a 3-option choice** (over-engineering, KEEP, medium) · `src/remocon/components/SourceMenu.tsx:23`

**Now.** 131 lines of TSX and 101 of SCSS for picking All, DAM or Joysound. It has role=menu and menuitemradio, a document-level pointerdown listener to close on an outside tap, focus moves on open and close, and Arrow, Home, End, Escape and Tab handling. It also styles a level-4 popover.

**Why it's more than needed.** The user's U4 decision (PLAN-ui-round.md item 4) is only 'the source moves behind a settings button … which shows the source when it isn't All'. The platform already does that: a native <select> opens the OS picker (the iOS wheel on phones) with keyboard, focus and dismissal built in. Everything else in this component re-implements that.

**Simpler shape.** Keep the button's look (MdTune icon, the source name when it isn't All, the caret) in a position:relative wrapper. Lay over it a `<select aria-label=Source>` with All, DAM and Joysound options (position:absolute; inset:0; opacity:0; font-size of at least 16px, because iOS zooms in on smaller fields, as TextField.module.scss:57 already notes). onChange calls onSelect. Move the pressed and focus-ring styles to the wrapper with :focus-within or :has(select:focus-visible). Delete .menu, .item and .tick, $kf-shadow-menu in both themes, and the 'Level 4' line in the tokens comment. The e2e helpers switch to selectOption, and the search-menu screenshot is dropped.

**Saves.** About 100 lines of TSX and about 70 of SCSS. Gone: the outside-click listener, the focus management and the keyboard map.

**Risk.** Four e2e specs click menuitemradio (remote.spec.ts:30,55, jp.spec.ts:16, screenshots.spec.ts:690-712) and would switch to selectOption. The u4 'search-menu' screenshot can't capture a native picker, so it would be dropped. The open picker would look native rather than Graphite.

**Verifier.** The plan doesn't call for a custom menu. PLAN-ui-round.md:21 (U4) asks only for a settings button that names the source when it isn't All. The user has also already gone back to native controls on the phone once: PLAN-ui-round.md:57 says "The phone's sliders are native again (the user's call)". The app already uses native <select> elsewhere (YouTubeInfo.tsx:61, the display's Settings), and the hard-fork plan turned the Materialize selects into native ones (PLAN-hard-fork.md:236). The component has had only two commits: it was created in 01547e8 and recolored in 56d23a2. It fixes no bug. Its outside-tap listener, focus moves and Arrow, Home, End, Escape and Tab handling all copy what a native picker already does. The saving is larger than the reviewer counted. $kf-shadow-menu and the 'Level 4: menus' depth level in tokens.scss exist only for this menu (tokens.scss:83,150,221, SourceMenu.module.scss:65), so they go too. The focus-mechanics e2e test (remote.spec.ts:62-100) also shrinks. One SCSS correction: the button styles (lines 9-50) stay, so about 45 SCSS lines go, not 70. What is lost is the Graphite look of the open menu and the u4 'search-menu' screenshot. That is a visual choice the user should approve, not a behaviour.

## oe-phone-3

**UI-kit variants and props whose only caller is /dev/ui** (over-engineering, KEEP, low) · `src/remocon/components/ui/Button.tsx:6`

**Now.** Button variant="danger" is used only in DevUiPage, which added it in 0765550. It brings the .danger rule in Button.module.scss:75-83 and --kf-danger-pressed in both themes (tokens.scss:77,141,209). IconButton tone="accent" and the aria-pressed toggle style (.accent and .iconButton[aria-pressed], Button.module.scss:117) are also used only in DevUiPage. ListRow `current` (ListRow.tsx:50, currentProps on all three branches, .current at ListRow.module.scss:36-50) lost its last app caller in da018b3, when the current song moved off the queue list. `className` is accepted but never passed on Sheet, TopBar, List, ListRow, EmptyState, SegmentedControl and TextField. DevUiPage also keeps its own copy of the now-playing bar (DevUiPage.tsx:163-174 plus the now* classes in DevUiPage.module.scss).

**Why it's more than needed.** The 2026-10-27 review (code-review-2026-10-27-product.md:54) already cut unused primitive props. These survived only because /dev/ui demos them, so the review page now keeps dead API alive. /dev/ui itself is planned (PLAN-product.md:150) and is not flagged here.

**Simpler shape.** Drop Button's danger variant (the type member, the .danger rule, --kf-danger-pressed in both themes and the $ alias; keep $kf-danger, which dangerIcon and Feedback use). Drop IconButton tone accent and the .iconButton[aria-pressed] rule, ListRow current (the prop, currentProps and .current), and the unused className props, along with their /dev/ui demos. Leave DevUiPage's now-playing header as it is, or replace it with plain text. Don't try to render the live-state NowPlaying there.

**Saves.** About 100 lines across Button, ListRow, 4 other primitives, 2 SCSS modules, tokens.scss and DevUiPage. Three variant concepts and one token go.

**Risk.** Only /dev/ui and its screenshots change. A future 'Remove' text button would need the variant back, about 10 lines.

**Verifier.** Checked by grep, including across multi-line JSX. In the app, Button variant="danger" appears only in DevUiPage (added in 0765550), and $kf-danger-pressed is read only by .danger. IconButton tone="accent" and aria-pressed appear only in DevUiPage. ListRow `current` has no caller outside DevUiPage:379 since da018b3. className is never passed to Sheet, TopBar, List, ListRow, EmptyState, SegmentedControl or TextField (only IconButton receives one). There is a counterpoint: PLAN-product.md B lists Button 'primary, secondary, danger, icon'. But the project's own review already cut the planned Button `icon` because 'only /dev/ui uses it' (code-review-2026-10-27-product.md:54), so this follows the user's own rule. One correction: NowPlaying (NowPlayingSheet.tsx:41) reads the live state and isn't exported. /dev/ui can't render it with its fixture songs, so 'render <NowPlaying>' doesn't work. The hand-copied bar is the Sheet demo's header, which is demo content and not dead API. Leave it, or swap in a plain header. Without it the saving is about 80 lines, not 100.

## oe-phone-4

**tokens.scss emits 17 non-color custom properties that nothing reads** (over-engineering, KEEP, low) · `src/remocon/tokens.scss:327`

**Now.** The custom-properties mixin, included under :root in index.scss:7, writes --kf-space-1..6, --kf-radius*, --kf-tap, --kf-font and --kf-text-* 'for inline styles and anything outside Sass'.

**Why it's more than needed.** Nothing in src/remocon reads them. Grep finds no var(--kf-space|radius|tap|font|text-) outside tokens.scss, and no style= props in the remote. The display has its own copies in src/renderer/tokens.css:99ff and doesn't load this file.

**Simpler shape.** Delete the custom-properties mixin (tokens.scss:325-345) and its @include in index.scss:7. Reword the file's header comment (tokens.scss:6-8) so it says only the color mixins put --kf-* on :root.

**Saves.** About 22 lines, and one of the two ways a token reaches a stylesheet.

**Risk.** None in the current code. A future inline style would use the Sass value or add the one property it needs.

**Verifier.** I confirmed that nothing in src/remocon, src/common or tests reads var(--kf-space-_|radius_|tap|font|text-*), and the remote has no style={...} props. The display's matching var() uses (Announcements.css, index.css) come from src/renderer/tokens.css:96ff, which defines them itself and doesn't load the remote's SCSS. The mixin dates from 4078acb, with no later caller, and no bug or plan depends on it. Deleting it is free.

## oe-phone-7

**Adhoc lyrics screen: a pass-through page, a one-button file and a redundant index ref** (over-engineering, WEAK, low) · `src/remocon/components/AdhocLyricsControls/AdhocLyricsControls.tsx:23`

**Now.** AdhocLyricsPage.tsx (15 lines) only reads :id and renders AdhocLyricsControls. LyricsController.tsx (17 lines) is one <button> with one caller. AdhocLyricsControls mirrors selectedIndex into indexRef through a _setSelectedIndex wrapper, and onSendLine reads the ref.

**Why it's more than needed.** The ref dates from upstream (9ffab75). onSendLine is rebuilt on every render and runs from a click, so the state is never stale there. The timer-driven ref that does matter is selectedRef in LyricsPicker, which stays. The page file and the button file add a hop each without adding anything.

**Simpler shape.** Keep AdhocLyricsPage. Inline LyricsController's <button> into AdhocLyricsControls and delete LyricsController.tsx. Leave the indexRef, or drop it only if a send right after a wheel scroll is accepted as harmless.

**Saves.** About 35 lines and 1–2 files.

**Risk.** If AdhocLyricsControls reads useParams itself, withLoader's resetProps no longer sees the id. Navigating from one lyrics id to another without a remount wouldn't clear a shown error. That's rare, and keeping the page file avoids it.

**Verifier.** Only part of this holds. AdhocLyricsPage is the same thin route page as NiconicoPage (17 lines) and YouTubePage, so cutting this one alone breaks the pages/ convention. As the reviewer says, it also keeps withLoader's resetProps keyed on the id, so the page should stay. LyricsController is left over from upstream. It held Send and Remove until 0645e26 dropped Remove, and inlining its one button saves a file and about 15 lines. The indexRef is not fully redundant, so 'never stale' overstates it. LyricsPicker's settle timer calls onSelectLine from a setTimeout (LyricsPicker.tsx:48-56). That is a default-priority update in React 19, so a Send tap that arrives before that render commits would read the old selectedIndex from plain state, while the ref has the new one. The window is tiny, but it is a real case, so dropping the ref is a judgement call rather than removing dead defence.

## oe-phone-8

**The device ID is created in a React effect and read in apiClient, which depends on effect order** (over-engineering, KEEP, low) · `src/remocon/hooks/useUserIdentity.ts:36`

**Now.** useUserIdentity's effect writes localStorage.deviceId on first visit. apiClient.ts:304-306 has to explain that it reads the ID late because this child effect runs before LiveStateProvider's effect opens the stream. The nickname is read from localStorage in two places, apiClient.storedIdentity and useUserIdentity.storedNickname, each with its own "nickname" literal.

**Why it's more than needed.** Identity is split across a hook and the client module, so its correctness depends on React's child-before-parent effect order. That is an implicit contract held up by a comment.

**Simpler shape.** In apiClient, add a deviceId() getter that reads localStorage and, if empty, stores and returns uuidv4(), or returns null if storage throws. identityHeaders and openLiveStream's HTTP branch use it. Drop the effect and the ordering comment. Move storedNickname and saveNickname next to it so 'nickname' is written once.

**Saves.** About 8 lines, plus the ordering comment and the hidden dependency.

**Risk.** Low. The display never reads it, because the IPC path returns before storedIdentity.

**Verifier.** Confirmed. The ID is created in a useEffect in useUserIdentity (lines 36-40), and openLiveStream has to explain that it reads it late because of effect order (apiClient.ts:304-306). The 'nickname' key is written in two places (apiClient.ts:49, useUserIdentity.ts:16/28). On the display, call() and openLiveStream take the IPC path before they read identity, and the display's LiveStateProvider has no checkAdmin, so it never reads the ID. The e2e tests that seed deviceId through localStorage (api.spec.ts:258,584) still work with create-on-read. Keeping uuid is right: phones load over plain http, where crypto.randomUUID isn't available. One correction: creating the ID must stay inside the try/catch and give null when storage throws. Otherwise a blocked-storage phone gets a new ID on every request, where today it is simply anonymous.

## oe-phone-9

**Seven one-line barrel files for single-component folders** (over-engineering, WEAK, low) · `src/remocon/components/YouTubeInfo/index.tsx:1`

**Now.** AdhocLyricsControls, JoysoundYouTubeInfo, Loader, MoreButton, NiconicoInfo, VideoMetadata and YouTubeInfo each have an index.tsx with only `export { default } from "./X"`. Four of these folders hold nothing but that one .tsx. Newer components sit flat in components/: SearchResults.tsx, SourceMenu.tsx, QueueButtons.tsx, WithReading.tsx.

**Why it's more than needed.** It's a convention from upstream (9ffab75 and others) that the hard fork no longer needs. The files only pass imports through, and the codebase now follows two layouts.

**Simpler shape.** Optional, and only when touching these files anyway: move JoysoundYouTubeInfo, NiconicoInfo, VideoMetadata and YouTubeInfo flat into components/. Import Loader, MoreButton and AdhocLyricsControls by file path, and delete the seven index.tsx files.

**Saves.** 7 files and 4 folders, and one layout convention instead of two.

**Risk.** Only import paths change, and the typecheck catches every one.

**Verifier.** The facts are right: seven one-line re-export files, and four of the folders hold just one .tsx plus its index. But this is a layout inconsistency, not complexity. Nobody has to reason about these files, the change is pure churn (7 files, 4 folders, import paths and blame history), and it doesn't make any frequently changed area easier to work in. Loader and AdhocLyricsControls are real multi-file folders, and Loader's index also re-exports withLoader. Worth doing only alongside other edits to these components.
