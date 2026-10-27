# Phase A5 (tool status and update, event-driven popSong) hand-over

Branch `worktree-agent-adcb09a825b4c209e`, from master 316df2c, not pushed. For phase D, which shows the tools in Settings and the tools problem in the notice bar.

## The two methods

Both are display-only settings methods, like A3's (`SETTINGS_METHODS` in `src/main/settings.ts`): the display calls them through `window.karafriends.api.call(method, {})`; a phone gets 403. Types in `src/common/api.ts`.

| Method           | Input | Output                                    |
| ---------------- | ----- | ----------------------------------------- |
| `getToolsStatus` | `{}`  | `ToolsStatus`                             |
| `updateTools`    | `{}`  | `{ ok: true }` or `{ ok: false, reason }` |

`ToolsStatus`:

- `ffmpeg`, `ytdlp`: each `{ version, updatedAt, overridden }`.
  - `version`: what the tool gives as its version (yt-dlp `2026.10.26`, ffmpeg `9.0.2-full_build-www.gyan.dev`), or `null` until the launch check has asked it (or if it couldn't say).
  - `updatedAt`: when karafriends downloaded it (ms since the epoch). For a copy downloaded before this phase, the file's time.
  - `overridden`: `KARAFRIENDS_YTDLP_PATH` or `KARAFRIENDS_FFMPEG_PATH` names the copy in use. karafriends never downloads it, so `updatedAt` is `null`; show something like "Your own copy" instead of a date. `updateTools` leaves it alone (it only asks its version again).
- `lastCheck`: when this launch's check for new versions finished, or `null` while it hasn't (it starts when the app does).
- `problem`, `problemSince`: the tools problem below, and since when (ms), or `null`.

`updateTools` downloads both tools again (those not overridden), ignoring the cache's validators and age, then records their versions and clears the problem. It is slow: about 5 minutes here, almost all of it the ffmpeg archive from gyan.dev. Show it as running (disable the button, a spinner in place) until it answers. A second call while one runs gets the same answer. Downloads queued meanwhile wait for it. On failure the old copies stay and `reason` is one sentence, `"Couldn't update the tools: <error>"` (offline, or on Windows a yt-dlp.exe still in use by a download). Call `getToolsStatus` again after it answers to show the new versions.

## The tools problem

`LiveState.toolsProblem: string | null`, live on the display (`useLiveState((s) => s?.toolsProblem ?? null)`); phones get it too and ignore it. While set it is always:

> YouTube downloads are failing; try Update tools in Settings

Show it as it is in the one notice bar at the top, with the remote-port banner, and name the settings button **Update tools** so the sentence matches. It is set when a YouTube or Niconico download fails for a reason that isn't the video's (`isToolProblem` in `src/common/downloadFailure.ts`: YouTube's bot check, an error yt-dlp doesn't name, yt-dlp not starting, the tools missing, a timeout), and cleared when a later YouTube or Niconico download works or `updateTools` completes. "Video unavailable", "Private video" and the other video reasons never set it. It isn't saved, so a restart clears it too. Phones still get each failure's own reason through `queueFailed`, as in A1.

## Inside

- `src/common/externalResources.ts`: `toolsStatus()`, `updateTools()`; versions and download times live in `versions.json` beside the validators. The pure parts (`parseToolVersion`, `toolStatus`) are in `externalResourcesPlan.ts`.
- The problem is `State.toolsProblem` in `src/main/state.ts`, set and cleared through `store.update` in `src/main/api.ts` (`ytdlpFailed`, `ytdlpWorked`) and in `src/main/services.ts` after `updateTools`; `toLiveState` passes the message on.
- `src/renderer/Player.tsx`: while waiting, the live queue going from empty to non-empty calls `popSong` at once (`pollNowRef`); the 5 s poll stays. D's `useSongPlayer` split should keep that: `pollTimeoutRef` is null while a `popSong` is in flight, which is what stops a second call.

## Tests

- Unit: `parseToolVersion` and `toolStatus` (`externalResourcesPlan.test.ts`), `isToolProblem` (`downloadFailure.test.ts`), the problem set and cleared by queueing (`api.test.ts`), the live state and `queue.json` (`live.test.ts`, `state.test.ts`), both methods' answers and 403s (`settings.test.ts`, `server.test.ts`).
- e2e: `downloadFailure.spec.ts` (a removed video leaves `toolsProblem` null; the bot check, from the new fake `tests/fixtures/bin/yt-dlp-broken`, sets it; `getToolsStatus` shows yt-dlp overridden; phones get 403) and `player.spec.ts` (a song queued while the display waits starts within 2 s, with the fake `yt-dlp-downloads`).
