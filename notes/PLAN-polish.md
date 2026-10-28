# Plan: polish round (after the mobile round)

The mobile round ([`PLAN-mobile.md`](PLAN-mobile.md)) is merged and its review fixes are landing. The user then listed nine more things, below. Same way of working as before: Fable coordinates, Opus subagents build in their own worktrees, the coordinator reviews, re-runs checks, merges into master and pushes without asking; the "Keep it simple" rule and the design brief from `PLAN-product.md` bind every phase.

## Status (keep this table current; it is how any session picks up where things stand)

| Step                                                                         | State       | Branch / commit | Notes |
| ---------------------------------------------------------------------------- | ----------- | --------------- | ----- |
| P1: no proxy; DAM songs carry both stream URLs                               | not started |                 |       |
| P2: remote: top bar, bottom bar, now-playing bar, melody slider, light theme | not started |                 |       |
| P3: display: A/V offset, UI scale, DAM low-bitrate fallback                  | not started |                 |       |
| P4: review and fixes                                                         | not started |                 |       |
| Final: iPhone and TV check by the user                                       | not started |                 |       |

## The list (2026-10-27) and the decisions from Q&A

1. **History button in the top bar next to Profile.** The History row on the empty search screen goes.
2. **Standardize the icon size in the bottom bar.** Every control in the now-playing bar's control row uses the same icon size and tap target.
3. **Tell the artist from the singer, and make the bar look better.** The user meant the display first (the up-next strip under the video and the "Now playing" corner show "artist · singer" as one muted line), and the phone's bar too. Decision: on the display, the strip and the corner show the artist on its own and the singer as "Ken" with a small initial circle (or "queued by Ken" in the corner), never joined to the artist with a dot; the strip gets a cleaner look (one row per song: title, artist, singer badge, wait; a clearer divider; the "Up next" label set apart). On the phone, the collapsed now-playing bar shows the title on line one, the artist on line two, and on the right the singer's initial circle with their nickname beside it in the muted colour.
4. **DAM audio lags the lyrics.** Decision: the user saw this before the mobile round removed the pitch shifter from the key-0 path (44 ms) and hasn't retested. The offset setting (5) ships either way; the two-element "audio runs ahead" change is not planned unless the retest still shows a lag at key 0.
5. **Audio/video offset (±) and UI scale in the display's Settings.**
6. **Guide melody slider always greyed out.** It works (measured in the real app); it was enabled only for an admin while a Joysound song played. Decision: move it to an "Admin" section on the phone's profile screen, shown when the phone is an admin, always enabled; remove it from the playback controls.
7. **If DAM is lagging, switch to the low-bitrate stream.** Decision: for the rest of that song only; each new song tries the high-bitrate stream again.
8. **Remove the proxy settings and the code behind them.** The user runs a VPN.
9. **Light theme, with light / dark / auto on the phone.** The display stays dark.

## How this plan is run

- Lanes: P1 (server) and P2 (remote) run alongside each other. P3 (display) starts after P1 merges, since the low-bitrate fallback needs the second URL P1 adds. Then P4, then the user's check.
- Checks for every phase as in `PLAN-mobile.md`: `yarn typecheck`, `yarn lint`, `yarn prettier --check .`, `yarn test:unit`, `yarn build-prod`, `yarn test:e2e:ci`, the WebKit run for remote phases (`KARAFRIENDS_E2E_WEBKIT=1 yarn test:e2e remote`), a real launch with `KARAFRIENDS_LOCAL_ONLY=1 KARAFRIENDS_HIDE_WINDOW=1`, and screenshots into `notes/ui-refresh-screenshots/p-*.png` for anything visual, reviewed against the design brief (which gains a light-theme clause in P2).
- The Windows/MSIX notes from `PLAN-product.md` apply unchanged.

## Phases

### P1: no proxy; DAM songs carry both stream URLs (branch `no-proxy`)

Files: `src/common/configSchema.ts`, `src/main/http.ts`, `src/main/services.ts`, `src/main/index.ts` (the `session.setProxy` call and the `app.on("login")` handler), `src/common/childEnv.ts` (and its callers in `src/main/downloads/`; the app never sets `http_proxy` now, so the env copy goes too), `src/main/settings.ts` (the proxy keys leave `RESTART_KEYS`; `importConfig` drops them like the other obsolete keys), `src/renderer/Settings.tsx` (the proxy fields and the restart note for them; the port keeps its restart note), `src/common/api.ts` (`PoppedDamSong`), `src/main/api.ts` (`popSong`), `README.md`, `CHANGELOG.md`, tests.

- Remove `proxyEnable`, `proxyHost`, `proxyPort`, `proxyUser`, `proxyPass` from the schema, the rules and the defaults; add them to `OBSOLETE_KEYS` so an old `config.yaml` or an imported file loses them with a note. Delete `setProxy`, the proxy agent in `http.ts`, `envWithoutHttpProxy`, the Electron session proxy and the login handler, and the Settings section. The README's "Running a party" says DAM and Joysound need a Japanese IP and a VPN on the computer; drop the proxy sentence.
- `PoppedDamSong.streamingUrls` becomes a list of `{ high: string; low: string }` (one per vocal type as today), and `popSong` fills both from `getMusicStreamingUrls`; `useLowBitrateUrl` still picks which one the display starts with (P3 reads it from the popped song, so add `startWithLowBitrate: boolean` to `PoppedDamSong` too). The display's current loader (`useSongPlayer.ts`) must keep working: P1 updates its one line that reads the URL, nothing else there.
- Tests: unit for the schema (old keys dropped with a note), `popSong` output, `importConfig` of a file with proxy keys; the e2e `settings.spec.ts` cases that touched proxy fields change to the port.

### P2: remote: top bar, bottom bar, now-playing bar, melody slider, light theme (branch `remote-polish`)

Files: `src/remocon/**` (`TopBar`, the search page's History row, `NowPlayingSheet/*`, `ProfilePage.tsx`, `tokens.scss`, `index.scss`, every `.module.scss` that names a colour), `i18n`, `tests/e2e/remote.spec.ts`, `screenshots.spec.ts`, `CHANGELOG.md`, and one paragraph added to the design brief in `PLAN-product.md`.

- **Top bar:** History icon button next to Profile on every screen (except the first-visit nickname screen), the History row on the search screen removed.
- **Bottom bar:** one icon size (28px) and one 44px tap target for every control in the row (emotes toggle, restart, play/pause, skip, flat, key, sharp); the key value gets the same height.
- **Now-playing bar:** as decided: title, artist, singer badge (initial circle plus nickname in the muted colour) on the right. Expanded, the current song row matches.
- **Melody slider:** an "Admin" section on the profile screen, shown when `useIsAdmin()`, holding the guide-melody slider (always enabled; one request on release as the mobile fixes made it) and nothing else yet; remove it from `PlaybackControls`.
- **Light theme:** the tokens become CSS custom properties with two value sets (dark as today; light: near-white page `#f5f5f5`, white surface, a light-grey panel, `#1a1a1a` text, the same accent, borders at 3:1 against the page, muted text at 4.5:1), switched by `data-theme="light" | "dark"` on `<html>`; a "Theme" section on the profile with Light / Dark / Auto (auto follows `prefers-color-scheme`, saved in `localStorage` as `theme`, default auto). Every component colour comes from the tokens, so nothing else changes; check the source labels, the pressed states, the drag's held row and the slider in both themes. Add to the design brief in `PLAN-product.md`: the light theme's rules (same type, spacing, radius and accent; no shadows beyond the sheet's; the Don't list applies).
- Tests: e2e for the History button, the theme switch (the `data-theme` attribute and a computed background), the admin section showing the slider for an admin only; screenshots of search, the open sheet and the profile in light and dark, Chromium and WebKit, as `p-*.png`.

### P3: display: now-playing strip, A/V offset, UI scale, DAM low-bitrate fallback (branch `display-polish`)

Files: `src/renderer/UpNext.tsx` and `.css`, `Announcements.tsx` and `.css`, `IdleScreen.tsx` (the idle list uses the same row), `Settings.tsx` and `.css`, `webAudio.ts`, `useSongPlayer.ts`, `JoysoundRenderer.tsx`, `AdhocLyrics.tsx`, `PianoRoll.tsx` (the lyric or note timing read from the video), `index.css`/`App.tsx` (the root font size), `tests/e2e/display.spec.ts`, `settings.spec.ts`, `screenshotsDisplay.spec.ts`, `CHANGELOG.md`.

- **Strip and corner:** as decided in item 3: the up-next strip's rows show title, artist, a singer badge (initial circle plus nickname in the muted colour) and the wait, with a clearer divider and the "Up next" label set apart; the idle list and the "Now playing" / "Queued" corner cards use the same title, artist, singer layout, so the artist is never joined to the singer with a dot. Screenshots `p-display-playing.png` and `p-display-idle.png` at 1080p.

- **A/V offset:** a "Display" section in Settings with "Audio/video offset" in ms from −300 to +300 in steps of 10, saved on the display in `localStorage` (like the mics). Positive delays the audio by that much through a `DelayNode` before the gain node (every source). Negative advances what the display draws from the video's time: the Joysound renderer, the adhoc lyrics and the piano roll read `video.currentTime + offset`. DAM's own lyrics are in the video, so a negative offset can't move them; the setting's help line says so. The audio context is created with `latencyHint: "interactive"`, and the section shows the context's measured output latency in ms as information.
- **UI scale:** "UI scale" from 50% to 200% in steps of 10%, saved on the display, multiplying the root font size from M9 (`clamp(...)` × scale). The lyrics renderers aren't affected (they size from the video).
- **DAM low-bitrate fallback:** in the DAM loader, count hls.js `BUFFER_STALLED_ERROR` events; on the third within one song, `loadSource` the low-bitrate URL for the same vocal type at the current position (`startPosition` or a seek after `MANIFEST_PARSED`), announce "Switched to low bitrate" in the corner, and keep playing. Each new song starts with the URL the popped song says. No session-wide memory.
- Tests: unit for the offset arithmetic if it's a pure function; e2e: the offset and scale settings save and the root font size changes; the fallback can be driven with a `page.route` that fails fragment requests after the manifest on a seeded DAM-like stream only if the fixture can serve HLS, else say it needs the party check with a throttled network.

### P4: review and fixes

Two reviewers (remote; server and display) over `git diff <start of this round>..HEAD` with the same brief as the earlier rounds, a Fable verification pass, findings appended to `notes/code-review-2026-10-27-product.md` under "Polish round", one fix session per area.

### Final: iPhone and TV check by the user

On the phone: the History button, the bottom bar, the now-playing bar, the melody slider on the profile as an admin, the light theme in auto with the phone in light and dark mode. On the TV: a DAM song at key 0 (is the lag gone?), the offset setting if not, UI scale at 150%, and a DAM song on a throttled network to see the low-bitrate switch.
