# Code review: hard-fork simplification (2026-10-27)

## Overview

This review covers the karafriends hard-fork simplification, `git diff 5335f3e..HEAD`. Opus reviewers checked five areas: the server API, state and live stream; security of the LAN-facing server and IPC; client data flow and UI replacements; upstream integrations (DAM, Joysound, YouTube, Niconico, downloads); and build, packaging, CI and tests. A separate verifier then tried to disprove each finding. 19 findings held up, none were refuted and none were left uncertain. There is nothing critical, but two high issues need fixing before the next party or release: any device on the LAN can crash the app with one request (#1), and the release workflow can't upload its zips (#2).

The **Origin** column below shows whether this diff introduced the problem ("New") or whether it was already there at 5335f3e ("Pre-existing").

## Confirmed findings

| #   | Severity | Title                                                                                                                           | File:line                                                      | Origin                       |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| 1   | High     | Any LAN client can crash the whole app through the WebSocket-upgrade refusal                                                    | `src/main/httpServer.ts:34`                                    | New (regression)             |
| 2   | High     | Release workflow can't upload its zips: the new repo's GITHUB_TOKEN is read-only                                                | `.github/workflows/release.yaml:7`                             | New (new repo defaults)      |
| 3   | Medium   | popSong commits the song change, then can block ~17 min on DAM retries or drop the song                                         | `src/main/api.ts:604`                                          | Pre-existing                 |
| 4   | Medium   | pushAdhocLyrics lets any phone write any text to the shared lyrics, with no permission check and no limit                       | `src/main/api.ts:561`                                          | Pre-existing, made worse     |
| 5   | Medium   | Admin and ownership checks trust a nickname header, and every nickname is broadcast to phones                                   | `src/main/api.ts:117`                                          | New (incomplete new control) |
| 6   | Medium   | YouTube adhoc lyrics are stored before the download and never removed unless that song plays                                    | `src/main/api.ts:501`                                          | Pre-existing                 |
| 7   | Medium   | Remote re-renders its whole tree on every live-state flush, so DAM queue buttons stay disabled while any download runs          | `src/remocon/components/DamQueueButtons/DamQueueButton.tsx:38` | New (regression)             |
| 8   | Medium   | 30s timeout now also cuts off the response body, so large Joysound getFME downloads abort and retry from scratch                | `src/main/http.ts:51`                                          | New (regression)             |
| 9   | Medium   | `yarn dev` can't rebuild main or preload on Windows because the running app locks the native .node                              | `electron.vite.config.ts:83`                                   | New                          |
| 10  | Low      | A phone that connects during the throttle window can be left showing a state that no longer exists                              | `src/main/live.ts:241`                                         | New                          |
| 11  | Low      | pushAdhocLyrics is unbounded and open to any phone, and every live-state event re-sends the whole list                          | `src/main/api.ts:561`                                          | Pre-existing, made worse     |
| 12  | Low      | Each nicoInfo request starts its own yt-dlp process, with no cache or concurrency cap and no identity needed                    | `src/common/videoDownloader.ts:1129`                           | New                          |
| 13  | Low      | /api/events has no limit on connections and ignores write backpressure                                                          | `src/main/server.ts:73`                                        | Pre-existing                 |
| 14  | Low      | The joysoundSong id goes unvalidated into a URL path sent with the host's Joysound session, and upstream errors are echoed back | `src/main/joysoundApi.ts:187`                                  | Pre-existing                 |
| 15  | Low      | Form bodies are joined without percent-encoding, so phone search terms are split or mangled (and DAM passwords break)           | `src/main/joysoundApi.ts:121`                                  | Pre-existing                 |
| 16  | Low      | YouTube caption codes with a region/script subtag are silently refused, but queueSong reports success                           | `src/common/videoDownloader.ts:1005`                           | Pre-existing                 |
| 17  | Low      | Proxy stripping for yt-dlp deletes http_proxy from the main process instead of from the child's env                             | `src/common/videoDownloader.ts:1200`                           | Pre-existing                 |
| 18  | Low      | The phone remote's production CSS targets Electron's Chromium, which strips the `-webkit-user-select` prefix iOS needs          | `electron.vite.config.ts:113`                                  | New                          |
| 19  | Low      | The plan gives the wrong names for the macOS signing secrets that release.yaml reads                                            | `notes/PLAN-hard-fork.md:117`                                  | New (docs)                   |

Overlaps: #4 and #11 are the same pushAdhocLyrics gap, found by two reviewers from different angles. One fix closes both. #14 and #15 share the unencoded Joysound path and form input. #19 should be fixed together with #2.

---

## High

### 1. Any LAN client can crash the whole app through the WebSocket-upgrade refusal

`src/main/httpServer.ts:34` · New (regression)

**What is wrong.** The new `upgrade` handler calls `socket.end()` on the raw socket but never adds an `error` listener. Before Node emits `upgrade`, it removes the HTTP server's own socket error handler. So an ECONNRESET or EPIPE on that socket becomes an unhandled `error` event. That turns into an `uncaughtException`, and `handleError` responds with `process.exit(1)`. The old code went through ws's `handleUpgrade`, which attaches an error handler before it aborts the handshake.

**Failure scenario.** Any device on the LAN sends `GET / HTTP/1.1` with `Connection: Upgrade` and `Upgrade: websocket` to port 8080, then resets the TCP connection. The main process exits, and the display, queue and downloads go down mid-party. It takes one request and can be repeated after every relaunch.

**Fix.**

```ts
socket.on("error", () => socket.destroy());
socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
```

Optionally also destroy the socket on `finish`, as ws's `abortHandshake` does.

**Evidence.** httpServer.ts:34-36 never adds an error listener. `http.Server` is allowHalfOpen, so the socket stays readable after `end()`, and a peer RST then emits ECONNRESET with nothing listening. index.ts:27 sends uncaughtException to `handleError`, which exits at line 24. The verifier reproduced it in a scratch script (Node v26) using the exact handler. One upgrade request followed by a client `resetAndDestroy()` printed `UNCAUGHT ECONNRESET read ECONNRESET`, and the process exited. With the error listener added, it survived 20 attempts.

### 2. Release workflow can't upload its zips: the new repo's GITHUB_TOKEN is read-only

`.github/workflows/release.yaml:7` · New (new repo defaults)

**What is wrong.** release.yaml has no `permissions:` block, so its jobs get the repo's default token permissions. The new repo made in Phase 2 defaults to read-only. The archived old repo defaulted to write, which is why this used to work. All four jobs upload with `softprops/action-gh-release@v3`, and that needs `contents: write`.

**Failure scenario.** You publish a release. The win, linux, mac-arm64 and mac-x64 jobs all build, and the mac jobs also sign and notarize. Then each job fails at the upload step with 403 "Resource not accessible by integration". The release ends up with no zips.

**Fix.** Add this at the top level of release.yaml (or on each job):

```yaml
permissions:
  contents: write
```

Alternatively, switch the repo's Actions workflow permissions to read/write.

**Evidence.** release.yaml has no `permissions:` key anywhere: the top level is `on:` and then `jobs:` at line 7. The diff only added `cache: yarn`. `gh api repos/HyperBCS/karafriends/actions/permissions/workflow` returns `{"default_workflow_permissions":"read"}`. The upload steps are at lines 48, 91, 111 and 130. `gh workflow list` shows only Build and CodeQL, so Release has never run in this repo. build.yaml already sets its own `contents: read`.

---

## Medium

### 3. popSong commits the song change, then can block ~17 min on DAM retries or drop the song

`src/main/api.ts:604` · Pre-existing

**What is wrong.** popSong shifts the queue, sets `currentSong` and records history first (api.ts:577-598). Only then does it await `Promise.all` of `getMusicStreamingUrls` and `getScoringData` (604-613). Both use promise-retry's defaults: 10 retries backing off from 1s to 512s, about 1023s in total. The `.catch(() => [])` on scoring data (609) only runs after every retry has failed, and `Promise.all` waits for it. If the streaming URLs finally reject, popSong returns a 500 after the song has already left the queue. Player.tsx then polls again and pops the next song.

**Failure scenario.** The head of the queue is a DAM song, and DAM's scoring or streaming-URL endpoint keeps failing for it (flaky DAM, expired session, a song with no scoring reference). The display stays blank for about 17 minutes while every phone shows that song as playing. If the streaming URLs fail too, the song appears in history but is never sung, and the next song starts. This happens even though a downloaded DAM song plays from `karafriends://local` without any streaming URL.

**Fix.** Don't let optional data block or fail the song change:

- Fetch scoring data with few or no retries and a short timeout, falling back to `[]`.
- Catch a streaming-URL failure and return `streamingUrls: []`, so the display can still use the local file.

Alternatively, do the DAM lookups before committing the queue change in `store.update`.

**Evidence.** In damApi.ts:100-115 and 118-140, both calls use promiseRetry with its defaults. getScoringData rejects every time DAM answers with non-binary data (129-133). Player.tsx:56-59 just polls again. The local-file path at Player.tsx:87 and 114-121 needs no streaming URL. At 5335f3e, graphql.ts:574-590 resolved streamingUrls and scoringData (with no catch at all) after the shift, so it blocked the same way.

### 4. pushAdhocLyrics lets any phone write any text to the shared lyrics, with no permission check and no limit

`src/main/api.ts:561` · Pre-existing, made worse

**What is wrong.** The handler appends the caller's free-text `lyric` (up to 1000 chars) to `state.currentSongAdhocLyrics`. It doesn't check identity, supervised mode, who the current singer is, or how many entries there are. The remote only offers this control to the singer of a playing YouTube song with lyrics (AdhocLyricsControls.tsx:44-46), but the server never enforces that. The whole array goes into every live-state event. `flush()` re-stringifies it up to 4 times a second and sends it to every phone, and over IPC to the display. The display (AdhocLyrics.tsx:25-63) re-renders and canvas-measures every entry on each change. Only popSong clears the array.

**Failure scenario.** During any song, a LAN script loops `POST /api/pushAdhocLyrics {"lyric":"<1000 chars>","lyricIndex":0}`, with no headers needed. After about 100k requests (under a minute on a LAN), the live state is about 100 MB. Each flush blocks the main process, and the app locks up. If the state reaches V8's maximum string length, `JSON.stringify` in flush (run from a setTimeout) throws a RangeError, which the fatal handler treats as a crash, and the app exits. Even in supervised mode, any guest can put arbitrary text on the TV during someone else's lyrics song.

**Fix.**

- Accept only `lyricIndex`, and look the line up on the server in `idToAdhocLyrics[currentSong.songId]`.
- Require that `currentSong` is a YouTube song with `hasAdhocLyrics`.
- Require that the caller owns the song or is an admin, as `requirePlaybackControl` does (ideally by device ID only, see #5).
- Reject indexes outside the stored lyrics, so the list can never grow past the song's line count.

**Evidence.** api.ts:561-566 has none of these checks. validate.ts:234-240 only caps the size of each entry (lyric ≤1000 chars, lyricIndex ≤100000). The only reset is in popSong (api.ts:579). live.ts:77 puts the array in every state, and flush stringifies and compares it (live.ts:191-200). Download progress triggers flushes 4 times a second (218-222). server.ts and httpServer.ts have no rate limiting, and index.ts:12-28 makes any uncaught exception fatal. At 5335f3e, graphql.ts:1080-1092 had no checks either, but the array is now sent with every state event. The verifier rated it medium rather than high: it needs a hostile LAN guest, and song names and nicknames are free text on the TV anyway.

### 5. Admin and ownership checks trust a nickname header, and every nickname is broadcast to phones

`src/main/api.ts:117` · New (incomplete new control)

**What is wrong.** `isAdmin` (api.ts:117-121) treats the caller as an admin if the `X-Karafriends-Nickname` header is in `adminNicks`. `owns` (125-128) matches on nickname alone. But every queue item, the current song, history and emotes send the singer's nickname, songId and timestamp to every phone. So hiding device IDs gives supervised mode no protection, because any phone can copy a nickname it sees. `whoami` (618-620) also lets a phone test any nickname for admin status.

**Failure scenario.** Supervised mode is on. Mallory reads guest A's nickname, songId and timestamp from `/api/events`, then sends `POST /api/removeSong` with `X-Karafriends-Nickname: <A>`. A's song is removed. By copying the current singer's nickname, she can also skip or pause the song.

If the host has queued or emoted under an adminNicks name, Mallory confirms that nickname with `whoami` and becomes an admin. She can then:

- jump the queue (tryHeadOfQueue),
- ignore paxSongQueueLimit,
- call popSong. That moves the next song into currentSong while the display is still playing the old one, so the popped song is never played. It also returns DAM streaming URLs fetched with the host's account.

**Fix.** In supervised mode, decide ownership by device ID only (the same rule as `isMine`), and grant admin only through `adminDeviceIds`. Drop `adminNicks`, or document that it is spoofable. Update the remote's `isOwnSong` to match.

**Evidence.** isAdmin and owns feed the supervised check in removeSong (533), requirePlaybackControl (133-144), tryHeadOfQueue (440), the hasMaxSongsInQueue bypass (168) and popSong (574). The nickname comes straight from the header (caller.ts:13-19). Nicknames are broadcast at live.ts:52-62, 71-74 and 139, and api.ts:417. caller.ts:3-4 admits that headers are unproven. But the plan deliberately hides device IDs and the admin list from phones, and the nickname path defeats that. Before this diff there was no server-side enforcement at all, so this is a weak new control, not a regression.

### 6. YouTube adhoc lyrics are stored before the download and never removed unless that song plays

`src/main/api.ts:501` · Pre-existing

Full title: phones can grow queue.json without limit and overwrite other guests' lyrics.

**What is wrong.** queueSong (youtube) writes `idToAdhocLyrics[songId]` (up to 100,000 chars) immediately, before the download runs. The entry is deleted only when popSong moves past that song. A failed download, a removeSong, or a song that never plays leaves it there for good. The map is saved to queue.json, and `save()` re-serializes the whole state on every `store.update`, including the popSong poll every 5s while idle. The key is the YouTube video ID, not the queue item, so a second queueSong for the same video replaces the first guest's lyrics.

**Failure scenario.** A phone keeps queueing `{kind:'youtube', songId:<random 11-char id>, adhocLyrics:<100k chars>, gainValue:1}`. Each download fails within seconds, which frees the paxSongQueueLimit slot, or the phone rotates device IDs. Each request adds about 100 KB to queue.json for good, so every state update gets slower and the file keeps growing across restarts. Separately, Mallory can queue Alice's video ID with her own lyrics, and her text replaces Alice's on the display.

**Fix.**

- Store the lyrics only in the `onReady` callback, once the item is actually queued.
- Key them by queue item (songId plus timestamp), or keep them on the queue item itself.
- Delete them in removeSong and when a download fails.
- Cap the total size of stored lyrics.

**Evidence.** api.ts:501-508 writes the entry before `deps.downloads.youtube` runs. The only delete is at api.ts:581-583; grep finds only lines 408, 506 and 582. serializeState keeps the map (state.ts:124-135), it is reloaded at 183-191, and save() re-stringifies everything at 79-80. Each request is capped at 100,000 chars (validate.ts:189). The per-device limit keys on a client-chosen device ID header (api.ts:156-172). The same code was at graphql.ts:1021-1025 at 5335f3e.

One more risk: serializeState (state.ts:80) runs outside save's try/catch. Once the state is too big for `JSON.stringify`, every `store.update` throws. That includes `pushSongToQueue` called from download `onReady` callbacks outside any request, which reaches the fatal handler (index.ts:12-28).

### 7. Remote re-renders its whole tree on every live-state flush, so DAM queue buttons stay disabled while any download runs

`src/remocon/components/DamQueueButtons/DamQueueButton.tsx:38` · New (regression)

**What is wrong.** The remote's root `App` now reads the full live-state context. `useQueueNotifications()` (App.tsx:27) calls `useQueue()`, which calls `useLiveState()` (useQueue.ts:28). So any live-state change re-renders App, the router and every page, and nothing is memoized. While a Joysound, YouTube or Niconico download runs, the hub flushes progress about every 250 ms, so every phone re-renders about 4 times a second.

DamQueueButton resets its label with an effect that has no dependency array. Every re-render clears its 2.5s timer and starts a new one, so the timer never fires, and the button stays `disabled={isPending || text !== defaultText}` (line 57). `useQueueNotifications` also calls `navigator.serviceWorker.register(...)` on every render (useQueueNotifications.ts:34).

**Failure scenario.** Guest A's YouTube or Joysound song is downloading for 30s or more. Guest B taps "Queue song" on a DAM song page. The button shows "Estimated wait: T-…" (or an error) and stays disabled until A's download finishes, plus 2.5s. B can't queue another vocal version or retry without leaving the page. All phones also re-render the whole remote 4 times a second for as long as the download runs.

**Fix.**

```tsx
useEffect(() => {
  if (text === defaultText) return;
  const t = setTimeout(() => setText(defaultText), 2500);
  return () => clearTimeout(t);
}, [text, defaultText]);
```

Also move `useQueueNotifications()` into a leaf component that renders null (e.g. `<QueueNotifications />` inside App), so flushes don't re-render the router tree. Register the service worker once, in an effect.

**Evidence.** The root is `<LiveStateProvider><App/></LiveStateProvider>` (remocon/index.tsx:18-20). The hook chain runs App.tsx:27 → useQueueNotifications.ts:31 → useQueue.ts:28 → apiClient.ts:300-301. `mergeLiveState` (apiClient.ts:154-169) keeps the old object only when nothing changed. `downloads[].progress` is in every phone's state (live.ts:78-93) and rises on every progress line (videoDownloader.ts:114-129). watchDownloads flushes every 250 ms (live.ts:218-239). Routes elements are new JSX on each render (App.tsx:37), and SongPage, DamQueueButtons and DamQueueButton are plain function components. The effect itself is unchanged from 5335f3e, but there App's useQueue only changed on Relay `queueChanged` events. Medium because the button recovers 2.5s after downloads stop, no data is lost, and leaving the page works around it.

### 8. 30s timeout now also cuts off the response body, so large Joysound getFME downloads abort and retry from scratch

`src/main/http.ts:51` · New (regression)

**What is wrong.** `httpFetch` passes `signal: AbortSignal.timeout(30000)` to node-fetch 3. node-fetch keeps the abort listener attached until the body finishes, so the 30s limit covers the whole download. The old Apollo fetcher cleared its timer as soon as the headers arrived. `JoysoundAPI.getSongRawData` (POST /player/getFME) returns the song's audio track as base64 Ogg inside JSON. That is several MB, and it now has to arrive within 30s.

**Failure scenario.** The host uses proxyEnable (an HTTP tunnel to Japan) or a slow link. A 4-5 minute song's getFME body is about 5-6 MB, which needs more than about 200 KB/s to arrive in time. Each attempt is aborted mid-body. promiseRetry (10 retries, backing off 1s→512s) starts the download over each time. After about 20 minutes, `downloadJoysoundData`'s catch drops it and the song is never queued. Before this diff the same request worked at any speed.

**Fix.** Make the timeout cover only the wait for headers: use an AbortController and call `clearTimeout` once `httpFetch` resolves. Or use an inactivity timeout on the body instead of a total deadline. At minimum, let callers pass a timeout and give getFME a much larger one.

**Evidence.** In `node_modules/node-fetch/src/index.js`, line 97 attaches the abort listener and lines 247-250 remove it only on response `end`. An abort mid-body destroys the stream, so `json()` rejects. At 5335f3e, graphql.ts:1355-1369 cleared the timer in a `finally` right after `await nodeFetch(...)`, and RESTDataSource read the body after that. getSongRawData (joysoundApi.ts:253-262) goes through post → http → parseBody → `resp.json()`, and its `ogg` field is used at videoDownloader.ts:918. In a scratch script with a 1s timeout, the headers arrived in 9 ms, then `json()` failed with AbortError at 1000 ms.

### 9. `yarn dev` can't rebuild main or preload on Windows because the running app locks the native .node

`electron.vite.config.ts:83` · New

**What is wrong.** src/main/index.ts:2 and src/preload/index.ts:2 import `native/index.node`. electron-vite emits it as `build/dev/{main,preload}/chunks/index-<hash>.node`, and the running Electron loads those copies. In watch mode, Vite empties outDir on every rebuild (`fs.rmSync`, no retries) and rewrites the .node file under the same name. electron-vite only kills Electron after the rebuild finishes. On Windows a loaded DLL can't be deleted (EPERM) or overwritten (EBUSY). macOS and Linux are not affected, but Windows is the main dev machine.

**Failure scenario.** On Windows, run `yarn dev`, then edit any main-process file (src/main, or src/common code that main imports) or src/preload/index.ts. The rebuild fails with `EPERM ... chunks`, and the app never restarts. Changes take effect only after stopping and rerunning `yarn dev`, even though the README says main and preload rebuild and restart automatically.

**Fix.** In serve mode, keep the native module out of build/dev. For example, add a small plugin or `rolldownOptions.external` for main and preload when `command === "serve"` that rewrites the import to `require(<absolute path to native/index.node>)`. Alternatively, set `build.emptyOutDir: false` for main and preload in dev and emit the .node under a name that changes on every build.

**Evidence.** electron-vite (lib-DoUt4oMD.js:718) emits `require(<asset>)`, and `build/dev/{main,preload}/chunks/index-CjbCEb98.node` both exist. emptyOutDir defaults to true because the outDir is inside the root. Vite's vite:prepare-out-dir (`vite/dist/node/chunks/node.js:34381-34394`) resets on watchChange and empties the directory again. emptyDir uses rmSync with no retries (line 2429). electron-vite restarts Electron only in closeBundle (lib-CLhLGLN3.js:26-31, 81-90). Until then, the old main process holds the main copy, and the display renderer holds the preload copy (index.ts:147, `sandbox:false`). In a scratch script, a child process loaded a copy of native/index.node, and the parent then got EPERM from rmSync and EBUSY from writeFileSync.

---

## Low

### 10. A phone that connects during the throttle window can be left showing a state that no longer exists

`src/main/live.ts:241` · New

**What is wrong.** `subscribe()` sends the new listener the current state (line 241), but doesn't update `lastSent` or flush the pending timer. `flush()` skips sending when the state equals `lastSent` (line 198). Take this sequence within one 250 ms window: the state goes A→B, a phone subscribes and gets B, then the state goes back to A. The pending flush sees A === lastSent and sends nothing, so the new phone stays on B.

**Failure scenario.** Someone taps pitch +1 then −1 (or pause then play) within 250 ms while another phone's EventSource reconnects (phone wake, network blip). The reconnected phone shows the wrong key or a paused state until the next change.

**Fix.** In `subscribe()`, flush any pending change before adding the listener (`if (flushTimer) flush();`), so the snapshot equals lastSent. Or reset `lastSent = null` whenever a newer snapshot goes out.

**Evidence.** live.ts:231-241 and 191-200. `publish()` at line 228 already flushes the pending change first, but `subscribe()` doesn't. The verifier reproduced it with the real `createLiveHub` and a fake store. PLAYING was flushed, then within the window came PAUSED, a new subscriber, and PLAYING again. The new subscriber only ever received `['PAUSED']`.

### 11. pushAdhocLyrics is unbounded and open to any phone, and every live-state event re-sends the whole list

`src/main/api.ts:561` · Pre-existing, made worse. This is the same handler as #4, seen from the performance side.

**What is wrong.** The handler checks neither identity, supervised mode, nor the current song. Each call appends up to 1000 chars, with no limit on the number of entries, until popSong. `toLiveState` puts the whole array into every state event (live.ts:77). Under the old GraphQL design it was only re-sent when lyrics were pushed. Now it goes out with every change, including the 4-per-second download-progress flushes, to every phone. It is also stringified on the main thread at least twice per flush.

**Failure scenario.** An untrusted guest scripts a few thousand calls, and each state event grows to megabytes. Every queue, playback or progress change then pushes it to every phone up to 4 times a second. That saturates the Wi-Fi, stalls the remotes and loads the main process until the next song starts.

**Fix.** The same as #4:

- Accept pushes only during a YouTube song with `hasAdhocLyrics`.
- Require the current singer or an admin, at least in supervised mode.
- Cap the entry count at the song's line count.
- Ignore duplicate `lyricIndex` values.

**Evidence.** The handler is at api.ts:561-566. validate.ts:234-240 limits only each entry (via `string()` at line 35). The array is persisted at state.ts:174 and sent by live.ts:77 and 213-222. At 5335f3e, graphql.ts:1080-1093 was just as open and did a saveDb on every push. Throttling caps the event rate.

### 12. Each nicoInfo request starts its own yt-dlp process, with no cache or concurrency cap and no identity needed

`src/common/videoDownloader.ts:1129` · New

**What is wrong.** This diff moved Niconico lookups from an in-process library to `yt-dlp --dump-single-json`. `getNicoVideoInfo` runs yt-dlp with execFile for every `POST /api/nicoInfo`; on Windows that is a PyInstaller one-file exe. Each run gets a 30s timeout and a 16 MB output buffer. The only input check is the ID's shape. Nothing caches results, limits how many run at once or limits requests per caller, and no identity is needed.

**Failure scenario.** A phone script fires a few hundred concurrent requests for `sm1`, `sm2` and so on. Each one starts a yt-dlp.exe that unpacks itself and starts Python. Together they use up CPU, RAM and temp disk on the karaoke PC, which stalls playback.

**Fix.** Cache results by videoId, and send concurrent requests for the same ID to one in-flight promise. Cap concurrent lookups at 1-2, queueing extra requests or answering them with 503.

**Evidence.** videoDownloader.ts:1122-1135. The handler at api.ts:395-405 ignores the caller, and the only check is `isNicoVideoId`. At 5335f3e the lookup ran in process (graphql.ts:377, 882). The verifier lowered it to low because queueSong for youtube and nico already spawns yt-dlp per distinct videoId (videoDownloader.ts:1023-1057). That is limited only by paxSongQueueLimit per device ID, and the device ID can be rotated. nicoInfo is a cheaper path to the same denial of service.

### 13. /api/events has no limit on connections and ignores write backpressure

`src/main/server.ts:73` · Pre-existing

**What is wrong.** Every `GET /api/events` adds a listener and a 20s heartbeat timer, with no limit per client or in total. `send` ignores `res.write`'s `false` return value. For a client that stops reading, Node keeps buffering in memory with no limit.

**Failure scenario.** A script opens thousands of `/api/events` connections and never reads from them (TCP zero window). It then drives state changes at 4 per second, e.g. pushAdhocLyrics, or setPitchShiftSemis when supervised mode is off. Every stalled socket buffers another full copy of the state, and memory grows until the app runs out.

**Fix.** Cap concurrent event streams, in total and per remote address. When `res.write` returns false (or `writableNeedDrain` is set), skip intermediate events and send only the latest state after `drain`. Or destroy connections that stay backed up past a threshold.

**Evidence.** server.ts:58-88, with `send` at 72-74. httpServer.ts sets no `maxConnections` or timeouts. Events can be made large and frequent (#4, download progress). The old graphql-ws transport buffered the same way.

### 14. The joysoundSong id goes unvalidated into a URL path sent with the host's Joysound session, and upstream errors are echoed back

`src/main/joysoundApi.ts:187` · Pre-existing

**What is wrong.** `validators.joysoundSong` accepts any string of up to 64 chars (validate.ts:110-112). `getSongDetail` fetches `${baseURL}/songdetail/${id}` with the host's Joysound cookies. URL parsing resolves `../` and allows `?query`, so the id can point at any path on www.sound-cafe.jp. On a non-2xx answer, `http()` (http.ts:59-66) puts the URL and the first 200 chars of the body in the error message. `errorAnswer` (dispatch.ts:50) returns that message to the phone. The search query and artist id are also joined unencoded into the form body (see #15).

**Failure scenario.** A phone sends `POST /api/joysoundSong {"id":"../mypage/whatever"}`. The main process fetches that sound-cafe.jp URL with the host's session cookies, and the phone gets back the first 200 chars of any 4xx or 5xx body.

**Fix.**

- Validate Joysound song and artist ids as digits only in validate.ts, and `encodeURIComponent` the path segment.
- Encode form values in `JoysoundAPI.post`.
- Make `errorAnswer` return a generic message for 500s to HTTP callers, and keep the details in the console log.

**Evidence.** node-fetch 3.3.2 parses URLs with WHATWG URL. The old RESTDataSource did ``this.get(`songdetail/${id}`)``, and Apollo surfaced error details too. The impact is limited. It only allows GETs on sound-cafe.jp, cookies are never echoed, and 2xx pages fail the invariant checks, so only error bodies leak. DAM URLs carry no credentials.

### 15. Form bodies are joined without percent-encoding, so phone search terms are split or mangled (and DAM passwords break)

`src/main/joysoundApi.ts:121` · Pre-existing

**What is wrong.** `JoysoundAPI.post` joins form fields as `${k}=${v}` with no encoding. The values include `keyword` (a phone's search query, up to 200 chars) and `artistId` (any string up to 64 chars). MinseiAPI.post and login (damApi.ts:60-65, 92) do the same. The DAM password from config.yaml is passed raw (services.ts:46), while the Joysound credentials are encoded (services.ts:54-57).

**Failure scenario.** A Joysound search for `C&K` or `Tom & Jerry` sends `keyword=C` plus a stray parameter. `+` turns into a space, and a lone `%` gives a malformed body. A guest can also add parameters (e.g. `x&count=…`) to a request that carries the host's session cookie and XSRF token. A DAM password containing `&`, `+`, `%` or `=` always fails to log in.

**Fix.** Run `encodeURIComponent` on each value when joining, in `JoysoundAPI.post`, `MinseiAPI.post` and `login`. Check Joysound artist and song IDs against a digits-only pattern.

**Evidence.** The joins are at joysoundApi.ts:120-122 and damApi.ts:60-65 and 92. The raw password is at services.ts:46, against the encoded Joysound credentials at 54-57. The phone's query reaches getSongListByKeyword and getArtistListByKeyword unencoded (api.ts:319-332). The phone's `id` (validate.ts:107) reaches getSongListByArtist and getSongDetail (joysoundApi.ts:187). The client doesn't encode either: `encodeURIComponent` appears only for identity headers in apiClient.ts. The code was identical at 5335f3e (old joysoundApi.ts:122-125, graphql.ts:1245).

### 16. YouTube caption codes with a region/script subtag are silently refused, but queueSong reports success

`src/common/videoDownloader.ts:1005` · Pre-existing

**What is wrong.** `captionCodeRe` is `/^[a-z]{2}$/` (line 26). The remote sends youtubei.js's `language_code` unchanged, and YouTube uses codes like `zh-Hant`, `zh-Hans`, `pt-BR`, `es-419` and `en-GB`. validate.ts:190 accepts up to 16 chars, and queueSong returns `{ ok: true, eta }` before the download starts. `downloadYoutubeVideoImpl` then just logs an error and returns, without calling `onComplete` or adding a download queue entry.

**Failure scenario.** A guest picks "Chinese (Traditional)" captions (`zh-Hant`) and taps queue. The phone gets ok/eta, but nothing is downloaded or queued, and the guest sees no error.

**Fix.** Accept BCP-47-style codes, e.g. `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`, which is still safe as a yt-dlp argument and in the `.vtt` file name. Check the code in validate.ts or queueSong, so a bad code returns a 400.

**Evidence.** The same regex was at line 21 at 5335f3e. api.ts:373 passes `language_code` through unchanged. queueSong is at api.ts:493-522, and the early return is at videoDownloader.ts:1005-1010.

### 17. Proxy stripping for yt-dlp deletes http_proxy from the main process instead of from the child's env

`src/common/videoDownloader.ts:1200` · Pre-existing

**What is wrong.** downloadNicoVideoImpl (1198-1200) and downloadJoysoundYoutubeVideoPromise (412-414) do `const env = { ...process.env }; delete process.env.http_proxy;`, then spawn yt-dlp with `env`. The copy is made before the delete, so yt-dlp still gets the proxy. Meanwhile the main process loses `http_proxy` for good, and `HTTP_PROXY` too, because Windows env keys are case-insensitive. Later child processes started without an explicit env inherit the stripped environment. That includes ffmpeg for DAM and Joysound, and the new `getNicoVideoInfo` call (1129).

**Failure scenario.** The user runs karafriends with `http_proxy` set. The first Nico download still goes through the proxy, despite the comment "Don't need a proxy". After it, ffmpeg and yt-dlp lookups no longer see the proxy, so their behaviour depends on whether such a download has already run in this session.

**Fix.** Delete the keys from the copy (`delete env.http_proxy; delete env.HTTP_PROXY`), and use the same helper for getNicoVideoInfo's execFile so lookups and downloads agree.

**Evidence.** videoDownloader.ts:412-414 and 1198-1200. The getNicoVideoInfo execFile (1129-1133) passes no env option. The same code was at 427-429 and 1205-1207 at 5335f3e. It only matters when `http_proxy` is set in the environment; config.yaml's proxy uses a tunnel, not env vars.

### 18. The phone remote's production CSS targets Electron's Chromium, which strips the `-webkit-user-select` prefix iOS needs

`electron.vite.config.ts:113` · New

**What is wrong.** The remote (src/remocon) is built in electron-vite's renderer environment, whose `target` and `cssTarget` are Electron 43's Chromium (chrome146). The config doesn't override this, even though the page is served to phones. The production minifier (lightningcss) removes vendor prefixes that chrome146 doesn't need. The source has both `user-select: none` and `-webkit-user-select: none` in AdhocLyricsControls.module.scss:28-29 (`.lyricsPicker`) and EmoteButtons.module.scss:14-15 (`.emoteItem`). The built remocon CSS keeps only the unprefixed one, and iOS Safari only honours the `-webkit-` form.

Parcel kept the prefix. Dev builds are unminified, so they look fine. The e2e tests drive the remote only in Chromium (Pixel 7), so they can't catch this.

**Failure scenario.** On an iPhone with a production build, a long press or drag on the lyrics picker, or quick repeated taps on the emote buttons, selects text and brings up the iOS selection callout or magnifier.

**Fix.** Give the renderer build phone targets, e.g. `cssTarget: ["chrome111", "safari15", "ios15"]`, and widen `target` the same way. Optionally, add a check of the built remocon CSS for prefixed properties.

**Evidence.** electron.vite.config.ts:113-125 sets no `target` or `cssTarget`, so the preset's `getElectronChromeTarget` (lib-DoUt4oMD.js ~575-596) applies. `build/prod/web/assets/remocon-BIk_-hiw.css` (built today) has only `user-select:none` for `._emoteItem` and `._lyricsPicker`. The effect is cosmetic.

### 19. The plan gives the wrong names for the macOS signing secrets that release.yaml reads

`notes/PLAN-hard-fork.md:117` · New (docs)

**What is wrong.** The pending user follow-up (status table at line 17, details at line 117) says to re-add `MACOS_SIGNING_CERT_BASE` and `MACOS_NOTARIZATION_API_KEY_BASE`. release.yaml reads `MACOS_SIGNING_CERT_BASE64` and `MACOS_NOTARIZATION_API_KEY_BASE64` (lines 22-23 and 65-66).

**Failure scenario.** You add the secrets under the plan's names. The workflow sees empty values and decodes empty files, so `security import` and notarization fail, and both mac release jobs fail.

**Fix.** Change line 117 to use the `_BASE64` names. Do this together with #2.

**Evidence.** notes/PLAN-hard-fork.md:117 against release.yaml:22-23 and 65-66. This is a docs bug only.

---

## Uncertain

None. The verifiers confirmed every finding they kept.

## Refuted

None. The verifiers refuted no findings in this run.
