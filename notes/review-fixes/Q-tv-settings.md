# Phase Q: TV Settings

Part of [`PLAN-review-fixes.md`](../PLAN-review-fixes.md), from the 2026-10-28 review of `fb09949` ([report](https://claude.ai/artifact/31yjSvAuHPpaHGPyXQXfHq)). Line numbers are as of `fb09949`. Wave 3; starts after: H, O, P.

Files: src/renderer/Settings.tsx (split by tab into files of its own), Settings.css, the Settings parts of src/renderer/App.tsx.

Each finding below was checked by a skeptic. CONFIRMED means traced end to end; PLAUSIBLE means the mechanism is real but the scenario wasn't shown. Over-engineering items were checked against callers, git history and `notes/`: KEEP means worth doing, WEAK means do it only while in the file anyway. The suggested fix is a starting point; where the verifier corrected it, the verifier wins.

| Finding                                       | Severity | Title                                                                                                                             |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [native-bindings-4](#native-bindings-4)       | Medium   | Native listing calls that can throw run during render, so one bad device puts the whole display on the error screen               |
| [renderer-settings-12](#renderer-settings-12) | Low      | Settings.tsx (1048 lines) mixes field primitives, tab navigation, the save/test/import chain and five tab bodies; split it by tab |
| [renderer-settings-4](#renderer-settings-4)   | Low      | First run: the save that completes a login removes the banner and moves 'Test login' out from under the click                     |
| [renderer-settings-5](#renderer-settings-5)   | Low      | Test login runs even when the save before it failed, tests the old login, and replaces the save's error with 'Signed in'          |
| [renderer-settings-6](#renderer-settings-6)   | Low      | A refusal and its tab dot stay up after the host puts the field back to the saved value                                           |
| [renderer-settings-7](#renderer-settings-7)   | Low      | Escape drops a field being edited, and Close hides a refusal: "saves as the host leaves it" isn't true for leaving Settings       |
| [renderer-settings-8](#renderer-settings-8)   | Low      | The Address pick isn't kept, so the restart the Port field asks for, or any relaunch, sends the QR code back to karafriends.local |
| [renderer-settings-9](#renderer-settings-9)   | Low      | The mic output's 'isn't connected / couldn't open' note is computed in Settings' render, so it doesn't follow the 2 s tick        |
| [renderer-settings-10](#renderer-settings-10) | Low      | Import config shows nothing for up to 15 s while both logins are tested, and every other save waits behind it                     |
| [renderer-settings-11](#renderer-settings-11) | Low      | The mic row keeps its four fixed columns at a large UI scale, leaving the device select almost no room for its text               |

## native-bindings-4

**Native listing calls that can throw run during render, so one bad device puts the whole display on the error screen** (medium, plausible, bug) · `src/renderer/Settings.tsx:481`

**Summary.** Four render-time calls into native code have no guard. Settings lists the outputs in a useState initializer. MicOutputSetting calls outputOptions in useMemo. DeviceSelect calls inputDevices() during render, and on Linux that lists again after refreshInputDevices. App's initializer lists the inputs outside its per-mic try. The only error boundary is at the root, so a throw unmounts Player along with the song. The native lists also fail as a whole when one device misbehaves. output_devices collects a Result<Vec> over _output_name, so one output whose description fails fails the whole list; cpal's WASAPI description even panics (`expect("could not open property store")`), and neon turns that into a JS error. _device_name unwraps device.id(), so one input without an id fails inputDevices, although collect_devices' comment says such an input is left out.

**Scenario.** During a song, the host presses S just as a Bluetooth headset or an HDMI TV endpoint is connecting or going away. Enumeration still sees the device, but its property store won't open. outputDevices() throws inside Settings' initializer, "Something went wrong" replaces the display, and the song stops; Reload is the only way back. If the input listing throws at launch instead, every Reload lands on the error screen until the device settles.

**Suggested fix.** Make the native lists skip a bad device the way collect_devices skips one whose config fails: use filter_map plus eprintln in output_devices, and `id().ok()` with skipping in _device_name. In the preload, wrap the listing calls so they log and return [] or null, so render code never sees a throw. Alternatively, try/catch in the initializers and show the message under Microphones.

**Earlier reviews.** Related to product review mic round #2 (a saved mic that fails to open threw out of App's initializer). That was fixed with a per-mic try; the listing call in the same initializer is still unguarded.

**Verifier.** PLAUSIBLE: The unguarded render-time calls are real. Settings.tsx:479-482 (useState initializer: refreshInputDevices + outputDevices), MicOutputSetting's useMemo outputOptions, DeviceSelect's inputDevices() during render, and App's openSavedMics, where the inputDevices() call at :150-154 is outside the per-mic try. index.tsx has a single root ErrorBoundary, so a throw there unmounts Player. The native facts are also right. output_devices collects into Result<Vec>, so one Err from _output_name fails the list. On Linux, label() returning None falls through to `description()?`. cpal-0.18.2 wasapi Device::description has `.expect("could not open property store")`, _device_name does `device.id().unwrap()`, and neon's convert_panics turns a panic into a JS exception. What I couldn't show is a realistic trigger. OpenPropertyStore or GetId failing on an endpoint that was just enumerated is rare, and the Bluetooth/HDMI timing scenario is speculative. The ALSA, PipeWire and ASIO id/description paths here practically always return Ok. The impact would be severe if it happened, but nothing shows it's reachable in practice, so this is a hardening item.

**Also reported as** (Native listing calls run during render and throw. Have the native lists skip a bad device (including the device.id() unwrap), and have the preload wrappers return [].):

- renderer-playback-5: A failed device listing throws into render: App never renders at launch, and opening Settings takes the song down (`src/renderer/App.tsx:151`). Its fix: Catch in the preload wrappers: log, return [], and don't memoize the failed list. That covers App, Settings and MicrophoneSetting at once.
- renderer-settings-3: A native enumeration error while Settings renders takes down the whole display, the playing song included (`src/renderer/Settings.tsx:479`). Its fix: Wrap these calls in nativeAudio.ts helpers that catch, log, and return an empty list or null plus a problem string shown under Microphones. Or put an ErrorBoundary around the Settings panel (or the Sound tab) so a failure there can't unmount the Player.
- native-core-4: `_device_name` unwraps `device.id()`, so one input that won't give its id throws for the whole list (`native/karafriends-lib/src/lib.rs:1070`). Its fix: Return `Option<String>` from `_device_name` (`device.id().ok()?`). Use filter_map in collect_devices, and in the find in `open` compare `== Some(name)`.

## renderer-settings-12

**Settings.tsx (1048 lines) mixes field primitives, tab navigation, the save/test/import chain and five tab bodies; split it by tab** (low, plausible, maintainability) · `src/renderer/Settings.tsx:438`

**Summary.** Settings.tsx is long (1048 lines; the default export runs from :438 to :1048, with 23 props, 18 of them pass-throughs for Sound/Display). The parts worth changing are narrower than a full split by tab. (1) The save/test/import chain (act, save, saveNumber, testLogin, importConfig) and the field primitives' derived state (TextSetting draft, Checkbox revert) have no unit tests, and findings 5-7 are bugs in exactly that logic. Pulling the chain into a plain module that can be tested with a fake `call` is worthwhile. (2) The Sound tab's open-time native calls and outputNote belong in a Sound component that ticks, which also fixes finding 9. The error-string duplication (5× at :309, :508, :510, :522, :602) is small.

**Scenario.** The bugs above all sit where these concerns meet: the stale outputNote (parent vs ticking child), Test login vs a failed save (chain semantics), and the banner shift (load state vs fields). None of the risky logic (TextSetting's derived draft, Checkbox's revert, the act chain) has a unit test; only e2e covers it. Error text is built five times as `String((err as Error)?.message ?? err)` (:309, :508, :510, :522, :602). LABELS (:420) repeats the labels in the JSX and in saveNumber's `label` argument, yet covers only 2 of the 6 keys the server can refuse.

**Suggested fix.** Make Settings.tsx a ~150-line shell (load, header, tabs, panel switch). Move the primitives to settings/controls.tsx (~135 lines). Move the chain to settings/actions.ts as a plain `createSettingsActions({call, say, reload})`, unit-testable under node --test with a fake call (~150 lines). Give each tab its own file: AccountsTab (~70), PartyTab (~135), SoundTab (~120, owning outputs/asioProblem/linux/outputNote so the native calls run only when Sound opens), DisplayTab (~35), AdvancedTab (~110 with DownloadsSection and Tools). Render Sound and Display without waiting for getSettings. Use one `problemMessage(err)` helper and one FIELD_LABELS table for both the JSX and `labelled`. The file line count stays about the same; the gain is that each concern can be tested and changed on its own.

**Verifier.** PLAUSIBLE: The facts mostly check out. The file is 1048 lines, the default export starts at :438, the error-string pattern appears five times at the lines given, and LABELS covers only paxSongQueueLimit and remoconPort. No unit test touches Settings; only tests/e2e/settings.spec.ts does. The prop count is off: 23 props, 18 pass-throughs, not 20 and 16. Some of the justification is weak. Finding 4 (the banner shift) and finding 5 (chain semantics) wouldn't go away with a file split, and the open-time enumeration costs about 4-6 ms, which is negligible. Splitting into about eight files with no line savings is mostly a style preference. What justifies a low-severity note is the missing tests for the chain and the field commit logic, plus co-locating the Sound tab's state with its ticking child. I narrowed the summary to those.

**Also reported as** (Split Settings.tsx by tab and make the save chain testable. cross-maintainability-6's api.ts and JoysoundRenderer splits are the same kind of refactor.):

- cross-maintainability-6: Settings.tsx, api.ts and JoysoundRenderer.tsx each hold a part that could be split out, and the display's preferences reach Settings through 23 props (`src/renderer/Settings.tsx:438`). Its fix: (a) Add displayPrefs.ts with a `pref(key, parse, fallback)` helper and a useDisplayPref hook. Each tab becomes its own component that reads the preferences it shows, with the primitives in settings/fields.tsx. App loses about 120 lines and the 23-prop relay. (b) Move the lookups into createLookups(deps) in main/lookups.ts, spread into the handlers the way createSettingsHandlers is. That takes about 230 lines out of api.ts, and the lookup tests move with them. (c) Put the canvas layout in joysoundTextures.ts, taking the expand rates as arguments instead of globals, and move the two shaders into .glsl files.

## renderer-settings-4

**First run: the save that completes a login removes the banner and moves 'Test login' out from under the click** (low, confirmed, bug) · `src/renderer/Settings.tsx:747`

**Summary.** Fields save on blur, and the blur happens on mousedown. When the save completes the first login, reload() flips isFirstRun to false and the banner above the DAM section is removed. That happens a few ms later, before mouseup, so everything below moves up by the banner's height. Chromium then fires the click on the common ancestor of the mousedown and mouseup targets, not on the button, and Test login never runs.

**Scenario.** On a fresh install the host types a DAM username, then the password, then clicks Test login with the mouse. mousedown blurs the password field, which runs save() and reload(): two IPC round trips and a config.yaml write, well under a typical 80-150 ms click. isFirstRun becomes false and the banner (about 6-9rem, roughly 100-140px at 1080p, more than the 4rem/64px button) disappears. On mouseup the pointer is over the gap or the Joysound card. Nothing happens, and Test login looks broken on the very first try. The same goes for a first click on 'Stream at a low bitrate'.

**Suggested fix.** Keep the banner's space until Settings closes: hold isFirstRun from the first load in state and ignore later reloads, or hide it with visibility rather than removing it. More generally, don't change layout above the field being edited as the result of a blur-save.

**Verifier.** CONFIRMED: The mechanism checks out. isFirstRun is live (main/settings.ts:178, both fields of one login set). save() awaits reload() over IPC (apiClient call → callOverIpc), so the banner is removed within milliseconds of the blur that mousedown triggers, well before a typical mouseup. The geometry holds whatever the line count: the shift is the banner (padding 2rem plus at least one 2.25rem line) plus the 1.5rem `> * + *` margin, so at least about 6.2rem, against a 4rem .kfButton. The pointer can't still be over Test login at mouseup. Chromium then fires click on the common ancestor (the reviewer also tested this in Electron), so the button's onClick doesn't run. I rate it low, not medium: it happens once per install and costs one dropped click, and the save itself worked. The second click works.

## renderer-settings-5

**Test login runs even when the save before it failed, tests the old login, and replaces the save's error with 'Signed in'** (low, confirmed, bug) · `src/renderer/Settings.tsx:562`

**Summary.** testLogin first sets 'Signing in…' synchronously, then queues its test on the chain whatever happened to the save queued just before it. If that save was refused or couldn't write config.yaml, the error is visible for about one click, then overwritten. The Accounts dot goes too, since the tone is no longer 'problem'. The test then runs against the old saved login.

**Scenario.** The host types a new DAM password and clicks Test login. The blur-save fails, e.g. 'Couldn't save config.yaml: EACCES', or 'damPassword must be text of at most 1000 characters' (shown with the raw key, since LABELS covers only 2 of the 6 refusable keys). The click immediately shows 'Signing in…', and the test signs in with the old saved password: 'Signed in to DAM.' The field still shows the new password. The host believes it's saved and working, but the next launch uses the old one.

**Suggested fix.** Make Test login depend on the save: keep the last save's result per section (or have save() return it) and, if it failed, skip the test and leave the error showing. Or don't overwrite a 'problem' message with 'Signing in…'.

**Verifier.** CONFIRMED: Traced. testLogin (Settings.tsx:562-570) says 'Signing in…' and queues its test whatever the earlier save returned. act (:516-526) ignores what earlier tasks returned. The test reads store.saved(), the old login. If the save completes before the click, the click overwrites its error. If it completes after, the error shows briefly and the test result replaces it. Either way the refusal or write error ends up hidden behind 'Signed in to DAM.' and the tab dot goes. The trigger is rare, though: a login field fails only on more than 1000 characters (configSchema) or a config.yaml write error. Hence low.

## renderer-settings-6

**A refusal and its tab dot stay up after the host puts the field back to the saved value** (low, confirmed, bug) · `src/renderer/Settings.tsx:187`

**Summary.** TextSetting commits only when `draft !== props.value`. After a refused value, typing the saved value back in commits nothing. The section keeps its 'problem' message, and the tab keeps its 'Needs a look' dot for the rest of the Settings session, although the field now holds a valid, saved value.

**Scenario.** With Songs per phone saved as 1, the host types 1001 and presses Enter, and sees 'Songs per phone must be a whole number from 0 to 1000'. They correct it to 1 and press Enter: no commit. The red message stays under the Queue section, and the Party tab shows a dot whenever another tab is open. The same happens after 'Port: enter a whole number.' when the old port is typed back. The e2e test only covers fixing to a different value (2).

**Suggested fix.** Compare against the last value sent, not props.value. Or, on commit, when draft equals props.value and the section is showing a problem, clear that message (call onCommit anyway; store.update ignores unchanged keys and answers 'Saved.').

**Verifier.** CONFIRMED: Settings.tsx:186-188 commits only when draft !== props.value. After a refused 1001, props.value stays '1' (save doesn't change it, and the derived-state reset at :182-185 doesn't fire), so typing 1 and pressing Enter commits nothing. The 'problem' message stays until the next say() for that section, and needsLook (:711-717) keeps the Party dot whenever another tab is open. e2e settings.spec.ts:408-420 fixes it to 2, a different value, so that path isn't covered. Cosmetic, so low.

## renderer-settings-7

**Escape drops a field being edited, and Close hides a refusal: "saves as the host leaves it" isn't true for leaving Settings** (low, confirmed, bug) · `src/renderer/App.tsx:401`

**Summary.** App's keydown handler closes Settings on Escape before its 'not while typing in a field' check. Unmounting the focused input fires no React onBlur, because React turns its event dispatch off during commit. So the edit is dropped without a save or a message. Closing with the button does run the blur-save, but Settings unmounts right away, so a refusal from that save is never shown.

**Scenario.** (a) The host types a new Joysound email and presses Escape to close. Nothing is saved, and the next open shows the old email. (b) The host types Port 80800 and clicks Close. The blur-save is refused (1-65535), but Settings is already gone, so the host never sees why and believes the port changed.

**Suggested fix.** On Escape, blur the active element first (`(document.activeElement as HTMLElement)?.blur()`) so the save runs, then close. For Close, close once `chain.current` settles and stay open, showing the message, if the last save failed. If Escape is meant to cancel, say so in the code and drop the draft explicitly.

**Verifier.** CONFIRMED: (a) App.tsx:400-404 handles Escape before the field check. Settings unmounts during commit, and react-dom 19.2.7 sets `_enabled = !1` in commitBeforeMutationEffects (line 13861, restored at 18079). Chromium's focusout on removing the focused input is therefore never dispatched to onBlur, and the draft is lost without a save. (b) mousedown on Close blurs the field and queues save(); the click then calls onClose and unmounts Settings, and the refusal's say() lands on an unmounted component and is lost. Both are real. The App comment suggests Escape working from inside fields is deliberate, but losing the edit isn't documented. Low.

## renderer-settings-8

**The Address pick isn't kept, so the restart the Port field asks for, or any relaunch, sends the QR code back to karafriends.local** (low, confirmed, bug) · `src/renderer/App.tsx:203`

**Summary.** hostname is plain useState seeded with `${HOSTNAME}:${port}` and never saved. A host who had to pick an IP because karafriends.local doesn't resolve for their phones (the README's advice) must pick it again on every launch, including straight after the Restart button the Port field shows. If the picked address goes away during a session (DHCP renewal, Wi-Fi change), its option disappears and the select stops matching the QR code, which still shows the old address.

**Scenario.** The host picks 10.10.10.225 and changes Port to 9090, and Settings offers Restart. After the restart the QR code says karafriends.local:9090 again, and the Android phones that needed the IP can't join until the host notices and picks it again.

**Suggested fix.** Save the chosen name (without the port) in localStorage, like the other display settings. On load, fall back to karafriends.local when the saved address is no longer in ipAddresses(), and build the value with the current port.

**Verifier.** CONFIRMED: App.tsx:203-205 seeds hostname from HOSTNAME and remoconPort() in plain useState, and nothing saves it. Every other display choice goes to localStorage (avOffset, uiScale, pitchBars, micOutput, songOutput, settingsTab). After the Restart the Port field offers, or any relaunch, the QR code goes back to karafriends.local. HostnameSetting rebuilds its options from ipAddresses() on each render, so if the picked address goes away, the controlled select has no matching option and shows another entry while QRCode keeps the old one. It costs a re-pick, so low.

## renderer-settings-9

**The mic output's 'isn't connected / couldn't open' note is computed in Settings' render, so it doesn't follow the 2 s tick** (low, confirmed, bug) · `src/renderer/Settings.tsx:492`

**Summary.** outputNote reads `props.mics[0]?.status()` in Settings' body. The 2 s useTick lives in the children (MicOutputSetting, MicrophoneSetting), and their re-renders don't re-run the parent. So the note under Mic output only changes when App happens to re-render Settings.

**Scenario.** Settings is open on Sound and the TV the mics play through goes to sleep. The watchdog reopens the mics on the default output, and mics[0].status() becomes 'ok: <TV> isn't connected; the mics play through the default output'. The rows' 'In use' lines update within 2 s, but the note under Mic output doesn't appear until something else re-renders App: a queued song's announcement, a mic change, or closing and reopening Settings.

**Suggested fix.** Move the note into MicOutputSetting, which already ticks, and pass it `mics` or a `status()` getter. That also takes the logic out of Settings.

**Earlier reviews.** Follows on from mic round #6 (show the native ok: note), which was fixed; this staleness wasn't covered.

**Verifier.** CONFIRMED: outputNote is computed in Settings' body (:492-493) from mics[0].status(), and through mixer.status() (mixer.rs:302-307) that returns the mixer's 'ok: …' note. useTick (MicrophoneSetting.tsx:67-73) re-renders only MicOutputSetting and MicrophoneSetting, not their parent. A note produced by the watchdog's reopen (InputDevice.check → new device → mixer.open → build's fallback note) therefore shows only when Settings re-renders: App re-renders on announcements, mic or live-state changes, or a tab switch, and Settings on its own saves. Picking an output from the select does update it at once, because setMicOutput re-renders App, so only the watchdog path goes stale. Low.

## renderer-settings-10

**Import config shows nothing for up to 15 s while both logins are tested, and every other save waits behind it** (low, confirmed, bug) · `src/renderer/Settings.tsx:622`

**Summary.** importConfig runs inside the serial `act` chain with no busy message, and its buttons stay enabled. The main side tests both logins before it answers (Promise.all of testLogin, 15 s timeout each). Meanwhile the Config file section is blank, a second Import click queues another file dialog, and any checkbox or field saved in that time shows its optimistic state but doesn't save until the import is done.

**Scenario.** The host imports a config while the VPN is down or slow. For up to 15 s nothing says the import is running. They click Import again and get a second file dialog once the first finishes. A Supervised mode tick made in that time shows ticked but isn't saved, or visible to phones, until the login tests time out.

**Suggested fix.** Say 'Importing and testing the logins…' (tone busy) right after the file is picked, and disable Import/Export while it runs. Or have importConfig return straight away and run the login tests as separate `act`s, so the chain isn't held.

**Verifier.** CONFIRMED: importConfig (:622-640) runs inside act with no busy say(), unlike testLogin and updateTools, and the Import/Export buttons are never disabled. main/settings.ts:270-278 awaits Promise.all of testLogin for both services, each raced against LOGIN_TIMEOUT_MS = 15_000, before it answers, so the chain is held for up to about 15 s when a service hangs. Later saves (checkbox ticks shown optimistically, field blurs) queue behind it, and a second Import click queues another openTextFile after the first finishes. Low: the UI is unclear and saves are delayed, but nothing is lost.

## renderer-settings-11

**The mic row keeps its four fixed columns at a large UI scale, leaving the device select almost no room for its text** (low, confirmed, bug) · `src/renderer/Settings.css:265`

**Summary.** `.settingsFields` drops to one column when the panel is under 50rem, but `.settingsMicRow` (2fr 1fr 1fr 12rem with three 2rem gaps) has no narrow rule. At UI scale 200% on 1080p (1rem = 32px, so the window is 60rem wide), the panel's inner width is about 31.5rem. The device select gets about 6.75rem (216px), of which 5rem is padding and the arrow, and the sliders get about 3.4rem (108px) under 64px labels like 'Gain 100%'.

**Scenario.** A host bumps UI scale to 180-200% to read Settings on a TV across the room. Each mic row's device select shows almost none of the device name, the Gain/Echo labels spill over their columns, and 'Add a microphone' is just as cramped. The other fields have already gone to one column.

**Suggested fix.** Add `.settingsMicRow` to the `@container (max-width: 50rem)` rule, e.g. `grid-template-columns: 1fr 1fr` with the device select spanning both columns and Remove on the sliders' row.

**Verifier.** CONFIRMED: I worked the CSS through. The root size is clamp(10px, 100vh/67.5, 32px) × scale, so at 200% the window is 60rem wide at both 1080p and 2160p. .settings is under 90rem, so --settings-edge is 3rem and the tabs take 21rem. The panel's content box is 35.5rem, so the 50rem container query turns .settingsFields into one column, and the section's inner width is 31.5rem. .settingsMicRow (:265-270) has no narrow rule: 31.5 − 12 − 3×2 gives 6.75rem for the device select, minus its 1rem plus 4rem padding, and about 3.4rem per slider, under 2rem-text labels like 'Gain 100%' that can't fit and overflow their minmax(0,1fr) columns. At 150% it still fits (about 16.75rem for the select). Scales of 170% and up are uncommon, since 100% is already sized for a TV. Low.
