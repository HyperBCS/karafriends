# Phase A: Party basics: wake lock, one instance, mDNS, no phone notifications

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/main/index.ts, src/main/mdns.ts, src/common/ipAddresses.ts, src/renderer/HostnameSetting.tsx, the notification files (src/remocon/hooks/useQueueNotifications.ts, static/notificationServiceWorker.js, src/main/middleware/, the Settings row in src/remocon/pages/SettingsPage.tsx, notification i18n keys, .oxlintrc entry, its e2e test).

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                               | Severity                      | Title                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [gap-sleep-resume-power-1](#gap-sleep-resume-power-1) | High                          | Nothing keeps the screen on or the laptop awake between songs                                                                                              |
| [main-boot-upstream-7](#main-boot-upstream-7)         | High                          | mDNS query handling reads only the first question, compares names case-sensitively and never replies unicast                                               |
| [common-contract-1](#common-contract-1)               | Medium                        | karafriends.local mDNS answers include bogus A records made from IPv6 addresses, plus VPN/virtual adapters; the QR address picker offers invalid IPv6 URLs |
| [main-boot-upstream-3](#main-boot-upstream-3)         | Medium                        | No single-instance lock: a second launch runs a second display that shares queue.json, admin sessions and downloads                                        |
| [remocon-queue-2](#remocon-queue-2)                   | Medium                        | 'Up soon' notifications repeat on every queue change and every reload, stacking up; the 10-minute warning can come a song late                             |
| [main-boot-upstream-8](#main-boot-upstream-8)         | Low                           | A renderer that crashes on load is reloaded forever, with no limit or backoff                                                                              |
| [main-boot-upstream-9](#main-boot-upstream-9)         | Low                           | The F5 / Ctrl+R confirmation is a synchronous dialog that freezes the main process                                                                         |
| [main-boot-upstream-11](#main-boot-upstream-11)       | Low                           | Dead or duplicated boot code: the activate branch, a second withTimeout, and the Service-Worker-Allowed middleware                                         |
| [oe-architecture-1](#oe-architecture-1)               | Over-engineering (KEEP, high) | Phone notifications can't work on the plain-HTTP LAN remote, yet a whole feature is kept for them                                                          |
| [oe-main-10](#oe-main-10)                             | Over-engineering (KEEP, low)  | The Service-Worker-Allowed middleware no longer does anything                                                                                              |

## gap-sleep-resume-power-1

**Nothing keeps the screen on or the laptop awake between songs** (high, confirmed, bug) · `src/main/index.ts:299`

**Summary.** No powerSaveBlocker anywhere in the app, and while the QR/idle screen shows or a song is paused, no media is playing, so Chromium holds no display wake lock. After the OS display timeout with no input on the laptop, the TV blanks; on GNOME defaults (this laptop: idle-delay 300 s, lock-enabled, lock-delay 0) the session also locks at once. The QR code disappears and later songs play behind a locked screen until someone types the password. Idle suspend is a secondary risk: it's disabled on this laptop, and on Windows an open audio stream often blocks it anyway.

**Scenario.** The queue runs dry and guests eat for 10 minutes. Ubuntu blanks the screen after 5 minutes and locks it; Windows turns the display off at its timeout and sleeps after 15–30 minutes. The TV goes black and the QR code is gone, so newcomers can't join. With no signal, many TVs go to standby and drop their HDMI audio sink, which moves the default output (see the mic-output finding). When a guest then queues a song, it plays behind the black or locked screen: a wake lock taken at that point doesn't wake a display that is already blanked. The audio plays, the lyrics can't be seen, and someone has to walk to the laptop and type the password. If the laptop suspended, the HTTP server and mDNS disappear: phones' POSTs fail and EventSource keeps retrying until someone wakes the machine.

**Suggested fix.** In app.on("ready"), unless HIDE_WINDOW: `keepAwake = powerSaveBlocker.start("prevent-display-sleep")`. This also blocks system sleep; Chromium implements it with the ScreenSaver/SessionManager Inhibit on Linux and a display-required power request on Windows. Start it at launch rather than when the display goes idle, because taking a lock doesn't wake a screen that is already blank. Optionally add a Display setting, "Keep the screen on" (default on), that stops the blocker when turned off.

**Earlier reviews.** New

**Verifier.** CONFIRMED: A grep for powerSaveBlocker, powerMonitor or wakeLock across src and native finds nothing. createWindow (index.ts:166-186) and app.on("ready") (:299-308) take no lock. While idle, startSong(null) (useSongPlayer.ts:288-291) only re-arms the poll, so no media element plays. The only lock Chromium takes itself is MediaWebContentsObserver's, which needs an audible video. Its audio lock follows audibility and only prevents app suspension, not display sleep. Native cpal mic audio gives Chromium no lock, and fullscreen doesn't inhibit idle on GNOME or Windows. So the GNOME default (blank after 5 min, lock on blank) and the Windows defaults (display off at 5–10 min, sleep at 30 min plugged in) take effect whenever the queue sits empty, which happens at most parties. The README doesn't warn the host either. A wake lock taken later doesn't turn a blanked display back on, so the advice to start the blocker at launch is right. I couldn't run the app to watch it happen (not allowed here), but every link in the chain is code or well-known OS default behaviour. | CONFIRMED: I couldn't refute this. The trigger is reachable with this laptop's own settings.

1. Nothing in the app keeps the screen on. `git grep -i 'powerSave|wakelock|wake.lock|screenSaver|prevent-display|caffeinate'` over the repo (excluding .yarn and yarn.lock) finds nothing in src, native, packager.js or the docs. createWindow (src/main/index.ts:166-186) and the ready handler (:299-308) take no lock. Electron 43.4.1, the version installed, does provide `powerSaveBlocker`.

2. Nothing in the idle display holds a Chromium lock either. IdleScreen.tsx shows only the Settings button, the QR code and UpNext: no media element. The one `<video>` (Player.tsx:66) has no src while waiting. startSong(null) only calls setPlaybackState("WAITING") and schedulePoll() (useSongPlayer.ts:288-291), and a paused song calls video.pause() (:400-401). The mics play through the Rust/cpal mixer, which Chromium doesn't see. The AudioContext outputs silence. As I understand Chromium, its media wake locks are a display lock for a visible video that is playing, and a system-only audio lock that follows audibility. So the QR screen and a paused song hold no display lock. A fullscreen window doesn't stop screen blanking on GNOME or Windows.

3. This machine meets the trigger. I read the GNOME settings: org.gnome.desktop.session idle-delay = 300, screensaver lock-enabled = true, lock-delay = 0, idle-activation-enabled = true. So 5 minutes with no keyboard or mouse input on the laptop blanks the TV and locks the session at once. That happens with the queue empty for 5 minutes (food, a break) or a song paused that long, which is common at a party. The QR code goes away and someone has to type the password. GNOME's lock screen stays locked whatever lock an app takes afterwards, so a song queued later plays audio behind the lock screen.

Corrections to the failure scenario:

- The suspend half doesn't apply here: sleep-inactive-ac-type and sleep-inactive-battery-type are both 'nothing'.
- On Windows, as far as I know, an open WASAPI output stream (the AudioContext's, and the mic mixer's output) usually registers a system-required power request. That often blocks idle sleep, though not display-off. So the server and mDNS vanishing is the less likely half. The common effect is a blank screen, plus the lock on GNOME.
- Settings opened with the laptop's mouse resets the idle timer itself, so that example is weak.
- The TV dropping its HDMI audio sink is speculative.

Severity: the display feature (lyrics, QR code, Up next) breaks in a common situation, and recovery means walking to the laptop. Nothing crashes and no data is lost, so this is high, not critical.

Not demonstrated: I didn't start Electron, so no blank was reproduced. The code-side absence and the OS settings are verified; the Chromium wake-lock details are from my knowledge of its source.

The file and line (src/main/index.ts:299, the ready handler) are correct. The suggested fix is sound: start `powerSaveBlocker.start("prevent-display-sleep")` at launch unless HIDE_WINDOW, because a lock taken after the screen has blanked won't unblank or unlock it.

## main-boot-upstream-7

**mDNS query handling reads only the first question, compares names case-sensitively and never replies unicast** (high, confirmed, bug) · `src/main/mdns.ts:19`

**Summary.** The responder answers only by multicast to 224.0.0.251:5353 and ignores the query's source port. Android's system resolver (DnsResolver, from November 2021) resolves .local with RFC 6762 §5.1 one-shot queries from a random port other than 5353 and listens for the answer on that socket. So Android phones on Wi-Fi never get karafriends' answer, and the default karafriends.local QR code doesn't load for them. Two smaller problems: only questions[0] is checked, and the name match is case-sensitive.

**Scenario.** An Apple phone batches a pending PTR browse question with the A question for karafriends.local in one packet. questions[0] is the PTR, so karafriends stays silent, and the phone only resolves on a later retry that happens to send A alone. A resolver doing a one-shot query from a random port, such as `dig -p 5353 @224.0.0.251 karafriends.local` or legacy-unicast clients, never gets an answer.

**Suggested fix.** Use `query.questions.some(q => q.name.toLowerCase() === HOSTNAME && (q.type === 'A' || q.type === 'ANY'))`. When rinfo.port !== 5353, or the question has the QU bit, also respond to rinfo. The handler is about 10 lines and fits in the same test as the previous finding.

**Verifier.** CONFIRMED: mdns.ts:23 calls respond() without rinfo, so multicast-dns sends to me = 224.0.0.251:5353 (index.js:79). That datagram only reaches sockets bound to port 5353. I read AOSP packages/modules/DnsResolver res_send.cpp. send_mdns() → setupUdpSocket() → random_bind() picks `1025 + arc4random_uniform(...)`, skips 5353, sends with sendto() to 224.0.0.251:5353 and [ff02::fb]:5353 without connect(), then waits 2 s in recvfrom() on that socket. It doesn't check the reply's ID. Android's docs (source.android.com/docs/core/ota/modular-system/dns-resolver) say getaddrinfo() resolves *.local this way, except on VPN and mobile data. So every Android A query reaches karafriends, gets a multicast answer the phone can't receive, and times out. A unicast reply to rinfo.address:rinfo.port would fix it, and the query ID and question should be echoed for stricter legacy clients. I didn't test on a device, and Chrome-on-Android → getaddrinfo is based on forum reports, not a test. The questions[0] issue (Apple batching other questions in front) is plausible but uncommon. Case sensitivity doesn't matter in practice, because browsers lowercase URL hosts. Raised to high because the legacy-unicast gap breaks the default QR code for Android guests.

**Also reported as** (One rewrite of the mDNS query handler fixes both: check every question, compare names case-insensitively, answer with the address on the querier's subnet, and also reply unicast to rinfo. That covers Android's one-shot queries and the VPN-routed multicast. Land it in the same PR as common-contract-1.):

- main-boot-upstream-1: mDNS replies go out through the Japan VPN, so karafriends.local stops resolving while the VPN is on (`src/main/mdns.ts:23`). Its fix: For each query, find the local IPv4 address whose subnet (address & netmask from os.networkInterfaces()) contains rinfo.address. Answer with that address only. Send the response unicast to rinfo (address and port) as well as by multicast. A unicast reply follows the LAN route, and it also covers legacy one-shot queriers. Another option is one multicast-dns instance per LAN interface (opts.interface = that address). Either way, a small test with an injected interface list should cover the choice.

## common-contract-1

**karafriends.local mDNS answers include bogus A records made from IPv6 addresses, plus VPN/virtual adapters; the QR address picker offers invalid IPv6 URLs** (medium, confirmed, bug) · `src/common/ipAddresses.ts:8`

**Summary.** ipAddresses() returns every non-internal address: IPv4 and IPv6 (always at least fe80 link-local), plus VPN, WSL and Docker adapters. mdns.ts answers an A query with all of them as type A. dns-packet encodes an IPv6 string as a garbage dotted-quad (0.0.0.0, 77.0.0.0, 222.0.0.0, …), so every host advertises bogus A records next to unreachable VPN/virtual ones. Some clients that try records in order may stall on them. The same list fills Settings > Address, where an IPv6 entry builds an unbracketed http://fe80::…:8080 that is not a valid URL.

**Scenario.** The host laptop has Wi-Fi plus any of: IPv6 (almost always, at least link-local), a VPN, WSL2/Hyper-V vEthernet, Docker or VirtualBox. A guest scans the default QR code (karafriends.local:8080). The phone's mDNS lookup gets several A records: for example 172.x (WSL), 192.168.1.20 (Wi-Fi), 0.0.0.0, 222.0.0.0. A client that tries them in order (Chrome tries addresses within one family one by one) can sit on an unreachable or public address until the connect times out before reaching the Wi-Fi one, or fail outright. The records have TTL 300, so the bad set stays cached for 5 minutes. A host who picks an IPv6 entry in Settings > Address gets a QR code phones can't open.

**Suggested fix.** In ipAddresses, keep only IPv4 (`iface.family === 'IPv4' || iface.family === 4`) and drop 169.254.0.0/16. In mdns.ts, use the query event's rinfo (`on('query', (query, rinfo) => …)`) to answer with the local IPv4 in the querier's subnet (address & netmask). Fall back to all IPv4 addresses. That's about 10 lines. If IPv6 is ever wanted in the picker, bracket it.

**Verifier.** CONFIRMED: ipAddresses.ts:8 filters only `!iface.internal`, so IPv6 (including fe80 link-local) and VPN addresses are kept. mdns.ts:24 sends each one as type "A". dns-packet 5.6.1 ra.encode calls ip.v4.encode on any string. I re-ran the check on this laptop (verify-common-contract/mdns.cjs) and the encoded answers decode to ['10.10.10.225','0.0.0.0','10.2.0.2','222.0.0.0','0.0.0.0','0.0.0.0']. Other typical IPv6 addresses come out as garbage too: fd00::1 → 77.0.0.0, fe80::1 → 109.0.0.0, and global 2601:/2a02:/240d: addresses → 0.0.0.0. Every host has at least link-local IPv6, so every karafriends.local answer carries bogus A records, plus the real but unreachable VPN or WSL addresses. For the picker, HostnameSetting.tsx:13 lists the raw addresses, and new URL('http://fe80::…:8080') throws Invalid URL, so picking an IPv6 entry gives a QR code no phone can open. I did not confirm how much the bogus records slow a phone down. iOS races addresses (Happy Eyeballs), so it is probably fine there. Chrome tries addresses one at a time, so whether it stalls depends on the order and whether the address is black-holed; a connect to 0.0.0.0 is usually refused quickly. Medium is a fair rating: bad records go out from every host, and the stall only happens on some clients.

**Also reported as** (Filtering ipAddresses() to IPv4 is one line and fixes both the junk A records and the IPv6 entries in the Address picker. gap-sleep-resume-power-4's question loop and TTL go with main-boot-upstream-7.):

- main-boot-upstream-6: mDNS answers send IPv6 addresses as garbage A records, plus the VPN and virtual-adapter addresses (`src/main/mdns.ts:24`). Its fix: Filter on family === 'IPv4' (in mdns.ts, or with a family option on ipAddresses so the renderer can bracket or skip IPv6). Answer with only the address whose subnet contains rinfo.address, which is the same change as the VPN finding. Add a unit test for the query handler with injected interfaces and a fake respond, covering IPv6, a VPN interface and multiple subnets.
- renderer-settings-2: The Address list offers IPv6 and VPN addresses; an IPv6 pick makes a QR URL phones can't open, and mDNS answers each IPv6 address as 0.0.0.0 (`src/common/ipAddresses.ts:8`). Its fix: Have ipAddresses() return IPv4 only (`iface.family === 'IPv4'`, or `=== 4` on older Node). That fixes the select and the mDNS answers together. Optionally drop or sort last any interface without a LAN-looking address, such as tun/wg/tailscale/docker/vEthernet, or at least label each option with its interface name so the host can tell Wi-Fi from VPN.
- cross-maintainability-4: mDNS answers karafriends.local with a 0.0.0.0 A record for every IPv6 address, and the Address picker offers those addresses (`src/common/ipAddresses.ts:8`). Its fix: Filter on `iface.family === "IPv4"` in ipAddresses. That one line fixes both callers. If IPv6 is wanted later, answer AAAA queries with the IPv6 addresses in mdns.ts and bracket them in the picker.
- gap-sleep-resume-power-4: mDNS answers carry junk A records: each IPv6 address becomes 0.0.0.0 or 222.0.0.0, plus VPN and virtual adapters (`src/main/mdns.ts:24`). Its fix: Loop over query.questions. For each question with name HOSTNAME and type A or ANY, answer with IPv4 addresses only, preferably just the ones on the subnet the query came from (match rinfo.address against each interface's cidr), falling back to all IPv4 addresses. Use TTL 120, RFC 6762's value for host records. Filter to IPv4 in ipAddresses() for the hostname list too, or bracket IPv6 addresses.

## main-boot-upstream-3

**No single-instance lock: a second launch runs a second display that shares queue.json, admin sessions and downloads** (medium, confirmed, bug) · `src/main/index.ts:299`

**Summary.** Nothing calls app.requestSingleInstanceLock(). Launching karafriends again starts a full second copy: another fullscreen display, another set of mics, and another writer of the same queue.json, adminSessions.json and karafriends_tmp folder.

**Scenario.** The host alt-tabs away from the fullscreen display and clicks the launcher again to bring it back, or double-clicks while the app is still starting. A second instance opens fullscreen on top of the first. Its HTTP server gets EADDRINUSE, and the display says 'port 8080 is in use… (another karafriends?)'. It loads the saved queue and pops the saved head song, so both displays play songs at once and its renderer opens the same mics again (doubled mic, or an exclusive-mode failure). Both processes rewrite TEMP_FOLDER/queue.json on every change, and the last writer wins, so songs guests queued on the first instance can be gone on the next launch.

**Suggested fix.** At the top of index.ts: `if (!app.requestSingleInstanceLock()) { app.quit(); }`. Skip the rest of the setup (mDNS, IPC, window) in that case. Add `app.on('second-instance', () => { rendererWindow?.restore(); rendererWindow?.focus(); })`. The lock is keyed to the user-data dir, and tests/e2e/fixtures.ts launches each instance with its own --user-data-dir and TEMP, so parallel e2e runs are unaffected.

**Verifier.** CONFIRMED: grep finds no requestSingleInstanceLock or second-instance anywhere in src, tests or packager.js, and Electron allows multiple instances by default. A second launch runs all of index.ts: mDNS (reuseAddr, so it works), IPC, a fullscreen BrowserWindow and startHttpServer. The server gets EADDRINUSE, and httpServer.ts:29-35 shows 'another karafriends?'. services.ts:39 loads the same TEMP_FOLDER/queue.json. TEMP_FOLDER is `${app.getPath('temp')}/karafriends_tmp` (downloads/index.ts:47), and serializeState saves the current song at the head of the queue, so the second display pops and plays the same song. Both processes save on every update() through the same `queue.json.tmp` and rename it into place (state.ts:256-275), so the last writer wins and the renames can race. The suggested fix is correct, and the e2e fixtures use their own --user-data-dir and TEMP (fixtures.ts:405-426). Medium fits: it needs an accidental relaunch.

## remocon-queue-2

**'Up soon' notifications repeat on every queue change and every reload, stacking up; the 10-minute warning can come a song late** (medium, confirmed, bug) · `src/remocon/hooks/useQueueNotifications.ts:69`

**Summary.** notifyDue runs whenever state.queue changes and notifies about every one of this phone's songs due within 10 minutes. It keeps no record of what it already announced and sets no `tag`. So every unrelated queue change, such as another guest queueing, a download finishing or a song ending, shows another notification. It also checks only on queue changes, so a song whose wait drops below 10:00 between changes isn't announced until the next change.

**Scenario.** A guest's song is 2nd in line, 8 minutes away. Over those 8 minutes, three other guests queue songs and one song ends. The guest's phone buzzes five times with "X is up in …", and Android stacks each one separately. Reloading the remote, or a mobile browser restoring a discarded tab, repeats it (`songs` goes from undefined to the queue). The other way round: the current song has 5:30 left and one 5:30 song is ahead, so the ETA is 11:00 when the current song starts. Nobody queues anything, so the next check is at the next song change. The guest gets 5:30 of notice instead of 10 minutes.

**Suggested fix.** Check on every render, but notify once per item key (`${songId}_${timestamp}`), when its eta first drops to ≤ 600. Keep the announced keys in a ref Set, mirrored to sessionStorage so a reload doesn't repeat them. Optionally add one more notification when the song becomes next. Pass `tag: key` so any repeat replaces the earlier notification instead of stacking.

**Earlier reviews.** Round 2 #3 (repeats on pause/resume/restart) and round 1 #22 (language switch) were fixed. The repeats on every other queue change and on reload remain.

**Verifier.** CONFIRMED: useQueueNotifications.ts:57-71: notifyDue runs on every change of `songs` (state.queue; mergeLiveState keeps its identity only when it is JSON-equal). It notifies every `isMine && eta <= 600` item and keeps no record of what it already announced. showNotification passes no tag, so service-worker notifications stack. Every queue add, a download finishing (pushSongToQueue) or popSong fires the notification again. On reload, `songs` goes from undefined to the array and the notification fires again. The late warning is also real: with no queue change, the next check comes only at the next popSong. Only phones that turned on notifications are affected, but at a busy party a guest gets many repeats for one song, which is enough to make people turn the feature off. Prior review: product round 2 #3 (repeats on pause/resume) was fixed by keying on state.queue, which narrowed the repeats but didn't stop them. The code comment shows the per-change behaviour is deliberate, but repeating for the same item has no purpose.

**Also reported as** (Notify once per item key, with a tag.):

- cross-performance-3: 'Up soon' notifications fire again on every queue change by anyone, and stack (`src/remocon/hooks/useQueueNotifications.ts:69`). Its fix: Keep a ref Set of song keys (`${songId}@${timestamp}`) already notified, and notify each song once, when it first comes within 10 minutes. Pass `tag` set to that key so any repeat replaces the earlier notification.

## main-boot-upstream-8

**A renderer that crashes on load is reloaded forever, with no limit or backoff** (low, plausible, bug) · `src/main/index.ts:190`

**Summary.** render-process-gone reloads the window at once on every reason except clean-exit, with no count and no delay. did-fail-load has a cap of 10, but its counter is never reset after a good load. A crash that happens on every load turns into a tight crash-reload loop.

**Scenario.** The renderer process hosts the native audio module. If opening the saved mic crashes it each time (a buggy ASIO driver, say), or the reason is 'launch-failed', the display reloads, reopens the mic and crashes again, about once a second. The host can never get to Settings to change the mic. Separately, after 10 transient load failures over a long session, did-fail-load stops retrying for good.

**Suggested fix.** Count crashes in a sliding window. Back off (1 s, 2 s, 4 s…), and after about 3 crashes in a minute, load the page with a query flag that skips opening the mics so the host can reach Settings. Reset rendererLoadAttempts on did-finish-load.

**Verifier.** PLAUSIBLE: The code is as described. render-process-gone calls reload() at once for every reason except clean-exit, with no count or delay (index.ts:190-195). rendererLoadAttempts only ever goes up (index.ts:274, 290). A tight loop needs a renderer that crashes on every load, such as a native fault while opening the saved mic in the preload-loaded module, or 'launch-failed'. That is possible but I couldn't confirm it happens. The 'after 10 load failures over a session' half is rarer still: prod loads a local file:// page, so did-fail-load on the main frame is essentially a dev-server case.

**Also reported as** (Renderer crash reloads have no cap or backoff. Use a sliding-window count and a safe mode that skips opening the mics.):

- gap-long-party-gpu-8: The display reloads after every renderer crash, with no cap or backoff (`src/main/index.ts:190`). Its fix: Count crashes in a sliding window, for example 3 within 60 s. Past that, stop auto-reloading, or reload with a flag (?safe=1) that skips reopening the saved mics. Back the reload off by a second or two.

## main-boot-upstream-9

**The F5 / Ctrl+R confirmation is a synchronous dialog that freezes the main process** (low, confirmed, performance) · `src/main/index.ts:323`

**Summary.** refreshRendererWindow uses dialog.showMessageBoxSync, which Electron documents as blocking the process until it's closed. While it's up, the HTTP API, the SSE streams, IPC from the display and the stdout pipes of running downloads all stall.

**Scenario.** Someone bumps F5 on the host keyboard mid-song and nobody answers the dialog. Every phone's queue and search requests hang, live updates stop, and the display's IPC calls queue up. A running ffmpeg or yt-dlp blocks once its stdout pipe fills. All of it resumes only when the dialog is closed.

**Suggested fix.** Use `await dialog.showMessageBox(rendererWindow, …)` (async) and reload when response === 0.

**Verifier.** CONFIRMED: refreshRendererWindow uses dialog.showMessageBoxSync (index.ts:320-330), and Electron documents it as blocking the process until the box closes. While it's open, the main-process event loop stops: the HTTP API, SSE and IPC replies all stall. Audio and video keep going, because they run in the renderer and the native threads. Children's pipes are only drained while the loop runs. The dialog shows on the TV over the display, so in practice someone dismisses it quickly. Low fits. The async showMessageBox fix is trivial.

## main-boot-upstream-11

**Dead or duplicated boot code: the activate branch, a second withTimeout, and the Service-Worker-Allowed middleware** (low, confirmed, maintainability) · `src/main/index.ts:314`

**Summary.** `app.on('activate')` can never create a window: rendererWindow starts undefined and is never set to null, and window-all-closed quits anyway. If it ever did, createWindow would register the protocol again and start a second HTTP server on the same port, which would raise a false 'port in use' problem. services.ts:84-99 repeats api.ts:157-163's withTimeout. The Service-Worker-Allowed: / header is unneeded, because the only service worker is /notificationServiceWorker.js at the root with scope '/', which is already its default maximum scope.

**Scenario.** There's no runtime failure today. A future macOS change that sets rendererWindow = null on 'closed' would hit the double-server path. Two withTimeout copies can drift apart, and the middleware sends a pointless header on every static response.

**Suggested fix.** Delete the activate handler, or split the one-time setup (protocol, Express, HTTP server) out of createWindow before keeping it. Export one withTimeout(promise, ms, label?) from a small shared module and use it in both files. Delete middleware/remoconServiceWorkerAllowed.ts and its use. Together that's about 30 lines and one file.

**Verifier.** CONFIRMED: I checked all three facts. (a) `let rendererWindow: BrowserWindow | null;` starts undefined, and its only assignment is at index.ts:167. `rendererWindow === null` never holds, so the 'activate' handler (index.ts:314-318) is dead, and window-all-closed quits anyway. If it ever ran, createWindow would register the protocol again and start a second server. (b) services.ts:84-99 and api.ts:157-163 are two copies of withTimeout that differ only by the label. settings.ts:143-150 also races its own inline timer. (c) The only service worker is /notificationServiceWorker.js, from static/ served at WEB_DIR's root, registered with scope '/' (useQueueNotifications.ts:12-14). '/' is already its maximum scope, so the Service-Worker-Allowed header does nothing. In dev it goes through Vite without the header and still works. The middleware is used only at index.ts:248. The change is small and removes a misleading code path.

## oe-architecture-1

**Phone notifications can't work on the plain-HTTP LAN remote, yet a whole feature is kept for them** (over-engineering, KEEP, high) · `src/remocon/hooks/useQueueNotifications.ts:10`

**Now.** A service worker (static/notificationServiceWorker.js), an Express middleware that adds Service-Worker-Allowed to every response (src/main/middleware/remoconServiceWorkerAllowed.ts), useQueueNotifications plus a <QueueNotifications/> mounted outside LanguageProvider (src/remocon/index.tsx:54), a Notifications row on the phone's Settings (SettingsPage.tsx:150-187), six i18n keys in en and ja, and an e2e test (player.spec.ts:353) that fakes Notification.permission and navigator.serviceWorker.register.

**Why it's more than needed.** Phones load the remote from http://karafriends.local:8080 or http://<LAN IP>:8080, and nothing in the repo serves HTTPS (httpServer.ts only calls http.createServer). Chrome and Safari only give Notification permission and navigator.serviceWorker to secure contexts, and iOS also needs the page installed to the Home Screen. On a guest's phone the row either doesn't show or reads 'Off. Allow them in the browser's settings', which the guest can't do. The e2e test passes only because it runs at http://127.0.0.1 (fixtures.ts:481), and localhost counts as secure. The feature came from upstream's HTTPS tunnel (offkai.karafriends.party), which phase E deleted. Both notifications already have in-app equivalents: the queue button shows 'Couldn't download: <reason>', and the queue sheet counts down the waits.

**Simpler shape.** As proposed: delete useQueueNotifications.ts, <QueueNotifications/>, static/notificationServiceWorker.js and its .oxlintrc entry, remoconServiceWorkerAllowed.ts and its use in index.ts, the Settings row, the notification.* and settings.notifications* keys in en/ja, the player.spec test, and the README line 59 mention. Also make queueFailed display-only in live.ts messageEvents and drop its owner-phone tests.

**Saves.** About 220 lines across 4 files plus i18n and an e2e test. It also removes a middleware that runs on every request and a component mounted at the root.

**Risk.** Only someone who opens the remote over HTTPS, or has set Chrome's 'insecure origins treated as secure' flag, would lose the 'up soon' notification. Nobody on the documented setup gets it today.

**Verifier.** The facts check out. httpServer.ts only calls http.createServer. HostnameSetting offers only karafriends.local and the LAN IPs, over http. notes/stack-review-runtime.md:143 already records that phones load the remote over plain http://<LAN IP>, which is not a secure context. Nothing in notes/ plans HTTPS. The tunnel was deleted in 362bd4b (phase E). In an insecure context navigator.serviceWorker is undefined, and Chrome Android reports Notification.permission as 'denied' and has no `new Notification()`. So on Android the row reads 'Off. Allow them in the browser's settings', which the guest cannot actually do, and on iOS the row is hidden. The e2e test overwrites navigator.serviceWorker.register, which only exists because the test runs at http://127.0.0.1. The feature has needed fixes again and again for no real users: product review #22, mobile #3 ('up soon' repeating on pause), polish #3 (readings), f77523c, and the U1 eta rework. The reviewer missed one more saving: useQueueNotifications is the phone's only consumer of queueFailed. The queue button reads failures from live-state downloads (useDownloadButtonText.ts:99-112), so queueFailed can go to the display only, and live.ts loses its forOwner/isMine branch. Separately, the Service-Worker-Allowed middleware is not needed even if the feature stays: the worker is served from the root (static/ is the publicDir), and a root worker's default maximum scope is already '/'.

## oe-main-10

**The Service-Worker-Allowed middleware no longer does anything** (over-engineering, KEEP, low) · `src/main/middleware/remoconServiceWorkerAllowed.ts:3`

**Now.** A factory in its own middleware/ directory that adds `Service-Worker-Allowed: /` to every response (index.ts:248).

**Why it's more than needed.** The service worker is served from the site root, /notificationServiceWorker.js (static/ into WEB_DIR, served by express.static at /), and registered with scope '/' (useQueueNotifications.ts:12-13). A worker script at the root already has '/' as its maximum scope, so the header changes nothing. In dev, phones load the remote from the Vite server, which never sends this header, and that works.

**Simpler shape.** Delete src/main/middleware/remoconServiceWorkerAllowed.ts (and the then-empty middleware/ directory), and its import and use at index.ts:53 and 248.

**Saves.** One file, one directory, and 3 lines in index.ts.

**Risk.** Only if the worker is ever moved under a sub-path while keeping scope '/'. In that case the header would be needed again.

**Verifier.** Confirmed. The header came from d6bc74a (2023), when the worker was built from src/remocon/notificationServiceWorker.ts and the remote sat behind a reverse proxy (the value was then '/notificationServiceWorker.js'). Now the worker is static/notificationServiceWorker.js, copied to the root of build/<mode>/web (electron.vite.config.ts publicDir) and served at / by express.static(WEB_DIR). It is registered with scope '/' (useQueueNotifications.ts:12). A worker script at the root may already claim '/', so the header does nothing, and the dev server works without it. The header is also added to every response, /api included, for no reason.
