# Phase M: Phone: navigation and pages

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 2; starts after: A.

Files: src/remocon/App.tsx, src/remocon/components/Loader/_, src/remocon/pages/_, rank.ts, songLink.ts, videoLink.ts, src/common/readings.ts.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                       | Severity | Title                                                                                                                                                   |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [remocon-components-1](#remocon-components-1) | Medium   | Moving from one song page to another of the same kind keeps the old page, or the old error, on screen                                                   |
| [remocon-pages-1](#remocon-pages-1)           | Medium   | Every screen shares one <main> scroller: Back lands at the top of a long results list, and cached pages open at the last screen's scroll position       |
| [remocon-pages-3](#remocon-pages-3)           | Low      | An 11-character title such as 'OneLastKiss' or 'SuperBeaver' opens a YouTube page for a video that doesn't exist on Enter or when the field loses focus |
| [remocon-pages-4](#remocon-pages-4)           | Low      | songLink drops a Joysound song's background video, so 'queue it again' from History and the Now playing link lose it                                    |
| [remocon-pages-5](#remocon-pages-5)           | Low      | With everyone-admin on, every phone shows "You're an admin" and a Sign out button that does nothing                                                     |
| [remocon-pages-6](#remocon-pages-6)           | Low      | History shows when each song was queued, not when it was sung, so times are off and can be out of order                                                 |
| [remocon-pages-9](#remocon-pages-9)           | Low      | rank checks isRomaji on the raw query, so full-width romaji or a full-width space gets no kana form                                                     |
| [remocon-pages-10](#remocon-pages-10)         | Low      | Route paths and source labels are spelled out in five places each                                                                                       |
| [common-contract-4](#common-contract-4)       | Low      | reading() treats Latin titles with accents, symbols, curly quotes or Unicode hyphens as Japanese, so 'Café' shows as 'kafye' and "Don’t" as 'どんと'    |

## remocon-components-1

**Moving from one song page to another of the same kind keeps the old page, or the old error, on screen** (medium, confirmed, bug) · `src/remocon/components/Loader/Loader.tsx:52`

**Summary.** `withLoader` resets its error boundary only when the wrapped component's props change. Its Suspense boundary is reused across same-route navigations, and HashRouter applies those in a transition. So when only a route param changes, React keeps showing the previous page until the new lookup resolves, and an earlier error stays up without the new lookup ever being tried.

**Scenario.** (a) A guest is on /search/niconico/sm1 and opens the sheet, then taps the now-playing Niconico song sm2. The address changes, but React keeps sm1's page, with its live "Queue video" button, on screen until the yt-dlp lookup for sm2 returns, which takes seconds and can take up to 30 s. A tap on "Queue video" in that window queues sm1 again. The same happens on /song/A → /song/B and on Joysound song pages, without a spinner. (b) DAM is down, so /song/A shows "Couldn't load this: …". The guest taps the now-playing DAM song B. SongPage's props are still {kind:"dam"}, so LoadError stays in its error state and shows A's error on B's page. B's lookup only runs after a tap on "Try again".

**Suggested fix.** Key the lookup by its route id so that each song mounts a new boundary, which shows its spinner and starts with no error. Use `<NiconicoInfo key={videoId} …>` in NiconicoPage, as YouTubePage already does. For SongPage and ArtistPage, add a small wrapper in App.tsx that renders `<SongPage key={useParams().id} kind=…/>`. Key by the id and not the pathname, so that a Joysound background-video change (a replace navigation to /:id/:videoId) doesn't remount the page. One e2e test that navigates song→song after a failed lookup would pin this.

**Earlier reviews.** Related to product review #19 (one song's choices carried to the next), which was fixed by keying JoysoundQueue and YouTubeInfo. The withLoader boundary itself was never keyed, so this part remains.

**Verifier.** CONFIRMED: I reproduced both halves in headless Chrome, using a scratch bundle with the real withLoader from Loader.tsx, react-router 8.3 HashRouter, TanStack Query 5 with createQueryClient(), and a 1 s suspending lookup on a /song/:id route. (a) After location.hash went from #/song/A to #/song/B, the page still showed "Song A" 0.3 s later with no spinner, while the lookup for B was in flight. It switched only once B resolved. (b) With #/song/badA failed, navigating to #/song/B left "Couldn't load this: lookup of badA failed" on screen 2.5 s later, and B's queryFn was never called. The mechanism matches the code. HashRouter (lib.js:205) wraps history updates in startTransition, and _renderMatches gives the rendered routes no key, so same-route navigations reuse SongPage's boundary. LoadError's resetProps is {kind:"dam"}, which compares shallowly equal. NiconicoInfo resets its error, since its props carry videoId, but it still holds the old page during the transition. The main way to reach this is the now-playing link onto a page of the same kind, which is a less common path, so medium stands. Repro: /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/verify-remocon-components/repro/drive.cjs

**Also reported as** (Key each param page and its queue buttons by the route id so that same-route navigation remounts them.):

- remocon-pages-2: Same-route navigation reuses the page: the old song stays up with no spinner, an earlier load error sticks, and queue-button state carries over (`src/remocon/components/Loader/Loader.tsx:85`). Its fix: Key each param page at its route, e.g. a tiny wrapper `const ByParam = ({ name, children }) => <Fragment key={useParams()[name]}>{children}</Fragment>` around SongPage, ArtistPage and NiconicoPage in App.tsx. Each song then gets a fresh boundary (spinner), fresh error state and fresh buttons, and the hand-placed keys in SongPage.tsx and YouTubePage.tsx can go.
- remocon-queue-6: A queue button's progress and busy state carry over to another song's page when the route stays the same (DAM, Niconico) (`src/remocon/pages/SongPage.tsx:72`). Its fix: Add key={song.id} to DAM's QueueButtons and key={videoId} to NiconicoInfo, as JoysoundQueue and YouTubeInfo already have.

## remocon-pages-1

**Every screen shares one <main> scroller: Back lands at the top of a long results list, and cached pages open at the last screen's scroll position** (medium, confirmed, bug) · `src/remocon/App.tsx:140`

**Summary.** Each Route element in Shell is a <Screen> in the same position, and react-router doesn't key RenderedRoute, so React keeps one Screen instance and one <main> DOM node (the only scroller, App.module.scss .main overflow-y:auto) across all routes. No code in src/remocon saves or restores scrollTop, so a screen's scroll position carries over to the next one.

**Scenario.** A guest searches 恋 by title (30 DAM + 100 Joysound rows), scrolls to row ~60, opens it, then taps Back. SearchResults renders the cached rows at once, at the song page's scroll offset (usually 0), so the guest has to scroll down again after every song they look at. It also goes the other way. From a scrolled History or admin Settings screen to a page whose lookup is cached (any song or video seen in the last 10 min, LOOKUP_STALE_MS), there's no Suspense fallback to shrink the content, so the new page opens at the old offset clamped to its height. On tall pages (the YouTube page, a Joysound song with a background video) the title and player are scrolled off the top.

**Suggested fix.** In Screen, keep a Map from history index (window.history.state.idx, which survives the search page's replace navigations) to main.scrollTop. Save on pathname change in a layout-effect cleanup, and restore the saved value (or 0) in a useLayoutEffect after the new page renders. About 15 lines, and it also stops a forward navigation inheriting the old offset.

**Verifier.** CONFIRMED: Traced it. Every Route element in Shell is a <Screen> at the same tree position. react-router 8.3's _renderMatches (hooks.js:788) creates RenderedRoute with no key, and Routes adds no location key, so React keeps one Screen and one <main> node (App.tsx:140, the only scroller per App.module.scss/index.scss) across routes. Only the children change type and remount. Nothing in src/remocon or src/common saves or restores scrollTop: the only hits are the iOS window.scrollTo, useDragReorder and LyricsPicker. SearchResults uses useInfiniteQuery, which doesn't suspend, so on Back the cached rows render at once at whatever offset the song page left, usually 0. That is the main browse flow (search → song → Back), and the e2e test at remote.spec.ts:523-535 only counts rows. The forward direction is real too, and doesn't even need a lookup: from a scrolled results list, tapping Settings (no Suspense) or a cached History opens it at the old offset clamped to its height. It's a usability annoyance on the most common path, not a broken feature, so medium is right.

## remocon-pages-3

**An 11-character title such as 'OneLastKiss' or 'SuperBeaver' opens a YouTube page for a video that doesn't exist on Enter or when the field loses focus** (low, confirmed, bug) · `src/remocon/pages/SearchPage.tsx:100`

**Summary.** commit() runs on Enter and on blur, and youtubeVideoId() takes any 11-character [A-Za-z0-9_-] token that isn't a single capitalised or all-caps word as a video ID. So a title or artist typed without spaces that's exactly 11 characters navigates away to /search/youtube/<text>.

**Scenario.** A guest types 'OneLastKiss' (or 'SuperBeaver', 'MyHairisBad', 'back-number'). After 500 ms the DAM and Joysound results show. They press the keyboard's Search key, or tap 'Artist' in the toggle, which blurs the field. commit() → videoLink returns {kind:'youtube', videoId:'OneLastKiss'} → navigate pushes a YouTube page that says the video's info couldn't be loaded, instead of the results they were looking at.

**Suggested fix.** Keep auto-opening for real links (anything with '.' or '/'). For a bare ID-shaped token, don't navigate on blur or Enter: add an 'Open YouTube video <id>' (or Niconico) row above the results, so the guest picks it. Or navigate on Enter only when both catalogs came back empty.

**Earlier reviews.** Product review #21 (a typed ID opening after the debounce) was fixed by opening bare IDs only on Enter or blur. This is the edge that fix leaves: blur includes tapping the toggle or the source menu.

**Verifier.** CONFIRMED: I ran a probe against videoLink(). 'OneLastKiss', 'SuperBeaver', 'MyHairisBad', 'back-number', 'HappyEnding', 'LoveForever' and 'yorushika11' all return {kind:'youtube'}, while 'Butterflies' and 'ORANGERANGE' return null. SearchPage.tsx:100 onBlur={commit}, and onSubmit blurs the field, so the keyboard's Search key (the usual way to finish typing) or tapping the By toggle navigates to /search/youtube/<text>. The mechanism is certain. The input is unusual, though: guests mostly type kana or kanji, and Latin titles usually have spaces, and all-lowercase single words are already excluded. So low.

## remocon-pages-4

**songLink drops a Joysound song's background video, so 'queue it again' from History and the Now playing link lose it** (low, confirmed, bug) · `src/remocon/songLink.ts:23`

**Summary.** songLink() builds /joysoundSong/<songId> from kind and songId only. Shared Joysound items carry youtubeVideoId, and the remote has a /joysoundSong/:id/:youtubeVideoId route that SongPage reads as the initial background, but History rows and the Now playing link never use it.

**Scenario.** A guest sang a Joysound song with a YouTube background. In History they tap it 'to queue it again' (HistoryPage's own comment). The song page opens with 'Add background', and queueing it plays without the video unless they find and paste the link again. Tapping Now playing on that song likewise shows no background.

**Suggested fix.** In songLink, append `/${song.youtubeVideoId}` for kind 'joysound' when it's set (widen the parameter to SharedQueueItem-like {kind, songId, youtubeVideoId?}).

**Verifier.** CONFIRMED: songLink.ts:19-24 uses only kind and songId. JoysoundQueueItem.youtubeVideoId (api.ts:92-96) survives shareQueueItem (live.ts:49-58, which spreads every field but user) into the history items and the live state's currentSong. App.tsx:189 has the /joysoundSong/:id/:youtubeVideoId route, and SongPage.tsx:78 reads it as initialVideoId. HistoryPage.tsx:41 and NowPlayingSheet.tsx:72 call songLink, so 'queue it again' from History loses the background video. It's a small, real loss: low.

## remocon-pages-5

**With everyone-admin on, every phone shows "You're an admin" and a Sign out button that does nothing** (low, confirmed, bug) · `src/remocon/pages/SettingsPage.tsx:394`

**Summary.** Admin shows the signed-in view whenever whoami says isAdmin. With config.everyoneIsAdmin that's true for every phone, including ones that never signed in, so Sign out calls adminLogout without a token, clears nothing and stays in the same state.

**Scenario.** The host turns on everyone-admin. A guest who never signed in opens Settings and sees "You're an admin" and Sign out. Tapping Sign out flashes the button disabled and changes nothing. A guest who did sign in and taps Sign out also stays an admin, with no word why.

**Suggested fix.** Show Sign out only when adminToken !== null. When the live state's config.everyoneIsAdmin is on, say so ('Everyone is an admin right now') instead of 'You're an admin' plus a dead button.

**Verifier.** CONFIRMED: Admin (SettingsPage.tsx:394) branches on isAdmin === true only. Server-side, isAdmin = config.everyoneIsAdmin || isRealAdmin (api.ts:200-201), and whoami returns it. The host can switch it on from the display's Settings (Settings.tsx:822). With it on, every phone sees 'You're an admin' and Sign out. adminSignOut calls adminLogout, which removes nothing for a null token, then storeAdminToken(null), and whoami still answers true, so the button does nothing visible. No remocon string mentions everyone-admin mode. A misleading but harmless control: low.

## remocon-pages-6

**History shows when each song was queued, not when it was sung, so times are off and can be out of order** (low, confirmed, bug) · `src/remocon/pages/HistoryPage.tsx:46`

**Summary.** The row's <time> is song.timestamp, which the API documents as when it was queued. popSong copies the queue item into songHistory unchanged, and the list is in sung order, newest first.

**Scenario.** With a 40-minute queue, a song sung at 22:10 is listed at 21:30. After an admin's 'play next' or a drag reorder, the newest-first list shows e.g. 21:45 above 21:20 above 21:50, which reads as broken to guests looking back at the night.

**Suggested fix.** Record playedAt: now() in HistoryItem in popSong (state.ts parse it as optional for old files) and return it from history. Or, smallest change, label the time as 'Queued 21:30'.

**Verifier.** CONFIRMED: api.ts:76-78 documents timestamp as when the song was queued. popSong (api.ts:979-986) unshifts { song: next } unchanged, HistoryItem (state.ts:141-143) has only song, and HistoryPage.tsx:45-55 formats song.timestamp. The list is in sung order (unshift at pop), so with a queue wait the times run behind when songs were sung. After a play-next or drag reorder, the queued times are out of order in a newest-first list. Cosmetic: low.

## remocon-pages-9

**rank checks isRomaji on the raw query, so full-width romaji or a full-width space gets no kana form** (low, confirmed, bug) · `src/remocon/rank.ts:30`

**Summary.** queryForms NFKC-normalizes the tokens, but decides whether to add the hiragana form with isRomaji(query) on the unnormalized text. wanakana says false for full-width Latin and for U+3000, so those queries never match DAM's kana readings.

**Scenario.** rank('ｋｏｉ', [[愛(アイ), 恋(コイ)]]) returns 愛, 恋, while 'koi' returns 恋, 愛. 'koi　hoshino' with an IME's full-width space likewise loses the こい form (probe run on this commit).

**Suggested fix.** Test the normalized text: `if (isRomaji(typed.join("")))`, and add the full-width cases to rank.test.ts.

**Verifier.** CONFIRMED: I probed it on this commit. isRomaji('ｋｏｉ') and isRomaji('koi　hoshino') are both false, and rank('ｋｏｉ', [[愛(アイ), 恋(コイ)]]) gives 愛,恋 while 'koi' gives 恋,愛. rank.ts:30 tests the raw query, while normalize() (NFKC, lowercase, spaces stripped) already folds those characters. It only changes how the server's results are ordered, and full-width romaji is uncommon input: low. The fix (test typed.join('')) is one line.

## remocon-pages-10

**Route paths and source labels are spelled out in five places each** (low, confirmed, maintainability) · `src/remocon/pages/ArtistPage.tsx:42`

**Summary.** The song-page path prefixes are repeated in songLink.ts SONG_PAGES, ArtistPage SONG_PAGES, SearchResults PAGES and SongPage's chooseVideo literal, beside App.tsx's routes: 4 copies of '/song/' and 5 of '/joysoundSong/'. ArtistPage, SongPage and SearchResults each hand-roll t(kind === 'dam' ? 'source.dam' : 'source.joysound') instead of calling the existing sourceName(kind). SourceMenu's mapping is separate (it includes 'all').

**Scenario.** Renaming or adding a route (say the song-page path for a new catalog) means editing all five. A missed copy doesn't fail the typecheck: its links fall through App's '*' route to <Navigate to="/">, which silently drops the guest on the search screen.

**Suggested fix.** Have ArtistPage, SearchResults' title rows and chooseVideo build links with songLink({kind, songId, youtubeVideoId}), and add an artistLink beside it. Use sourceName(kind) everywhere for the label. That's about 15 fewer lines and one place for each path.

**Verifier.** CONFIRMED: The facts mostly check out. '/song/' is spelled in 4 places (App.tsx:182, songLink.ts:5, ArtistPage.tsx:42, SearchResults.tsx:36), and '/joysoundSong/' in 5 (plus SongPage.tsx:106). The DAM/Joysound label ternary is hand-rolled in ArtistPage.tsx:50, SongPage.tsx:66 and SearchResults.tsx:79-80, although songLink.ts already exports sourceName(kind). SourceMenu.tsx:10 isn't a copy: it maps SearchSource, including 'all', via a template key. Routes have been renamed before (the /profile redirect and the six old search pages), and a missed copy falls through to '*' → '/' with no type error. Pointing ArtistPage and SearchResults at the existing songLink/sourceName helpers is a cheap, worthwhile cleanup. Low.

## common-contract-4

**reading() treats Latin titles with accents, symbols, curly quotes or Unicode hyphens as Japanese, so 'Café' shows as 'kafye' and "Don’t" as 'どんと'** (low, confirmed, bug) · `src/common/readings.ts:41`

**Summary.** The 'already in Latin letters' test is wanakana's isRomaji, which fails on any character outside its small romaji set: é, ☆, ♡, ×, ’, ‐ (U+2010). Those names fall through to the kana or romaji branch, and the whole title or artist is replaced by DAM's katakana reading or a romanization of it. This shows on the phones' rows (WithReading, QueueList, SongPage, notifications) and on the TV's Up next, which uses the queuing phone's readingsMode.

**Scenario.** A guest with Readings set to romaji searches DAM. A song titled 'Café' (reading かふぇ) shows as 'kafye'. 'LOVE☆' (らぶ) shows as 'rabu'. "Don’t" with a curly apostrophe shows as 'どんと' in kana mode. A title DAM writes with U+2010 hyphens, such as Bling‐Bang‐Bang‐Born, gets romanized from its katakana. After that guest queues the song, the TV's Up next shows it the same way.

**Suggested fix.** Show as written whenever the name has no kana or kanji: `if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(written)) return null;` in place of the isRomaji check. Add those four cases to readings.test.ts.

**Verifier.** CONFIRMED: readings.ts:41 returns null only when wanakana's isRomaji(NFKC(written)) is true. I re-ran reading() (verify-common-contract/readings.ts) and got: 'Café'/romaji → 'kafye', 'LOVE☆'/romaji → 'rabu', 'Don’t'/kana → 'どんと', 'Pokémon'/kana → 'ぽけもん', 'Bling‐Bang‐Bang‐Born' (U+2010)/romaji → 'burinbanbanboon', 'LOVE♡' → 'らぶ', '→Pia-no-jaC←' → 'ぴあのじゃっく', '“Hello”' → 'はろー'. ASCII names such as B'z, Mr.Children, King & Prince, m-flo and L'Arc～en～Ciel correctly give null. The callers (WithReading, QueueList, SongPage, useQueueNotifications, renderer/UpNext) all show the result in place of the name. Only guests who chose kana or romaji are affected, the replacement is still readable, and no existing test covers these names. Low.
