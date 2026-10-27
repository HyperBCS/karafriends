# karafriends runtime stack review

Scope: the runtime/app layer: API, Relay, Express, Sentry/OTel, UI libraries, utilities and heavy assets. Build tooling (Parcel, Yarn PnP, Babel, tslint, wdio, packaging) is covered separately in `notes/stack-review-build.md`.

Method: read-only. Dependency counts and sizes come from walking `yarn.lock` from each root dependency and keeping only the packages nothing else needs (what removing that root would actually drop), then summing their `.yarn/cache` zip sizes. Bundle shares come from the source maps of the existing `build/dev` output, which is unminified and built with `--no-optimize`. Prod bundles are smaller and tree-shaken, so treat those shares as indicative. Nothing was built, installed or edited.

## TL;DR

- **GraphQL plus Relay is the main source of complexity, and almost none of what makes them worth it is used.** The schema has 35 operations; the app needs a shared state object, about 12 lookups and 7 commands. Relay is used only for Suspense queries and a "More" button. All 7 fragments are pagination fragments defined and consumed in the same file. No updaters, no optimistic updates, no fragment composition. Live state bypasses the Relay store entirely: hooks copy it into `useState`.
- **Recommended target:** plain JSON RPC (`POST /api/<method>`) plus one Server-Sent Events stream that pushes a single "live state" snapshot (queue, now playing, playback, pitch, adhoc lyrics, download progress). Shared TypeScript types replace the schema and codegen. TanStack Query, or tiny hooks, replace Relay. Optionally, the display window uses Electron IPC instead of localhost HTTP.
- **Quick wins that don't touch the architecture:**
  - Remove Sentry. Its DSN is hard-coded to _upstream's_ Sentry project, and its default breadcrumbs capture console logs that contain DAM auth tokens and Joysound session cookies.
  - Replace the `niconico` package. It drags in 286 packages, including jsdom, jest 26 and axios 0.19, for one metadata scrape.
  - Make Innertube lazy. Today every GraphQL request waits on YouTube init.
  - Drop 12 unused packages, including a stub `@types/hls.js` that pulls in a second 5.6 MB copy of hls.js.
- **Payoff of the full plan:** about 450 fewer lockfile packages (of 1,835) and about 98 MB less `.yarn/cache` (of 463 MB); about 104 MB if the build review then drops Babel. Roughly 75% of the dev main-process bundle goes, and about 1,300 hand-written plus 8,774 generated lines.
- **Upstream cost:** the files a rewrite touches are quiet upstream (`schema.graphql`, `graphqlEnvironment.ts` and `src/remocon/` have had 0 commits in 12 months). Upstream churn is mostly dependabot (145 of 163 `package.json` commits). Steps 1–5 below are upstreamable; steps 6–9 are a deliberate fork of the API layer.

---

## 1. Current architecture

### 1.1 Shape

```
 phones (remocon, React)                 Electron main process                         display window (renderer, React)
 http://<LAN IP>:8080 or CF tunnel       ───────────────────────────────────           file:// in prod, :3000 in dev
 ┌──────────────────────────┐            Express :8080  (graphql.ts:1281-1407)         ┌──────────────────────────────┐
 │ Relay env                │  POST      ├─ compression()                              │ same Relay env               │
 │ graphqlEnvironment.ts    │ ─/graphql─>├─ /graphql  Apollo Server 5 + graphql-tools  │ (graphqlEnvironment.ts)      │
 │  fetch + graphql-ws      │  WS        │     context: new MinseiAPI/JoysoundAPI/      │  → http://localhost:8080 ←── │ over HTTP/WS to itself
 └──────────────────────────┘ <─/graphql─│     DkwebsysAPI per request + Innertube     │  CORS stripped by           │
                                         ├─ WS /graphql  graphql-ws useServer          │  webRequest hooks           │
                                         │     (no context; PubSub fan-out)             │  (index.ts:111-139)          │
                                         ├─ Service-Worker-Allowed header              │ preload: config (sync IPC),  │
                                         └─ static remocon (prod) / proxy to :3000     │ native audio, IP addresses   │
                                         karafriends:// file protocol (index.ts:150)   └──────────────────────────────┘
                                         in-memory "NotARealDb" + queue.json (graphql.ts:281-373)
                                         mDNS karafriends.local (mdns.ts)
                                         DAM/Joysound via @apollo/datasource-rest + node-fetch + tunnel
                                         YouTube via youtubei.js, Niconico via `niconico`, downloads via yt-dlp/ffmpeg
```

**Renderer ↔ main goes over localhost HTTP/WS, even though both run inside the same Electron app.** The preload (`src/preload/index.ts:18-55`) exposes only `ipAddresses`, `karafriendsConfig()` (a synchronous IPC call, used for the port number) and the native audio module. Every queue, playback or pitch interaction from the display goes through `http://localhost:${remoconPort}/graphql` (`src/common/graphqlEnvironment.ts:14-46`). This creates two pieces of plumbing:

- a CORS workaround that strips `Origin` and rewrites `Access-Control-Allow-Origin` for `localhost:8080` (`src/main/index.ts:111-139`, marked TODO);
- a dev-only CORS middleware (`src/main/graphql.ts:1325-1335`).

It also means the display stops working if port 8080 is taken. `EADDRINUSE` quits the whole app (`graphql.ts:1292-1304`).

### 1.2 API surface and who uses it

Schema: `src/common/schema.graphql`, 402 lines. **18 queries, 10 mutations, 7 subscriptions.**

| Need                     | GraphQL operations today                                                                            | Used by                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared queue             | `queue`, `currentSong` + sub `queueChanged`                                                         | `common/hooks/useQueue.ts` → remocon `SongQueue`, renderer `Queue`                                           |
| Now playing              | `currentSong` + sub `currentSongChanged`                                                            | `remocon/hooks/useNowPlaying.ts` → ControlBar/NowPlaying, PlaybackControls, AdhocLyricsControls, YouTubePage |
| Playback control         | `playbackState`, `setPlaybackState` + sub `playbackStateChanged`                                    | `common/hooks/usePlaybackState.ts` → remocon PlaybackControls, renderer Player                               |
| Pitch                    | `pitchShiftSemis`, `setPitchShiftSemis` + sub `pitchShiftSemisChanged`                              | `common/hooks/usePitchShiftSemis.ts` → remocon PitchControls, renderer Player                                |
| Adhoc lyrics             | `adhocLyrics(id)`, `pushAdhocLyrics` + sub `currentSongAdhocLyricsChanged`                          | remocon AdhocLyricsControls; renderer AdhocLyrics                                                            |
| Emotes                   | `sendEmote` + sub `emote`                                                                           | remocon EmoteButtons (sends every 200 ms while held); renderer Effects                                       |
| "Song added" toast       | sub `queueAdded`                                                                                    | renderer App (`M.toast`)                                                                                     |
| Queue a song             | `queueDamSong`, `queueJoysoundSong`, `queueYoutubeSong`, `queueNicoSong`                            | 4 queue-button components                                                                                    |
| Download progress        | `videoDownloadProgress` **polled every 1 s** by `setInterval`                                       | Joysound/YouTube/Niconico queue buttons, about 44 lines copy-pasted ×3                                       |
| Remove from queue        | `removeSong`                                                                                        | remocon SongQueueItem                                                                                        |
| Next song                | `popSong`, **polled every 5 s** when idle                                                           | renderer Player (`Player.tsx:65,98-133`)                                                                     |
| DAM search / detail      | `songsByName`, `artistsByName`, `artistById{songs}`, `songById`                                     | SongSearchResults, ArtistSearchResults, Artist, SongPage                                                     |
| Joysound search / detail | `joysoundSongsByKeyword`, `joysoundArtistsByKeyword`, `joysoundSongsByArtist`, `joysoundSongDetail` | 3 result components + JoysoundSongPage                                                                       |
| YouTube / Nico metadata  | `youtubeVideoInfo`, `nicoVideoInfo`                                                                 | YouTubeInfo, JoysoundYouTubeInfo, NiconicoInfo                                                               |
| History                  | `songHistory` (connection)                                                                          | SongHistory                                                                                                  |
| Config (3 fields)        | `config`                                                                                            | `remocon/hooks/useConfig.ts` → PlaybackControls, SongQueueItem                                               |

Observations:

- **The "subscription" pattern is reimplemented four times.** `useQueue`, `useNowPlaying`, `usePlaybackState` and `usePitchShiftSemis` each do an initial `fetchQuery`, then a `requestSubscription`, then a refetch on `visibilitychange` to catch up after a phone sleeps. That is 457 lines for what is conceptually one "give me the current state and keep it fresh" hook.
- **The WebSocket exists, yet download progress is polled at 1 Hz per button, and the display polls `popSong` every 5 s.**
- **The four `queueXSong` mutations are near-identical** (`graphql.ts:920-1074`). The schema comment at `schema.graphql:39-40` says they're split only because GraphQL has no input unions.
- **`Song.streamingUrls` and `Song.scoringData` resolvers (`graphql.ts:516-529`) are never selected by any client.** Only the `DamQueueItem` versions are, via `popSong`.

### 1.3 Lines of code by layer

| Layer                                                         | Files                                                                   | Lines                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                                                        | `src/common/schema.graphql`                                             | 402                                                                                                                                                                                                                                                           |
| Resolvers + state + server setup                              | `src/main/graphql.ts`                                                   | 1,407. About 245 lines of TS types duplicating the schema (47-290), about 90 lines of state and persistence (281-373), 730 lines of resolvers (475-1204) of which about 200 are Connection/edge/pageInfo glue, about 200 of Apollo/WS/proxy setup (1206-1407) |
| Upstream HTTP clients                                         | `src/main/damApi.ts`, `src/main/joysoundApi.ts`                         | 413 + 359                                                                                                                                                                                                                                                     |
| Client network layer                                          | `src/common/graphqlEnvironment.ts`                                      | 74                                                                                                                                                                                                                                                            |
| Live-state hooks                                              | `common/hooks/*` (326) + `remocon/hooks/useConfig, useNowPlaying` (172) | 498                                                                                                                                                                                                                                                           |
| GraphQL documents in components                               | 31 files use Relay                                                      | about 740 lines inside `graphql` tags (31 files, 3,286 lines total)                                                                                                                                                                                           |
| Relay generated (gitignored, built by `relay-compiler`)       | 52 `__generated__/*.graphql.ts`                                         | 8,774 (340 KB)                                                                                                                                                                                                                                                |
| For scale: all remocon source / renderer source / main source |                                                                         | 3,607 / 3,209 / 2,541                                                                                                                                                                                                                                         |

### 1.4 Relay usage profile

| Relay feature                                                                  | Used?              | Evidence                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useLazyLoadQuery` + Suspense                                                  | Yes, 13 components | wrapped by `withLoader`                                                                                                                                                   |
| `usePaginationFragment` (`@connection`/`@refetchable`)                         | Yes, 7 lists       | every one is a "More" button calling `loadNext(30)`                                                                                                                       |
| Fragment composition / data masking across components                          | **No**             | all 7 fragments are on `Query`, defined and consumed in the same file as their one query                                                                                  |
| Normalized store updates (`updater`, `ConnectionHandler`, `commitLocalUpdate`) | **No**             | 0 occurrences                                                                                                                                                             |
| Optimistic updates                                                             | **No**             | 0 occurrences                                                                                                                                                             |
| Store as source of live state                                                  | **No**             | queue, now playing, playback and pitch are copied from `fetchQuery`/`requestSubscription` into `useState` (12 `fetchQuery`, 5 `requestSubscription`, 1 `useSubscription`) |
| Cursor pagination                                                              | **Not really**     | cursors are stringified offsets (`graphql.ts:563-570, 705-712`); `hasPreviousPage: false` everywhere                                                                      |
| Fetch policies                                                                 | One                | `store-and-network` on History                                                                                                                                            |

What Relay actually buys today: Suspense data loading, back-navigation caching (store-or-network), and generated TS types. TanStack Query or shared hand-written types cover all three without a compiler, a Babel plugin or codegen.

### 1.5 Server state, Express, middleware

- State lives in a module-global `db` ("NotARealDb", `graphql.ts:281-312`). It is persisted to `queue.json` by `saveDb()`, which is called by hand from each mutation (TODO at `graphql.ts:316`). Fan-out goes through `graphql-subscriptions` `PubSub`, with 7 event types.
- The Express pipeline (`index.ts:161-170`) is small: `compression()`, `/graphql` (`express.json` + Apollo), the WebSocket server on the same HTTP server, `Service-Worker-Allowed: /`, then static remocon (prod) or a dev reverse proxy to Parcel :3000 (`middleware/remoconReverseProxy.ts`). Express itself is justified; nothing here is over-engineered except what GraphQL adds.
- **The Apollo context awaits `innertubeApiProvider()` for every request** (`graphql.ts:1371-1372`). If `Innertube.create()` hangs or rejects (YouTube unreachable), _every_ request fails or stalls up to 30 s: queue, playback, DAM search. That is a coupling bug, not just bloat.
- The data sources are built per request with `cache: server.cache` (`graphql.ts:1376-1389`). The cache does nothing: every DAM/Joysound call is a POST except the Joysound song-detail HTML GET.
- **`DataLoader` (`damApi.ts:276-412`) is effectively a no-op.** The loaders live on a per-request `DkwebsysAPI` instance, and no request loads the same key twice.
- **Proxy handling is inconsistent.** Data-source requests go through `node-fetch` with a `tunnel` agent (`graphql.ts:1337-1362`), but `MinseiAPI.login` and `JoysoundAPI.login` use global `fetch` (`damApi.ts:101-116`, `joysoundApi.ts:267-358`) and bypass the proxy. With `proxyEnable`, logins go out on the direct route.

### 1.6 Sentry and OpenTelemetry

- `Sentry.init({ dsn: "https://80cbda8c…@sentry.io/6728669", debug: true })` appears in all three entry points: `src/main/index.ts:9-12`, `src/remocon/index.tsx:10-13`, `src/renderer/index.tsx:118-121`. Plus `captureException` in `index.ts:16` and `renderer/ErrorBoundary.tsx:25`.
- **The DSN is set, and it belongs to upstream's project.** It was added upstream in 2023 (`16207f1a`, `bc81e44a`). Crashes from this fork, and errors from party guests' phones, report to the upstream maintainer's Sentry.
- **Possible credential leak.** In `@sentry/node-core` 10.70, `getDefaultIntegrations()` includes `consoleIntegration`, `httpIntegration` and `nativeNodeFetchIntegration`, so console output and outgoing request URLs become breadcrumbs attached to events. The app logs:
  - DAM `userCode` plus a live `authToken` on every Minsei call (`damApi.ts:72-74`, via `post(url, { requestNo, ...creds })`);
  - Joysound session cookies plus the XSRF token on every Joysound call (`joysoundApi.ts:130-136`).

  So any reported crash can carry live session tokens to a third-party project.

- **OpenTelemetry is not used by the app at all.** `@opentelemetry/api`, `core` and `sdk-trace-base` were added only as peers that Sentry 10.67 needs under PnP (commit `8bd7a64f`: "Add the required peers as direct dependencies so the main-process build resolves"). There are 0 imports in `src/`.
- Cost: 38 packages and 14.1 MB of cache. In the dev bundles: about 4.5 MB of main (22%), 2.0 MB of remocon (12.6%) and 2.0 MB of renderer (25%) unminified source. `@sentry/conventions` alone is 1.08 MB per bundle.
- `handleError` (`index.ts:14-22`) exits the app on _any_ unhandled rejection. That behavior is independent of Sentry; keep it or soften it consciously.

### 1.7 UI libraries, utilities, assets

| Package                                                                                                                                   | Usage                                                                                                                                                                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `materialize-css` 1.0.0 (2018, unmaintained)                                                                                              | renderer only: `M.toast` ×2 (`App.tsx:92`, `Player.tsx:141`), `M.AutoInit` ×2 for selects (`HostnameSetting.tsx:30`, `MicrophoneSetting.tsx:26`), grid/`btn`/`collection` classes, full CSS import (`App.tsx:2`) | replace with about 50 lines of CSS and a 30-line toast                                                                                                                                                                                                                                                                                                                                          |
| `react-icons` 5.7.0                                                                                                                       | 21 icons from 6 sets in 9 remocon files                                                                                                                                                                          | 22.1 MB of cache. In the dev build it is 11.2 MB, 70% of the remocon bundle (no tree-shaking under `--no-optimize`). Inline the 21 SVGs                                                                                                                                                                                                                                                         |
| `react-fade-in` 2.0.1                                                                                                                     | 1 use (`renderer/AdhocLyrics.tsx`); peer `react ^16.8 \|\| 17`                                                                                                                                                   | CSS `@keyframes`                                                                                                                                                                                                                                                                                                                                                                                |
| `react-mobile-picker-scroll` 0.2.14                                                                                                       | 1 use (`AdhocLyricsControls/LyricsPicker.tsx`); peer `react <17`, uses `componentWillReceiveProps`                                                                                                               | CSS scroll-snap list, or `<select size>`                                                                                                                                                                                                                                                                                                                                                        |
| `react-swipeable`                                                                                                                         | **unused**                                                                                                                                                                                                       | remove                                                                                                                                                                                                                                                                                                                                                                                          |
| `react-router` 8                                                                                                                          | `HashRouter`, 13 routes, 26 files                                                                                                                                                                                | keep: conventional and light (0.38 MB source)                                                                                                                                                                                                                                                                                                                                                   |
| `classnames`, `format-duration`                                                                                                           | 4 files each                                                                                                                                                                                                     | keep (tiny)                                                                                                                                                                                                                                                                                                                                                                                     |
| `uuid`                                                                                                                                    | 1 use (`useUserIdentity.ts`)                                                                                                                                                                                     | keep. `crypto.randomUUID()` needs a secure context, and phones usually load the remocon over plain `http://<LAN IP>`                                                                                                                                                                                                                                                                            |
| `lodash`                                                                                                                                  | 1 call: `memoize` in `preload/index.ts:8,32`                                                                                                                                                                     | replace with a 5-line memo (lodash stays in the lockfile via other packages)                                                                                                                                                                                                                                                                                                                    |
| `ts-invariant`, `promise-retry`                                                                                                           | 14 and 4 files                                                                                                                                                                                                   | keep (tiny)                                                                                                                                                                                                                                                                                                                                                                                     |
| `kuroshiro` + `kuroshiro-analyzer-kuromoji` + `kuromoji`                                                                                  | romaji/furigana for Joysound lyrics (`joysoundParser.ts`)                                                                                                                                                        | keep. Could become kuromoji + `wanakana` (already a dependency), but romanization could shift subtly; low value                                                                                                                                                                                                                                                                                 |
| `static/dict/` (17 MB)                                                                                                                    | kuromoji dictionary loaded by the renderer (`renderer/index.tsx:124`)                                                                                                                                            | **justified, not a duplicate.** Its decompressed contents differ from the `kuromoji` package's own dict; it was swapped in deliberately (`c3500b39`, `3211f8fb`, 2023-06, "fill in missing romaji"). The package's bundled dict (20.8 MB zip) is the dead weight, and it is unavoidable while depending on `kuromoji`                                                                           |
| `src/renderer/fonts/` (6.0 MB JP + 7.1 MB KR OTF)                                                                                         | canvas lyrics renderer (`JoysoundRenderer.tsx:115-126`, `fontCode 1` = Korean)                                                                                                                                   | justified. Options: WOFF2 conversion; lazy-load KR since it's only for Korean songs. Low priority                                                                                                                                                                                                                                                                                               |
| `youtubei.js` (patched)                                                                                                                   | only `getBasicInfo` (`graphql.ts:825-870`) for title, captions and loudness                                                                                                                                      | keep (`yt-dlp -J` lacks the loudness value used for `gainValue`), but make init lazy                                                                                                                                                                                                                                                                                                            |
| `hls.js`                                                                                                                                  | DAM HLS streaming fallback (`Player.tsx`)                                                                                                                                                                        | keep, but note there are **two copies** in cache (1.7.1 and 1.6.13, 13.3 MB). 1.6.13 exists only because `@types/hls.js@1.0.0` is a deprecated stub depending on `hls.js@*`                                                                                                                                                                                                                     |
| `niconico` 1.2.0                                                                                                                          | `nicovideo.watch()` for one metadata lookup (`graphql.ts:871-894`)                                                                                                                                               | **replace.** It declares `jest`, `jsdom` and `axios@^0.19` as _runtime_ dependencies: 286 packages, 7.2 MB of cache, 4.6 MB (22%) of the dev main bundle, because Parcel bundles node_modules into main. axios 0.19 has published CVEs (e.g. CVE-2020-28168, CVE-2021-3749). It scrapes `#js-initial-watch-data[data-api-data]`, the pre-2024 watch page; **unverified whether it still works** |
| `node-fetch` + `tunnel`                                                                                                                   | upstream proxy support                                                                                                                                                                                           | keep for now (4 packages, under 0.1 MB); use them for logins too                                                                                                                                                                                                                                                                                                                                |
| `qrcode`, `youtube-player`, `fft.js`, `cubic-spline`, `gl-vec2`, `polyline-normals`, `color-convert`, `wanakana`, `multicast-dns`, `yaml` | renderer and main features                                                                                                                                                                                       | justified                                                                                                                                                                                                                                                                                                                                                                                       |

### 1.8 Bundle composition (dev build, unminified source attributed via source maps)

| Bundle                   | Total source | Biggest contributors                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main (`build/dev/main_`) | 20.4 MB      | GraphQL server stack about 6.2 MB (30%; includes Apollo's usage-reporting protobuf at 1.76 MB, bundled even though usage reporting is disabled, and graphql's TS sources at 1.35 MB) · niconico/jsdom/axios 4.6 MB (22%) · Sentry/OTel 4.5 MB (22%) · youtubei.js 1.6 MB · express 1.4 MB · **app code 0.24 MB** |
| remocon                  | 16.0 MB      | react-icons 11.2 MB (70%) · Sentry 2.0 MB · React 1.1 MB · Relay 0.76 MB · react-router 0.38 MB · app 0.32 MB                                                                                                                                                                                                    |
| renderer                 | 8.1 MB       | hls.js 3.0 MB · Sentry 2.0 MB (25%) · React 1.1 MB · Relay 0.76 MB (9%) · materialize 0.35 MB · kuroshiro/kuromoji 0.33 MB · app 0.23 MB                                                                                                                                                                         |

In the main bundle, the app's own code is about 1% and three replaceable stacks are about 75%.

---

## 2. Over-engineered vs justified

| Area                                                                          | Verdict                      | Why                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GraphQL server (Apollo 5, graphql-tools, as-integrations, PubSub, graphql-ws) | **Over-engineered**          | One trusted-ish LAN client type, about 20 real operations, no third-party consumers, no field-level cost concerns. The schema mostly mirrors handwritten TS types (duplicated in `graphql.ts:47-290`). Connections and unions add glue (about 200 lines) and a schema/codegen/compile step |
| Relay (runtime + compiler + Babel plugin)                                     | **Over-engineered**          | Only Suspense and "More" pagination are used (§1.4). It forces `relay-compiler` (40 MB of platform binaries in cache), `babel-plugin-relay` and therefore Babel in the Parcel pipeline, plus 52 generated files                                                                            |
| WebSocket subscriptions (7 streams)                                           | **Over-engineered in shape** | Live updates are justified, but 7 separate streams plus "initial query + subscribe + refetch on wake" ×4 is the complicated way to sync one small state object                                                                                                                             |
| `@apollo/datasource-rest` + `dataloader` + `server.cache`                     | **Over-engineered**          | POST-only APIs (nothing to cache), per-request loaders (nothing to batch); only a timeout, a proxy and error-on-non-2xx are needed                                                                                                                                                         |
| Sentry + OpenTelemetry                                                        | **Remove**                   | Reports to someone else's project, leaks tokens through breadcrumbs, and costs 14 MB of cache plus a quarter of the renderer bundle                                                                                                                                                        |
| `niconico`                                                                    | **Remove**                   | 286 packages for one scrape that yt-dlp (already shipped) can do                                                                                                                                                                                                                           |
| Express, compression, mDNS, karafriends:// protocol, queue.json persistence   | Justified                    | small and purposeful                                                                                                                                                                                                                                                                       |
| youtubei.js, hls.js, kuromoji/kuroshiro + custom dict, fonts, native audio    | Justified                    | they are the product                                                                                                                                                                                                                                                                       |
| materialize-css, react-icons, react-fade-in, react-mobile-picker-scroll       | Mildly over-weight           | each is used for a handful of things; cheap to replace                                                                                                                                                                                                                                     |
| react-router, classnames, uuid, format-duration, ts-invariant, promise-retry  | Fine                         | tiny, conventional                                                                                                                                                                                                                                                                         |

---

## 3. Alternatives and trade-offs

### 3.1 Live updates: GraphQL subscriptions vs raw WebSocket vs SSE

|                                           | graphql-ws (today)                                                                 | Raw WebSocket (`ws`) | **SSE (`text/event-stream`)**                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server dependencies                       | graphql-ws, ws, graphql-subscriptions, graphql (+ bufferutil/utf-8-validate peers) | ws (+ peers)         | none (Express `res.write`)                                                                                                                                       |
| Client dependencies                       | graphql-ws + Relay                                                                 | none                 | none (`EventSource`)                                                                                                                                             |
| Reconnect                                 | `shouldRetry: () => true`                                                          | hand-written         | built in; server sends the snapshot on reconnect, so the visibility-refetch logic goes away                                                                      |
| Phone → server direction                  | —                                                                                  | possible             | not needed: commands go over POST                                                                                                                                |
| Through Cloudflare Tunnel (`tunnel.yaml`) | yes                                                                                | yes                  | yes; send a heartbeat comment every ~20 s                                                                                                                        |
| Gotchas                                   | —                                                                                  | —                    | `compression()` buffers the stream, so exclude `/api/events` or call `res.flush()`; browsers cap at 6 HTTP/1.1 connections per origin (fine: one stream per tab) |

**Pick SSE.** Every live need here (queue, now playing, playback, pitch, adhoc lyrics, download progress, emote, song-added toast) is server → client. Client → server is just POSTs.

### 3.2 Request/response: GraphQL vs REST vs JSON-RPC vs tRPC

- **REST (resource URLs + verbs):** familiar, but karafriends' operations are verbs ("queue this", "pop next", "set pitch"), so it would invent resources for little gain.
- **JSON-RPC style, `POST /api/<method>` with a JSON body (recommended):** one 40-line router, one 25-line client, and a shared `Api` TypeScript interface in `src/common/api.ts` imported by main, remocon and renderer. All three are compiled from one repo, so types are end-to-end without codegen. The same handler map can be served over Electron IPC (§3.3) for free.
- **tRPC v11:** the batteries-included version of the above. End-to-end inference, Express adapter, SSE subscriptions (`httpSubscriptionLink`), TanStack Query integration. Costs: 3–4 packages (usually plus `zod`), its own link/adapter concepts, and IPC needs a community adapter (`electron-trpc`) that may lag Electron releases. **A good second choice** if you'd rather not own the router and client (about 100 lines).
- **What GraphQL gave for free that you must keep:**
  1. **Input validation.** Phones are untrusted. Add small runtime checks per command (about 8 inputs), or `zod` if you prefer.
  2. **Field allow-listing on `config`.** The resolver spreads the whole config, _including DAM/Joysound passwords_, and only the schema's 3 fields keep them out of the response (`graphql.ts:797-802`). Return an explicit object.
  3. **CSRF protection.** Apollo 4+ rejects non-JSON "simple" requests by default. Require `Content-Type: application/json` on `POST /api/*` and send no CORS headers, so a random web page can't drive the queue.

### 3.3 Renderer ↔ main: localhost HTTP vs Electron IPC

|                              | localhost HTTP/WS (today)                           | **IPC via contextBridge**                                                             |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Code paths                   | one (same as phones)                                | two transports, but both dispatch into the same handler map (about 30 lines)          |
| CORS hacks                   | needed (`index.ts:111-139`, `graphql.ts:1325-1335`) | gone (the ipcasting.jp CORS rule stays)                                               |
| Port conflict                | display dies with the app                           | display keeps working; only phones are affected, so `EADDRINUSE` can become a warning |
| Config sync IPC for the port | needed                                              | not needed                                                                            |
| Effort                       | —                                                   | S–M once the API is transport-agnostic                                                |

Worth doing, but **after** the API migration. Doing it while GraphQL is still there means writing a Relay `Network` over IPC, which is wasted work.

### 3.4 Client data layer: Relay vs TanStack Query vs hand-rolled hooks

- **TanStack Query v5 (recommended):** `useSuspenseQuery` keeps the existing `withLoader`/Suspense structure; `useSuspenseInfiniteQuery` maps 1:1 onto `usePaginationFragment`'s `loadNext/hasNext/isLoadingNext`; `useMutation` maps onto Relay's. Back-navigation caching comes via `staleTime`. About 2 packages, no compiler, no Babel, no generated files.
- **Hand-rolled:** `useApi(method, input)` with a Map cache and Suspense (about 60 lines) plus `usePaged` (about 30 lines). Zero dependencies, but you own cache and Suspense edge cases. Reasonable if you want the absolute minimum.
- **Live state never needs a query library.** One `LiveStateProvider` holding the SSE snapshot replaces `useQueue`, `useNowPlaying`, `usePlaybackState`, `usePitchShiftSemis` and `useConfig` (498 lines) with about 60 lines.

### 3.5 Upstream HTTP clients: `@apollo/datasource-rest` vs a thin helper

A `src/main/http.ts` helper of about 40 lines covers everything used today: timeout (`AbortSignal.timeout`), proxy agent, form or JSON body, parsing by content type (JSON / `application/octet-stream` → ArrayBuffer / text), and throwing on non-2xx. What datasource-rest offers beyond that (GET dedup, HTTP-cache semantics, request hooks) is unused here. Keep the class and method names in `damApi.ts`/`joysoundApi.ts` so upstream patches to method bodies still apply.

Caveat: keep the existing manual `k=v&…` body join (`damApi.ts:66-71`, `joysoundApi.ts:124-126`) rather than switching to `URLSearchParams`. The latter would percent-encode values like the DAM `compAuthKey` `2/Qb9R@8s*` differently. Route both logins through the helper so they honor the proxy.

Proxy options: (a) keep `node-fetch` + `tunnel` (tiny); (b) Electron `net.fetch`, which already follows `session.setProxy` and the `app.on('login')` handler (`index.ts:141-148, 253-272`). (b) would delete both packages, but verify first that it exposes `Set-Cookie`, which Joysound login depends on (`joysoundApi.ts:65-70`).

### 3.6 Telemetry

(a) **Remove** (recommended): write uncaught errors to `app.getPath("logs")` and keep the existing exit/dialog behavior. (b) Keep Sentry with the DSN taken from `config.yaml` (default empty), `debug: false`, and a `beforeBreadcrumb` that drops console breadcrumbs. (c) Electron's built-in `crashReporter` for native crashes in the Rust module; no dependency.

### 3.7 Niconico metadata

(a) **`yt-dlp --dump-single-json --skip-download <watch URL>`** (recommended). yt-dlp is already resolved and spawned by `downloadNicoVideo` (`videoDownloader.ts:1144+`), is maintained against Niconico site changes, and returns title, uploader, uploader_id, duration, view_count, thumbnail and description. Cost: about 1–3 s per lookup to spawn the process. (b) A direct `fetch` of the watch page plus parsing the embedded JSON: no process spawn, but you maintain the scraper.

---

## 4. Recommended target design

```
 phones ──POST /api/<method> (JSON)──┐                       ┌── display window
        <──GET /api/events (SSE)─────┤                       │   ipcRenderer.invoke("api", m, i)   (step 9; HTTP until then)
                                     ▼                       ▼   webContents.send("live", event)
                         src/main/server.ts  ─────────>  src/main/api.ts  (handler map: business logic)
                         (Express: /api router,              │
                          SSE, static remocon,               ├─> src/main/state.ts  (db + persist + "change" emitter)
                          dev proxy)                         ├─> damApi.ts / joysoundApi.ts  (plain classes on http.ts)
                                                             ├─> youtubei.js (lazy), yt-dlp (downloads + Nico info)
                                                             └─> videoDownloader.ts (unchanged; reports progress into state)
 shared:  src/common/api.ts  (types: Api, LiveState, LiveEvent, QueueItem…)   src/common/apiClient.ts  (call(), LiveStateProvider)
```

**Live state.** One object, pushed whole on every change. Throttle to about 4 Hz while downloads are progressing; the queue is a few KB.

```ts
interface LiveState {
  currentSong: QueueItem | null;
  queue: QueueItem[]; // ETAs computed client-side, as withETAs does today
  playbackState: "PAUSED" | "PLAYING" | "RESTARTING" | "SKIPPING" | "WAITING";
  pitchShiftSemis: number;
  adhocLyrics: { lyric: string; lyricIndex: number }[];
  downloads: {
    kind: QueueItem["kind"];
    songId: string;
    suffix: string | null;
    progress: number;
    deviceId: string;
  }[];
  config: {
    supervisedMode: boolean;
    adminNicks: string[];
    adminDeviceIds: string[];
  }; // explicit, no secrets
}
type LiveEvent =
  | { type: "state"; state: LiveState }
  | { type: "emote"; emote: string; user: UserIdentity }
  | { type: "queueAdded"; name: string; artistName: string };
type QueueItem = {
  kind: "dam" | "joysound" | "youtube" | "nico";
  songId: string;
  name: string;
  artistName: string;
  playtime: number | null;
  timestamp: string;
  user: UserIdentity;
} & KindSpecificFields;
```

**Methods.** 19 methods replace 35 schema operations. `Page<T> = { items: T[]; nextOffset: number | null }`.

- Lookups: `damSearchSongs`, `damSearchArtists`, `damArtist`, `damSong`, `joysoundSearchSongs`, `joysoundSearchArtists`, `joysoundArtistSongs`, `joysoundSong`, `youtubeInfo`, `nicoInfo`, `adhocLyrics`, `history`.
- Commands: `queueSong` (one discriminated-union input replacing 4 mutations), `removeSong`, `setPlaybackState`, `setPitchShiftSemis`, `pushAdhocLyrics`, `sendEmote`.
- Display-only: `popSong`. For DAM items it attaches `streamingUrls` and `scoringData`.

Everything the old `queue`, `currentSong`, `playbackState`, `pitchShiftSemis`, `config` and `videoDownloadProgress` queries and all 7 subscriptions did is now the `LiveState` stream. Download-progress polling and per-hook wake-up refetches disappear. `popSong` polling can stay (cheap) or become "pop when `queue.length > 0` arrives".

**Client.**

- `LiveStateProvider` (one `EventSource`, or the IPC listener in the display) with `useLiveState()` and `useLiveEvent(type, cb)` for emote and toast.
- TanStack Query for the 12 lookups and 7 commands, through one `call(method, input)`.

**Server.**

- `state.ts` provides `update(mutator)`, which mutates the state, persists it (same atomic write as today) and emits a change. This resolves the TODO at `graphql.ts:316`.
- `api.ts` holds the resolver logic minus the GraphQL glue: no edges/pageInfo, no `__typename`, no `IDataSources` context.
- `server.ts` holds the Express wiring.
- DAM/Joysound clients are created once, not per request. Innertube is created only by `youtubeInfo`.

**What stays:** Express, compression (minus the SSE path), mDNS, the `karafriends://` protocol, `queue.json`, videoDownloader, youtubei.js, hls.js, kuromoji with the custom dict, fonts, react-router, the native module.

**Optional hardening while here:**

- Do server-side checks for `removeSong`, `setPlaybackState` and head-of-queue. Today supervised mode is enforced only in the remocon UI (`PlaybackControls.tsx:22-25`, `SongQueueItem.tsx:44-54`).
- Return `isAdmin` for the caller instead of shipping the admin device-ID list to every phone, since anyone can copy an ID into `localStorage`.

---

## 5. Migration plan

Each step ships independently and leaves the app working. "Cache" means `.yarn/cache` bytes removed, computed by walking `yarn.lock` (packages nobody else needs).

| #   | Step                                                                                                                                                                                                                                        | Effort       | Risk                                                         | Removes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Drop unused deps (§6); delete the `regenerator-runtime` import (`graphql.ts:45`) and the unused `KeyValueCache` type imports                                                                                                                | S            | very low                                                     | 12 packages, **6.0 MB** cache (5.6 MB of it is the duplicate hls.js 1.6.13 pulled by `@types/hls.js`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | Remove Sentry and OTel; replace with a file log in main (`index.ts:7-22`) and console logging in `ErrorBoundary`                                                                                                                            | S            | low                                                          | 5 direct deps, 38 packages, **14.1 MB** cache; about 4.5 MB main / 2 MB remocon / 2 MB renderer unminified; stops the token leak to the upstream project                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | Lazy Innertube: move `await innertubeApiProvider()` from the Apollo context (`graphql.ts:1372`) into the `youtubeVideoInfo` resolver                                                                                                        | S            | low                                                          | 0 deps; a YouTube outage no longer stalls or fails every request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Replace `niconico` with `yt-dlp -J` in `nicoVideoInfo` (`graphql.ts:871-894`)                                                                                                                                                               | S–M          | low–medium (check whether the current code even works first) | 1 dep, **286 packages, 7.2 MB** cache, about 4.6 MB (22%) of the main bundle; jsdom, jest 26 and axios 0.19 leave the runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Replace `@apollo/datasource-rest` and `dataloader` with `src/main/http.ts`; route logins through it (fixes proxy bypass); instantiate DAM/Joysound clients once. Resolvers unchanged                                                        | M            | medium (DAM/Joysound need a Japanese IP to test)             | 4 direct deps (`@apollo/datasource-rest`, `@apollo/utils.fetcher`, `@apollo/utils.keyvaluecache`, `dataloader`); about 40 lines of DataLoader wrappers (the 30-per-page paging logic stays); small cache gain (0.1 MB)                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Add `state.ts`, `api.ts`, `/api/*` and `/api/events` (SSE) **alongside** `/graphql`; GraphQL resolvers call the same `api.ts` functions. Add `src/common/api.ts` types                                                                      | M            | medium                                                       | nothing yet (net +about 400 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7   | Move live state to SSE: `LiveStateProvider` in remocon and renderer; replace `useQueue`, `useNowPlaying`, `usePlaybackState`, `usePitchShiftSemis`, `useConfig`, the AdhocLyrics/Effects/App subscriptions and the 3 progress-polling loops | M            | medium                                                       | about 500 hook lines plus about 130 polling lines; 7 subscriptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | Move lookups and commands to TanStack Query, one feature at a time (DAM → Joysound → YouTube/Nico → history → queue buttons). Merge the 4 queue mutations into `queueSong`                                                                  | L (31 files) | medium                                                       | about 740 lines of GraphQL documents; adds about 2 packages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | Delete GraphQL and Relay: `schema.graphql`, the GraphQL half of `graphql.ts`, `graphqlEnvironment.ts`, `__generated__`, the `relay` block in `package.json`, `.babelrc`, the `build-relay-*` scripts                                        | S            | low (nothing imports them by now)                            | `@apollo/server`, `@as-integrations/express5`, `@graphql-tools/schema`, `graphql`, `graphql-subscriptions`, `graphql-ws`, `ws` (+`bufferutil`, `utf-8-validate`, `@types/ws`), `react-relay`, `relay-runtime`, `relay-compiler`, `relay-compiler-language-typescript`, `relay-config`, `babel-plugin-relay`, `@types/react-relay`, `@types/relay-runtime`: **98 packages, 47.7 MB** cache (relay-compiler alone is 40.3 MB). About 30% of the main bundle and about 0.76 MB per browser bundle. About 1,300 hand-written plus 8,774 generated lines. Then Babel can go (build review): **237 packages, 52.8 MB** together |
| 10  | Display over IPC: preload exposes `api.call` and `onLive`; main serves `ipcMain.handle("api")` from the same handler map; drop the localhost CORS rules and the dev CORS middleware                                                         | S–M          | low–medium                                                   | about 40 lines of CORS/port plumbing; display survives port conflicts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | UI library swaps, each independent: inline 21 icons (react-icons), CSS + toast for materialize, CSS fade, scroll-snap picker, local `memoize`                                                                                               | S each       | low                                                          | 12 packages, **22.8 MB** cache (react-icons 22.1 MB); about 0.35 MB of renderer CSS/JS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Totals: steps 1, 2, 4, 5, 9 and 11 together remove **452 of 1,835 lockfile packages and 97.9 MB** of the 463 MB cache. This is computed as one set, so shared transitive packages are counted once. With Babel removed afterwards: **613 packages, 103.6 MB**. TanStack Query adds back about 2 packages.

Ordering rationale:

- Steps 1–5 are independent wins inside today's architecture, and each is small enough to offer upstream.
- Steps 6–9 are a strangler migration. Both APIs live side by side until the last component moves, so you can stop at any point with a working app.
- Step 10 is cheap only once the API is transport-agnostic.
- Step 11 can happen any time.

Testing: the remocon/renderer wdio tests are black-box UI tests (`tests/wdio/*/test.js`), not API tests, so they survive the swap. DAM/Joysound flows need a Japanese IP.

---

## 6. Unused or barely-used dependencies (evidence)

For the cleanup session. "Imports" means imports in `src/`, `scripts/`, `electron.js` and `packager.js`.

**Unused at runtime — safe to remove:**

| Package                                                | Evidence                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user-agents` + `@types/user-agents`                   | 0 imports. The last importer was removed in `6782ba79` (2026-02-08, "replace youtubeApi with youtubei.js")                                                                                             |
| `mv`                                                   | 0 imports. The last use was removed in `221a32fe` (2026-07-21, runtime external resources)                                                                                                             |
| `cors` + `@types/cors`                                 | 0 imports ever. Added in `84a17bf3` (2025-01-30, Parcel migration); CORS is done by hand (`graphql.ts:1325-1335`, `index.ts:111-139`)                                                                  |
| `react-swipeable` + `@types/react-swipeable`           | 0 imports. Removed from src in `88411f03` (2023-06-04)                                                                                                                                                 |
| `@types/hls.js`                                        | deprecated stub (hls.js ships its own types). It depends on `hls.js@*`, so `hls.js@1.6.13` (5.6 MB) lands in the cache next to 1.7.1 (`yarn.lock`)                                                     |
| `regenerator-runtime`                                  | only a side-effect import at `graphql.ts:45`, a Babel-era leftover. Main-process deps were checked (e.g. `niconico` has no `regeneratorRuntime` references). Remove the import and run once to confirm |
| `@opentelemetry/api`, `/core`, `/sdk-trace-base`       | 0 imports; present only as Sentry peers under PnP (`8bd7a64f`). They go with Sentry (step 2)                                                                                                           |
| `@apollo/utils.keyvaluecache` (as a direct dependency) | only `import type { KeyValueCache }` in `damApi.ts:9` and `joysoundApi.ts:2`, never referenced. Transitive via datasource-rest anyway                                                                  |

**Not imported, but probably needed by the build or PnP (leave to the build review):**

| Package                                                                                  | Evidence                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supports-color`, `bufferutil`, `utf-8-validate`                                         | 0 imports; all added in `42ed6969` (2023-05-07, "Switch to Yarn PnP") as optional peers (debug and ws). bufferutil and utf-8-validate go with `ws` in step 9 |
| `process`                                                                                | `import process from "process"` in Node code resolves to the builtin; the npm package is Parcel's browser polyfill (added in `6a4c565d`, the Parcel switch)  |
| `postcss`, `parcel-reporter-static-files-copy`, `@parcel/transformer-react-refresh-wrap` | build plugins listed under `dependencies`                                                                                                                    |
| `kuromoji` (direct)                                                                      | not imported directly; `kuroshiro-analyzer-kuromoji` already depends on it. Kept for types (`@types/kuromoji`) and PnP strictness                            |

**Misplaced:** `@types/react-fade-in`, `@types/react-swipeable`, `@types/user-agents`, `@types/wicg-mediasession` and `@types/youtube-player` sit in `dependencies` and belong in `devDependencies` (or should go, per above).

**Barely used** (one or two call sites; replace when convenient): `lodash` (1 call, `memoize`), `react-fade-in` (1), `react-mobile-picker-scroll` (1), `materialize-css` (4 call sites plus CSS classes, renderer only), `dataloader` (no-op, §1.5), `niconico` (1 call), `youtubei.js` (1 call, but needed), `uuid` (1 call, but needed).

---

## 7. Effect on pulling from upstream (`emmaworley/karafriends`)

Upstream activity over the last 12 months, from local history:

- `src/common/schema.graphql`, `src/common/graphqlEnvironment.ts` and `src/remocon/**`: **0 commits.**
- `src/main/graphql.ts`: 5. `src/main/index.ts`: 4. `src/renderer/**`: 7. `src/main/joysoundApi.ts`: 4. `src/main/damApi.ts`: 2. `src/common/videoDownloader.ts`: 3. Mostly the July 2026 hardening burst (#2303–#2314).
- `package.json`: 163, of which **145 are dependabot**.

Implications:

- **Steps 1–5 are upstream-friendly.** They are small, self-contained and arguably bugs: the DSN pointing at upstream's project, the Innertube coupling, the unused deps, the stub types package, the jsdom/axios 0.19 drag. Offering them as PRs reduces your long-term diff.
- **Steps 6–9 fork the API layer.** Conflict surface on future merges:
  - `graphql.ts` resolvers. Upstream changes there must be ported by hand into `api.ts`, but there are only about 5 per year, and they're mostly in the queue/state logic that moves nearly verbatim.
  - Any upstream remocon/renderer component touching Relay. Rare: 0 remocon commits in 12 months.
  - Upstream adding a new GraphQL field or operation means re-implementing it as an RPC method.
- **Keep file and method names stable** in `damApi.ts`, `joysoundApi.ts` and `videoDownloader.ts`. These are where upstream fixes actually land (site/API changes at DAM, sound-cafe and YouTube), so their patches keep applying. Changing only the base class (step 5) touches a handful of lines per file.
- **Dependabot noise:** bumps to packages you removed will conflict in `package.json`/`yarn.lock`. Resolve by keeping yours and regenerating the lockfile. Net effect: fewer deps means fewer bump PRs to merge at all (Sentry, Apollo, Relay and OTel account for many of them). Lockfile and `.pnp.cjs` conflicts already exist; the build review may reduce them.
- If you'd rather avoid the fork entirely, steps 1–5 plus 11 alone get about 50 MB of cache, about 45% of the main bundle and the privacy fix, and keep GraphQL/Relay identical to upstream.

---

## 8. Coupling with the build-tooling review

- **Relay is what keeps Babel in the build.** `.babelrc` contains only `{"plugins": ["relay"]}`, which makes Parcel route JS/TS through `@parcel/transformer-babel` instead of SWC alone. Dropping Relay (step 9) lets the build drop `.babelrc`, `@babel/*`, `babel-plugin-relay` and `@parcel/transformer-babel`. The `babel-loader` dependency is webpack-era and already dead.
- **`relay-compiler`** is a build step (`build-relay-dev/prod`, run under `concurrently`), produces gitignored `__generated__` types that `tsc --noEmit` depends on, and is the single largest package in the cache (40.3 MB of per-platform binaries). Step 9 removes the step, the CI ordering constraint and the `relay` block in `package.json`.
- **`inline-string:` transformer** (`.parcelrc`, used by `graphql.ts:32` to import the schema) is only needed for GraphQL.
- **Any bundler switch** (e.g. Vite or esbuild): Relay would need `vite-plugin-relay` plus Babel, so **doing step 9 first makes a bundler switch simpler**. Vite's dev proxy could also replace `middleware/remoconReverseProxy.ts`.
- **`includeNodeModules: true` for `main_`** is why jsdom, Sentry and Apollo bloat the main bundle (20.4 MB unminified in dev, about 1% app code). Steps 2, 4 and 9 shrink it about 75%. A build that externalizes node_modules would hide the bundle cost but not the cache cost.
- **The `youtubei.js` patch** (`.yarn/patches/youtubei.js-npm-18.0.0-…patch`) exists only because Parcel inlines `import.meta.url` as a drive-letter-less `file:///` URL on Windows. Re-check it after any bundler change; it may become unnecessary, or need a different fix.
- **PnP peer shims:** `@opentelemetry/*` (Sentry), `supports-color`, `bufferutil` and `utf-8-validate` were added to satisfy PnP peers. They disappear with steps 2 and 9 regardless of whether PnP stays.
- **Static assets:** `static/dict` is copied by `parcel-reporter-static-files-copy`. Any new bundler needs an equivalent (e.g. Vite `publicDir`). The fonts are referenced from `renderer/index.css` and are bundler-agnostic.
- **wdio tests** drive the UI, not the API, so the API migration doesn't affect the test-runner decision.
- **New dependency from this plan:** TanStack Query (about 2 packages, no build integration). Optional `zod`.

---

## Appendix: issues noticed while reading (not fixed)

- `removeSong` with an unknown song calls `splice(-1, 1)` and **removes the last queued song** (`graphql.ts:1138-1142`). Two phones removing the same song at once triggers it.
- `songHistory` pagination uses `slice(afterInt, firstInt)` (`graphql.ts:812`), so page 2 is always empty.
- Every GraphQL request awaits Innertube init (`graphql.ts:1372`), covered in step 3.
- DAM and Joysound logins bypass the configured proxy (`damApi.ts:101-116`, `joysoundApi.ts:267-358`).
- `inspector.open()` runs unconditionally in production (`index.ts:27`), so a debugger listens on 127.0.0.1:9229.
- Supervised mode and admin checks exist only in the remocon UI; the server accepts `removeSong`, `setPlaybackState` and `tryHeadOfQueue` from anyone. `adminDeviceIds` is sent to every phone (`useConfig.ts`).
- The `niconico` package scrapes a pre-2024 Niconico page structure; verify whether `nicoVideoInfo` still works.
- `src/main/index.ts` imports `MinseiAPI` and `JoysoundAPI` (lines 47, 49) without using them, and `src/main/proxiedFetcher.ts` is an empty file.
