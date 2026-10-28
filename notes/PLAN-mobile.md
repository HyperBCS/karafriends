# Plan: mobile round (after the product round)

The product round ([`PLAN-product.md`](PLAN-product.md)) is merged. The user then tried the remote on an iPhone in Safari and found it wanting. This round fixes what they saw and adds the two features they asked for alongside it.

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                                          | State                          | Branch / commit                                                                              | Notes                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1: everyone-admin mode                                       | done                           | `worktree-agent-a3b3f22d44d0eaef3`, merged 2026-10-27                                        | The per-phone song limit still applies in this mode (0 for none). Verified with a real launch and curl.                                                                                                                                                                                                                                 |
| M2: locked shell, home button, contrast                       | done                           | `worktree-agent-abfbfb29773210a9d`, merged 2026-10-27                                        | Tokens: surface `#343434` (1.5:1 vs page), panel `#3a3a3a`, border `#646464` (3.2:1); grey text stays above 4.5:1. WebKit project behind `KARAFRIENDS_E2E_WEBKIT=1`. Real iOS bounce and the keyboard wait for the iPhone check. Screenshots `m-*.png`.                                                                                 |
| M3: drag to reorder the queue                                 | done                           | `worktree-agent-a1803968cb8c9b00c`, merged 2026-10-27                                        | Pointer-event drag with a grip, keyboard arrows on the handle, optimistic with snap-back. Checked in Chromium, WebKit and a real launch with mouse-type pointers; a real finger waits for the iPhone check.                                                                                                                             |
| M4: relevance-ranked search across catalogs                   | done                           | `worktree-agent-ad3f9409368ffba19`, merged 2026-10-27                                        | `src/remocon/rank.ts`. A romaji query is also tried as kana and a kana query as romaji, since Joysound gives no readings. Checked on the real catalogs: "恋", "lemon", "よあそび".                                                                                                                                                      |
| M6: lyrics mode when queueing (kana, romaji, both)            | done                           | `worktree-agent-aaca6d6599cfa66e0`, merged 2026-10-27                                        | Joysound only. "Both" checked on a real song: `m-lyrics-both.png`. The guide-melody slider landed here too. The queued row's mode label is still to add.                                                                                                                                                                                |
| M7: readings in the phone's own text                          | done                           | `worktree-agent-ae106c8f63288f46d`, merged 2026-10-27                                        | Profile setting, DAM readings only (Joysound gives none). Checked on the real catalog. Queued DAM songs carry the title reading, not the artist's; the artist page's list has no readings yet.                                                                                                                                          |
| M8: guide vocal volume (spike, then implement where possible) | done                           | spike `notes/M8-guide-vocal-spike.md`; `worktree-agent-ada43647f19957716`, merged 2026-10-27 | DAM: impossible (separate full mixes). Joysound: a 3-channel ogg whose centre is a synthesized guide melody the display dropped; now mixed in at an admin-set level, default 0, measured in the real app. The phone slider came with M6. Found: the pitch-shift stage costs about 8.5 dB and 44 ms even at zero shift (M9 bypasses it). |
| M9: display: live countdowns and scaling with the window      | done                           | `worktree-agent-aea8baebd3c81b1ce`, merged 2026-10-27                                        | Root size `clamp(10px, 1.48vh, 32px)`, renderer CSS in rem; `m-display-{720,2160}.png`. The vocoder is bypassed at zero key shift. Found: the drag list's optimistic order resets on each live tick (M5 fixes); a phone's clock offset shifts its waits; the lyrics renderers still use px.                                             |
| M5: review and fixes                                          | review done, fixes in progress | `notes/code-review-2026-10-27-product.md`, "Mobile round"                                    | 13 findings (1 High: the vocoder bypass changed the loudness), two fix sessions.                                                                                                                                                                                                                                                        |
| Final: iPhone check by the user                               | not started                    |                                                                                              |                                                                                                                                                                                                                                                                                                                                         |

## What the user saw (2026-10-27, iPhone, Safari)

- The whole page moves when a list scrolls: the top bar and the now-playing bar drift, and the page rubber-bands.
- There is no way home from a song page except Back.
- Scrolling the queue in the now-playing panel scrolls other things too.
- Rows, lists and the panel are too close in colour to the page: hard to tell the queue from the background.
- Admins should drag songs to reorder, not press buttons.
- A party needs a mode where everyone can change the queue and playback.
- Search shows every DAM result, then every Joysound result. Best matches should come first, whatever the source.

## Decisions (from Q&A on 2026-10-27)

- **Device:** iPhone Safari is the target. The e2e suite emulates Chrome, so every remote phase also runs its smoke tests in Playwright's WebKit (opt-in locally, see M2), and the user does the final check on the phone.
- **Navigation:** keep the top bar and the bottom now-playing panel. Add a Home button next to the profile icon in the top bar; no tab bar.
- **Scroll lock:** only the list in the middle scrolls. The top bar, the now-playing bar and the page never move, and the page never bounces on iOS. The queue inside the now-playing panel scrolls on its own.
- **Contrast:** keep the near-black page; lists, the queue and the panel get a clearly lighter surface, borders you can see, and more space between rows.
- **Drag:** a grip handle on each queue row for admins, dragged with pointer events and no library; the row follows the finger and the others slide apart. Move to top stays as a button; Up and Down go.
- **Everyone-admin mode:** a Settings checkbox on the display, "Everyone is an admin": every phone can reorder, remove any song, pause, skip and change key with no password. It overrides supervised mode. The display's settings stay display-only.
- **Search ranking:** results from DAM and Joysound are ranked together by how well they match the query, best first; no more source blocks.
- **Readings (added later the same day):** two things. When queueing a Japanese song, the guest picks how its lyrics show on the TV: kana ruby, romaji, or both (today Joysound has a per-song romaji toggle; DAM has no lyrics display, so this is Joysound only). And a per-phone setting on the profile screen shows the phone's own song titles and artists as written, with a kana reading, with romaji, or both.
- **Guide vocal volume:** an admin control, for DAM and Joysound wherever the service delivers the guide vocal as a separate track that the display can mix. Investigate both first; where it's mixed into the stream, say so and do nothing.
- **Display (added later the same day):** the up-next waits count down live on the display and the phones (the server records when the current song started and how long it has been paused), and the display's UI scales with the window instead of staying at 1080p pixel sizes.
- **Autonomy and roles:** as the product round ended: Fable coordinates, phases run as background Opus subagents in their own worktrees, the coordinator reviews, re-runs checks, merges into master and pushes, with no confirmation per phase. The "Keep it simple" rule and the design brief from `PLAN-product.md` bind every phase.

## How this plan is run

- Lanes: M1 (server and the display's Settings checkbox) runs alongside M2 (the remote's shell) and the M8 spike (read-only investigation). After M2 merges, M3 and M4 run alongside each other (M3 owns the now-playing panel and queue rows, M4 the search page and a new ranking module; both add i18n keys, which the coordinator merges). After those, M6 and M7 run alongside each other (M6 owns the Joysound queue buttons, the queue item's lyrics field end to end and the display's Joysound renderer; M7 owns the rows that show titles and artists and the readings helper; both add a section to the profile screen and i18n keys, which the coordinator merges), M8's implementation (the spike found a Joysound guide melody channel), and M9 after M8 merges (both touch the state and live-state files). Then M5, then the user's check.
- Checks for every phase: `yarn typecheck`, `yarn lint`, `yarn prettier --check .`, `yarn test:unit`, `yarn build-prod`, `yarn test:e2e:ci`, and for remote phases the WebKit smoke run below, plus a real launch with `KARAFRIENDS_LOCAL_ONLY=1 KARAFRIENDS_HIDE_WINDOW=1`.
- Screenshots for M2 and M3 as in the product round (`KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots` after `yarn build-prod`), into `notes/ui-refresh-screenshots/m-*.png`, reviewed against the design brief.
- The Windows/MSIX notes from `PLAN-product.md` apply unchanged.

## Phases

### M1: everyone-admin mode (branch `everyone-admin`)

Files: `src/common/configSchema.ts`, `src/common/api.ts`, `src/main/api.ts`, `src/main/live.ts`, `src/main/settings.ts` (nothing new: the field rides on `setSettings`), `src/renderer/Settings.tsx` (one checkbox in the Queue section), `README.md` (one line), tests.

- `config.yaml`: `everyoneIsAdmin: boolean`, default false, `CONFIG_RULES` boolean.
- `src/main/api.ts`: `isAdmin(caller)` is true for every caller while `config.everyoneIsAdmin` is on. Nothing else changes: `moveSong`, `removeSong`, `setPlaybackState`, `setPitchShiftSemis`, `tryHeadOfQueue` and `whoami` all go through `isAdmin`. Display-only methods stay display-only (`requireDisplay`, `DISPLAY_ONLY_METHODS`).
- `LiveState.config` carries `everyoneIsAdmin` next to `supervisedMode`, and the hub refreshes on change as it does for `supervisedMode` (`services.ts`'s `onChange`). The remote's `useIsAdmin()` already re-asks `whoami` on reconnect; make it also re-ask when `config.everyoneIsAdmin` in the live state changes, so controls appear without a reload.
- Settings screen: "Everyone is an admin: any phone can change the queue and playback, no password needed." under the Queue section, saved like supervised mode.
- Tests: unit for `isAdmin` under the flag (phone with no token can move, remove, pause; display-only still refused), live state carrying the flag; e2e in `api.spec.ts`: turn it on through the display's `setSettings`, a plain phone moves a song, turn it off, the phone gets 403.
- One CHANGELOG line.

### M2: locked shell, home button, contrast (branch `remote-shell`)

Files: `src/remocon/App.tsx`, `App.module.scss`, `index.scss`, `tokens.scss`, `components/ui/TopBar.tsx` and its SCSS, `components/NowPlayingSheet/*` (only the scrolling of its queue region; M3 changes the rows), `components/ui/*.module.scss` (surfaces and borders), `i18n/en.ts` and `ja.ts` (the Home label), `tests/e2e/remote.spec.ts`, `tests/e2e/screenshots.spec.ts`, `playwright.config.ts` (the WebKit project), `tests/e2e/fixtures.ts` only if the WebKit project needs a device override.

- **Shell:** the app is a fixed, full-viewport column (`position: fixed; inset: 0` or `height: 100dvh` with a `100vh` fallback), `html, body { overflow: hidden; overscroll-behavior: none; }`, the `<main>` the only scroller (`overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch`), the top bar and the now-playing bar outside it. The now-playing panel's queue region is its own scroller with `overscroll-behavior: contain` and a max height, so it never scrolls the page. Inputs don't zoom the page on focus (16px font, which the tokens already give). Check that the keyboard opening on the nickname and search fields doesn't leave the layout shifted when it closes.
- **Home:** a Home icon button next to the profile icon in the top bar on every screen except search; it navigates to `/`. Label `nav.home` (exists).
- **Contrast:** raise the tokens so the page, the surface and the panel are three clearly different greys (surface at least 1.5:1 against the page; borders at least 3:1 against the page, as WCAG asks for component boundaries), rows separated by a visible hairline and more vertical space, the panel a step lighter than lists with its existing shadow. Write the chosen values and the ratios in `tokens.scss`'s comments. The accent and text colours don't change.
- **WebKit smoke run:** add a `webkit` Playwright project with an iPhone device for the remote-only specs (`remote.spec.ts`, `screenshots.spec.ts`), gated on `KARAFRIENDS_E2E_WEBKIT=1` so CI is unchanged; `yarn test:e2e:install` installs chromium and webkit. The phase's checks include running it.
- Tests: e2e that scrolling a long result list leaves the top bar and the now-playing bar at the same position (read `boundingBox` before and after a wheel/touch scroll), that the queue region scrolls without moving the top bar, and that Home from a song page lands on search. Screenshots: search with results, the panel open with six queued songs, a song page; each in WebKit and Chromium.
- One CHANGELOG line.

### M3: drag to reorder the queue (branch `queue-drag`)

Files: `src/remocon/components/NowPlayingSheet/*` (the queue rows), a new `src/remocon/components/NowPlayingSheet/useDragReorder.ts` with a unit test for its pure index arithmetic, `i18n/en.ts` and `ja.ts`, `tests/e2e/remote.spec.ts`, `tests/e2e/screenshots.spec.ts`.

- For admins (`useIsAdmin()`), each queued row shows a grip handle (`aria-label` "Drag to reorder", `touch-action: none` on the handle only). Pointer events: on `pointerdown` on the handle, capture the pointer, lift the row (a translateY following the pointer, the others sliding with a short transform transition), compute the target index from the pointer's Y against the row rects, and on `pointerup` call `moveSong` with `toIndex` if it changed. Keyboard: the handle takes focus and Arrow Up/Down move the row (calls `moveSong`), so it's reachable without touch. The list stays optimistic until the live state confirms; on error, snap back and show the reason.
- Remove the Up and Down buttons; keep Remove and Move to top in the expanded row.
- No library; keep the hook under about 150 lines.
- Tests: unit for the index arithmetic; e2e with the Chromium touch emulation and in WebKit: an admin drags the third song above the first and the live state (and the display) show the new order; a guest sees no handle. Screenshot: the panel with a row mid-drag if `page.mouse` can hold it, else the panel with handles.
- One CHANGELOG line.

### M4: relevance-ranked search across catalogs (branch `search-rank`)

Files: a new `src/remocon/rank.ts` (pure, no React) with `rank.test.ts`, `src/remocon/pages/SearchPage.tsx` and its results component, `i18n` if a label changes.

- `rank.ts`: normalize query and candidates the same way: Unicode NFKC, lowercase, full-width to half-width, katakana to hiragana (`wanakana.toHiragana`, already a dependency), spaces and punctuation removed; keep the `nameYomi`/reading fields DAM gives as a second candidate string. Score each result: exact title 100, title starts with the query 80, every query token found in the title 60, title contains the query 50, the same for the artist at 40/30/20/10, plus a small bonus for shorter titles so "恋" ranks above "恋愛サーキュレーション". Stable sort by score, then by each source's own order; alternate sources only on exact ties. Group nothing and drop nothing: a song in both catalogs appears twice, adjacent if the scores tie.
- `SearchPage`: rank the loaded pages of both sources together each time either changes; "More" loads the next page of both and re-ranks. The source label stays on each row. The artist search ranks artists the same way.
- Tests: unit cases for kana/kanji/romaji queries, tokens, ties; e2e in `remote.spec.ts` with faked DAM and Joysound responses asserting the order of the first three rows.
- One CHANGELOG line.

### M6: lyrics mode when queueing (branch `lyrics-mode`)

Files: `src/common/api.ts` (`JoysoundQueueItem.lyricsMode`), `src/main/validate.ts`, `src/main/api.ts` (`queueSong` input), `src/main/state.ts` (`parseState` reads old `isRomaji` as `"romaji"`/`"kana"`), `src/renderer/JoysoundRenderer.tsx` and `useSongPlayer.ts` (the mode reaches the renderer), `src/remocon/` (the Joysound queue buttons on `SongPage`, a "Lyrics on the TV" default on the profile screen kept in `localStorage`), `i18n`, tests.

- `lyricsMode: "kana" | "romaji" | "both"` replaces `isRomaji` on Joysound queue items (the download file names don't depend on it; keep them). "kana" is today's default rendering (kanji with kana ruby), "romaji" is today's romaji rendering, "both" draws the romaji line under the kanji line in the renderer; keep the renderer change to the layout of the lines it already draws (the romaji conversion exists in `src/common/joysoundParser.ts`).
- Remote: the Joysound song page's queue buttons become one "Queue" button plus a three-way choice (kana / romaji / both) next to it, preset from the phone's profile default; the queued row shows the mode as a small label.
- Tests: unit for `parseState` reading old items; e2e queueing a Joysound song with each mode through the fixture's fake tools and checking the queue item's `lyricsMode` in the live state; a renderer screenshot for "both" if a telop fixture exists in `tests/fixtures` (else say it needs the party check).
- One CHANGELOG line.

### M7: readings in the phone's own text (branch `readings`)

Files: a new `src/remocon/readings.ts` (pure: given a title and the reading DAM gives, return the line to show for the chosen mode; kana to romaji through `wanakana.toRomaji`) with `readings.test.ts`; the rows that show titles and artists (search results, the queue rows, history, the song page heading); a "Readings" section on the profile screen (as written / kana / romaji / both) in `localStorage`; `i18n`.

- DAM results carry `nameYomi`/`artistNameYomi` already (see `DamSong` in `src/common/api.ts`); Joysound results carry readings only where its API gives them, else the row shows the title as written. Queue items don't carry readings today: add `nameYomi` and `artistNameYomi` as optional fields on `SongToQueue`/`QueueItem` (server passes them through, `parseState` tolerates their absence) so the queue and history can show readings too. That is the one server change in this phase; keep it to those two optional strings.
- Tests: unit for the readings helper (kana → romaji, missing reading, "both"); e2e that switching the setting changes a search row's text.
- One CHANGELOG line.

### M8: guide vocal volume (spike first, branch `guide-vocal`)

- **Spike (read-only, reports back):** read `src/main/damApi.ts` (`getMusicStreamingUrls`, the vocal types the DAM song page offers: the "guide vocal" queue button) and `src/main/joysoundApi.ts` (`getSongRawData`, `getMovieUrls`) and, on a Japanese IP with the installed app's logins, fetch one DAM song's streaming URLs and probe each HLS variant with ffprobe (the app's ffmpeg comes with it) for the number and language of audio tracks; fetch one Joysound song's raw data and probe its ogg for channels and any second stream. Report: for each service, whether the guide vocal is a separate audio track or stream (mixable), a separate full mix (selectable, not mixable), or mixed in; and the smallest way to control its level.
- **Implement only if a separate track exists:** a `guideVocalVolume` (0 to 1) in the live state like `pitchShiftSemis`, admin-only `setGuideVocalVolume`, a slider on the phone's playback controls next to the key, and the display's audio graph (`src/renderer/webAudio.ts`) mixing that track at that gain. If only separate full mixes exist, do nothing beyond the report, and say so in the Status table.

### M9: display: live countdowns and scaling with the window (branch `display-live`)

Files: `src/main/state.ts`, `src/main/api.ts` (`popSong`, `setPlaybackState`), `src/main/live.ts`, `src/common/api.ts`, `src/common/hooks/useQueue.ts`, `src/renderer/UpNext.tsx`, `IdleScreen.*`, `Announcements.css`, `NoticeBar.css`, `Settings.css`, `App.css`, `tokens.css`, `index.css`, tests, `tests/e2e/display.spec.ts`.

- **Countdowns.** `State` gets `currentSongStartedAt: number | null` (ms since the epoch, set in `popSong` when a song starts, cleared when none plays) and `currentSongPausedMs: number` with `pausedSince: number | null` (`setPlaybackState` to PAUSED records the time; back to PLAYING adds the pause to `pausedMs`; RESTARTING resets `startedAt` to now and `pausedMs` to 0). `LiveState` carries `currentSongStartedAt` and `currentSongPausedMs` plus `playbackState` (already there). `useQueue`'s ETAs subtract the elapsed time (`now - startedAt - pausedMs`, minus the time since `pausedSince` if paused) from the current song's playtime, floor at 0, and a one-second ticker in the hook re-renders only the components that show ETAs. Not saved in `queue.json` beyond what's there (after a restart the current song replays from the start, so `startedAt` is set again by `popSong`).
- **Scaling.** The display's sizes move to `rem` with the root font size tied to the window: `html { font-size: clamp(10px, 1.48vh, 32px) }` (16px at 1080p, 32px at 2160p, 10px floor for a small dev window), and every px in the renderer's CSS that is a size, space or radius becomes rem (the 1px hairlines stay px). The QR code already uses vh; the up-next strip, idle list, announcements, notice bar and settings follow the root size. The lyrics renderers (`JoysoundRenderer`, `PianoRoll`, `AdhocLyrics`) draw to canvases sized from the video element and aren't part of this; check they still fit after the strip's height changes.
- Tests: unit for the elapsed-time arithmetic (pause, resume, restart) and `withETAs` with a started song; e2e in `display.spec.ts`: a seeded playing song's up-next wait decreases by about 2 s over 2 s, pausing from a phone freezes it; screenshots of the idle screen at 1280×720 and 3840×2160 into `notes/ui-refresh-screenshots/m-display-{720,2160}.png` showing the same layout at both sizes.
- One CHANGELOG line.

### M5: review and fixes

Two reviewers (remote; server and display) over `git diff <start of this round>..HEAD` with the product round's reviewer brief, a Fable verification pass, findings appended to `notes/code-review-2026-10-27-product.md` under a "Mobile round" heading, and one fix session per area.

### Final: iPhone check by the user

On the phone: scroll a long result list and the queue, open a song page and go Home, turn on everyone-admin on the display and reorder by drag from a plain phone, search "恋", "lemon" and "よあそび" and check the order. Queue a Joysound song with lyrics set to "both" and read the TV. Switch the readings setting and look at the search rows. Turn up the guide melody during a Joysound song. Watch an up-next wait count down, and resize the display window. Note every snag in the Status table's Notes column.
