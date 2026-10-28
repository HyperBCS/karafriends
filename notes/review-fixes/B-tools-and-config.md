# Phase B: Tools and config

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/common/externalResourcesPlan.ts, src/common/externalResources.ts, scripts/getExternalResources.mjs, src/common/downloadFailure.ts, src/common/configStore.ts, src/common/configSchema.ts (and the small getSettings surface in src/main/settings.ts for a load problem).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                           | Severity                     | Title                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [main-settings-tools-1](#main-settings-tools-1)   | High                         | Linux downloads yt-dlp's Python zipapp, which won't run on Ubuntu 22.04 (Python 3.10) or without python3                                                                          |
| [main-settings-tools-2](#main-settings-tools-2)   | High                         | macOS ffmpeg is an Intel-only build pinned to 6.1.1: no ffmpeg on Apple Silicon without Rosetta, and Update tools can never update it                                             |
| [main-settings-tools-3](#main-settings-tools-3)   | Medium                       | Linux re-downloads a 157 MB ffmpeg and unpacks about 1 GB on nearly every launch, while all downloads wait                                                                        |
| [main-settings-tools-5](#main-settings-tools-5)   | Medium                       | Windows: Update tools fails with EPERM while a DAM/YouTube download is running ffmpeg.exe or yt-dlp.exe                                                                           |
| [main-downloads-3](#main-downloads-3)             | Medium                       | "Requested format is not available" (an outdated yt-dlp) is classified as "Video unavailable", which hides the Update tools notice                                                |
| [main-settings-tools-4](#main-settings-tools-4)   | Medium                       | An unreadable config.yaml (e.g. a duplicated key) silently runs on defaults, and the first save overwrites the file                                                               |
| [main-settings-tools-6](#main-settings-tools-6)   | Low                          | config.yaml values are never checked against CONFIG_RULES at launch: `everyoneIsAdmin: off` makes every phone an admin, and an all-digit password loses its leading zero for good |
| [main-settings-tools-9](#main-settings-tools-9)   | Low                          | Partial-write recovery: no fsync before rename, a truncated config.yaml is read as 'empty = defaults', and versions.json is written in place                                      |
| [main-settings-tools-10](#main-settings-tools-10) | Low                          | The tools' single-flight/force/keep-cached logic has no tests because externalResources.ts does Electron and I/O at module load                                                   |
| [main-settings-tools-11](#main-settings-tools-11) | Low                          | getExternalResources.mjs: the ASIO SDK download has no timeout and no write-error handler                                                                                         |
| [oe-main-6](#oe-main-6)                           | Over-engineering (KEEP, low) | externalResources.ts writes its own retry loop and stall watchdog, which promise-retry and http.ts already provide                                                                |
| [oe-build-tests-6](#oe-build-tests-6)             | Over-engineering (WEAK, low) | Hand-rolled retry/backoff and a node-fetch stream pipe for one cached Windows-only download                                                                                       |

## main-settings-tools-1

**Linux downloads yt-dlp's Python zipapp, which won't run on Ubuntu 22.04 (Python 3.10) or without python3** (high, confirmed, bug) · `src/common/externalResourcesPlan.ts:193`

**Summary.** On Linux, assetPlans' default branch downloads `releases/latest/download/yt-dlp`, the Python zipapp (`#!/usr/bin/env python3`, refuses Python < 3.11). Windows and macOS get standalone builds. On Ubuntu 22.04, which the README says is supported and which ships Python 3.10.12, and on hosts with no python3, every YouTube download and Niconico lookup fails. The display then says 'try Update tools', but Update tools downloads the same zipapp again. Debian 12 (Python 3.11) is not affected.

**Scenario.** Ubuntu 22.04, or Debian/Arch minimal without python3: the app launches and the tools 'download fine'. Every YouTube download and every Niconico lookup or download then exits with 'ImportError: You are using an unsupported version of Python. Only Python versions 3.11 and above are supported by yt-dlp'. None of the YTDLP_ERRORS patterns match, so it is classed REASONS.other, which isToolProblem counts as a tools problem. The display then says 'YouTube downloads are failing; try Update tools'. Update tools downloads the same zipapp, so YouTube and Niconico never work on that machine. At launch, toolVersion also gets null each time.

**Suggested fix.** For Linux, download `${YTDLP_BASE}_linux` (and `_linux_aarch64` when process.arch is arm64). Keep the dest name `yt-dlp` so nothing else changes, and update the URL expectation in externalResourcesPlan.test.ts. Standalone builds unpack on each run (slightly slower start), but they bundle their own Python.

**Verifier.** CONFIRMED: externalResourcesPlan.ts:189-196: on Linux the yt-dlp URL is the bare YTDLP_BASE, the platform-independent zipapp. The cached copy on this laptop starts with `#!/usr/bin/env python3` followed by a PK zip. I unzipped yt_dlp/**init**.py, and line 3 is `if sys.version_info < (3, 11): raise ImportError('...Only Python versions 3.11 and above...')`. toolCommand spawns the file directly, so the shebang picks the system python3. On Ubuntu 22.04 that is Python 3.10.12, and README.md:15 explicitly says the Linux zip supports 22.04. The ImportError text matches none of the YTDLP_ERRORS patterns, so it becomes REASONS.other, which isToolProblem counts as a tools problem. Update tools re-downloads the same zipapp, so the loop never ends. Debian 12 (Python 3.11) is unaffected, so the README's other example is fine. 'No python3 at all' is rarer on desktop installs, but it is the same failure. Nothing guards it: assetPlans never checks process.arch or Python. The suggested fix is right: yt-dlp_linux / yt-dlp_linux_aarch64 are standalone builds, and the dest name can stay. This laptop runs Python 3.14, which is why it works here. | CONFIRMED: I could not refute it, and I reproduced it end to end.

1. **The asset.** externalResourcesPlan.ts:193 sets `url: YTDLP_BASE` for Linux. That is `.../releases/latest/download/yt-dlp`, and nothing in the plan looks at process.arch. Windows gets `yt-dlp.exe` and macOS gets `yt-dlp_macos`; both are standalone. The cached ~/.config/karafriends/externalResources/ytdlp/yt-dlp (version 2026.10.26 in versions.json) starts with `#!/usr/bin/env python3` followed by a zip. The zip's yt_dlp/**init**.py line 3 is `if sys.version_info < (3, 11): raise ImportError(...)`. externalResourcesPlan.test.ts:66 pins this URL.

2. **Real Ubuntu 22.04.** I ran a copy of that cached file, mounted read-only, in a throwaway `docker run --rm ubuntu:jammy` container:
   - Bare image: `/usr/bin/env: 'python3': No such file or directory`, exit 127.
   - After installing jammy's own python3-minimal (Python 3.10.12): `ImportError: You are using an unsupported version of Python. Only Python versions 3.11 and above are supported by yt-dlp`, exit 1.
   - The same failure happens with plain `--version`, so the at-launch version check (toolVersion) also returns null. Since no version gets recorded, it is asked again on every launch.

3. **Classification.** I fed both outputs to the real modules with `node --import tsx` (script: /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-main-settings-tools-1/classify.ts). `ytdlpFailureReason` returns "Download failed" (REASONS.other) for both, and `isToolProblem` returns true. So in api.ts:325-331, ytdlpFailed sets toolsProblem to TOOLS_PROBLEM ("YouTube downloads are failing; try Update tools in Settings"). The YouTube/Niconico jobs in jobs.ts:763/829 use reasonForExit: ytdlpFailureReason. Niconico lookups (downloads/index.ts:202, execFileAsync) reject on the same failure.

4. **Update tools can't fix it.** updateTools → check(true) → ensureAsset force re-downloads the same zipapp URL, so the problem comes back with the next YouTube song.

5. **Reachability.**
   - README.md:15 says the Linux zip supports "as old as Ubuntu 22.04 or Debian 12", and line 20 gives 22.04 its own apt line, which has no python3.
   - Ubuntu 22.04 is a still-supported LTS, and its desktop install always ships python3 3.10, so every 22.04 desktop host hits this. No configuration avoids it: /usr/bin/env python3 resolves to 3.10. The only escape is the undocumented workaround of pointing KARAFRIENDS_YTDLP_PATH at yt-dlp_linux.
   - Debian 12 (3.11.2), Ubuntu 24.04 (3.12), and current Fedora and Arch with python installed work. So the finding is right about 22.04 and does not overstate Debian 12.
   - The no-python3 case (minimal Arch or Debian) is real but less common on a desktop host.

6. **Severity.** The README says that outside Japan, or without a DAM or Joysound login, only YouTube and Niconico work. For an Ubuntu 22.04 host that can mean no songs at all, and the on-screen advice sends them in a loop. That is a feature fully broken in a common setup for that platform, so high stands. It stops short of critical only because Linux hosts are a subset and DAM/Joysound still work.

7. **Fix.** The suggested fix is sound:
   - Use `${YTDLP_BASE}_linux`, or `_linux_aarch64` on arm64, and keep dest `yt-dlp`.
   - Update test line 66.
   - A cached zipapp is replaced automatically: the stored etag won't match the new asset, so the conditional request gets a 200 and the new build is downloaded.
   - Cost: the standalone onefile build unpacks on every start, which makes Niconico lookups and downloads start a bit slower.

## main-settings-tools-2

**macOS ffmpeg is an Intel-only build pinned to 6.1.1: no ffmpeg on Apple Silicon without Rosetta, and Update tools can never update it** (high, confirmed, bug) · `src/common/externalResourcesPlan.ts:179`

**Summary.** darwin downloads evermeet's ffmpeg-6.1.1.zip for every arch. That binary is thin x86_64 (Mach-O cputype 0x01000007, checked from the zip itself). On the darwin-arm64 release without Rosetta, spawning it fails with EBADARCH (-86), so every Joysound, YouTube and Niconico song fails. Nothing catches it: the download only checks that the file exists, and Update tools downloads the same zip again. The pinned URL now 302s to a third-party mirror.

**Scenario.** An Apple Silicon Mac running the darwin-arm64 release (README.md:11), without Rosetta 2 installed (common on newer Macs; macOS only offers to install it for apps opened from Finder, not for a binary spawned by another process): spawning ffmpeg fails with 'Bad CPU type in executable'. DAM background downloads fail and are only logged. Every Joysound song fails, since runJoysoundFFmpeg needs ffmpeg, and so does every YouTube or Niconico song, since yt-dlp is given --ffmpeg-location. With Rosetta installed, ffmpeg runs under translation (slower), and Update tools downloads the same 2023 6.1.1 zip again forever. Apple plans to drop general Rosetta support after macOS 27, which makes this a time bomb.

**Suggested fix.** Pick the ffmpeg source by process.arch: a maintained arm64 macOS static build for darwin-arm64, and a current release URL instead of a pinned 6.1.1. Also, before finalize() swaps a new binary in, run `-version` on it in tmpDir and keep the old copy if it won't start. That catches a wrong-arch or broken download on every platform.

**Verifier.** CONFIRMED: externalResourcesPlan.ts:169-188 uses https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip on every darwin arch, and release.yaml builds a darwin-arm64 release. I fetched the first 64 KB of that zip (it 302s to the e.deolaha.ca:4242 mirror) and inflated the first entry. 'ffmpeg' is a thin Mach-O (magic cffaedfe) with cputype 0x01000007 = x86_64, not a universal binary. evermeet's release JSON says the current version is 9.0.2, so the pinned URL never moves, and Update tools fetches 6.1.1 again. On Apple Silicon without Rosetta, exec of an x86_64 binary fails (Bad CPU type). ffmpeg is used for DAM background downloads (jobs.ts:208), every Joysound job (runJoysoundFFmpeg) and yt-dlp's --ffmpeg-location (jobs.ts:329-330), so Joysound, YouTube and Niconico all fail. GitHub's macos-latest runners have Rosetta, so CI can't catch it. With Rosetta installed the songs work, just translated and stuck on 6.1.1. That limits the severe case to Macs without Rosetta, which is still common for an arm64-native app. I couldn't test macOS's exec-time behaviour here, but it is standard. The binary arch and the pin are verified. | CONFIRMED: I couldn't refute this, and I confirmed the parts that can be checked from here.

1. The darwin plan has no arch branch. src/common/externalResourcesPlan.ts:179 hardcodes https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip, and the darwin-arm64 build uses it too. release.yaml builds and ships karafriends-darwin-arm64.zip (PACKAGER_ARCH=arm64), and README.md:11 points Apple Silicon users to it. Every other binary that build runs is arm64-capable: Electron, the native module, and 7za, which packager.js picks by PACKAGER_ARCH. yt-dlp_macos is universal. That leaves ffmpeg as the only Intel-only binary.

2. The binary really is Intel-only. I fetched the first 64 KB of the zip (curl -r 0-65535, under the scratchpad dl/ dir), inflated the start of the "ffmpeg" entry with python -I and read its Mach-O header: magic 0xfeedfacf, cputype 0x01000007, a thin x86_64 file with no arm64 slice. The evermeet.cx/ffmpeg page today is titled "static FFmpeg binaries for macOS 64-bit Intel" and says "I do not plan to provide native ffmpeg binaries for Apple Silicon ARM". Its current release is 9.0.2.

3. The pinned URL still works for now, but it depends on a mirror. It 302s to https://e.deolaha.ca:4242/pub/ffmpeg/ffmpeg-6.1.1.zip. A ranged GET with node-fetch's UA gets 206 with last-modified 31 Dec 2023, so a GET still downloads. That host answers HEAD with 403. If it goes away, a first launch on any Mac throws "An external resource wasn't successfully downloaded!".

4. The path to failure: an Apple Silicon Mac without Rosetta 2. Rosetta isn't preinstalled; macOS offers to install it only when an Intel app is opened through LaunchServices. A child process exec'd by node gets EBADARCH, which node reports as "spawn Unknown system error -86".
   - ensureExternalResources still passes, because it only checks that the file exists. toolVersion fails and is only logged, so Settings shows no ffmpeg version.
   - Joysound: runJoysoundFFmpeg (jobs.ts:252) → runTool's proc.on('error') → DownloadFailure(toolFailedToStart, "Couldn't start the downloader"). Every Joysound song fails.
   - YouTube and Niconico (jobs.ts:766-773) pass `--recode mp4 --ffmpeg-location <x86 ffmpeg>`. yt-dlp starts, but it can't run ffmpeg to recode, so the song fails.
   - DAM still plays from HLS; only its background ffmpeg download fails, and that is only logged.
   - Update tools (force) downloads the same x86 6.1.1 zip again, so it can't repair this.
   - With Rosetta installed, everything works under translation, pinned to a 2023 build.

On the scale, this is high: on an Apple Silicon Mac without Rosetta, which is a realistic setup for a newer Mac in 2026, three of the four song sources fail every time, with no hint at the cause. It isn't critical, because DAM still plays, nothing crashes, and Macs that have Rosetta work. Calling Update tools "never updating" is accurate, but that part on its own is low (it's a maintainability issue). The file and line are correct: externalResourcesPlan.ts:179, and the test at externalResourcesPlan.test.ts:56 pins the same URL.

## main-settings-tools-3

**Linux re-downloads a 157 MB ffmpeg and unpacks about 1 GB on nearly every launch, while all downloads wait** (medium, confirmed, performance) · `src/common/externalResourcesPlan.ts:201`

**Summary.** Linux ffmpeg comes from BtbN's `latest` release, `ffmpeg-master-latest-linux64-gpl.tar.xz`, which is rebuilt and re-uploaded about daily. The ETag therefore changes daily, and the launch check (externalResources.ts:220-243) sends a conditional request every launch with no staleness gate when a validator exists. So any launch on a new day gets a 200: 157 MB, then two 7za passes into os.tmpdir() that extract the whole tar flat (ffmpeg, ffprobe, ffplay, docs).

**Scenario.** The host starts karafriends on Linux the evening of a party. The launch check starts a 157 MB download (about a minute at 20 Mbps, much longer on venue Wi-Fi or a phone hotspot). Every Joysound, YouTube and Niconico song queued meanwhile waits in jobPaths(), since ensureExternalResources is single-flight. Peak temp use is the .tar.xz plus the .tar plus the flat-extracted binaries, about 1.2 GB. That lands in RAM where /tmp is tmpfs (this Ubuntu 26.04 laptop: tmpfs 7.4G; Fedora too). It happens again the next day, and it tracks ffmpeg master rather than a release.

**Suggested fix.** Check ffmpeg only when its cached copy is older than STALE_MS, or on Update tools, even when a validator exists. yt-dlp is the tool that must stay current, and its check can stay per launch. Better still, use a release-branch or dated autobuild. Extract only the binary: pass the `*/bin/ffmpeg` path with `-r` to the second `7za e`, which saves about two thirds of the temp space.

**Verifier.** CONFIRMED: ensureAsset (externalResources.ts:214-243) skips the network only when there is no validator (canSkipUnvalidated). With a stored ETag it always makes a conditional GET, and any 200 means a full download plus the materialize steps. A HEAD on the BtbN URL today returned etag "0x8DF345CC969AFB5" (the one in versions.json), content-length 157320908 and last-modified Tue 27 Oct 19:02. The GitHub API shows the 'latest' release asset re-created 2026-10-27T19:01:47Z (BtbN autobuilds daily from master). So the first launch after each rebuild, roughly once a day and so effectively every party, re-fetches 157 MB. The steps are `7za e` of the .tar.xz, then `7za e` of the whole .tar with no filter. index.ts:304 starts this at launch, and jobPaths() (downloads/index.ts:51-61) plus lookUpNicoVideoInfo await the same single-flight promise, so Joysound, YouTube and Niconico downloads queued meanwhile wait. DAM still streams. /tmp is tmpfs here (7.5G), so the roughly 1 GB temp peak lands in RAM. Correction: 'nearly every launch' is really 'the first launch after each daily rebuild'.

## main-settings-tools-5

**Windows: Update tools fails with EPERM while a DAM/YouTube download is running ffmpeg.exe or yt-dlp.exe** (medium, plausible, bug) · `src/common/externalResources.ts:166`

**Summary.** finalize() copies the new binary to `${dest}.part` and then renames it over dest. On Windows, an executable that is running can be renamed but not replaced, so MoveFileEx(REPLACE_EXISTING) fails with access denied. The forced check doesn't wait for running jobs, and only downloads that start later wait on ensurePromise.

**Scenario.** During a party, the display shows 'YouTube downloads are failing; try Update tools'. The host presses it while a queued DAM song's background ffmpeg download or another YouTube download is running. The rename of ffmpeg.exe.part (or yt-dlp.exe.part) over the running exe fails, and updateTools answers 'Couldn't update the tools: EPERM: operation not permitted, rename …'. The tools problem isn't cleared, and an approximately 170 MB ffmpeg.exe.part is left in userData. The host has to guess that waiting for downloads to finish would help.

**Suggested fix.** On win32, rename dest to `${dest}.old` first (allowed for a running image), then rename .part into place, then delete .old (ignore failure, and clean up stale .old/.part files at the next launch). Alternatively, make the forced check wait for in-flight jobs. Remove the .part file when the rename fails.

**Verifier.** PLAUSIBLE: The code path holds. finalize() (externalResources.ts:162-167) does copyFile to dest.part, then fs.rename over dest, which libuv runs as MoveFileExW(REPLACE_EXISTING). updateTools → check(true) → doEnsure(true) re-downloads ffmpeg every time (force skips the conditional headers) and doesn't coordinate with running jobs. ffmpeg.exe is often running at a party: api.ts:617-645 starts downloadDamVideo for every queued DAM song, and Joysound jobs run ffmpeg several times. Windows refuses to replace or delete a file backing a mapped image section, which would surface as EPERM. Promise.allSettled lets yt-dlp update while ffmpeg fails. doEnsure then rethrows, updateTools returns 'Couldn't update the tools: EPERM…', and services.ts:186-191 doesn't clear toolsProblem. The .part file is overwritten on the next try, so it doesn't grow. I couldn't run it on Windows, so the OS behaviour is documented, not observed. Waiting and retrying works, which keeps this at medium.

## main-downloads-3

**"Requested format is not available" (an outdated yt-dlp) is classified as "Video unavailable", which hides the Update tools notice** (medium, confirmed, bug) · `src/common/downloadFailure.ts:97`

**Summary.** The bare `not available` alternative in the unavailable pattern matches yt-dlp's 'Requested format is not available', the usual symptom of an outdated yt-dlp. That reason isn't a tool problem, so guests see 'Video unavailable' and the display never suggests Update tools. (Niconico's real geo error is classified correctly as geoBlocked. Disk-full errors are counted as tool problems.)

**Scenario.** YouTube changes its player and the cached yt-dlp's nsig/SABR handling breaks. Every download prints "WARNING: ... nsig extraction failed ... ERROR: [youtube] <id>: Requested format is not available. Use --list-formats ..." (youtubeJob's -S, or the Joysound background's -f bv). Each guest is told "Video unavailable" and tries other videos, which fail the same way. toolsProblem is never set, so Settings' Update tools, the one fix, is never suggested. Smaller cases: "Niconico video is not available in your region" comes out as unavailable rather than geoBlocked, and "No space left on device" counts as a tools problem, which updating won't fix.

**Suggested fix.** Put an entry like [/requested format is not available|only images are available/i, REASONS.other] before the unavailable entry, or narrow `not available` to `video (is )?not available|isn't available`. Add those lines and the niconico region line to the ytdlpFailureReason cases. Optionally give ENOSPC its own reason that isn't a tool problem ("The karaoke PC's disk is full").

**Verifier.** CONFIRMED: A scratch run of ytdlpFailureReason on yt-dlp's real format error, 'ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats' (raised at YoutubeDL.py:3091-3093), returns 'Video unavailable', and isToolProblem returns false. The bare `not available` in the unavailable pattern matches it. That error is the usual result of a stale yt-dlp (nsig or SABR breakage leaves no usable formats), especially for the Joysound background's -f bv. So guests are told the video is unavailable and the Update tools notice never appears. downloadFailure.test.ts has no format-error case. One sub-claim is wrong: yt-dlp's niconico geo error is raise_geo_restricted's 'This video is not available from your location due to geo restriction', and the /geo.?restrict/ pattern runs first, so it classifies correctly as 'Not available in this country' (checked). ENOSPC ('No space left on device') does come out as 'Download failed', which counts as a tools problem.

## main-settings-tools-4

**An unreadable config.yaml (e.g. a duplicated key) silently runs on defaults, and the first save overwrites the file** (medium, confirmed, bug) · `src/common/configStore.ts:68`

**Summary.** When parsing fails, loadAtLaunch copies the file to config.yaml.broken, logs to the console and returns the defaults. Nothing reaches the display: getSettings has no load problem to report. The host sees the first-run Settings screen ('no login set'). The next store.update writes `{...defaults, ...change}` over config.yaml, so the logins, admin password, port and queue settings survive only in a .broken file no UI or README mentions.

**Scenario.** A user hand-edits config.yaml (old versions required it) and appends `supervisedMode: true` while the original `supervisedMode: false` line is still there. yaml 2.9 throws DUPLICATE_KEY (line 3). At launch the app opens on Accounts as if the logins were wiped. The host retypes the DAM login, and config.yaml is rewritten with defaults plus that login. The Joysound login, admin password hash and other settings are gone from the live file. The console's 'Fix the YAML and relaunch' advice is useless by then, because config.yaml is now valid.

**Suggested fix.** Keep the load problem in the store (e.g. `loadProblem: string | null`) and return it from getSettings. Show it at the top of Settings, e.g. 'config.yaml couldn't be read (line 3); your settings are in config.yaml.broken — fix it and restart, or Import config from it'. Also parse with `uniqueKeys: false` (last one wins, plus a warning), so the most likely hand-edit mistake isn't fatal.

**Verifier.** CONFIRMED: Probed with the repo's yaml 2.9.0 via createConfigStore in scratch. A file with a duplicated supervisedMode key throws DUPLICATE_KEY. loadAtLaunch's catch (configStore.ts:68-90) copies it to .broken, logs, and returns the defaults without writing back. After store.update({damUsername, damPassword}), config.yaml held only the defaults plus the DAM login. The Joysound login, adminPasswordHash and adminPasswordSalt were gone from the live file and survive only in config.yaml.broken. Nothing outside configStore.ts mentions 'broken' (I grepped src, tests, README and CHANGELOG), and getSettings (settings.ts:164-180) returns only settings/isFirstRun/needsRestart, so the display gets no hint. Other plausible hand-edit triggers fail the same way, e.g. a password starting with @ (BAD_SCALAR_START) or *. The data isn't destroyed, since .broken keeps it, but nothing tells the host it exists. Medium is right.

## main-settings-tools-6

**config.yaml values are never checked against CONFIG_RULES at launch: `everyoneIsAdmin: off` makes every phone an admin, and an all-digit password loses its leading zero for good** (low, confirmed, bug) · `src/common/configSchema.ts:131`

**Summary.** configFromFile merges the parsed file over the defaults unchecked. Only adminPasswordHash/Salt get a type check. YAML 1.2 (the yaml lib's default) reads yes/no/on/off as strings and digit-only text as numbers. The live config then holds truthy strings for booleans and numbers for passwords, and loadAtLaunch writes the coerced values back to the file.

**Scenario.** (a) A hand-written `everyoneIsAdmin: off` or `supervisedMode: no` loads as the string 'off'/'no'. api.ts:201's `config.everyoneIsAdmin || isRealAdmin(caller)` is then true for every phone, and supervised mode turns on although the user wrote no. (b) `damPassword: 01234567` loads as the number 1234567, so DAM login fails. Launch writes `damPassword: 1234567` back, so the original text is gone from the file too. Long digit strings become floats (123456789012345678901 → 123456789012345680000). Unknown or typo keys (`damUserName`) are kept silently and then reported as 'Dropped' when that same export is imported.

**Suggested fix.** After the merge, check each known key with its CONFIG_RULES rule, reset a bad value to its default and add a problem line, the same way the hash and salt are handled. For the TEXT keys, take the value from a second `parse(text, { schema: 'failsafe' })`, where every scalar is a string, so '01234567' survives. Warn about unknown keys at launch too.

**Verifier.** CONFIRMED: Probe: a file with `damPassword: 01234567`, `supervisedMode: no`, `everyoneIsAdmin: off` and `damUserName: typo` loads as damPassword 1234567 (a number), supervisedMode 'no', everyoneIsAdmin 'off', with damUserName kept. Launch writes all of that back unquoted (configStore.ts:98). configFromFile (configSchema.ts:102-134) type-checks only the hash and salt, and api.ts:201/215 use the values as truthy. I'm re-rating to low for three reasons. It needs a hand-edit using YAML 1.1 words or an unquoted all-digit password. The app's own writes use true/false and quote numeric-looking strings. And the oldest config.ts in git used the same parser unchecked, so a config from an old version that worked loads the same way. The UI also shows the real state: Settings' Checkbox gets checked='off', which is truthy, so 'Everyone is an admin' shows on and one click fixes it. Test login fails for the mangled password, and retyping it in Settings saves a string. A real but uncommon mismatch with import, which does run configProblems.

## main-settings-tools-9

**Partial-write recovery: no fsync before rename, a truncated config.yaml is read as 'empty = defaults', and versions.json is written in place** (low, plausible, bug) · `src/common/configStore.ts:38`

**Summary.** writeConfigFile does writeFileSync(tmp) then renameSync with no fsync. It also runs on every launch (line 98) even when nothing changed. A zero-length config.yaml parses as null, which counts as a valid empty file (line 58), so it gets the defaults and no .broken copy. externalResources.ts:87 writes versions.json in place, with no temp file.

**Scenario.** The karaoke PC loses power (or someone pulls the plug at the end of a party) shortly after launch's write-back, or after a settings save. On NTFS the rename can be durable before the data, which leaves a zero-length config.yaml. The next launch silently loads defaults and writes them back: logins and admin password gone, and no .broken copy. For versions.json, a torn write reads as {}, so validators are lost and the tools are re-fetched once the 7-day staleness passes. That part is minor and self-healing.

**Suggested fix.** Open the tmp file, write, fsyncSync, close, then rename. Skip the launch write-back when the serialized text equals what was read. Treat an existing zero-length (or all-NUL) config.yaml like a broken one: set it aside and surface it, as in the broken-config finding. Write versions.json through the same tmp+rename helper.

**Verifier.** PLAUSIBLE: The code facts hold. writeConfigFile (configStore.ts:38-43) does writeFileSync then renameSync with no fsync, and it runs on every launch (:98) even when nothing changed. Probe: a zero-length config.yaml loads as defaults and is written back with no .broken copy. An all-NUL file is treated as broken and set aside. writeVersions (externalResources.ts:85-88) writes in place, and readVersions turns a torn file into {}, which only costs a re-check. The data-loss case needs a power loss within seconds of a write, on a filesystem that can commit the rename before the data. ext4's default auto_da_alloc mitigates replace-by-rename, and NTFS ordering isn't reproduced. Rare, low.

## main-settings-tools-10

**The tools' single-flight/force/keep-cached logic has no tests because externalResources.ts does Electron and I/O at module load** (low, confirmed, test-gap) · `src/common/externalResources.ts:365`

**Summary.** check(), doEnsure() and ensureAsset() hold the risky rules: a forced failure must not reject the shared promise while both tools exist, a failed refresh keeps the cached copy, a failed non-forced check is retried, and a 304 changes nothing. The last review's Medium #3 was a bug in exactly this code. Only the pure plan module is tested, because this file reads app.getPath/app.isPackaged at import.

**Scenario.** A later edit to check(), e.g. returning `promise` instead of `run` for force, or dropping the `ensurePromise === promise` guard, brings back 'every download queued during Update tools fails with no tools'. No unit test catches it, and the e2e suite copies real tools rather than exercising updates.

**Suggested fix.** Wrap the side effects in a `createToolsManager({ fetch, fs, exec, now, paths, overrides })` factory, with externalResources.ts as a thin Electron wiring of it. Then write about six node --test cases with fake fetch/fs for the rules above. That moves roughly 250 lines without changing behaviour.

**Verifier.** CONFIRMED: The facts hold. There is no externalResources.test.ts, and only externalResourcesPlan.test.ts covers the pure module. externalResources.ts reads app.isPackaged/app.getPath at module load (:46-71), so node --test can't import it. The e2e fixture (tests/e2e/fixtures.ts:195-216) copies installed tools, and downloadFailure.spec only checks updateTools is display-only. The check()/doEnsure() promise rules (:358-402) are where the prior round's Medium #3 bug was (product review row 3). Worth a test, but a smaller change than the suggested ~250-line factory also works: move check()'s single-flight/force logic into a tiny pure helper taking doEnsure and toolsPresent callbacks, and test that.

## main-settings-tools-11

**getExternalResources.mjs: the ASIO SDK download has no timeout and no write-error handler** (low, confirmed, build-ci) · `scripts/getExternalResources.mjs:59`

**Summary.** fetchWithRetries has no AbortController timeout, so a hung connection never rejects. downloadFile listens for res.body 'error' and fileStream 'finish', but never for fileStream 'error'. The runtime copy of this logic in externalResources.ts fixed both (a 30 s header timeout and a 60 s stall watchdog), but the build script never got the fixes.

**Scenario.** On a Windows CI runner or dev box, steinberg.net accepts the connection and then stalls. `yarn dev`/`build-*` hang with no output until the job's 6 h timeout. A disk-full or permission error on the temp archive becomes an unhandled 'error' event that crashes the script with a bare stack, not the 'ASIO SDK wasn't successfully downloaded' message.

**Suggested fix.** Add a 30 s AbortController around fetch and a fileStream 'error' → reject, or share one small download helper (plain .mjs) between the script and externalResources.ts so the fixes live in one place.

**Verifier.** CONFIRMED: scripts/getExternalResources.mjs:36-57 calls fetch(url) with no signal or timeout (node-fetch 3.3.2 has none by default), so a stalled connection never rejects. downloadFile (:59-67) has no fileStream 'error' handler and no stall watchdog, unlike externalResources.ts:107-121/128-156. It only matters on Windows when buildResources/asio is missing (first dev build, or a CI cache miss keyed on this script's hash), so it rarely runs. Still a cheap, real robustness gap, so low.

## oe-main-6

**externalResources.ts writes its own retry loop and stall watchdog, which promise-retry and http.ts already provide** (over-engineering, KEEP, low) · `src/common/externalResources.ts:94`

**Now.** fetchAsset (externalResources.ts:90-124) has its own exponential-backoff loop and its own AbortController header timeout. streamToFile (126-156) has its own stall watchdog that re-arms on every 'data' event. promise-retry is already a dependency (damApi.ts, joysoundApi.ts). http.ts's httpFetch already times out on silence, both before the headers and between body chunks (http.ts:70-130). This file also imports node-fetch directly. stack-review-runtime.md:152 kept node-fetch for the tunnel proxy agent, and 2a122f7 removed that proxy.

**Why it's more than needed.** There are three hand-written fetch wrappers for one job: fetch with a timeout, then retry. The download-stall logic is the same idea as http.ts's silence timer, written a second time. node-fetch's reason to stay is gone, and it now costs a direct dependency (with 4 transitive ones) and the `counter` hack in ResponseInit (http.ts:121-130).

**Simpler shape.** `promiseRetry({ retries: 5, factor: 2, minTimeout: 1000 }, (retry) => httpFetch(url, { headers, timeoutMs: 60_000 }).then((r) => { if (!r.ok && r.status !== 304) throw new Error(String(r.status)); return r; }).catch(retry))`, then `await pipeline(res.body, fs.createWriteStream(dest))` from stream/promises. Removing node-fetch comes later: http.ts on global fetch (getSetCookie(), redirect:'manual'), checked against the Joysound login, plus scripts/getExternalResources.mjs.

**Saves.** About 55 of the 65 lines in fetchAsset and streamToFile, one of the three fetch wrappers, and later one dependency plus the ResponseInit cast.

**Risk.** Low to moderate. httpFetch uses one timeout for both headers and body, so pick 60 s. externalResources lives in src/common but only main imports it, so importing ../main/http is fine. The Joysound login depends on Set-Cookie and on manual redirects. Test that on global fetch before removing node-fetch.

**Verifier.** Right that fetchAsset and streamToFile re-implement httpFetch's silence timer (before the headers and between body chunks) and promise-retry's backoff. node-fetch's stated reason (the tunnel proxy agent) went with 2a122f7. But the proposed code breaks one behaviour. promise-retry only retries when fn calls retry(err); a rejection from httpFetch (connection reset, timeout) ends the retries (node_modules/promise-retry/index.js: only EPROMISERETRY errors retry). fetchAsset's comment says some CDNs reset the connection instead of answering with an error, so thrown errors must retry too. Other notes: merging the 30 s header timeout and the 60 s stall timeout into one 60 s value is fine. externalResources imports electron, so it is main-only and importing ../main/http (or moving the file to src/main) is fine. Removing node-fetch later also means changing scripts/getExternalResources.mjs and getSetCookies (headers.raw()). The module is stable, and this saves about 50 lines, so low.

## oe-build-tests-6

**Hand-rolled retry/backoff and a node-fetch stream pipe for one cached Windows-only download** (over-engineering, WEAK, low) · `scripts/getExternalResources.mjs:36`

**Now.** `fetchWithRetries` (5 retries, exponential backoff, catching thrown network errors) plus `downloadFile` (node-fetch body piped into a write stream, with a hand-made promise) make about 35 lines. Their only use is fetching the ASIO SDK from steinberg.net, Windows only, skipped when buildResources/asio exists, and cached in CI by actions/cache. The chmod comment at l.22 blames "Yarn PnP", which the repo no longer uses (nodeLinker: node-modules).

**Why it's more than needed.** The retry was built (9ee724f) for johnvansickle.com resetting CI connections while the script downloaded ffmpeg/yt-dlp on every build. That download moved to runtime (80b08e0), leaving a single cached request. Node's global fetch plus `fs.writeFileSync` does the download, and promise-retry is already a dependency if retries are still wanted. The chmod itself is still needed: macOS 7za in node_modules has no exec bit, and packager.js spawns it to zip.

**Simpler shape.** `await promiseRetry((retry) => fetch(url).then((r) => r.ok ? r : Promise.reject(new Error(String(r.status)))).catch(retry), { retries: 5 })`, then `fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()))`, using global fetch. Reword the chmod comment to say that 7zip-bin's macOS binaries ship without the exec bit. Keep a retry: releases don't cache buildResources.

**Saves.** About 30 lines, a bespoke retry loop and a stream/promise dance. The script stops importing node-fetch.

**Risk.** Low. A Steinberg blip on a cold CI cache fails the Windows job once instead of being retried.

**Verifier.** The reviewer's history is partly wrong. Retries date from bbcb341 (#75). 9ee724f only extended them to thrown network errors. The 'cached in CI' claim holds only for build.yaml. release.yaml's Windows job has no actions/cache, so every release downloads from steinberg.net fresh, and a fresh Windows dev checkout does too. A retry still has some value there, so dropping it loses something. Swapping to global fetch plus writeFileSync plus promiseRetry (already a dependency) keeps the behaviour and saves about 20 lines, but node-fetch stays in package.json for src/main/http.ts and src/common/externalResources.ts. The stale 'Yarn PnP' comment is a real doc nit (.yarnrc.yml has nodeLinker: node-modules). The chmod is still needed: node_modules/7zip-bin/mac/*/7za is -rw-rw-r--, and packager.js spawns path7za to zip.
