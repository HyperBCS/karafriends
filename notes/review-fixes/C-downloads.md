# Phase C: Downloads

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/main/downloads/*, src/main/services.ts (download wiring and the temp folder).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                             | Severity                        | Title                                                                                                                                                |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [main-downloads-1](#main-downloads-1)               | High                            | Niconico downloads run yt-dlp without --ffmpeg-location, so they can't merge and fail wherever ffmpeg isn't on PATH                                  |
| [main-downloads-2](#main-downloads-2)               | Medium                          | A Joysound song with a YouTube background holds a yt-dlp slot for its whole job, including up to ~17 min of Joysound API retries                     |
| [main-state-2](#main-state-2)                       | Medium                          | queue.json and every download live in /tmp, which is RAM-backed tmpfs on current Linux                                                               |
| [main-downloads-5](#main-downloads-5)               | Low                             | DAM downloads start at once with no concurrency limit and compete with the song streaming on the TV                                                  |
| [main-downloads-6](#main-downloads-6)               | Low                             | Interrupted or failed downloads leave large partial files that nothing ever sweeps                                                                   |
| [main-downloads-7](#main-downloads-7)               | Low                             | The Joysound started-marker is deleted after compose, before the five pad steps, so a crash then caches an unpadded background for good              |
| [main-downloads-8](#main-downloads-8)               | Low                             | ffmpeg's Duration line is parsed per stdout chunk, but ffmpeg writes it in pieces: progress can stick at NaN and compose can take the wrong duration |
| [main-downloads-9](#main-downloads-9)               | Low                             | Two downloads can truncate and garble one log: dam-<songId>.log across URL indexes, yt-<id>.log between a YouTube song and a Joysound background     |
| [main-boot-upstream-10](#main-boot-upstream-10)     | Low                             | Quitting or restarting leaves yt-dlp and ffmpeg running                                                                                              |
| [cross-maintainability-5](#cross-maintainability-5) | Low                             | Each download's file names are spelled out separately in five places across main and renderer                                                        |
| [tests-unit-3](#tests-unit-3)                       | Low                             | One failing assertion in jobs.test's yt-dlp slot test hangs the rest of the file and the CI job                                                      |
| [oe-main-1](#oe-main-1)                             | Over-engineering (KEEP, medium) | Download wiring goes through four layers, and one of them repeats a check that can never pass                                                        |
| [oe-main-9](#oe-main-9)                             | Over-engineering (KEEP, low)    | getJoysoundOggPlaytime hand-writes a byte search that Buffer.indexOf already does                                                                    |

## main-downloads-1

**Niconico downloads run yt-dlp without --ffmpeg-location, so they can't merge and fail wherever ffmpeg isn't on PATH** (high, confirmed, bug) · `src/main/downloads/jobs.ts:830`

**Summary.** nicoJob is the only yt-dlp run that doesn't pass --ffmpeg-location. Niconico serves only separate video-only and audio-only formats, and the app's ffmpeg isn't on PATH. yt-dlp (whose CLI defaults to --no-abort-on-error) warns 'formats won't be merged', leaves nico-<id>.f<video>.mp4 and .f<audio>.mp4 and exits 0. nicoJob then fails with 'yt-dlp exited 0 but left no nico-<id>.mp4' (REASONS.other, which shows the Update tools notice). Every Niconico download fails wherever ffmpeg isn't on PATH, and the unmerged files are left behind.

**Scenario.** Windows install as the README describes it, where the app downloads ffmpeg into %APPDATA%\karafriends\externalResources\ffmpeg\ and yt-dlp into ...\ytdlp\, and ffmpeg isn't on PATH. A guest queues sm9. yt-dlp picks bestvideo+bestaudio, finds no ffmpeg and prints "ERROR: You have requested merging of multiple formats but ffmpeg is not installed. Aborting due to --abort-on-error", then exits 1. That classifies as REASONS.other, which isToolProblem counts as a tools problem, so the display says "YouTube downloads are failing; try Update tools", and updating can't fix it. Every Niconico song fails. Linux without a system ffmpeg fails the same way; it works on this laptop only because /usr/bin/ffmpeg exists.

**Suggested fix.** Add "--ffmpeg-location", paths.ffmpeg to nicoJob's args. Better: merge youtubeJob and nicoJob, which are about 80% the same (prefix, prepareTempFile, runTool, finally unlink, exists check), into one ytdlpVideoJob(paths, item, prefix, target, extraArgs) that owns the shared args (-N 4, --ffmpeg-location, -o, --). That saves about 40 lines and the two can't drift apart again. Do the same for downloadYoutubeVideo and downloadNicoVideo in index.ts. Then make the fake yt-dlp exit 1 without --ffmpeg-location so the nico test covers it.

**Verifier.** CONFIRMED: nicoJob (jobs.ts:830-837) passes only -N 4 -o <file> -- <url>, while youtubeJob and the Joysound background pass --ffmpeg-location. The app's ffmpeg lives in externalResources/ffmpeg/ and yt-dlp in externalResources/ytdlp/ (externalResourcesPlan.ts:137-138). Nothing adds ffmpeg to PATH, and the README's Windows and Linux install steps don't install a system ffmpeg. With no location given, yt-dlp's FFmpegPostProcessor looks up a bare 'ffmpeg' (ffmpeg.py:105-106). The cached yt-dlp's niconico extractor (niconico.py:418-441) builds only audio-only and video-only domand formats, so every Niconico video needs a merge. The finding's mechanism is wrong in one detail: the CLI defaults to ignoreerrors='only_download' (**init**.py:155), so yt-dlp warns instead of aborting. I checked this with the cached yt-dlp, PATH stripped of ffmpeg, on a local split-rendition HLS served over HTTP. It printed 'WARNING: You have requested merging of multiple formats but ffmpeg is not installed. The formats won't be merged', wrote nico-sm9.f67.mp4 and nico-sm9.fgroup_aud-audio_1.mp4, wrote no nico-sm9.mp4, and exited 0. nicoJob then throws DownloadFailure(REASONS.other, 'yt-dlp exited 0 but left no ...'). isToolProblem counts that as a tools problem, so the display tells the host to Update tools, which can't help. Every Niconico song fails on a default Windows install, and on Linux without a system ffmpeg; it works on this laptop only because /usr/bin/ffmpeg exists. The fake yt-dlp ignores flags, so jobs.test.ts can't catch it. | CONFIRMED: I reproduced this against the real module and real tools; it is not just inferred from the code.

Code path: jobs.ts:830-837 passes only `-N 4 -o <file> -- <url>`. youtubeJob (772-773) and the Joysound background job (329-330) pass `--ffmpeg-location paths.ffmpeg`. resourcePathsFor (externalResourcesPlan.ts) puts ffmpeg in externalResources/ffmpeg/ and yt-dlp in externalResources/ytdlp/. Nothing in src/ adds that folder to PATH, and runTool spawns with the inherited env and no cwd. With no location given, yt-dlp's FFmpegPostProcessor._determine_executables falls back to a bare "ffmpeg". On Windows, CreateProcess then searches yt-dlp's own folder, the cwd, the system folders and PATH, and finds nothing. Electron apps started from Finder on macOS get PATH=/usr/bin:/bin:..., so even a Homebrew ffmpeg isn't found.

Niconico side: in the cached yt-dlp 2026.10.26, niconico.py _extract_formats builds audio-only (vcodec none) formats and video variants from the domand HLS master. common.py:2422-2429 sets acodec='none' on video variants that reference an audio group. So no single format has both video and audio, and 'best/bestvideo+bestaudio' resolves to a merge.

Repro: /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-main-downloads-1/repro.ts calls the real nicoJob with the cached yt-dlp and the cached ffmpeg path, with PATH set to a folder that holds only python3, on sm9. Output: "[info] sm9: Downloading 1 format(s): video-h264-360p-1+audio-aac-128kbps", then "WARNING: You have requested merging of multiple formats but ffmpeg is not installed. The formats won't be merged". It downloaded both streams (24 MB + 4 MB) and exited 0, and nicoJob rejected. failureReason was "Download failed" (REASONS.other), isToolProblem was true, so api.ts:326-328 sets the TOOLS_PROBLEM banner. Files left: nico-sm9.faudio-aac-128kbps.mp4 and nico-sm9.fvideo-h264-360p-1.mp4, with no nico-sm9.mp4.

Control: the same yt-dlp run with `--ffmpeg-location <cached ffmpeg>` under the same PATH printed "[Merger] Merging formats into nico-sm9.mp4" and exited 0. The suggested fix works.

Corrections to the finding: it isn't "ERROR ... Aborting due to --abort-on-error / exit 1". The yt-dlp CLI defaults to ignoreerrors='only_download', so this is a warning and exit 0, and the failure comes from nicoJob's existsSync check. That makes it worse than described. Guests wait for the full download before it fails, bandwidth and a yt-dlp slot are spent on it, and the unmerged .f*.mp4 files are never removed: deleteTempFiles runs only when a stale .tmp is found, and the finally block unlinks the .tmp. A retry of the same video reuses those files ("has already been downloaded") and fails the same way, so they don't pile up.

It works on this laptop only because /usr/bin/ffmpeg exists. tests/fixtures/bin's fake yt-dlp ignores the flag, so jobs.test.ts can't catch it.

Severity: a whole song source fails every time on the default install of every platform, and the banner sends the host to "Update tools", which can't fix it. Other sources keep working, so it doesn't ruin the party. That makes it high, not critical. The suggested fix is right: add `--ffmpeg-location paths.ffmpeg`, preferably by sharing the yt-dlp arguments between youtubeJob and nicoJob.

## main-downloads-2

**A Joysound song with a YouTube background holds a yt-dlp slot for its whole job, including up to ~17 min of Joysound API retries** (medium, confirmed, performance) · `src/main/downloads/queue.ts:103`

**Summary.** runDownload holds one of the two yt-dlp slots for a whole Joysound-with-YouTube-background job, not just its yt-dlp run. That includes getSongRawData's uncapped promise-retry (10 retries, 1023 s of backoff, plus up to 30 s of timeout per attempt). If getFME fails or stalls, the slot sits idle for about 17-22 min after yt-dlp has exited, and with two such jobs every YouTube and Niconico download waits at 0% until both fail. Shown with the real modules in scratchpad/review/repro-main-downloads-2/repro.ts.

**Scenario.** The VPN to Japan drops, or the Joysound login stops working, and two guests queue Joysound songs with YouTube backgrounds. Each background's yt-dlp finishes in about a minute, but joysoundJob waits in Promise.all for getSongRawData. That retries 10 times with about 1023 s of backoff, plus up to 30 s of silence timeout per attempt. Both slots stay taken for roughly 17-22 minutes, and every YouTube and Niconico song queued in that window shows 'downloading 0%' the whole time. The success path holds slots too: http.ts:17-19 notes getFME can take minutes over a slow VPN, and the slot sits idle meanwhile.

**Suggested fix.** Take the slot only around the yt-dlp runTool calls: a withYtdlpSlot(() => runTool(...)) used in youtubeJob, nicoJob and downloadJoysoundYoutubeVideoPromise (runTool already refuses an aborted signal, so a background stopped while waiting won't start). Then drop runsYtdlp from runDownload. Separately, cap the Joysound download retries (e.g. retries: 3, and no retry on 4xx), so a guest hears about a failure in seconds, not 17 minutes.

**Earlier reviews.** Product review #17 added YTDLP_SLOTS. This is a flaw in how that fix scopes the slot, not a re-report.

**Verifier.** CONFIRMED: runDownload (queue.ts:102-109) takes the slot before job(item) and releases it only when the job settles. runsYtdlp counts a Joysound job with a background (queue.ts:82-85). joysoundJob awaits Promise.all of the background's yt-dlp run and getSongRawData (jobs.ts:661-664), then compose and pad. getSongRawData uses promiseRetry with the defaults (retries 10, factor 2, minTimeout 1 s: about 1023 s of backoff, plus up to 30 s of HTTP silence timeout per attempt), and .catch(retryFn) retries every error, 403s included. So when the Joysound API fails, a background whose yt-dlp finished in a minute keeps its slot for about 17-22 minutes. Two such songs block every YouTube and Niconico download at 0%; the reviewer's scratch simulation (slot.ts) shows it. I rate it medium, not high: it needs a Joysound outage or a broken login, plus two Joysound-with-background songs to take both slots (one still leaves a slot). In the success path the extra hold is only getFME's wait plus a few seconds of ffmpeg copies. | CONFIRMED: I could not refute it, and a script that runs the real modules reproduces it.

The code path:

- In `runDownload` (src/main/downloads/queue.ts:102-109), `takeYtdlpSlot()` comes before `job(item)` and `releaseYtdlpSlot()` sits in its `finally`. So for a joysound key with `suffix !== null` (queue.ts:82-85), the slot is held for the whole `joysoundJob`.
- `joysoundJob` (jobs.ts:631-664) starts the yt-dlp background and `getSongRawData` side by side, then waits on `Promise.all`. After that it runs compose and the 5 pad ffmpegs.
- `getSongRawData` (joysoundApi.ts:272-281) runs promise-retry with the defaults. I checked `node_modules/retry` 0.12.0: retries 10, factor 2, minTimeout 1000, no randomization. That is 1023 s of backoff, and every error is retried, including a 403 and a failed login from `credsProvider`. With a hung link, each attempt can also wait up to 30 s of silence (http.ts TIMEOUT_MS). So the total is about 17 min, up to about 22 min.

The repro is /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-main-downloads-2/repro.ts. It uses the real `JoysoundAPI.getSongRawData` (only `post` is overridden to throw `HttpStatusError(403)`, as when the VPN is down), the real `joysoundJob`, `youtubeJob` and `runDownload`, the fake tools from tests/fixtures/bin, and timers of 1 s or more scaled down 1000x. Results:

- Both Joysound background yt-dlps finished at about 10 ms, with progress at 1.
- The YouTube item stayed `{status: "downloading", progress: 0}`.
- The YouTube job started only after all 20 backoffs (2 jobs × [1,2,4,…,512] s = 2046 s, i.e. 1023 s per job). Then both Joysound jobs failed with "Couldn't get the song from Joysound", and only then did YouTube download.

Why medium, not high:

- **The path is not common.** It needs the opt-in YouTube background feature (pasting a YouTube link on the Joysound song page, or "sing again" from history). getFME also has to fail or stall for a long time. And a full block needs two such jobs at once; with one, YouTube and Niconico just drop to a single slot.
- **The VPN-down trigger is narrower than the scenario says.** With the VPN down, Joysound search fails (its errors come back as []) and DAM breaks as well. So the guest must already have the song page open, or the drop must come between search and queue, or getFME must fail with an HTTP error for one song while other calls work.
- **The success path costs little.** Compose and pad are `-c copy` ffmpeg runs that take seconds. The real idle time comes only when getFME is slow over the VPN and takes longer than yt-dlp. That is a real cost, but a moderate one.

So this is a real bug on a less common path. YouTube and Niconico songs can sit at "downloading 0%" for 17-22 min. It is not a common-case breakage.

File, line and summary are accurate (queue.ts:103-109; the retry is at joysoundApi.ts:274-281). One addition: the 17-minute retry with no cap is the bigger problem for the guest on its own, because their Joysound song shows "downloading" for the whole time before it fails, slot or no slot. The suggested fix is sound: take the slot only around the yt-dlp `runTool` calls (an aborted signal is already refused, so a stopped background won't start), and cap or skip retries on 4xx for getFME.

## main-state-2

**queue.json and every download live in /tmp, which is RAM-backed tmpfs on current Linux** (medium, confirmed, bug) · `src/main/services.ts:39`

**Summary.** queue.json and every downloaded video live under app.getPath("temp")/karafriends_tmp. On Linux that is /tmp, which is tmpfs on Ubuntu 25.10+/26.04, Fedora and Arch, and is cleared at boot on older Ubuntu. A reboot or power loss therefore loses the saved queue and history, and on tmpfs every download takes RAM until 'Clear downloads' or a reboot, until the tmpfs cap makes downloads and saves fail.

**Scenario.** Linux host, mid-party: the laptop loses power or reboots. On relaunch queue.json is gone, so the queue and history are empty. Separately, over a long party each YouTube/Joysound/DAM video (tens to hundreds of MB) stays in RAM-backed /tmp until 'Clear downloads'. That builds memory pressure, and once the tmpfs cap (50% of RAM) fills, downloads and queue.json saves fail with ENOSPC (only logged by save()). On Windows, %TEMP% is also cleared by Storage Sense/Disk Cleanup.

**Suggested fix.** Save queue.json under app.getPath("userData"), moving an existing temp-folder file once at launch. Put downloads in a persistent cache folder, e.g. path.join(app.getPath("userData"), "downloads") or $XDG_CACHE_HOME/karafriends on Linux. Clear downloads keeps working, since folder.ts already skips queue.json*.

**Verifier.** CONFIRMED: services.ts:39 puts queue.json in TEMP_FOLDER, and downloads/index.ts:47 sets TEMP_FOLDER = app.getPath("temp")/karafriends_tmp, which is os.tmpdir() (/tmp) on Linux. On this Ubuntu 26.04 laptop, `findmnt /tmp` shows tmpfs. Even on a disk-backed /tmp, Ubuntu's tmpfiles setup clears it at boot, so a reboot or power loss loses queue.json on any Ubuntu. The downloads are 720p mp4s (yt-dlp -S res:720) and DAM HLS remuxes, roughly 50-100 MB a song. They stay in RAM-backed tmpfs until 'Clear downloads' or a reboot, so a long party holds GBs of RAM, and at the tmpfs cap save() and the downloads fail with ENOSPC. Windows keeps queue.json on disk, so the RAM cost is Linux-only (tmpfs distros). It is a real cost on a less common platform and path, so medium.

**Also reported as** (queue.json and downloads live in /tmp, which is tmpfs on this Linux laptop. Move both to userData or the XDG cache.):

- main-downloads-4: Downloads and queue.json live in app.getPath("temp"), which is tmpfs (RAM) on this Linux laptop, with no size cap (`src/main/downloads/index.ts:47`). Its fix: Keep downloads on disk: path.join(app.getPath("userData"), "downloads"), or the XDG cache dir (~/.cache/karafriends) on Linux. Move queue.json to userData. For long parties, optionally evict the least recently used files not in use once the folder passes a cap (clearFolder already knows what's in use).

## main-downloads-5

**DAM downloads start at once with no concurrency limit and compete with the song streaming on the TV** (low, plausible, performance) · `src/main/downloads/index.ts:82`

**Summary.** DAM downloads have no concurrency limit: each queued DAM song starts its ffmpeg HLS copy at once. On a bandwidth-limited VPN, a burst of them could compete with the current song's stream, but four parallel downloads here each ran at full speed (about 3.3x), so the stall isn't shown.

**Scenario.** At the start of a party, 8 guests each queue a DAM song (paxSongQueueLimit 1; admins have no limit). One ffmpeg here ran at speed≈3.3x of a ~2.4 Mbit/s stream, about 8 Mbit/s, so 8 at once want about 64 Mbit/s. The TV's HLS stream of the current song (useSongPlayer streams while the file isn't there) stalls mid-song. On a slow VPN each copy can also pass TOOL_TIMEOUT_MS (15 min), delete its .tmp and fail, so all that bandwidth is wasted.

**Suggested fix.** Run DAM downloads through a small limiter of their own (1-2 at a time, next-up song first). The slot pattern in queue.ts can be reused with a separate counter.

**Verifier.** PLAUSIBLE: It's true that downloadDamVideo starts an ffmpeg HLS copy for every new songId-suffix right away (index.ts:72-89; api.ts:624-636 calls it for each queued DAM song), with no limit. But the claimed cost isn't shown, and this laptop's own logs argue against it. dam-7610-20, dam-7610-92, dam-7639-96 and dam-7610-34 ran at the same time (about 13:26-13:27). Each ran at 3.15-3.39x, the same as the solo dam-1208-61 (3.13x), so per-download speed looks bound by sequential segment latency, not bandwidth, and four at once didn't slow each other. A stall of the TV's ~2.4 Mbit/s stream at 8 parallel downloads depends on the VPN's capacity and is unproven. A burst like that lasts about 80 s, and the 15-minute timeout would need each download below 0.3x. A limiter could help on a slow link, but the stated impact is speculative.

## main-downloads-6

**Interrupted or failed downloads leave large partial files that nothing ever sweeps** (low, confirmed, bug) · `src/main/downloads/index.ts:167`

**Summary.** damJob never removes a stale <songId>-<idx>.mp4.tmp. YouTube and Niconico pass a no-op cleanUp, and their finally deletes the .tmp marker, so yt-dlp's .part and .f<id> files from a failed or timed-out run stay. prepareTempFile won't treat them as half-done next time either.

**Scenario.** The app is closed while a DAM song downloads. Right now /tmp/karafriends_tmp holds a 98 MB 7610-34-0.mp4.tmp from 13:28, and its log ends mid-progress with no 'karafriends:' line. It stays until someone queues that exact song and URL index again or presses Clear downloads. Likewise a YouTube download that times out leaves yt-<id>.f137.mp4.part and similar files. On tmpfs (see the TEMP_FOLDER finding) this is RAM.

**Suggested fix.** At startup, while downloadQueue is still empty, delete *.tmp, *.part, *.ytdl and _.f<digits>._ files that don't belong to a song in the restored queue (clearFolder's prefix logic already does this matching). Leaving YouTube .part files for resume is fine; the startup sweep bounds them.

**Verifier.** CONFIRMED: damJob (jobs.ts:194-202) checks only the final .mp4. A stale <songId>-<suffix>.mp4.tmp is overwritten (-y) only when that exact song and suffix are downloaded again. /tmp/karafriends_tmp holds a 98 MB 7610-34-0.mp4.tmp whose log ends mid-progress. YouTube and Niconico pass a no-op cleanUp (index.ts:167, 191), and their finally deletes the .tmp marker (jobs.ts:784-786, 843-845), so .part, .ytdl and .f<id> files from a failed or timed-out run stay. That includes the unmerged Niconico files from main-downloads-1, which on a retry are 'already downloaded' and fail the same way. Clear downloads does sweep them, and yt-dlp resumes a .part when the same video is queued again. So it's bounded, but nothing sweeps them on its own. Low.

## main-downloads-7

**The Joysound started-marker is deleted after compose, before the five pad steps, so a crash then caches an unpadded background for good** (low, confirmed, bug) · `src/main/downloads/jobs.ts:395`

**Summary.** composeJoysoundVideoPromise's finally unlinks tempFilename, which doubles as the 'download started' marker. padJoysoundVideoPromise then runs five ffmpeg steps and two renames on the final videoFilename with no marker left.

**Scenario.** A Joysound song gets a YouTube background about as long as the song, so padding runs. The app quits or crashes during the pad steps, leaving videoFilename as the composed but unpadded video, the .joy_02 and no .tmp. The next time anyone queues that song and background, queueDownloadedJoysoundSong plays the cached file with the background out of sync by `offset` ms (up to 10 s), from then on. The -no-sound, -pad and -concat files stay too.

**Suggested fix.** Keep the marker separate from the video input (e.g. the yt-dlp and Joysound download writes `${tempFilename}.video`, compose reads that), and unlink the marker as joysoundJob's last step, after padding.

**Verifier.** CONFIRMED: composeJoysoundVideoPromise's finally unlinks tempFilename, which is also the started marker (jobs.ts:389-396). joysoundJob then runs padJoysoundVideoPromise (jobs.ts:702-711): five ffmpeg steps, then the renames at :513-514. If the app quits or crashes in that window, videoFilename (composed, not padded), the .joy_02 and the pad leftovers remain, with no .tmp. queueDownloadedJoysoundSong (jobs.ts:561-574) then plays that cached file from then on. A pad step that fails normally is handled, since cleanUp's deleteTempFiles removes `${videoBaseName}.*`, so only a crash or quit matters. The window is a few seconds of stream copies, it only happens when a YouTube background is within 10 s of the song's length, and the effect is cosmetic: the background is misaligned by `offset` ms or loops at the end. Low.

## main-downloads-8

**ffmpeg's Duration line is parsed per stdout chunk, but ffmpeg writes it in pieces: progress can stick at NaN and compose can take the wrong duration** (low, confirmed, maintainability) · `src/main/downloads/jobs.ts:286`

**Summary.** Two inline Duration regexes (jobs.ts:286 and :375) run on single stderr chunks, and ffmpeg writes the Duration in pieces, so about 2% of runs under load miss it (none when idle). The Joysound video's progress then becomes NaN or 1, and the phone shows 'Finished Downloading' early. Compose's videoPlaytime stays 0, so a background that needed padding isn't padded. probeDuration's parseDuration reads the whole buffered output and isn't affected.

**Scenario.** In downloadJoysoundVideoPromise, if the split hides the Duration, songFrames stays 0. The first 'frame= 0' line then gives 0/0 = NaN, and Math.max(progress, NaN) keeps progress NaN for the rest of the download, which the phone receives as null. A frame>0 line gives Infinity instead, so progress jumps to 100%. In composeJoysoundVideoPromise, videoPlaytime stays 0 until the next Duration line, the ogg on stdin, is taken as the video's (the XXX at :379), so the pad decision and offset are computed from the wrong length.

**Suggested fix.** Line-buffer stderr in runTool (split on \r or \n, keep the remainder) and call onStderr per line. Use run.ts parseDuration everywhere (drops two parsers) and guard songFrames > 0.

**Verifier.** CONFIRMED: strace confirms that ffmpeg writes ' Duration: ' and the time in separate write(2) calls. I spawned ffmpeg as runTool does and checked each stderr chunk. With Node idle, 0 of 400 runs split the Duration. With 16 ffmpegs running in parallel, 23 of 1015 (about 2%) did, so it happens under load. Effects in downloadJoysoundVideoPromise: songFrames stays 0, so the first frame line gives NaN (frame=0, which then sticks) or Infinity (frame>0, so 100% at once). NaN goes out as null, and useDownloadButtonText treats null or >= 1 as done, so the phone says 'Finished Downloading' early. Two parts of the finding are wrong. In composeJoysoundVideoPromise the ogg on stdin prints 'Duration: N/A' (checked with a piped ogg), so it isn't taken as the video's length: videoPlaytime stays 0 and padding is skipped. And run.ts parseDuration isn't affected: probeDuration passes it the whole buffered stderr from execFile. Only the two inline parsers (jobs.ts:286, :375) run per chunk. Cosmetic, low.

## main-downloads-9

**Two downloads can truncate and garble one log: dam-<songId>.log across URL indexes, yt-<id>.log between a YouTube song and a Joysound background** (low, confirmed, bug) · `src/main/downloads/jobs.ts:222`

**Summary.** Log names leave out what makes a download unique. Both writers open the same file with flags 'w' at the same time, so each truncates it and then writes at its own offset.

**Scenario.** Guests queue DAM 1234-56 at streaming URL 0 and at 1 (two vocal types), which are two concurrent damJobs (index.ts dedupes by songId-suffix only). Both write dam-1234-56.log. Likewise YouTube song X and a Joysound song with X as background both write yt-X.log (jobs.ts:336, 779). The log the host opens to see why one failed is interleaved garbage. The guest-facing reason is unaffected, since it comes from the in-memory tail.

**Suggested fix.** Name logs like their outputs: dam-<songId>-<suffix>.log and joysound-<songId>-<bg>.yt.log, and update filePrefixes (folder.ts) to keep them with their song.

**Verifier.** CONFIRMED: damJob logs to dam-${songId}.log with freshLog (jobs.ts:222), and the download key includes the suffix (index.ts:79). queueSong doesn't dedupe DAM songs, and QueueButtons offers one button per streamingUrlIdx (vocal type), so two guests can run two DAM downloads of one song at once. The Joysound background (jobs.ts:336) and youtubeJob (jobs.ts:737) both use yt-<id>.log. runTool opens logs with flags 'w' (run.ts:91-93), so a second writer truncates the file while the first keeps writing at its own offset, and the log comes out interleaved. It needs two overlapping downloads (each about 80 s for DAM), and only the host's diagnostic log suffers; the guest's reason comes from the in-memory tail. Low.

## main-boot-upstream-10

**Quitting or restarting leaves yt-dlp and ffmpeg running** (low, plausible, bug) · `src/main/index.ts:310`

**Summary.** On Linux and macOS, runTool starts each tool detached in its own process group. Nothing stops running tools at quit or at restart's app.exit(0), so an ffmpeg can run on as an orphan and keep writing into karafriends_tmp. ffmpeg ignores SIGPIPE, so it isn't stopped by losing its pipes. Windows isn't affected.

**Scenario.** The host changes the port, presses Restart in Settings, or quits at the end of the night while a Joysound or YouTube song is downloading. ffmpeg or yt-dlp keeps running (CPU, bandwidth) and writing into karafriends_tmp. The relaunched app may start the same song's job on the same file names.

**Suggested fix.** Keep the set of running tool processes in run.ts and export stopAllTools(). Call it from app.on('will-quit') and in restart() before app.exit(0). killTree already handles both platforms.

**Verifier.** PLAUSIBLE: There's no before-quit or will-quit handler, and restart calls app.exit(0) (services.ts:173-176). That part is true. The Windows claim is wrong. On Windows detached is false (run.ts:128), and libuv puts every child spawned without UV_PROCESS_DETACHED into its global job object, which has JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. When the parent exits the job handle closes, and the cmd → yt-dlp → ffmpeg tree is killed, since descendants inherit the job. On POSIX, setsid'd children survive. When the parent dies their stdout and stderr pipes close. ffmpeg sets SIGPIPE to SIG_IGN and carries on until its conversion ends, which is bounded and a few minutes. yt-dlp, being Python, most likely dies with BrokenPipeError on its next progress write. So the orphans are short-lived ffmpegs on Linux and macOS, and only the restart-and-same-file overlap is a real if unlikely problem. Low.

## cross-maintainability-5

**Each download's file names are spelled out separately in five places across main and renderer** (low, confirmed, maintainability) · `src/main/downloads/folder.ts:22`

**Summary.** The download file names are built separately in jobs.ts, folder.ts filePrefixes, downloads/index.ts keys, api.ts's inUse suffix and isDownloading key, QueueButtons.tsx and useSongPlayer.ts. jobs.test.ts pins jobs' output names to literals, so a rename in jobs.ts alone would fail a test. Nothing checks that the other copies agree.

**Scenario.** Change one name in jobs.ts only, say DAM's video to dam-<id>-<idx>.mp4 next to its dam-<id>.log, or Joysound's "default" background suffix. The display's HEAD check then misses the file and streams every DAM song (useSongPlayer.ts:186), or loads a Joysound video that isn't there. clearDownloads stops recognising the playing file and deletes it. No test would catch this: folder.test.ts uses literal names, not the ones jobs.ts produces.

**Suggested fix.** Create one src/common/songFiles.ts with `downloadKey(item)`, which returns {kind, songId, suffix}, and `songFiles(key)`, which returns {video, telop?, captions?, prefixes}. jobs.ts, folder.ts, downloads/index.ts, api.ts, QueueButtons and useSongPlayer.ts (which prepends karafriends://local/) all call it. That removes about 30 lines and lets one test check that each job writes only files matching its prefixes.

**Verifier.** CONFIRMED: The duplication exists as described: jobs.ts:196/222/535-544/732-737/812-816, folder.ts:22-36, downloads/index.ts:79/102, api.ts:588-592 and :937-946, QueueButtons.tsx:44-48, and the karafriends:// URLs in useSongPlayer.ts. The names cross the main/renderer boundary, so a shared src/common module is a reasonable change. The finding overstates one point: 'No test would catch this' is wrong for jobs.ts. jobs.test.ts asserts the literal names it writes (e.g. 'joysound-123456-default.mp4', 'yt-…mp4', 'nico-sm9.mp4'), so a rename in jobs.ts fails a test. What goes untested is that folder.ts and the renderer agree with jobs.ts. The names have been stable, so this is low severity.

## tests-unit-3

**One failing assertion in jobs.test's yt-dlp slot test hangs the rest of the file and the CI job** (low, confirmed, test-gap) · `src/main/downloads/jobs.test.ts:121`

**Summary.** The yt-dlp slots are module globals (queue.ts:64-80). The slot test takes both slots and releases them only through the finish() calls at line 130. If any assertion at lines 121-128 fails first, both slots stay taken, and every later test in the file that runs yt-dlp waits forever: the Niconico download and the Joysound-with-background ones. node:test's default per-test timeout is Infinity, test:unit sets no --test-timeout, and no CI job sets timeout-minutes. The job then runs until GitHub's 6-hour limit and never reports the later tests.

**Scenario.** I copied jobs.test.ts to the scratchpad and changed only the assertion at line 121 so it fails. The run reported 3 tests (1 pass, 1 fail, the file cancelled) and was still hanging when my 90 s cap killed it. run.test.ts has the same shape. If runTool's timeout or abort handling regresses, the `node -e setInterval` child never exits, the promise never settles and the test hangs. The child is also detached into its own process group (run.ts:128), so it can outlive the runner.

**Suggested fix.** In the slot test, release the slots whatever happens: `t.after(() => { for (const f of finishers.values()) f(); })`. Give the tests that wait on child processes or the slots `{ timeout: 20_000 }`, as api.test.ts:649 already does. Add `--test-timeout=60000` to test:unit and `timeout-minutes: 45` to each build job, so a regression fails in minutes and names the test.

**Verifier.** CONFIRMED: I reproduced it myself (scratchpad/review/verify-tests-unit/jobs-hang.test.ts), changing only the assertion at line 121. The failure is reported at once, and the next test (Niconico, which waits for a yt-dlp slot in queue.ts:64-80 that is never released) then hangs until killed. That was 45 s in my run, exit 124. It also happens in-process. On this Node (v24.22.1), even a trivial `test(() => new Promise(() => {}))` keeps the runner alive instead of being cancelled when the event loop empties. So any never-settling promise hangs the run: a slot leak in queue.ts itself, or a runTool timeout regression in run.test.ts. No test has a timeout except api.test.ts:649. package.json has no --test-timeout, and build.yaml has no timeout-minutes. Low rather than medium: the hang only happens once some other assertion has already failed, the spec reporter streams that failure before the hang (checked mid-run), and the cost is a CI job that runs until GitHub's 6-hour cap instead of failing fast.

## oe-main-1

**Download wiring goes through four layers, and one of them repeats a check that can never pass** (over-engineering, KEEP, medium) · `src/main/services.ts:127`

**Now.** api.ts declares ApiDeps.downloads, 7 methods with full signatures (api.ts:108-141). services.ts:127-159 adapts each one with a lambda that only reorders arguments: it passes store.getState().downloadQueue, item.user, item.songId and upstreamClients.joysound. Those go into downloads/index.ts wrappers with 5 to 7 positional parameters (downloadJoysoundData, downloadYoutubeVideo, downloadNicoVideo, index.ts:106-194), then into queue.ts runDownload (7 positional parameters), then into jobs.ts. downloadYoutubeVideo and downloadNicoVideo are the same 20 lines except for kind, description and job. Each wrapper starts with alreadyDownloading() (queue.ts:255-263).

**Why it's more than needed.** Each wrapper in downloads/index.ts has exactly one caller: the matching lambda in services.ts. The lambdas add nothing beyond moving arguments around. The alreadyDownloading guard can't fire. queueSong already returns 'Someone is already adding this song' when isDownloading() is true (api.ts:584-595). Everything from that check to startDownload's push is synchronous, so there's no await in between. It's a leftover: the downloads-layer guard is from 5e3f746, and the API check came later in ff7810f (review #11). If the guard ever did fire, the phone would get ok:true and then hear nothing, because neither onReady nor onFailed is called.

**Simpler shape.** createDownloads(store, joysoundApi) in downloads/index.ts returns ApiDeps['downloads'] directly, reading user, songId and youtubeVideoId from the item. One helper serves YouTube and Niconico and takes the job. Delete alreadyDownloading and make queueSong's synchronous isDownloading check the single documented guard (update the jobs.ts:562 comment). If a downloads-side guard is wanted, put it at the top of the Joysound entry, before queueDownloadedJoysoundSong, and have it call onFailed.

**Saves.** About 33 lines of adapter lambdas in services.ts, about 40 lines in downloads/index.ts, and alreadyDownloading in queue.ts. The adapter layer goes, and so do the parameter lists that repeat what the queue item already holds.

**Risk.** Low. api.test.ts fakes ApiDeps.downloads and wouldn't change. A future caller that skips queueSong's check would no longer be refused silently. Keep one guard that reports through onFailed if that matters.

**Verifier.** The facts hold. alreadyDownloading can't fire: api.ts is the only caller of deps.downloads.joysound/youtube/nico (grep), and queueSong runs isDownloading() and then the downloads call synchronously, with no await in between (api.ts:586-595, then 654/685/708). Nothing else adds to downloadQueue, and serializeState saves it as []. The guard came over from videoDownloader in 5e3f746. The API check came later in ff7810f, whose message says the old path dropped the request with ok:true. The services.ts lambdas (127-159) only reorder arguments into wrappers that have one caller each. downloadYoutubeVideo and downloadNicoVideo differ only in kind, description and job. services.ts changes often (17 commits). One fix to the simpler shape: if a guard stays, it can't go in runDownload/startDownload. For Joysound it has to run before queueDownloadedJoysoundSong, which otherwise sees the running download's .tmp marker, deletes it (deleteJoysoundTempFiles) and starts a second download over the same files. That is what the 'First:' comment at index.ts:124 is about. The jobs.ts:562 comment ('downloadJoysoundData has checked that none is running') also has to point at queueSong once the guard goes.

## oe-main-9

**getJoysoundOggPlaytime hand-writes a byte search that Buffer.indexOf already does** (over-engineering, KEEP, low) · `src/main/downloads/jobs.ts:131`

**Now.** About 48 lines that search for the 'playtime=' tag with nested loops over subarray slices, read the length through a DataView, and build the value one character at a time with String.fromCharCode.

**Why it's more than needed.** Node's Buffer can find the tag, read the uint32, and decode the slice directly.

**Simpler shape.** `const at = ogg.indexOf('playtime='); if (at < 4) return NaN; const len = ogg.readUInt32LE(at - 4) - 9; return parseInt(ogg.toString('latin1', at + 9, at + 9 + len), 10);`, plus a missing-tag fixture test.

**Saves.** About 40 lines.

**Risk.** Low. Behaviour when the tag is missing should stay NaN, as it is now through parseInt(''). Cover it with a small fixture test.

**Verifier.** Confirmed. The function is about 48 lines of nested byte comparison, a DataView and per-character string building. Buffer.indexOf, readUInt32LE and toString('latin1') do the same job. jobs.test.ts already has an ogg(playtimeMs) fixture (line 166) that drives it through the Joysound job, so the swap is covered. Keep the 'missing tag → NaN' behaviour (today that's parseInt('')). The old loop also treats a partial tag at the buffer's end as a match and reads before the buffer when the tag is within 4 bytes of the start. The indexOf version with an `at < 4` guard is stricter, and no worse.
