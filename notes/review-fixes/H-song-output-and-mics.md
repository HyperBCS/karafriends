# Phase H: Display: song output and mics

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 1; starts after: nothing (starts at once).

Files: src/renderer/webAudio.ts (output lifecycle), src/renderer/nativeAudio.ts, the device parts of src/renderer/App.tsx, src/renderer/MicrophoneSetting.tsx.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                                     | Severity | Title                                                                                                                             |
| ----------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [gap-song-output-lifecycle-1](#gap-song-output-lifecycle-1) | High     | A lost song output (TV off, TV on another input, HDMI blip, DAC unplugged) freezes every song, silent, until relaunch             |
| [gap-song-output-lifecycle-3](#gap-song-output-lifecycle-3) | Medium   | The saved song output is applied once at launch; a TV turned on later is never used, while Settings shows it as selected          |
| [renderer-audio-3](#renderer-audio-3)                       | Medium   | A mic that fails its first open is dropped instead of kept down for the watchdog; saved mics vanish at launch and are then erased |
| [renderer-settings-1](#renderer-settings-1)                 | Medium   | A mic, mic output or song output that fails to open is dropped without a word                                                     |
| [gap-song-output-lifecycle-6](#gap-song-output-lifecycle-6) | Low      | The 'Output latency' hint is read once per App render and goes stale after a song output change                                   |

## gap-song-output-lifecycle-1

**A lost song output (TV off, TV on another input, HDMI blip, DAC unplugged) freezes every song, silent, until relaunch** (high, confirmed, bug) · `src/renderer/webAudio.ts:50`

**Summary.** Once a song output is explicitly chosen with setSinkId, Chromium 150 treats that device leaving the output list as a render error: StopRendering, an 'error' event, state 'suspended'. Nothing in src calls resume() or listens for statechange, error or devicechange. The video's audio is pulled only through the context, so video, lyrics and pitch bars freeze (paused stays false), and DAM songs may also trigger spurious hls.js stall handling. A later setSinkId (System default or the TV again) doesn't restart a suspended context, so only a reload or relaunch recovers.

**Scenario.** Windows, Song output set to the TV's HDMI output (saved, and applied at launch by App.tsx:323). Mid-song the TV goes to standby or switches input, or HDMI renegotiates. Windows marks the endpoint unplugged and it leaves Chromium's device list, so AudioContext::OnDevicesChanged sees is_sink_id_given_ and calls HandleRenderError: StopRendering, an 'error' event, state 'suspended'. The song freezes on screen with no sound while video.paused stays false. When the TV comes back, OnDevicesChanged only handles a sink that is missing, so nothing restarts. The host opens Settings and picks System default: changeSongOutput's setSinkId('') resolves, but NotifySetSinkIdIsDone restarts rendering only if the context was running, so it stays suspended. A Skip from a phone does fire 'ended', but the next song freezes at 0:00. Only a reload or relaunch brings sound back. The mics meanwhile come back by themselves (the watchdog), so the room hears singers over a frozen screen.

**Suggested fix.** Give KarafriendsAudio the output's lifecycle:

- Keep the wanted output (the id App saves).
- On audioContext 'statechange' to 'suspended' or on 'error' (the app never suspends the context itself), first call `setSinkId({ type: 'none' })`, then `resume()`. Chromium's silent sink keeps the clock running, so the video and lyrics carry on without blasting the laptop speakers. Falling back to setSinkId('') is the other choice.
- On `navigator.mediaDevices` 'devicechange', enumerate the outputs. When the wanted id is listed again, call setSinkId(id) and then resume().
- Also call resume() after every changeSongOutput.
  About 30 lines in one class. Unit-test it with a fake AudioContext (an EventTarget with state, setSinkId and resume) and a fake mediaDevices. The e2e's fake audio can never lose a device.

**Earlier reviews.** New: neither 2026-10-27 review covers the song output's lifecycle.

**Verifier.** CONFIRMED: I checked the finder's Chromium files against chromium.googlesource.com at tag 150.0.7871.224 (Electron 43.4.1 here reports Chrome/150.0.7871.224), and they match. OnDevicesChanged: when the sink is missing and is_sink_id_given_ is set, it calls HandleRenderError. HandleRenderError (running or interrupted) calls StopRendering, fires 'error' and sets the state to 'suspended'. NotifySetSinkIdIsDone sets is_sink_id_given_ = true, so the setSinkId calls at App.tsx:323 and :332 set the flag. It restarts rendering only when sink_transition_flag_was_running_ is set, so a later setSinkId('') or re-picking the TV leaves the context suspended. StartRendering is only reached from resume(), NotifySourceNodeStart (which returns early without a gesture requirement, and the app has no scheduled source nodes), prerender, and the end of an interruption. grep over src finds no resume(), statechange, onerror or devicechange anywhere.

I re-ran the finder's harness myself (Electron 43.4.1, --no-sandbox --disable-audio-output --mute-audio, under xvfb). While running, the video moved +2 s. After suspend it moved +0 s with paused=false. Seeking to the end still fired 'ended'. setSinkId('') resolved and the context stayed suspended. The video's sound comes only through createMediaElementSource (useSongPlayer.ts:445), so every song freezes until reload.

One nuance for DAM songs: hls.js 1.7.1's gap controller sees the stuck playhead as a buffer stall. It nudges the playhead forward 0.1 s at a time and fires BUFFER_STALLED_ERROR, so after 3 stalls the app may wrongly announce 'Switched to low bitrate', and it may skip the song as broken. Either way there is no sound and nothing recovers.

I rated it high, not critical. The impact is party-ruining, but it needs an explicitly chosen output that leaves the device list mid-session: a TV in standby or on another input, an HDMI blip, a Bluetooth speaker that turns itself off, a DAC unplugged. That is a real but not everyday situation. | CONFIRMED: I couldn't refute it. Every step that can be checked holds.

Chromium source (the Chrome/150.0.7871.224 in node_modules/electron, Electron 43.4.1), audio_context.cc:

- OnDevicesChanged, around line 1800: when the sink descriptor is no longer valid and is_sink_id_given_ is set, it calls HandleRenderError and does not fall back to the default.
- HandleRenderError, around line 1992: on kRunning it calls StopRendering, dispatches 'error' and sets kSuspended.
- Nothing restarts the context when the device returns. OnDevicesChanged only handles a sink that is missing.
- NotifySetSinkIdBegins and NotifySetSinkIdIsDone restart rendering only if the context was running.
- NotifySourceNodeStart returns early when no user gesture is required.
- setSinkId to the id already in use resolves at once, without a restart.
- The platform path ends in the same place. A WASAPI session disconnect raises kDeviceChange, and OutputController::ProcessDeviceChange re-creates the stream on the same id. Re-opening a device that is gone fails, and AudioOutputResampler gives no fake-stream fallback after the first stream. So the stream goes to kError, then OnControllerError, AudioOutputDevice::OnError, and finally AudioContext::OnRenderError, which is HandleRenderError again.

The trigger is reachable in the app:

- App.tsx:323 applies the saved output with setSinkId at launch.
- changeSongOutput (App.tsx:330) also calls setSinkId. NotifySetSinkIdIsDone sets is_sink_id_given_ = true even for ''.
- grep finds no resume(), statechange, onerror or devicechange anywhere in src.
- useSongPlayer.ts:445 sends the video's only audio path through audio.audioContext.

My own Electron 43.4.1 harness (xvfb, --disable-audio-output --mute-audio, so fake streams and no device opened) is at /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-gap-song-output-lifecycle-1/app/main.js. It routes a silent webm through createMediaElementSource:

- running: the video moves 1.5 s in 1.5 s.
- suspended: the video moves 0 s in 2 s, paused=false.
- setSinkId('') resolves, but the context stays suspended and the video still moves 0 s.
- video.play(): still 0 s.
- setSinkId({type:'none'}): still suspended, 0 s.
- resume(): the video moves again, 1.49 s, while on the silent sink. This confirms the suggested fix keeps the video's clock running without sound.
- setSinkId('') while running: the video keeps moving.

What I could not show directly is a real device leaving the list, since the e2e's fake audio can't lose a device and I didn't touch the real audio devices. That step rests on the Chromium source above, which follows the Web Audio spec's error handling on a running AudioContext.

I also checked that DAM's hls.js 1.7.1 doesn't make it worse. A stall with a contiguous buffer reports a single non-fatal BUFFER_STALLED_ERROR per stall period and doesn't nudge, so the stream stays frozen rather than being skipped as broken and eating the queue.

Why high and not critical:

- It needs both an explicitly picked, non-default Song output and that device going away mid-session. With System default (the default, nothing saved), is_sink_id_given_ stays false and Chromium falls back to the default by itself.
- A renderer reload (Ctrl+R/F5, index.ts:320-334) recovers, and the queue survives in main's queue.json. That isn't something a host would think to try, though.

Why it is still above medium: the devices people pick for Song output are the ones that come and go. A TV's HDMI output goes when the TV goes to standby or switches input, or when HDMI renegotiates through an AV receiver; a Bluetooth speaker drops out of range; a USB DAC gets unplugged. When it happens, the whole show stops silently across every later song, and the obvious fix, picking an output again in Settings, does nothing.

The file and line stand. The class at webAudio.ts:50 and :157 is where the lifecycle handling belongs.

## gap-song-output-lifecycle-3

**The saved song output is applied once at launch; a TV turned on later is never used, while Settings shows it as selected** (medium, confirmed, bug) · `src/renderer/App.tsx:320`

**Summary.** The saved Song output is applied only once, when the display starts (App.tsx:320-327). If that device isn't connected yet, setSinkId rejects, the songs stay on the system default, and nothing applies the saved choice again when the device shows up later. Settings then shows that device as selected (songOutput is the saved choice, not audioContext.sinkId), and picking it again fires no change event.

**Scenario.** The laptop is started, or karafriends launched, before the TV is on or while it is on another input. On Windows that HDMI endpoint is 'not plugged in', so setSinkId rejects with NotFoundError and the songs go to the default, the laptop speakers. The TV comes on: no devicechange handler exists, so the songs stay on the laptop all night. The host opens Settings: SongOutputSetting lists the TV, `missing` is false, and the select shows 'LG TV' as chosen. Re-selecting it fires no onChange, so the only fix is to pick System default and then the TV again. A TV that appears while Settings is open stays '(not connected)' until Settings is reopened, because enumerateDevices runs once on mount (Settings.tsx:362). Because the launch-time setSinkId never succeeded, is_sink_id_given_ is false and Chromium doesn't treat anything as an error. The context just stays on the default.

**Suggested fix.** Share the mechanism with the first finding. KarafriendsAudio keeps the wanted id, and on 'devicechange' (plus once at startup) it calls setSinkId(wanted) whenever that id is listed and `context.sinkId !== wanted`. Move the localStorage load and save into the class as well, so App drops savedSongOutput, the launch effect and half of changeSongOutput (about 25 lines), and the result is one unit-testable owner. In SongOutputSetting, listen for 'devicechange' to refresh the list, and show where the songs actually play (`context.sinkId`) whenever it differs from the choice: 'LG TV (not connected; playing on System default)'.

**Earlier reviews.** New.

**Verifier.** CONFIRMED: App.tsx:320-327 calls setSinkId(saved.id) once and only logs a rejection. With the device not listed, Chromium rejects it. NotifySetSinkIdIsDone never runs, so is_sink_id_given_ stays false and sink_descriptor_ stays the default ''. OnDevicesChanged then never acts when the TV appears, because the default sink is still valid. Nothing else re-applies the saved id: there is no devicechange listener in src.

App's songOutput state is initialised from savedSongOutput() (App.tsx:192), not from audioContext.sinkId. SongOutputSetting's value is output?.id, and once the TV is listed `missing` is false, so the select shows the TV as chosen while the songs play on the default. Re-selecting the same option fires no onChange, so the workaround is System default, then the TV. enumerateDevices runs once per SongOutputSetting mount (Settings.tsx:362-382), so a TV that appears while it is open stays '(not connected)'.

The README documents the fallback to the default, but not that the choice is never re-applied or that Settings shows the wrong output.

I rated it medium, not high. It needs a launch before the TV's endpoint exists (HDMI-on-other-input often keeps the endpoint), and the host can find a fix in Settings (pick System default, then the TV). | CONFIRMED: I couldn't refute it. The path is confirmed in the code and in Chromium's own source.

Path from trigger to failure:

1. index.tsx:29 builds one KarafriendsAudio for the life of the page.
2. The effect at App.tsx:320-327 runs once and calls setOutput(saved.id), which calls context.setSinkId. A rejection is only logged with console.warn.
3. The only other caller of setOutput is changeSongOutput. The renderer has no 'devicechange' listener (grep finds none), and the page reloads only after a crash or a confirmed F5.

Chromium's audio_context.cc, fetched by the finder into find-gap-song-output-lifecycle/chromium/audio_context.dec.cc:

- SetSinkIdResolver::Start (line ~283) rejects with NOT_FOUND when the id isn't in output_device_ids_. Windows lists only active endpoints, so a TV that is off or unplugged isn't there.
- is_sink_id_given_ is set only in NotifySetSinkIdIsDone, so after a failed call sink_descriptor_ stays "" (the default).
- When the TV appears, OnDevicesChanged (line ~2026) refreshes output_device_ids_. The current sink "" is still valid, so nothing re-targets.

The UI side:

- songOutput state is still the saved choice (useState(savedSongOutput)).
- SongOutputSetting runs enumerateDevices on mount. Once the TV is listed, `missing` (Settings.tsx:384) is false and the select's value is the TV's id, so the TV shows as selected while the songs play on the default.
- Choosing the TV again fires no onChange. The ways out are System default then the TV, F5, or a relaunch.

Demonstration: /tmp/claude-1000/-home-brandon-Documents-karafriends/76fa4dac-61da-4447-8fd7-5bfaae6912c0/scratchpad/review/repro-gap-song-output-lifecycle-3/sim.mjs models Chromium's sink rules from that source and runs App's launch logic and Settings' `missing` logic verbatim. It prints selectValue 'tv', missing false, shownLabel 'LG TV', actuallyPlayingOn 'system default'.

Why medium rather than high:

- The trigger needs two things: a Song output other than the default, and that device absent when the display starts but connected later. Examples are launching before the TV is on, a TV that drops HDMI hotplug in standby, or USB/Bluetooth audio connected after launch. All are realistic (the README already mentions "the TV went to sleep" for mics), but none is the usual order. Fullscreen opens on whatever display exists at launch, so hosts usually turn the TV on first.
- The failure is audible at once: songs come from the laptop or default device. So it's noticed at the first song, not left all night.
- The host can recover by picking System default then the TV, by F5, or by relaunching. The misleading "selected" state makes that harder to find, but the feature doesn't stay broken.

That fits "a real bug on a less common path". The file and line in the finding are right: the effect starts at App.tsx:320 (its comment is at 318), with the related display logic at Settings.tsx:384-397.

One overstatement: "the songs stay on the laptop all night" assumes the host never notices or works around it.

## renderer-audio-3

**A mic that fails its first open is dropped instead of kept down for the watchdog; saved mics vanish at launch and are then erased** (medium, confirmed, bug) · `src/renderer/nativeAudio.ts:118`

**Summary.** The InputDevice constructor calls create() before it starts the watchdog, so a first open that fails throws. openSavedMics catches the error and drops the mic. Settings' onChangeMic doesn't catch at all. The watchdog's 'tried again every time, until it is back' only covers mics that opened once.

**Scenario.** The PC boots with the HDMI TV (its only output) still off. InputDevice::new fails at mixer.open_if_needed(), every saved mic is dropped, and when the TV wakes no mic comes back. The host's first mic or level change (saveMics) then rewrites localStorage "mics" with only the open mics, so the saved list is gone for good. A busy mic at launch has the same effect. In Settings, picking a mic that won't open (busy, or unplugged since the list was made) throws out of the select's onChange: no row appears, no message is shown, and the select snaps back to 'Select a microphone'.

**Suggested fix.** Let the constructor start the mic down instead of throwing: `this.open = false; this.openAgain();` and then start the watchdog. The row then shows the error and the watchdog retries, at launch and in Settings, and the saved list stays intact. That needs a stable row key: Settings.tsx:941 `key={mic.deviceId}` changes on every reopen anyway, which remounts the row (mid slider drag) the next time Settings renders. Use an id assigned once per InputDevice.

**Earlier reviews.** Related to product review #4 (the watchdog now never gives up, fixed). Launch-time and first-open failures were noted there as untested and are still present.

**Verifier.** CONFIRMED: nativeAudio.ts:118 runs create() before the watchdog starts, and the neon binding (native/karafriends/src/lib.rs input_device__new) throws on Err. karafriends-lib InputDevice::new runs mixer.open_if_needed()? before it looks up the input, so a missing default output ("No default output device") fails every mic. App.tsx openSavedMics catches the error, drops the mic with only a console.warn, and never retries. saveMics, called from changeLevels (any level change, including an admin's from a phone) and from setMics, then writes only the open mics to localStorage "mics", so the dropped mic is erased. onChangeMic (App.tsx:385) has no try/catch and MicrophoneSetting's select onChange calls it directly, so a failed open throws out of the event handler: no row, no message. Note that mics missing from the list at launch are dropped on purpose (the filter in openSavedMics), so the bug is specifically a listed mic or the output failing to open. The Settings path (a mic unplugged since the list was made) is the more common way in. The Settings.tsx:941 key={mic.deviceId} point is right: preload maps devices to a new numeric index on each open, so the key changes on every reopen.

**Also reported as** (An InputDevice should be able to start down so the watchdog retries it, and the saved list should stay intact. That needs a stable per-InputDevice row key instead of the native handle (native-bindings-6).):

- renderer-playback-2: A saved mic that's off or busy at launch gets no row and no retry, and the next level change erases it (`src/renderer/App.tsx:156`). Its fix: Let an InputDevice start in the down state. In the constructor, catch create() (open=false, error=String(err)) and start the watchdog anyway. The row then shows why the mic is down, and the mic opens when it appears. openSavedMics can then keep every saved mic (no channelCounts filter, no drop on a throw), and the try/catch goes. onChangeMic can no longer throw, and saveMics keeps the mic saved.
- native-bindings-1: A saved mic that isn't there at launch is erased from the saved list at the next level change (`src/renderer/App.tsx:156`). Its fix: Don't drop saved entries just because they didn't open this time. Option 1: in saveMics, write the open mics plus the saved entries that never opened and weren't removed by the host. Option 2 (better): keep each such mic as a row in an error state that the watchdog keeps retrying. A receiver switched on later then comes back by itself, and the row says why it is down. An e2e fake with a mic that fails to open would cover this.
- native-bindings-6: Mic rows are keyed by the native handle number, which changes on every reopen (`src/renderer/Settings.tsx:941`). Its fix: Give InputDevice a stable id assigned once in the constructor (a module counter), key rows by it, and make deviceId private. This removes the remounts and keeps the native handle out of the UI.

## renderer-settings-1

**A mic, mic output or song output that fails to open is dropped without a word** (medium, confirmed, bug) · `src/renderer/App.tsx:384`

**Summary.** Picking a device on the Sound tab can fail, and nothing on screen says so. The select just snaps back. onChangeMic calls openMic with no try/catch, so the native error escapes the select's onChange as an uncaught exception. changeMicOutput and changeSongOutput catch their errors but only console.error them. The Sound and Microphones sections (Settings.tsx:892, :921) take no `message`, so there is no place to show why.

**Scenario.** On Windows the inputs are listed once per launch (preload `inputList ??=`), so a USB mic unplugged since launch, or one another program holds in exclusive mode, is still listed. The host picks it in 'Add a microphone' and `native.inputDevice_new` throws. The select goes back to 'Select a microphone' with no message. The same happens when the mic output can't open, because every new mic fails inside open_if_needed. A song output whose setSinkId rejects also just reverts the select. The host can't tell a broken mic from a mis-click.

**Suggested fix.** Give the Microphones and Sound sections a message. Have onChangeMic, changeMicOutput and changeSongOutput return or throw the reason, and show it the way `act` does, e.g. "Couldn't open <label>: <reason>". In onChangeMic, try/catch around openMic so the error is shown rather than thrown out of the event handler.

**Verifier.** CONFIRMED: Traced end to end. App.tsx:384 onChangeMic calls openMic with no guard. new InputDevice → create() → native.inputDevice_new, which throws (lib.rs:162-165) when InputDevice::new fails (karafriends-lib lib.rs:433-441: open_if_needed or open, i.e. a device that won't build a stream). On Windows the preload caches the list (`inputList ??=`, preload/index.ts:239), so an unplugged mic, or one another program holds exclusively, is still offered. React 19 reports an error thrown from an event handler through reportGlobalError (console and window error) and leaves the controlled select at its old value. MicrophoneSetting shows mic.error only for a mic that already exists, and the Sound and Microphones SettingsSections get no `message`, so nothing on screen says why. changeSongOutput (setSinkId rejecting) and changeMicOutput only console.error. One correction: changeMicOutput's catch is narrower than the summary implies. mixer.build() falls back to the default output and returns an 'ok: … couldn't open' note when the chosen output fails, and Settings shows that note, so setOutputDevice throws only when the default output fails too. The mic-add path is the main case. Medium fits: it breaks a central feature, on a less common path.

**Also reported as** (A device that fails to open when picked does so silently: catch the error in onChangeMic and show the reason. Stopping the old mic first on the same exclusive endpoint is part of native-exclusive-1's fix.):

- native-bindings-3: Picking a mic that won't open fails silently, and in exclusive mode a row can't move to another channel of the same interface (`src/renderer/App.tsx:385`). Its fix: In onChangeMic, try openMic first. If it fails and the old mic is on the same device (oldMic.name === name), stop the old mic and try once more; if that also fails, reopen the old one. Otherwise keep the old mic. Show the error under the row through Settings state instead of letting it throw. A fake inputDevice_new that throws for one id would cover this.

## gap-song-output-lifecycle-6

**The 'Output latency' hint is read once per App render and goes stale after a song output change** (low, plausible, bug) · `src/renderer/App.tsx:495`

**Summary.** audioLatencyMs={props.audio.latencyMs()} is a value captured when App renders. Settings has no tick or 'sinkchange' listener for it. After changeSongOutput, App re-renders in the same microtask chain as the setSinkId resolution, before the new output has rendered and reported outputLatency, which Chromium updates only periodically. The hint keeps the old output's number until some unrelated App state changes.

**Scenario.** The host switches Song output from the laptop speakers (about 20 ms) to a TV that adds about 120 ms, then reads 'Output latency: 20 ms' under Audio/video offset and picks the offset from it. The real delay is 100 ms more, so lyrics run ahead of the sound until something else (an announcement, a mic change) re-renders App and the number jumps.

**Suggested fix.** Pass `audio`, or a `latencyMs` function, to Settings and read it under the existing useTick (MicrophoneSetting.tsx already ticks), or re-read it on the context's 'sinkchange' event. That is about 3 lines.

**Earlier reviews.** New.

**Verifier.** PLAUSIBLE: Confirmed: audioLatencyMs is a number computed in App's render (App.tsx:495). Settings has no tick or sinkchange listener for it; useTick lives only in MicrophoneSetting's children and doesn't re-render Settings or App. App re-renders only on its own state or the live-state selectors (mics, idle), so after a sink change the hint keeps whatever value was read at the render triggered by setSongOutput.

Whether that value is stale depends on timing. Chromium updates output_position_.hardware_output_latency on the render thread each quantum (audio_context.cc:1448). React 19 renders setSongOutput's update in a scheduler task shortly after the promise resolves, not 'in the same microtask chain' as claimed. The new WASAPI stream very likely hasn't produced a callback by then, but I couldn't confirm that without a real device.

The hint updates on the next App re-render, for example when the host changes the offset. The impact is a stale informational number.
