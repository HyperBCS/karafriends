# Plan: mobile round (after the product round)

The product round ([`PLAN-product.md`](PLAN-product.md)) is merged. The user then tried the remote on an iPhone in Safari and found it wanting. This round fixes what they saw and adds the two features they asked for alongside it.

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                        | State       | Branch / commit | Notes |
| ------------------------------------------- | ----------- | --------------- | ----- |
| M1: everyone-admin mode                     | not started |                 |       |
| M2: locked shell, home button, contrast     | not started |                 |       |
| M3: drag to reorder the queue               | not started |                 |       |
| M4: relevance-ranked search across catalogs | not started |                 |       |
| M5: review and fixes                        | not started |                 |       |
| Final: iPhone check by the user             | not started |                 |       |

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
- **Autonomy and roles:** as the product round ended: Fable coordinates, phases run as background Opus subagents in their own worktrees, the coordinator reviews, re-runs checks, merges into master and pushes, with no confirmation per phase. The "Keep it simple" rule and the design brief from `PLAN-product.md` bind every phase.

## How this plan is run

- Lanes: M1 (server and the display's Settings checkbox) runs alongside M2 (the remote's shell). After M2 merges, M3 and M4 run alongside each other (M3 owns the now-playing panel and queue rows, M4 the search page and a new ranking module; both add i18n keys, which the coordinator merges). Then M5, then the user's check.
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

### M5: review and fixes

Two reviewers (remote; server and display) over `git diff <start of this round>..HEAD` with the product round's reviewer brief, a Fable verification pass, findings appended to `notes/code-review-2026-10-27-product.md` under a "Mobile round" heading, and one fix session per area.

### Final: iPhone check by the user

On the phone: scroll a long result list and the queue, open a song page and go Home, turn on everyone-admin on the display and reorder by drag from a plain phone, search "恋", "lemon" and "よあそび" and check the order. Note every snag in the Status table's Notes column.
