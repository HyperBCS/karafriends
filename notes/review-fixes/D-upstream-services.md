# Phase D: Upstream services

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/main/joysoundApi.ts, src/main/damApi.ts, src/main/credentials.ts, src/main/http.ts.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                       | Severity | Title                                                                                                            |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| [main-boot-upstream-2](#main-boot-upstream-2) | Medium   | An expired DAM or Joysound session is kept for good: nothing logs in again, and 'Test login' says it works       |
| [main-boot-upstream-4](#main-boot-upstream-4) | Medium   | Upstream retries run ~17 minutes on permanent failures, log in again on every try, and outlive popSong's timeout |
| [main-boot-upstream-5](#main-boot-upstream-5) | Medium   | Joysound searches turn every failure into 'No results', and song pages into a song called 'Error'                |

## main-boot-upstream-2

**An expired DAM or Joysound session is kept for good: nothing logs in again, and 'Test login' says it works** (medium, plausible, bug) · `src/main/credentials.ts:54`

**Summary.** The shared DAM and Joysound logins last for the whole app run. Nothing calls forget() when a request fails. JoysoundAPI.post drops response cookies, and testLogin or a re-save of the same credentials leaves the shared login as it was. So if the upstream service ends the session mid-run, Joysound getFME and contentsInfo resolve with the login page or fail after about 17 minutes of retries. jobs.ts then throws a TypeError at telopBase64.slice or data.movie, and DAM's streaming and scoring calls keep the dead token. Only a restart, or changing a login field, recovers. Real session lifetimes are unverified, and upstream has run with sessions kept like this since 2023.

**Scenario.** A long party. sound-cafe's server-side session idles out, or the DAM token is invalidated, for example by signing in elsewhere. After that, every queued Joysound song fails: getFME errors or returns the login page, and jobs.ts hits a TypeError on `.telop`. Joysound searches come back empty, and DAM streaming URLs fail, so DAM songs that weren't downloaded can't play. The host opens Settings and presses Test, and it reports 'Joysound login works.'. testLogin makes a fresh login and leaves the dead shared one in place. Saving the same credentials again doesn't help, because configStore only reports keys whose value changed.

**Suggested fix.** Treat failures that look like a lost session as one: 401/403 from an API endpoint, a redirect to /login or an HTML body where JSON was expected, or a DAM statusCode for a bad token. On those, call credentials.dam.forget() or credentials.joysound.forget() and retry once with a fresh login. Pass the forget hook into the clients, or wrap credsProvider as `withRelogin(fn)`. In JoysoundAPI.post, merge response Set-Cookie headers back into the cookie jar with parseCookies. After a successful testLogin or a settings save, also forget (or replace) the shared session. That gives the host a real fix short of a restart.

**Verifier.** PLAUSIBLE: Every code fact checks out. memoizeSuccess clears the promise only on rejection or forget() (credentials.ts:21-37). forget() is called only from the onChange handler for DAM_LOGIN_KEYS and JOYSOUND_LOGIN_KEYS (credentials.ts:62-65). configStore.update drops keys whose value didn't change (configStore.ts:128-131), so saving the same credentials does nothing. JoysoundAPI.post never reads response cookies. Every MinseiAPI retry calls the same cached credsProvider. testLogin uses deps.logins, a fresh login that leaves the shared one alone (services.ts:169-172, settings.ts:143-150). So once a session dies, nothing recovers it before a restart. What I couldn't confirm is that sound-cafe or DAM sessions actually expire, or are revoked, within one app run. The upstream code has cached logins forever with plain memoize since before commit 79a80eb, and nothing in the notes reports it. Impact would be high if it happens, but how often is unknown. One small correction: a redirect to /login makes getFME return an HTML string, so the TypeError comes from `telopBase64.slice` on undefined, not from reading `.telop`. | PLAUSIBLE: The code part of the finding is right, and I reproduced it. What I couldn't confirm is the trigger.

Confirmed in code:

- memoizeSuccess (credentials.ts:21-38) clears its promise only when the login fails or forget() is called.
- forget() is called only from the onChange handler at credentials.ts:62-65, when a login key changes. grep finds no other caller.
- configStore.update (configStore.ts:128-131) filters out keys whose value didn't change. Saving the same credentials again fires no change, so it doesn't log in again.
- testLogin (settings.ts:130-161, services.ts:168-172) does its own fresh login and never touches the shared one.
- JoysoundAPI.post (joysoundApi.ts:136-161) never reads the response's Set-Cookie headers.
- MinseiAPI's promiseRetry loops (damApi.ts:110-151) call credsProvider() again on each retry, but they get the same cached token back.
- http() follows redirects and returns a non-JSON body as text (http.ts:136-166).

Repro: /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-main-boot-upstream-2/expired.test.ts (passes). It uses the real createCredentialProviders and JoysoundAPI against a local fake sound-cafe. After the server drops the session and answers 302 to /login:

- getSongRawData resolves with the login page's HTML string. It doesn't reject, so it isn't retried.
- The login count stays at 1.
- The joysoundJob step then throws a TypeError.
- A fresh "test" login works, but the shared provider still hands out the dead session.

Why PLAUSIBLE and not CONFIRMED: nothing shows that sound-cafe or Minsei ends a session within one app run. The finding says so itself. Before May 2023 the app logged in on every request. Lodash memoize then made the login last for the whole app run (commit 353d44f, #269). Upstream has used it that way at parties for about 3.5 years. Its only later change was adding retries with the same session to getFME and contentsInfo (2cc2825, Feb 2026). That weakly suggests sessions outlive a typical party, or that nobody traced a failure to this.

The trigger is still believable. sound-cafe looks like Spring: JSESSIONID, XSRF-TOKEN and the _csrf meta tag. Spring's default idle timeout is 30 minutes, and a gap that long with no Joysound request is common at a party that mostly sings DAM or YouTube. Losing AWSALB stickiness is another possible way to lose the session, but that is also unverified. So I can't refute it either.

If it happens, Joysound and the DAM songs that weren't downloaded stop working until a restart, and the host has nothing that points to that fix. That would be high if it happened often, but since it is unproven, medium.

Corrections to the summary:

- The TypeError isn't on `.telop`. It is `telopBase64.slice` at jobs.ts:678, or `data.movie.mov1` at jobs.ts:650 when the contentsInfo step resolves to HTML first.
- If the dead session gets a 4xx rather than a redirect, getFME and contentsInfo retry 10 times with backoff, about 17 minutes, all with the same dead cookies, before the download fails.
- "Joysound searches come back empty" holds only if search needs a login. A 4xx is caught and becomes []. A redirect resolves as an HTML string and goes into joysoundPage.
- The DAM "signed in elsewhere" case is speculation.

The suggested fix is reasonable: forget the login and retry once when an answer looks like a lost session, and have a successful testLogin or Save replace the shared login.

**Also reported as** (A DAM or Joysound session that expires is never dropped. Forget it and log in again once on an auth-shaped failure.):

- main-settings-tools-7: A DAM/Joysound session is kept for the life of the process: nothing forgets it when it expires (`src/main/credentials.ts:54`). Its fix: Have the clients call `credentials.x.forget()` (pass a `relogin` hook into MinseiAPI/JoysoundAPI) when a request fails with an auth-shaped error (401/403, a redirect to /login, DAM's auth status codes), then retry once. Failing that, give memoizeSuccess a max age (e.g. re-login after 20 min idle).

## main-boot-upstream-4

**Upstream retries run ~17 minutes on permanent failures, log in again on every try, and outlive popSong's timeout** (medium, confirmed, bug) · `src/main/joysoundApi.ts:179`

**Summary.** getMovieUrls, getSongRawData, getMusicStreamingUrls and getScoringData all call promiseRetry with its defaults: 10 retries backing off from 1 s to 512 s, about 1023 s of waiting plus up to 30 s of silence timeout per try. Every error is retried, including a rejected login, a 403 from outside Japan and 'no scoring data'. Each try calls credsProvider, and after a failed login that runs the whole login again.

**Scenario.** The host's Joysound password is wrong, or the VPN is off. A guest queues a Joysound song, and the phone shows it 'downloading' at 0% for about 17-22 minutes before it fails. Meanwhile sound-cafe gets about 11 full logins (4 requests each) on the host's account. For DAM, queueSong (api.ts:624) and popSong's two calls (api.ts:999, 1005) each start a chain. popSong now gives up after 10 s, but the chains keep running in the background for ~17 minutes. A DAM song with no scoring reference makes getScoringData reject as 'not binary' 11 times (11 POSTs) every time it's popped.

**Suggested fix.** Give each call explicit options, for example { retries: 3, minTimeout: 1000, maxTimeout: 5000 }. Call retry() only for transient errors: network or timeout errors and 5xx. Fail at once on login rejection, HttpStatusError or 4xx, DAM statusCode errors and non-binary scoring data. Let a credsProvider failure end the attempt rather than retry it. popSong could also pass an AbortSignal or a single-try variant so the chains it abandons stop.

**Earlier reviews.** Extends notes/code-review-2026-10-27.md #3 (marked fixed): popSong now stops waiting after DAM_POP_TIMEOUT_MS, but the retry chains it abandons still run ~17 min, and JoysoundAPI's downloads still use the same defaults.

**Verifier.** CONFIRMED: retry 0.12.0 defaults to retries 10, factor 2, minTimeout 1000 and maxTimeout Infinity (retry.js:18-24), and promise-retry 2.0.1 passes undefined options. The waits add up to 1+2+…+512 = 1023 s, plus up to 30 s of silence timeout per try (http.ts). All four call sites retry every error with `.catch(retryFn)`, including login rejections, 403s, checkError status codes and the 'not binary' string (damApi.ts:112-150, joysoundApi.ts:179-186, 274-281). credsProvider forgets a rejected login, so each retry logs in again. joysoundJob (jobs.ts:631-656) has no overall timeout, so the download row stays 'downloading' until both chains run out. popSong's withTimeout (api.ts:155-163, 997-1011) gives up on waiting but leaves the chains running, as its own comment says. So prior review #3 fixed the blocking, but the 17-minute retry chains it described are still there in the background. Small corrections: a rejected Joysound password costs 2 requests per login (GET /login and POST /login/check), not 4, and a 403 costs 1. getSongRawData and getMovieUrls start at the same moment, so their first login attempts share the in-flight promise.

## main-boot-upstream-5

**Joysound searches turn every failure into 'No results', and song pages into a song called 'Error'** (medium, confirmed, bug) · `src/main/joysoundApi.ts:171`

**Summary.** getArtistListByKeyword, getSongListByArtist and getSongListByKeyword catch every error and return []. getSongDetail returns placeholder 'Error' strings when the login fails. The remote has a per-catalog error with a Retry button for exactly this case, and it never shows for Joysound. Every search with a missing or failing login also runs a fresh login.

**Scenario.** The VPN drops for a moment, or the host never entered a Joysound login. Searches default to source 'all'. Every search shows the DAM results and silently no Joysound ones, so guests conclude the song isn't on Joysound. With a blank Joysound login, each search page still costs a failed GET /login plus POST /login/check against sound-cafe. Opening a Joysound song shows the title 'Error', artist 'Error' and lyrics 'Error', and the guest can still queue it.

**Suggested fix.** Drop the catch blocks so the error reaches dispatch, and the phone gets a status and message that the remote's InlineError already displays. In getSongDetail, throw instead of returning placeholders. Throw ApiError(503, "The host hasn't set up Joysound") without making a request when !hasLogin(config, 'joysound'). This removes about 15 lines.

**Verifier.** CONFIRMED: joysoundApi.ts:171-174, 252-255 and 266-269 log the error and return []. joysoundPage in api.ts:458-482 turns that into an empty page. SearchResults.tsx:114-136 shows 'search.failed' with Retry only when isLoadingError is set, and otherwise 'No results found'. SearchPage.tsx defaults source to 'all'. getSongDetail returns the 'Error' placeholders only when credsProvider rejects (joysoundApi.ts:191-201); an HTTP failure there still throws. hasLogin is used only in settings.ts (lines 136 and 178), so a blank login still runs GET /login and POST /login/check on every search. The fix as described (let errors through, throw ApiError 503 when !hasLogin) is right.

**Also reported as** (Joysound lookups swallow errors into [] or a song named 'Error'. Let the errors reject, and answer early when there is no Joysound login.):

- main-api-7: Joysound lookups answer an empty page or a song called "Error" on any upstream failure, so phones can't show what went wrong (`src/main/joysoundApi.ts:171`). Its fix: Let the errors reject (drop the `.catch(() => [])` and the 'Error' stub) so the phone's existing error state shows the message. Alternatively, catch the login failure in the handler and throw an ApiError(409, 'Joysound sign-in failed: …') the remote can show.
- cross-maintainability-3: Joysound lookups turn every failure into 'no results' or a song named 'Error' (`src/main/joysoundApi.ts:171`). Its fix: Drop the three catches and the 'Error' object so failures reach the remote the way DAM's do (about 25 fewer lines). To keep DAM-only hosts quiet, have createApi answer Joysound lookups with an empty page when !hasLogin(config, "joysound") (configSchema.ts:219), instead of logging in with empty fields. Alternatively, publish which catalogs are set up in LiveState.config and have the remote skip that search.
