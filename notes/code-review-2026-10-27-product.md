# Code review: the product round (2026-10-27)

## Overview

This review covers the product round, `git diff e15f92a..540eb7c`: phases A1 to A6, B, C, D, E and F of [`PLAN-product.md`](PLAN-product.md). Five Opus reviewers read the diff by area (server and admin; settings, config and tools; downloads; the phone remote; the display and Player), each told to trace a concrete failure before reporting and to list over-engineering separately. The coordinator (Fable) then re-read the code for every High and Medium finding and the Lows whose evidence it hadn't already seen during the merges; nothing was refuted. 29 findings held up: 2 High, 7 Medium, 20 Low. No credential reaches a phone, a log line or the live state, and no phone can get past an admin check.

The two Highs are in the display's player and would stop a party: a DAM stream error skips songs twice and leaves stray poll loops, and a song whose file can't load freezes the queue with no way out from a phone. Both are pre-existing; the Player split copied them faithfully.

**Origin** says whether this round introduced the problem.

## Findings

| #   | Severity | Area      | Title                                                                                                                                                       | File:line                                                     | Origin             |
| --- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------ |
| 1   | High     | Display   | A failing DAM stream calls `popSong` on every non-fatal hls.js error: songs skipped twice, stray 5 s poll loops never stop                                  | `src/renderer/useSongPlayer.ts:107`                           | Pre-existing       |
| 2   | High     | Display   | No `error` handler on the video and no catch on the telop fetch: a missing or undecodable file freezes the queue, Skip can't recover                        | `src/renderer/useSongPlayer.ts:142`                           | Pre-existing       |
| 3   | Medium   | Settings  | A failed Update tools rejects the shared tools promise, so every download queued while it ran fails with "no tools" and sets the tools problem              | `src/common/externalResources.ts:363`                         | New                |
| 4   | Medium   | Settings  | `importConfig` keeps an old file's `YOUR_PASSWORD_HERE` placeholders as real values; `hasLogin`'s placeholder check is dead since the defaults became empty | `src/main/settings.ts:251`, `src/common/configSchema.ts:61`   | New                |
| 5   | Medium   | Server    | The sign-in rate limit is per exact address (any IPv6 /64 gives unlimited addresses) and each try runs `scryptSync` on the main thread                      | `src/main/server.ts:276`, `src/common/adminPassword.ts:23`    | New                |
| 6   | Medium   | Downloads | A failed Joysound download deletes every `joysound-<id>-*` and the shared `.joy_02`, including another queued copy's finished video                         | `src/main/downloads/jobs.ts:58`, `:544`                       | Pre-existing       |
| 7   | Medium   | Downloads | Two downloads of one DAM song write the same `.tmp` at once; the display can play the corrupt result                                                        | `src/main/downloads/jobs.ts:183`                              | Pre-existing       |
| 8   | Medium   | Remote    | `history.replaceState({}, …)` after picking a Joysound background wipes react-router's index, so every later back button goes to an empty search            | `src/remocon/pages/SongPage.tsx:74`, `App.tsx:80`             | New                |
| 9   | Medium   | Remote    | The YouTube page's `<Navigate>` to the lyrics screen has no `replace`, so Back returns to the lyrics forever while the song plays                           | `src/remocon/pages/YouTubePage.tsx:31`                        | New                |
| 10  | Low      | Server    | An admin phone can call `popSong`, taking a song off the queue that then never plays                                                                        | `src/main/api.ts:746`                                         | Pre-existing       |
| 11  | Low      | Server    | A second phone queuing a song already downloading gets `ok: true` and its song is silently dropped (also Downloads #4)                                      | `src/main/api.ts:588`, `src/main/downloads/index.ts:90`       | Pre-existing       |
| 12  | Low      | Server    | `adminLogin` answers 403 both for a wrong password and for none set, so guests see "Wrong password" when there is none                                      | `src/main/api.ts:804`, `src/remocon/pages/ProfilePage.tsx:13` | New                |
| 13  | Low      | Settings  | YAML warnings and the launch parse error print the offending line, which can hold a password                                                                | `src/main/settings.ts:224`, `src/common/configStore.ts:283`   | New / Pre-existing |
| 14  | Low      | Settings  | A `config.yaml` that parses but isn't a mapping is overwritten with the defaults, with no `.broken` copy                                                    | `src/common/configStore.ts:312`                               | New                |
| 15  | Low      | Downloads | A yt-dlp message about a premiere, a live stream or a paid video counts as a tools problem                                                                  | `src/common/downloadFailure.ts:225`                           | New                |
| 16  | Low      | Downloads | `proc.kill()` kills only the direct process (a `.cmd` wrapper's yt-dlp lives on); the timeout settles before the kill                                       | `src/main/downloads/run.ts:133`                               | New                |
| 17  | Low      | Downloads | The plan's two-at-once yt-dlp limit isn't implemented: every queued video starts at once                                                                    | `src/main/downloads/queue.ts`                                 | New                |
| 18  | Low      | Downloads | A Joysound video left half-written by a crash is queued as complete on the next request                                                                     | `src/main/downloads/jobs.ts:518`                              | Pre-existing       |
| 19  | Low      | Remote    | Song pages keep one song's background, caption and lyrics choices when navigating to another song                                                           | `src/remocon/pages/SongPage.tsx:47`, `YouTubeInfo.tsx:21`     | Pre-existing       |
| 20  | Low      | Remote    | The playback-controls row is 362px wide and doesn't wrap: it scrolls sideways on 360px phones                                                               | `NowPlayingSheet.module.scss:42`                              | New                |
| 21  | Low      | Remote    | A Niconico or YouTube ID typed by hand opens the wrong video after the 500 ms debounce (`sm1`)                                                              | `src/remocon/pages/SearchPage.tsx:61`                         | New                |
| 22  | Low      | Remote    | Switching language remounts `QueueNotifications`, repeating the "your song is up soon" notification                                                         | `src/remocon/i18n/index.ts:121`                               | New                |
| 23  | Low      | Remote    | The artist link on song pages is a 24px tap target                                                                                                          | `SongPage.module.scss:31`                                     | New                |
| 24  | Low      | Display   | A failed checkbox save leaves the box showing the unsaved state                                                                                             | `src/renderer/Settings.tsx:83`                                | New                |
| 25  | Low      | Display   | Importing a config with a different admin password signs every phone out without saying so                                                                  | `src/main/settings.ts:283` (main side)                        | New                |

Four more Lows from the reviewers were folded into the rows above (Downloads #4 into #11; the Display reviewer's note on `deleteJoysoundTempFiles` into #6; two duplicate observations on `Viewer.adminToken` into the Simplicity list).

## Simplicity (cut unless noted)

- `Viewer.adminToken` on `/api/events`: parsed, sent by the client, read by nothing. Remove the query parameter, the client side and the `Viewer` field.
- `ADMIN_PASSWORD_SCRYPT` export and its comment about a README snippet that no longer exists: keep the constants, fix the comment, drop the export if nothing imports it.
- `apiRouter`'s `loginLimit` parameter: nobody passes it; the limiter is tested directly.
- Two code paths clearing admin sessions on a password change (`createSetAdminPassword` and the config listener): keep the listener, drop the call in `createSetAdminPassword`.
- `testLogin`'s `credentials` input: the settings screen always tests the saved login. Remove it and the tests that send it.
- `hasLogin`'s `!== DEFAULT_CONFIG[key]` and `Settings.tsx`'s `shown()`: dead since the defaults became empty (and the root of #4).
- `ConfigStore.onChange`'s unsubscribe: unused; keep (one line, and a listener that can't be removed is worse).
- `ToolsStatus.lastCheck`, `problem`, `problemSince`: the screen shows versions only and the notice bar reads the live state. Leave for this round: cutting them touches the API type both sides at once.
- `removeExpiredDownloads` and `failDownload`'s guard: keep; tiny and harmless.
- Remote primitives: `ListRow`'s `href` variant, `Tabs`' `panelId`, `InlineError`'s `retryLabel`, `Button`'s `icon` (only `/dev/ui` uses it), `Sheet`'s uncontrolled mode and label props: remove the unused ones. `useUserIdentity`'s `signIn`/`signOut` pass-throughs: import from `apiClient` directly.
- `useDownloadButtonText` encodes state as English text and parses it back to translate: store the state and percentage instead, if it stays under about 40 changed lines; otherwise leave.
- Display: `HostnameSetting`'s `port` prop (read it inside), `IdleScreen`'s second queue subscription (let `UpNext` render nothing when empty).

## Fix plan

Three fix sessions, one per area so they don't touch the same files, each with the checks from the plan:

- **Main process** (`src/main/**`, `src/common/**`, their tests, `tests/e2e/api.spec.ts`, `settings.spec.ts`, `downloadFailure.spec.ts`, `live.spec.ts`): #3, #4, #5, #6, #7, #10, #11, #12 (server side: answer 409 for "none set"), #13, #14, #15, #16, #17, #18, #25, and the main-side simplicity cuts.
- **Phone remote** (`src/remocon/**`, `tests/e2e/remote.spec.ts`): #8, #9, #12 (remote side: show the 409 message), #19 to #23, and the remote simplicity cuts.
- **Display** (`src/renderer/**`, `tests/e2e/display.spec.ts`, `player.spec.ts`): #1, #2, #24, and the display simplicity cuts.

## Status

Fixes in progress; this file is updated when they merge.
