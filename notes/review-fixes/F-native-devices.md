# Phase F: Native: device recovery, Windows exclusive and ASIO

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: native/karafriends-lib/src/lib.rs, mixer.rs, exclusive.rs.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                                     | Severity | Title                                                                                                                                              |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [native-exclusive-1](#native-exclusive-1)                   | High     | Exclusive mode: a second channel of the same interface can't open at all                                                                           |
| [native-bindings-2](#native-bindings-2)                     | Medium   | A mic that stays down makes the watchdog open and close the mic output (and, on Windows, load every ASIO driver) every 2 s on the display's thread |
| [gap-song-output-lifecycle-2](#gap-song-output-lifecycle-2) | Medium   | When the chosen mic output is lost or missing at launch, mics fall back to the laptop speakers (feedback risk) and never move back                 |
| [native-exclusive-5](#native-exclusive-5)                   | Medium   | Only exclusive mics detect a stalled stream; ASIO mics can go silent with status "ok" and are never re-initialised                                 |
| [native-core-2](#native-core-2)                             | Medium   | On Windows and macOS a cached input device is never evicted, so a replugged mic can stay dead for the rest of the party                            |
| [native-exclusive-2](#native-exclusive-2)                   | Medium   | ASIO mic on the output's driver overrides the chosen ASIO buffer size, and later changes are ignored                                               |
| [native-exclusive-3](#native-exclusive-3)                   | Medium   | Closing an ASIO output while an ASIO mic keeps the driver running loops the last buffers (buzz)                                                    |
| [native-linux-2](#native-linux-2)                           | Medium   | 24-bit device formats (I24/U24) are rejected, so on PulseAudio a 24-bit interface's mic or the whole mic output never opens                        |
| [native-bindings-5](#native-bindings-5)                     | Low      | setOutputDevice changes the native output choice even when it throws                                                                               |
| [native-exclusive-8](#native-exclusive-8)                   | Low      | Exclusive mics never report lost packets or a refused MMCSS priority                                                                               |
| [native-mixer-3](#native-mixer-3)                           | Low      | Output buffers of 4096+ frames overrun the fixed 200 ms mic ring: gaps, cuts and dropped samples                                                   |
| [native-mixer-6](#native-mixer-6)                           | Low      | The Pacer's spare margin only ever grows, so each dropout adds 2 ms of monitor delay for the rest of the session                                   |

## native-exclusive-1

**Exclusive mode: a second channel of the same interface can't open at all** (high, confirmed, bug) · `native/karafriends-lib/src/lib.rs:603`

**Summary.** With Mic mode set to Exclusive, every InputDevice opens its own exclusive IAudioClient on the endpoint (open → open_exclusive → ExclusiveInput::open, lib.rs:474-491 and 603). WASAPI gives an endpoint to only one exclusive stream, and while that stream holds it, shared clients are refused too. So a second channel of the same interface fails both ways and doesn't open at all. This breaks the README's promise that "a mic Windows won't give stays shared". It also leaves no visible reason: at launch the mic is dropped with a console warning and then forgotten on the next save, and picking or adding it in Settings just snaps back.

**Scenario.** Duet setup: a 2-input USB interface, Mic 1 = channel 1, Mic 2 = channel 2, Mic mode Exclusive. At launch mic 1 takes the endpoint. Mic 2's exclusive try fails and is reported as "Another program is using this mic" (exclusive.rs:53), even though the holder is karafriends. Its shared fallback (lib.rs:490-519) then fails too, so InputDevice::new throws. openSavedMics (App.tsx:157-163) drops mic 2 with only a console warning, and the next mic change in Settings saves the list without it. Turning Exclusive on at runtime has the same effect: changeMicMode reopens mic 1 exclusively, then mic 2's reopen fails both ways and it retries every 2 s showing cpal's device-busy error. The exclusive refusal is only eprintln'd (lib.rs:484), because the note is dropped when the shared path errors. Moving a row from channel 1 to channel 2 of the same interface also fails: onChangeMic opens the new mic before stopping the old one (App.tsx:385-388), the throw escapes the select's handler, and the row snaps back.

**Suggested fix.** Share one exclusive stream per endpoint. Keep a registry of endpoint id → Weak<shared capture> holding a list of per-channel callbacks: each InputDevice adds or removes its callback, and the stream closes when the last one leaves. cpal's ASIO host works the same way (many callbacks on one driver). Also have onChangeMic stop the old mic before opening the new one when both are on the same device.

**Earlier reviews.** New

**Verifier.** CONFIRMED: I traced the whole path. Each InputDevice calls open_exclusive, which runs exclusive::ExclusiveInput::open on the endpoint id (lib.rs:603). Nothing shares or counts streams per endpoint, even though on_data already gets every channel interleaved (exclusive.rs:76, 355). DeviceSelect offers every channel of every device (MicrophoneSetting.tsx:47-60), and on Windows most 2-input USB interfaces show up as one stereo capture endpoint. Once mic 1 holds the endpoint exclusively, mic 2's exclusive attempt fails at IsFormatSupported or Initialize. The shared fallback (lib.rs:490-522) then fails too: cpal's shared Initialize gets AUDCLNT_E_DEVICE_IN_USE, which Microsoft documents for an endpoint held in exclusive mode. That error is returned through `?`, so the 'Exclusive mode was refused' note is lost and only the eprintln at lib.rs:484 remains. At launch, openSavedMics (App.tsx:157-162) catches the error and drops the mic. After that, any setMics or changeLevels calls saveMics(mics, …), which writes localStorage without it, so the saved mic is gone. Turning Exclusive on at runtime has the same effect: changeMicMode reopens mic 1 exclusively, mic 2's reopen fails, and its watchdog retries every 2 s forever. onChangeMic (App.tsx:384-390) opens the new mic before it stops the old one, so moving a row to another channel of the same endpoint throws, and the controlled select snaps back. Exclusive mode is opt-in, but a duet on one 2-input interface is the main setup for it, and the result is a dead mic with an error that says nothing useful. High stands. | CONFIRMED: I traced the claim through the code and couldn't refute it. I couldn't run it, because the code is cfg(windows) and needs WASAPI hardware. The one outside fact the bug depends on is Microsoft's documented behaviour, and the code itself assumes the same thing.

Native side:

- InputDevice::open (lib.rs:472-491) tries open_exclusive first whenever MIC_MODE.exclusive is set and the device isn't ASIO.
- open_exclusive (lib.rs:586-640) calls exclusive::ExclusiveInput::open (line 603) once per InputDevice. Each call starts its own capture thread and its own IAudioClient initialized with AUDCLNT_SHAREMODE_EXCLUSIVE (exclusive.rs:406-420).
- Nothing tracks open endpoints. INPUT_DEVICES only caches the cpal::Device handle.
- Microsoft's IAudioClient::Initialize docs define AUDCLNT_E_DEVICE_IN_USE as "the device is being used in exclusive mode, or … in shared mode and the caller asked to use exclusive mode". So the second exclusive client gets DEVICE_IN_USE. pick_format already treats that code as final (exclusive.rs:425-436), and failed() turns it into the IN_USE text "Another program is using this mic" (exclusive.rs:619-620). That text is wrong here, because the holder is karafriends itself.
- The shared fallback then fails as well. cpal 0.18.2 either rejects it in supported_input_configs, where a shared-mode IsFormatSupported that isn't S_OK gives "Could not determine support for default audio format" (wasapi/device.rs:640-645), or at shared Initialize with DeviceBusy (mod.rs:66).
- Either way input_stream_config(...)? at lib.rs:491 returns Err. The exclusive note set at line 485 is thrown away, so the reason only reaches eprintln.

JS side:

- MicrophoneSetting.tsx:47-60 offers every channel of every input as its own option.
- A 2-in USB interface (Focusrite "Analogue 1 + 2", a class-compliant UMC) shows up in Windows as one capture endpoint with 2 channels. So "Mic 1 = ch1, Mic 2 = ch2, Exclusive" is a normal duet setup.

What happens at launch:

- openSavedMics (App.tsx:147-165) opens mic 1 exclusively. Mic 2 throws, gets a console.warn, and is left out of the `mics` state.
- saveMics(mics, …) runs on setMics and on changeLevels, which an admin phone's setMicLevels also reaches (App.tsx:251-259, 288-298). Either one then overwrites localStorage "mics" without mic 2, so even a level tweak from a phone makes the app forget it.
- The device list is safe: InputDevice's constructor calls inputLabel → inputDevices() before create(), and the preload caches the list on Windows. So the interface stays listed.

In Settings:

- onChangeMic (App.tsx:384-390) opens the new mic before stopping the old one, with no try/catch.
- Adding a row for ch2, or moving row 1 from ch1 to ch2, throws out of the select's onChange. The controlled select snaps back with nothing on screen.
- Stopping the old mic first would fix the move case, because InputDevice::stop sets input_stream = None, which drops ExclusiveInput and joins its thread. It wouldn't fix a second row.

Turning Exclusive on at runtime:

- changeMicMode reopens the mics in order. With Windows' default "Give exclusive mode applications priority", mic 1's exclusive open takes the device away from mic 2's shared stream. Mic 2's reopen then fails both ways, and its watchdog retries every 2 s while the row shows the cpal error.
- With that priority box unticked, both mics stay shared for that session, and mic 1 carries a misleading "Another program…" note. On the next launch, mic 2 dies as described above.
- Switching back to Shared brings mic 2 back.

Severity: it only happens on Windows, with Exclusive (opt-in, not the default) and two channels of one WASAPI (non-ASIO) endpoint. But that is the standard way to plug two mics in for a duet, the README sells Exclusive for lower delay, and when it happens it happens every time, with no workaround besides going back to Shared and no reason on screen. A singer's mic is fully dead, so I'm keeping high. Medium would be defensible because the mode is opt-in.

Line refs check out: lib.rs:484-485 (refusal only eprintln'd plus a note that is then dropped), 491 (shared path), 603 (ExclusiveInput per InputDevice), exclusive.rs:53 (IN_USE text), 76 (on_data gets every channel interleaved), App.tsx:384-389.

The suggested fix holds up. One ExclusiveInput per endpoint id, held through a Weak registry, would fan out to per-channel callbacks. Each one is already built by assemble/input_data_callback with its own channel_selection, and all of them ask for the same output_rate, so a single format works for every channel. Smaller interim fixes: have open_exclusive return a clear "this device is already open exclusively by another mic row" error (or hold the second channel back) instead of the misleading IN_USE text. Have onChangeMic stop the old mic before opening the new one and catch the throw. And stop saveMics from forgetting saved mics that failed to open.

## native-bindings-2

**A mic that stays down makes the watchdog open and close the mic output (and, on Windows, load every ASIO driver) every 2 s on the display's thread** (medium, confirmed, performance) · `native/karafriends-lib/src/lib.rs:435`

**Summary.** InputDevice::new opens the shared mic output (open_if_needed) before it looks for the input. When the input isn't there, close_if_unused closes the output again. nativeAudio.ts retries a down mic every 2 s and never stops. So whenever no other mic is open, each retry builds, starts and tears down an output stream, synchronously on the renderer's JS thread. If an output is chosen in Settings, build() also lists the outputs first. On Windows that calls asio_devices with no ASIO stream open, which loads every installed ASIO driver in turn. On Linux each retry makes two PipeWire registry round trips plus the output stream.

**Scenario.** Windows, one wireless mic, a mic output picked in Settings (the Topping over ASIO, or even "Speakers (Windows)"), and any ASIO driver installed (Realtek ASIO, ASIO4ALL, FlexASIO). The host switches the receiver off mid-party. Every 2 s, for the rest of the night: each ASIO driver is loaded, the chosen output is started and stopped, and the cached WASAPI device's supported_input_configs fails. The renderer's main thread is blocked for all of it, so video, lyrics and pitch bars can hitch every 2 s, and the interface may click. The console also gets the multi-line "Opened the mic output ... {config:#?}" print each time. On Linux with PipeWire, karafriends' output node appears and disappears every 2 s. While it is open other programs run at the mic buffer (MicrophoneSetting.tsx:263-265), so the graph's quantum can change under the song's audio each time.

**Suggested fix.** In InputDevice::new, look up the input and probe it before mixer.open_if_needed: on Windows call supported_input_configs on the cached device, on Linux check the fresh list. A missing mic then fails without touching the output, and the full config at the output's rate is worked out afterwards. Also back the JS watchdog off for a mic that keeps failing (for example 2 s, then 4, 8, up to 30 s).

**Earlier reviews.** Product review mic round #4 was fixed by retrying every 2 s forever. That fix makes this cost last as long as the mic is down; the cost of a retry wasn't reviewed.

**Verifier.** CONFIRMED: The mechanism holds in the code. A down mic has open=false and error set, so status() returns the error. check() then calls openAgain() on every 2 s tick (nativeAudio.ts:119, 145-153), and nothing backs it off. openAgain() → inputDevice_new → InputDevice::new (lib.rs:433-441) calls mixer.open_if_needed() before Self::open looks up the input. With no other source the output is None (deregister → close_if_unused closed it), so open() → close() → build() runs. When a choice is set, build() first lists the outputs (mixer.rs:212), and on Windows that reaches asio_devices. With ASIO_STREAMS == 0 that calls host.devices(), and cpal-0.18.2's asio Devices::next calls load_driver for each driver (I checked the cpal source). Then build_on starts the stream, printing the multi-line config. The input lookup or its config fails: on Windows the cached device's supported_input_configs; on Linux the fresh list after `input_devices.remove(name)`, where system_host() also builds a new host every call. Then close_if_unused tears the output down again. All of this is synchronous on the renderer's JS thread. I couldn't time stream opens here, because opening devices isn't allowed. The repeated open and close of an output stream, plus driver loads on Windows/ASIO, every 2 s for as long as the mic is down, is a noticeable cost on a less common path. The PipeWire quantum flapping is plausible but not verified.

**Also reported as** (The same root cause on every platform: InputDevice::new opens the mic output before it looks up the input. Look up the input first, then back the watchdog off.):

- renderer-audio-5: The watchdog's retry of a down mic opens and closes the mic output every 2 s on the display's JS thread (`src/renderer/nativeAudio.ts:145`). Its fix: Back off in the watchdog while a mic stays down: 2 s, doubling to about 30 s, reset on success. Or in native InputDevice::new, look the input up before open_if_needed() so a missing mic fails without touching the output. Cache the Linux host instead of creating one per listing.
- native-mixer-1: A lone mic that won't reopen opens and closes the mic output every 2 s (`native/karafriends-lib/src/lib.rs:435`). Its fix: Find the input device before touching the output. Move the INPUT_DEVICES lookup ahead of open_if_needed in InputDevice::new, so a missing mic returns its error without opening anything. Only the config query needs output_rate. Optionally, keep the output open for a few seconds after the last deregister instead of closing at once. That also avoids the three back-to-back opens a Linux buffer change does with one mic (set_mic_mode reopen, close on deregister, open on reopen).
- native-exclusive-4: A down mic makes every 2 s retry reopen the mic output and re-list every ASIO driver on the display thread (`native/karafriends-lib/src/lib.rs:436`). Its fix: Fail fast before touching the output: look up and probe the input (e.g. supported_input_configs(), or the endpoint state for exclusive) before mixer.open_if_needed(). Or don't close the output on a failed open, only in deregister. Or back the watchdog off (2 s, rising to 30 s) after repeated failures.

## gap-song-output-lifecycle-2

**When the chosen mic output is lost or missing at launch, mics fall back to the laptop speakers (feedback risk) and never move back** (medium, confirmed, bug) · `native/karafriends-lib/src/mixer.rs:228`

**Summary.** If an explicitly chosen mic output that isn't the system default drops out (TV standby, HDMI unplugged, an ASIO interface reset) or is missing at launch, build() falls back to the default output with an "ok: …isn't connected" note. Nothing tries the chosen device again after that: open_if_needed reopens only on a stream error, and working() treats "ok: " as healthy. The mics therefore stay on the default (e.g. laptop speakers) after the chosen device returns, until the host picks another output and then that one again. The only case that heals itself is when the device's return also changes the system default (cpal's DefaultOutput monitor then fires StreamInvalidated). Settings' note comes from mics[0] alone, and it goes stale once the device is listed again.

**Scenario.** Windows, Mic output = 'LG TV (Intel(R) Display Audio) (Windows)', which isn't the system default (that is why it was picked).

1. The TV goes to standby mid-song. cpal's WASAPI stream on that endpoint hits AUDCLNT_E_DEVICE_INVALIDATED, which arrives as DeviceNotAvailable, and error_callback stores it.
2. Within 2 s, each mic's check() sees the error, then closes and reopens the mic.
3. build() can't find the TV, so it opens default_output_device() (the laptop speakers) with the note 'ok: … isn't connected; the mics play through the default output'. The mics now howl through the laptop.
4. The TV comes back. Status is still 'ok: …', working() returns true, and nothing retries. The system default didn't change, so cpal's default-device monitor doesn't fire either.
   The same thing happens when the app starts before the TV is on: openSavedMics → setOutputDevice(TV) → the first mic opens on the fallback. Settings then lists the TV as the selected Mic output (the outputs include it again), above the stale 'isn't connected' line. Picking it again fires no change, so the host has to pick another output and then pick the TV back. If mic 0 is itself down, outputNote (Settings.tsx:492) shows nothing even though the other mics play through the laptop.

**Suggested fix.** Retry the choice while on the fallback. Add a native `retry_output()` that, while `note` is set, checks whether the chosen name is listed again in _output_devices() and calls open() if so (mics at another rate get the reopen status, as now). Call it once per watchdog tick: one mixer-level 2 s timer in App, not one per mic.
For the feedback risk, when an explicit mic output is missing, keep the mics silent (or make the fallback to the default an opt-in) instead of falling back to the default. Show the state on the TV (NoticeBar), not only in Settings.
Read the note from a native outputStatus(), not from mics[0].status().

**Earlier reviews.** Related to code-review-2026-10-27.md #4 (the watchdog gave up) and #6 (the 'not connected' note was never shown), both fixed. Those made mics retry and the note appear, but the output itself is still never retried once it has fallen back.

**Verifier.** CONFIRMED: I traced it in the code.

- The output stream error (DeviceNotAvailable is not Xrun or DeviceChanged, lib.rs:342-355) sets output_error.
- Mixer::status returns that error. InputDevice::status (lib.rs:681-686) passes it through, so check() closes and reopens the mic.
- InputDevice::new calls open_if_needed, which sees output_error and calls open(), then build(). The chosen name isn't in _output_devices(), so build() opens default_output_device() with note 'ok: … isn't connected; the mics play through the default output' (mixer.rs:227-235).
- working() (nativeAudio.ts:93-95) accepts 'ok: ', so check() returns early from then on.
- The only paths that retry the choice: set_output_device (called only from openSavedMics at App.tsx:148 and from changeMicOutput at :306), and on Linux Mixer::reopen through set_mic_mode (lib.rs:100), which runs only when the mic mode changes.
- cpal 0.18.2 gives only default-device streams a DefaultDeviceMonitor (wasapi/device.rs:548-556).
  So the mics stay on the fallback until the host picks another output and then the TV again. The README promises a TV that went to sleep is recovered.

The launch case is confirmed too. setOutputDevice runs with no stream open, so it is a no-op, and the first mic's open_if_needed falls back. MicOutputSetting then shows the TV as selected (connected = outputs.includes) above the stale 'isn't connected' note. outputNote reads mics[0].status() only (Settings.tsx:492-493), so a downed mic 0 hides the note.

The fallback itself was the deliberate fix for the earlier review's #5. The defect is that it never goes back to the chosen output. The feedback-howl risk is possible but not certain (laptop speakers are weak).

I rated it medium, matching the earlier review's rating of the analogous 'TV wakes, mic stays dead' (#4). The host can see the note, and re-picking an output fixes it. | CONFIRMED: I couldn't refute the no-retry part, but the feedback part is overstated.

How it happens:

1. The chosen output stream fails. On Windows, a Specific endpoint that goes away reports DeviceNotAvailable (cpal-0.18.2 wasapi mod.rs:62), and error_callback stores it in output_error.
2. InputDevice::status (lib.rs:681) returns that error. working() is false, so check() closes and recreates the mic, and InputDevice::new runs open_if_needed, which sees the error and calls open() then build().
3. The TV isn't listed (cpal only lists DEVICE_STATE_ACTIVE endpoints, device.rs:1264), so build() opens default_output_device() and sets the note "ok: … isn't connected" (mixer.rs:227-228).
4. From then on, open_if_needed (mixer.rs:169) only reopens when output_error is set, and check() returns early on any "ok: " status (nativeAudio.ts:93, :145). set_output_device is called only from openSavedMics and changeMicOutput (App.tsx:148, :306). So nothing ever tries the chosen device again.

Demonstration: a node script runs the real nativeAudio.ts against a fake native module that copies mixer.rs's open_if_needed/build/status logic. It is at /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-gap-song-output-lifecycle-2/watchdog.mts. The run printed:

- t1 (TV lost): 'opened DEFAULT (laptop speakers)'
- t2 (TV back, 5 watchdog ticks): [] — no calls, and the status still says "isn't connected"

The launch case behaves the same way: setOutputDevice only stores the choice while no mic is open, and the first mic's build() falls back. Picking the TV again in Settings fires no onChange, because the select's value is already the TV.

Why the trigger is narrower than claimed:

- The fallback stream is a cpal DefaultOutput stream, so it has a DefaultDeviceMonitor. When the Windows default changes, cpal emits StreamInvalidated (stream.rs:730-780). error_callback doesn't treat that as harmless, so the mics reopen and build() finds the TV again.
- So when the TV is also the Windows default, which Windows switches back to when the TV reappears, it heals itself. It stays stuck only when the explicit output is NOT the system default, or is an ASIO/PipeWire node whose return doesn't change the default.

Why the feedback risk isn't specific to this code: with Mic output = System default (the usual setting), the mics also move to the laptop speakers when the TV sleeps. That is by design, and the CHANGELOG documents the fallback to the default ("the default output plays instead, and Settings says why").

The real defect is the missing recovery. The README promises that mics recover "when the TV went to sleep", but with an explicit output they stay on the wrong speakers until the host picks another output and then the TV again in Settings. The other claims hold:

- The note becomes stale or contradictory once the TV is listed again.
- outputNote (Settings.tsx:492-493) reads only mics[0].status(), so it shows nothing while mic 0 is itself down.

Re-rated to medium: a real bug on a less common path (an explicit non-default output that drops and comes back without the default changing), and the host can recover by hand.

**Also reported as** (Falling back to the default mic output is sticky. Retry the chosen output when it is listed again, and consider staying silent rather than falling back to the laptop speakers.):

- native-exclusive-7: Fallback to the default output is sticky: a chosen output that comes back is never used again (`native/karafriends-lib/src/mixer.rs:227`). Its fix: Retry the choice once it is listed again: when Settings lists outputs and the note is set, call setOutputDevice(choice) again. Or have Mixer::status return a not-ok status when a cheap check finds the device back: an IMMNotificationClient for WASAPI, and for ASIO only on Settings open, since listing ASIO loads every driver.
- gap-sleep-resume-power-3: Once the chosen mic output goes missing, the mics never move back to it (`native/karafriends-lib/src/mixer.rs:169`). Its fix: While the mixer runs on a fallback (note set), retry the choice. Add a native retryOutput(): if self.note is set and the chosen name is listed again, call open(). The existing rate check already reopens mics at a different rate. Call it from navigator.mediaDevices' devicechange event in App.tsx, which fires on Windows and Linux when audio endpoints come and go, and every 10 s or so from the watchdog. Not every 2 s, because listing ASIO devices loads drivers. Re-apply the saved song output on devicechange too.

## native-exclusive-5

**Only exclusive mics detect a stalled stream; ASIO mics can go silent with status "ok" and are never re-initialised** (medium, confirmed, bug) · `native/karafriends-lib/src/lib.rs:681`

**Summary.** cpal-backed mics (ASIO, shared WASAPI, Linux) have no stall check like exclusive.rs's heard/STALL, and cpal's ASIO host has no data timeout, so an ASIO driver that stops calling bufferSwitch leaves the mic silent with status "ok". Also, after an ASIO reset or invalidation, the per-mic watchdogs reopen streams one at a time. When another stream still holds the driver (a second ASIO mic, or the output kept open by another mic), load_driver returns the same DriverInner, and cpal reuses its buffers without stopping or re-initialising the driver.

**Scenario.** A 2-input ASIO interface carries both mics and the mic output. A USB hiccup or brief power loss makes the driver post kAsioResetRequest, and all three streams get StreamInvalidated. Mic 1's watchdog reopens it while mic 2 and the output still hold the driver, so load_driver hands back the dead instance and the status reads "ok". Mic 2's reopen a moment later does the same. Both mics are silent, every status reads "ok", and nothing retries until the mics are removed or the app restarts. A driver that simply stops calling bufferSwitch without posting anything (driver-dependent) leaves even a single ASIO mic silent and "ok" forever.

**Suggested fix.** Move the stall check into InputDevice so it covers every host. input_data_callback bumps an AtomicU32 counter (Meters already has `frames`), and status() returns "The mic stopped sending sound" if the counter hasn't moved since a poll at least 2 s earlier. This deletes about 10 lines from exclusive.rs (heard/STALL). For ASIO, when one stream on driver X fails, fail the status of every mic on X and of the output, and have JS close them all before reopening any, so the driver is really reloaded.

**Earlier reviews.** New (product review #1 was about treating Xrun as fatal, a different problem)

**Verifier.** CONFIRMED: Confirmed in code. kAsioResetRequest/ResyncRequest send StreamInvalidated to every stream's event callback (cpal asio/stream.rs:1012-1033), so both mics and the output report errors. With two ASIO mics: mic 1's check() closes it (deregister; mic 2 is still registered, so the output stays), then reopens. open_if_needed sees output_error and closes the output, but mic 2's Stream still holds the Driver. load_driver returns the existing instance (asio-sys mod.rs:451-457), get_or_create_* return the old buffers (stream.rs:875-876, 918-919), and driver.start() is a no-op because the state says Running (mod.rs:860-866). Everything reports 'ok'. Mic 2's reopen then does the same, because the new output and mic 1 hold the driver. There is never a moment with zero holders, so the driver is never ASIOExit'ed and re-initialised. Correction: one ASIO mic plus the ASIO output does recover, because InputDevice::stop deregisters first, which closes the output when it is the only mic, and then drops the mic stream, so the driver is destroyed and reloaded. The finding's two-ASIO-mic scenario is right. With one ASIO mic and one WASAPI mic it depends on which watchdog fires first. The stall check really is private to exclusive.rs (exclusive.rs:298-315), and cpal's ASIO host has no timeout. Whether a given driver goes silent instead of recovering on its own is hardware-dependent, but after a USB drop the driver normally needs ASIOExit/ASIOInit. The finding's anchor on exclusive.rs:310 is only the contrast; the missing check belongs in InputDevice::status (lib.rs:681). Less common path: medium.

**Also reported as** (Move exclusive.rs's stall check into InputDevice and Mixer so it covers every host: shared WASAPI, ASIO and PulseAudio.):

- gap-sleep-resume-power-2: A mic or the mic output that stops calling back without an error stays 'ok' and silent (`native/karafriends-lib/src/lib.rs:681`). Its fix: Copy exclusive.rs's approach. Count callbacks: an AtomicU32 in Meters, bumped on every input callback, and another in Mixer for the output callback. In status(), if the count hasn't moved since a read 2 s or more ago, return "The mic stopped sending sound (nothing for 2 seconds)"; keep the last count and its Instant in atomics or a Mutex. The watchdog then reopens the mic just as it does after an error. On Windows, also look the device up again before a reopen, as Linux already does at lib.rs:453. That is about 25 lines plus a unit test on a fake clock. For PulseAudio, patch cpal to set no_move for non-default devices, so a source that vanishes kills the stream and raises an error.

## native-core-2

**On Windows and macOS a cached input device is never evicted, so a replugged mic can stay dead for the rest of the party** (medium, plausible, bug) · `native/karafriends-lib/src/lib.rs:456`

**Summary.** Outside Linux, `open` serves a mic from INPUT_DEVICES whenever its name is cached (lib.rs:449-469), and nothing ever removes an entry, even after the open fails. On macOS, cpal's CoreAudio Device is only the numeric AudioDeviceID (cpal-0.18.2 coreaudio/macos/device.rs:361-363). CoreAudio object IDs don't survive a device's removal (the UID, which `_device_name` already keys on, does). Linux already re-finds the device on every open (lines 450-455) for the same kind of reason.

**Scenario.** On a Mac, a USB mic or wireless-mic receiver is unplugged mid-party (or its power blips). The stream errors and the watchdog starts reopening every 2 s. Each attempt reuses the cached Device with the old AudioDeviceID, so it keeps failing after the mic is plugged back in. Re-picking the mic in Settings goes through the same cache entry. The README says the mic reopens by itself until it is back, but only an app restart restores it. Windows shared mode has the same structure: a cached IMMDevice, unlike exclusive mode, which looks up the endpoint by id on every open (exclusive.rs). Whether that IMMDevice works again after a replug is unverified; the prior review left it as a device test.

**Suggested fix.** When any step after taking a cached entry fails, remove it (`input_devices.remove(name)`) so the next attempt looks the device up again. Doing it before returning the error is enough, since the watchdog retries. On Windows, a fresh `_input_devices()` also loads every ASIO driver when no ASIO stream is open (asio_devices to cpal Devices::next, which loads each driver). For a DefaultHost device, re-find it among the system host's devices only, or limit the fresh lookup to every N attempts. Enumerating the system host costs about 10 ms here.

**Earlier reviews.** Related to an open item in code-review-2026-10-27-product.md (the mic round's device-test list): "whether a cached WASAPI device still opens after a replug". The macOS case and the missing eviction were not reported.

**Verifier.** PLAUSIBLE: The code path is as described. lib.rs:453-455 evicts only on Linux. Line 456 reuses a cached (Device, DeviceType), and no error path (input_stream_config, the id()? at 495, build_input_stream) removes it. nativeAudio.ts check() calls inputDevice_new with the same name every WATCH_MS = 2000, and re-picking in Settings sends the same name, so it hits the same entry. In cpal-0.18.2, the macOS Device is just {audio_device_id, is_default_output} (coreaudio/macos/device.rs:361-363). id() and every config query are live property reads on that ID. cpal does report an unplug (the kAudioDevicePropertyDeviceIsAlive listener sends DeviceNotAvailable, macos/mod.rs:158-166), so the watchdog does start retrying. The README promises such a mic is reopened until it is back. The one unverified link is whether CoreAudio gives a replugged device a new AudioObjectID. Apple only guarantees the UID as persistent, and in practice IDs are reissued, but I couldn't test it without a Mac, so this stays PLAUSIBLE. There is a further Windows mechanism: cpal's WASAPI Device caches an IAudioClient (future_audio_client, wasapi/device.rs:560-594). supported_input_configs fills it, and only build_input_stream takes it. If a retry activates a client and the device then drops before the build (a power blip, a flaky cable), the dead client stays cached in our cached Device, and every later retry fails on it. The window is narrow, and whether a stale IMMDevice re-activates after a clean replug is still the open device test from the prior review (code-review-2026-10-27-product.md:148). The cache itself is from 2023 (Connor Worley), so the problem predates this round. Medium is fair for a mic that is dead until restart on a less common path (a replug on a Mac).

## native-exclusive-2

**ASIO mic on the output's driver overrides the chosen ASIO buffer size, and later changes are ignored** (medium, confirmed, bug) · `native/karafriends-lib/src/lib.rs:983`

**Summary.** On Windows every input config uses BufferSize::Default. When the first ASIO input stream is added, cpal rebuilds the whole driver's buffers (input and output) at the driver's preferred size. When the output is reopened later, cpal reuses the existing output buffers (streams.output outlives the dropped Stream) and ignores the requested size. So with the mics and the mic output on one ASIO interface, the Settings Buffer choice never applies.

**Scenario.** Interface whose driver offers 8..2048 frames (the Topping in mixer.rs's test). The host picks Buffer 64 and the mics are that interface's ASIO inputs. InputDevice::new opens the output with Fixed(64) (mixer.rs:263). The ASIO input then calls get_or_create_input_stream → prepare_input_stream(output, n, None) → create_buffers(None → pref, e.g. 512): the driver is stopped, rebuilt at 512 and restarted, and "In use" shows 512. If the host then picks 128, Mixer::open closes and rebuilds the output, but get_or_create_output_stream finds streams.output still present and returns 512. mic.check() sees "ok", so nothing reopens.

**Suggested fix.** Build ASIO mics with BufferSize::Fixed(the ASIO output's chosen or current frames) when device_type.is_asio(). On an ASIO buffer change, stop every mic before reopening any, so the driver really is released. Today some stream always holds it, because changeMicOutput checks the mics one by one.

**Earlier reviews.** New

**Verifier.** CONFIRMED: supported_config_to_config uses BufferSize::Default for every input on Windows (lib.rs:979-984; the Fixed arm is cfg(not(windows))). Mixer::build_on gives the ASIO output Fixed(frames) (mixer.rs:260-266), and InputDevice::new opens the output first (lib.rs:435). The ASIO input then goes through cpal-0.18.2's get_or_create_input_stream (asio/stream.rs:854-891). With streams.input None, it calls prepare_input_stream(streams.output.take(), n, None) → create_streams → create_buffers(None → buffer_sizes.pref). That stops the running driver, disposes the buffers and recreates the input and output buffers at pref (asio-sys bindings/mod.rs:697-726). The output callback picks up the size change and resizes, so output_format shows pref. When the buffer changes later, Mixer::open → close() drops only the output Stream, and cpal's Stream::drop only removes its callbacks (stream.rs:1095-1099). The mic's Stream still holds the DriverInner, so streams.output survives. The next get_or_create_output_stream finds it and returns the old buffer_size (stream.rs:918-920), ignoring Fixed(new). changeMicOutput only calls mic.check(), and the mic still reports 'ok', so nothing reopens. Reopening a mic doesn't help either, because the output keeps holding the driver. An ASIO mic and an ASIO output always share one driver, since ASIO loads only one, so whenever the mics are ASIO inputs the Settings Buffer choice silently never applies. The audio doesn't break, but a setting doesn't work, on a less common path: medium.

## native-exclusive-3

**Closing an ASIO output while an ASIO mic keeps the driver running loops the last buffers (buzz)** (medium, confirmed, realtime-audio) · `native/karafriends-lib/src/mixer.rs:344`

**Summary.** Dropping an ASIO output stream only removes its callbacks. While an ASIO mic on the same driver keeps the driver Running, the output buffers stay allocated (AsioStreams.output survives) and nobody rewrites them, so the interface keeps playing its last two output half-buffers in a loop: a buzz with a fundamental at rate/(2×buffer), about 47 Hz at 512 frames/48 kHz. It lasts until every stream on that driver closes. A shorter burst plays during every same-driver output rebuild.

**Scenario.** Mics on Focusrite ASIO inputs, mic output Focusrite ASIO at 48 kHz. The host switches Mic output to "Speakers (Windows)", also at 48 kHz. Mixer::open → close() drops the ASIO output, but the mic's input Stream keeps the driver Running. The interface's outputs then repeat the last two buffers: a tone at rate/buffer (94 Hz at 512 frames), as loud as whoever was singing. The mic's rate equals the new output's, so mixer.open doesn't mark it stale and nothing reopens it. The buzz lasts until a mic is removed. A shorter burst also plays on every same-driver output reopen (rate or buffer change), between close() and the new callback, while _output_devices() enumerates.

**Suggested fix.** Silence an ASIO output before dropping it: give output_data_callback an Arc<AtomicBool> that makes it write zeros, set it, wait at least 2 × the buffer duration, then drop. Alternatively, when switching away, keep the old ASIO output alive playing zeros until the last ASIO mic on that driver closes, or mark the mics on that driver stale so they reopen and the driver is released.

**Earlier reviews.** New

**Verifier.** CONFIRMED: Confirmed in code. Mixer::open → close() sets output = None, which drops the cpal ASIO Stream, and its Drop only calls remove_callback/remove_event_callback (cpal asio/stream.rs:1095-1099). The mic's Stream still holds an Arc'd sys::Driver, so DriverInner isn't dropped, and the driver stays Running with input and output buffers both allocated. bufferSwitch runs only the registered callbacks (asio-sys mod.rs:1239-1241). The input callback only reads input buffers, and the code that silences output buffers is inside the removed output callback, so the output halves keep their last mix. If the new Windows output runs at the mics' rate, Mixer::open doesn't mark the sources stale (mixer.rs:195), so no mic reopens and the driver is never released. A mic reopen would fix it, since closing the only ASIO holder destroys the driver. Two corrections to the finding. The loop is two alternating half-buffers, so the fundamental is rate/(2×buffer), about 47 Hz, not 94 Hz. And the content is whatever the mics last picked up, which may be just room or backing-track bleed while the host is in Settings, not necessarily 'as loud as whoever was singing'. The same-driver rebuild burst is real but short: the gap covers the WASAPI output enumeration plus cpal's stream setup, a few periods. It needs ASIO mics, an output switched off the same interface at the same rate, and something listening on the interface outputs. That is less common, but the buzz lasts: medium.

## native-linux-2

**24-bit device formats (I24/U24) are rejected, so on PulseAudio a 24-bit interface's mic or the whole mic output never opens** (medium, confirmed, bug) · `native/karafriends-lib/src/linux.rs:381`

**Summary.** On Linux, a mic and the mic output open in the device's own default sample format: linux.rs:381/385 keep `default.config()` and its format, lib.rs:888 returns `default.sample_format()`, and mixer.rs:275 uses `default_config.sample_format()`. cpal's PulseAudio host takes that default from the server's sample_spec and maps s24le/s24-32le to SampleFormat::I24. `with_sample_type!` (lib.rs:4-50) has no arm for I24 or U24, so it falls to `_ => Err(UnsupportedConfig)`.

**Scenario.** The system runs real PulseAudio (Ubuntu 22.04 once the finding above is fixed, older distros, or KARAFRIENDS_AUDIO_HOST=pulseaudio). The default sink or a mic is a USB interface whose ALSA driver only takes S24_3LE (Behringer UMC-class interfaces, for example), so PulseAudio runs it at s24le. If it is the default sink, Mixer::open fails with "The mic output couldn't open: ...unsupported" and every InputDevice::new fails, leaving no mics at the party. If it is the mic, that mic is listed (listed_config doesn't check the format) but never opens, and the 2 s watchdog retries it forever. An ASIO driver with Int24 samples hits the same macro arm on Windows.

**Suggested fix.** In linux::stream_config, pick F32 whenever a range offers it with the device's channels and rate. PulseAudio converts on the server, PipeWire already defaults to F32, and ALSA plughw converts. Return the chosen format from stream_config instead of using `default.sample_format()` (also in mixer::build_on on Linux). Also add `I24 => cpal::I24` and `U24 => cpal::U24` arms to with_sample_type!, which covers ALSA dmix and ASIO Int24 drivers.

**Verifier.** CONFIRMED: I traced the code. cpal-0.18.2 pulseaudio/mod.rs: default_input_config/default_output_config come from `info.sample_spec` (default_config_from_spec), and S24Le/S24Be/S24In32Le/S24In32Be map to SampleFormat::I24. linux::stream_config (linux.rs:381) keeps default.config(), lib.rs:888 returns default.sample_format(), and mixer.rs:275 uses default_config.sample_format(). Both feed with_sample_type! (lib.rs:4-50), which has no I24/U24 arm and returns UnsupportedConfig from `_ =>`. When a USB interface only takes S24_3LE, PulseAudio's alsa sink falls back through its format try-list to s24le, so the sink/source sample_spec really is s24le. If that is the default sink, Mixer::open fails, and InputDevice::new fails with it because it calls mixer.open_if_needed()? first (lib.rs:435), so no mic opens. The PulseAudio host is reachable today without finding 1's fix: Debian 12 KDE/Xfce use PulseAudio, cpal's PipeWire host fails when no audio nodes are discovered, and KARAFRIENDS_AUDIO_HOST=pulseaudio forces it. PipeWire (always F32) and ALSA plughw (cpal ranks F32 first) are not affected. Medium: a real bug on a less common path.

**Also reported as** (Add I24/U24 arms to with_sample_type!, clamped to 8_388_607/8_388_608 per native-mixer-2, and prefer F32 on Linux.):

- native-mixer-2: 24-bit sample formats (I24/U24) are rejected: an Int24 ASIO interface can't be the mic output and its mics won't open (`native/karafriends-lib/src/lib.rs:47`). Its fix: Add arms for `cpal::SampleFormat::I24 => { type $T = cpal::I24; $body }` and the same for U24. Mind the clamp. dasp's f32->I24 conversion is `I24::new_unchecked((s * 8_388_608.0) as i32)` and assumes s < 1.0 (dasp_sample conv.rs:531-536). The mixer's clamp(-1.0, 1.0) would therefore write a clipped +1.0 as 0x800000, a full-scale negative spike. Clamp the 24-bit path to 8_388_607.0/8_388_608.0. The integer types already handled are safe because Rust's float->int `as` saturates.

## native-bindings-5

**setOutputDevice changes the native output choice even when it throws** (low, confirmed, bug) · `native/karafriends-lib/src/mixer.rs:67`

**Summary.** set_output_device stores the new choice before open() and keeps it if open() fails. open() has already closed the working output by then. The JS caller assumes a throw means nothing changed: changeMicOutput returns before saveMicOutput, setMicOutput and mic.check(). So Settings shows and saves the old output while the mixer holds the rejected one, and the next mic reopen (the watchdog, within 2 s) builds on the rejected one.

**Scenario.** A mini-PC whose only working output is the HDMI TV, which is asleep, with the mics on a USB interface that is switched off. The host picks the USB interface. It isn't connected and the default (the TV) won't open, so the call throws and Settings stays on the old choice. Later the interface is switched on and a mic reopens: the mics now play through the interface while Settings shows, and saves, the old output. The next launch silently reverts.

**Suggested fix.** Commit the choice only after open() succeeds; on failure, restore the previous choice and reopen it. Or have changeMicOutput's catch call setOutputDevice(micOutput) to put back what Settings shows.

**Verifier.** CONFIRMED: mixer.rs:61-72 sets `mixer.choice` before `mixer.open()?` and never restores it. open() calls close() first. build() falls back to the default output, so open() returns Err only when the default also fails (or listing or system_host fails). In that case output is None and output_error is set. changeMicOutput (App.tsx:304-310) returns from its catch before saveMicOutput, setMicOutput and mic.check(). Each mic's status() then reports the mixer's output_error, so the watchdog reopens it within 2 s. open_if_needed → open() → build() uses the rejected choice, so the mics follow the rejected output once it becomes available, while Settings shows and saves the old one. The trace holds end to end, but the precondition (both the chosen output and the system default fail at once) is uncommon, so low.

## native-exclusive-8

**Exclusive mics never report lost packets or a refused MMCSS priority** (low, confirmed, maintainability) · `native/karafriends-lib/src/exclusive.rs:344`

**Summary.** drain() ignores AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, the flag for a lost period. An MMCSS refusal is only eprintln'd (exclusive.rs:205), and open_exclusive passes Arc::default() as `realtime` (lib.rs:640), so Settings never says an exclusive mic isn't real-time. The cpal paths do both: they log xruns (lib.rs:342-349) and show "Not real-time".

**Scenario.** An exclusive mic at the default "Smallest" buffer crackles under load. There is no console line and no hint in the format line, so the host can't tell that a bigger Mic buffer (128/256/512) would fix it.

**Suggested fix.** Count discontinuities in an AtomicU32 shared with the capture thread, and log them rate-limited with RateLimit or show them on the format line. Pass the Mmcss error into the mic's `realtime` Arc, e.g. by giving ExclusiveInput::open that Arc or returning the error alongside the format.

**Earlier reviews.** New

**Verifier.** CONFIRMED: Facts check out. drain() tests only AUDCLNT_BUFFERFLAGS_SILENT (exclusive.rs:344), never DATA_DISCONTINUITY. Mmcss::join only eprintln's a refusal (exclusive.rs:204-206). open_exclusive passes Arc::default() as `realtime` (lib.rs:640), so format() can never add 'Not real-time' for an exclusive mic. The cpal WASAPI path does both: it emits Xrun on DATA_DISCONTINUITY (cpal wasapi/stream.rs:821-826), which error_callback logs rate-limited, and it emits RealtimeDenied through audio_thread_priority (wasapi/stream.rs:720), which error_callback keeps for the format line. MMCSS refusals are rare, but counting discontinuities is a small change, and it is the main clue a host has for picking a bigger Mic buffer at the default 'Smallest' period. A low-severity diagnostics gap worth fixing.

## native-mixer-3

**Output buffers of 4096+ frames overrun the fixed 200 ms mic ring: gaps, cuts and dropped samples** (low, confirmed, realtime-audio) · `native/karafriends-lib/src/mixer.rs:404`

**Summary.** Each mic ring is a fixed 200 ms (ring_capacity). The Pacer's "nearly full" branch fires when occupied + wanted > capacity and trims to the setpoint at the instantaneous level. Once the output buffer is about 90 ms, the normal level before a read (one buffer + margin + a mic chunk) trips this branch routinely. Each trim leaves only `margin` (4 ms) to cover the 10 ms mic-chunk granularity, so the next read underruns. At 8192 frames the ring can't hold two buffers and the mic's push_slice drops samples. Settings offers powers of two up to 8192 within the driver's range.

**Scenario.** I ran a verbatim copy of Pacer for 2 minutes with the repo test's mic model: 480/441-frame mic chunks every 10 ms, up to 3 ms late, 0 ppm. Output sizes of 512 and 2048 frames ran clean. 4096 at 48 kHz had one underrun at start (margin 4 -> 6 ms). 4096 at 44.1 kHz had 3 gaps and 15 cuts, dropping 308 ms of voice, and the margin ratcheted to 12 ms. 8192 at 48 kHz had 3 gaps, 12 cuts (109 ms), and 34,080 frames (710 ms) that the mic pushed into a full ring were dropped. So a host who picks a 4096 or 8192 ASIO buffer gets regular dropouts and clicks.

**Suggested fix.** Simplest: cap the offered sizes at 2048 frames, which is already 43 ms of monitor delay; in buffer_choices use (4..=11) and clamp max. Or size the ring from the output: max(rate/5, 2*output_frames + frames(rate, MARGIN_MAX_MS + START_MS + 10)). The mic opens after the output (open_if_needed), so the output's buffer is known by then. Also parameterise the existing simulate() test over output sizes so this is covered.

**Verifier.** CONFIRMED: I reproduced it with my own simulation, a verbatim sed extract of mixer.rs:27-41 and 358-451 under the repo test's mic model (10 ms chunks, up to 3 ms late, 0 and ±100 ppm, 120 s): /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/verify-native-mixer/pacer_sim.rs. At 48 kHz and 44.1 kHz, buffers of 512, 1024 and 2048 have 0 gaps and never trigger the nearly-full trim. At 4096 frames and 48 kHz there is 1 gap, right after the start trim, and the margin goes to 6 ms. At 4096 and 44.1 kHz there are 4 gaps, 8-16 nearly-full trims and 13-21 cuts, and the margin ratchets to 11 ms. At 8192 the nearly-full branch fires on about every read (around 690 times), with 4-6 gaps and 0.7-1.2 s of mic samples dropped by the full ring on push. Reachability is narrow. Linux offers at most 1024 (linux.rs:26), WASAPI shared isn't configurable, and Exclusive covers the mic only. So it needs an ASIO driver whose range reaches 4096 or more (the Topping's stops at 2048), and a host who picks an 85 ms+ monitor buffer for karaoke, which already sounds like an obvious echo. Low is right.

## native-mixer-6

**The Pacer's spare margin only ever grows, so each dropout adds 2 ms of monitor delay for the rest of the session** (low, plausible, realtime-audio) · `native/karafriends-lib/src/mixer.rs:436`

**Summary.** Each time a mic's buffer runs dry, plan() adds MARGIN_STEP_MS (2 ms) to the margin it keeps above a read, up to 30 ms. Nothing ever lowers it, so only reopening the mic resets it. The window steering targets read + margin, so it never trims this extra delay either.

**Scenario.** Over a long party, a USB mic's capture thread is late by more than the margin 13 times, for example during CPU spikes while yt-dlp/ffmpeg process a download, or capture xruns on a non-real-time thread. Each one is heard as a gap. The margin climbs from 4 to 30 ms, so the singer hears their voice about 26 ms later than at the start of the night, enough to feel like slapback. Nothing in Settings shows it; only the console's 'keeping N ms spare' line does.

**Suggested fix.** Let the margin decay: count windows since the last underrun in the window branch (mixer.rs:412-421), and after about 60 s without one, step the margin back down by MARGIN_STEP_MS toward MARGIN_MS. That's a few lines plus a test alongside the existing pacer tests.

**Verifier.** PLAUSIBLE: The mechanism is as described. The margin is set only in Pacer::new (mixer.rs:385), which runs only from register (mixer.rs:320), and the only change is the + MARGIN_STEP_MS at mixer.rs:436-437. The setpoint includes the margin, so window steering never trims it back. It is deliberate, documented behaviour, though: the comments at mixer.rs:24 and 355-357 say so, and the test pins the 30 ms cap. Any mic reopen resets it (watchdog error, output rate change, mic mode or buffer change). Reaching the 26 ms extra the finding describes takes 13 underruns, each one already an audible gap. My simulation of normal jitter has 0 underruns in 2 minutes at the usual buffer sizes, so how often a real party accumulates steps is unknown. Decay is a trade-off rather than a pure fix: a mic with a persistent cause would cycle between decay and gap. It's a real latency concern for long, glitchy sessions, but the impact is unshown.
