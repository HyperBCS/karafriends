import React, { useCallback, useEffect, useRef, useState } from "react";

import type { MicInfo } from "../common/api";
import { call, useLiveEvent, useLiveState } from "../common/apiClient";
import { GATE_OFF_DB, gateThreshold } from "../common/micGate";
import "./ui.css";
import "./App.css";
import Announcements from "./Announcements";
import Effects from "./Effects";
import { watchIdleCursor } from "./idleCursor";
import IdleScreen from "./IdleScreen";
import { parseCustomUrl } from "./remoteAddress";
import type { MicLevels } from "./MicrophoneSetting";
import {
  InputDevice,
  inputDevices,
  type MicMode,
  type MicOutput,
  setAsio,
  setMicMode,
  setOutputDevice,
} from "./nativeAudio";
import NoticeBar from "./NoticeBar";
import {
  AV_OFFSET_KEY,
  AV_OFFSETS,
  savedChoice,
  UI_SCALE_KEY,
  UI_SCALES,
} from "./playback";
import Player from "./Player";
import QRCode from "./QRCode";
import Settings, { SETTINGS_TABS, type SettingsTab } from "./Settings";
import type { SoundProps } from "./settings/SoundTab";
import Setup from "./Setup";
import UpNext from "./UpNext";
import type { Announcement } from "./useSongPlayer";
import KarafriendsAudio, { type SongOutput } from "./webAudio";

// How long an announcement stays in the corner.
const ANNOUNCE_MS = 4000;
// The most announcements shown at once; older ones go first.
const MAX_ANNOUNCEMENTS = 3;

// The noise gate starts off.
const DEFAULT_LEVELS: MicLevels = { gain: 100, echo: 40, gate: GATE_OFF_DB };

// localStorage's "mics": each device's name, its channel and its levels.
// Entries saved before the levels existed get the defaults.
type SavedMic = { name: string; channel: number } & MicLevels;

// The output device the mics play through; not set for the system default.
// An ASIO one's rate and buffer size, when not the driver's own, apart.
const MIC_OUTPUT_KEY = "micOutput";
const MIC_OUTPUT_RATE_KEY = "micOutputRate";
const MIC_OUTPUT_BUFFER_KEY = "micOutputBuffer";

// A whole number saved under key, if there is one.
function savedNumber(key: string): number | null {
  const value = Number(localStorage.getItem(key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function savedMicOutput(): MicOutput {
  return {
    name: localStorage.getItem(MIC_OUTPUT_KEY),
    rate: savedNumber(MIC_OUTPUT_RATE_KEY),
    bufferSize: savedNumber(MIC_OUTPUT_BUFFER_KEY),
  };
}

// Saves value under key, or forgets the key for null.
function save(key: string, value: string | number | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, String(value));
}

function saveMicOutput({ name, rate, bufferSize }: MicOutput) {
  save(MIC_OUTPUT_KEY, name);
  save(MIC_OUTPUT_RATE_KEY, rate);
  save(MIC_OUTPUT_BUFFER_KEY, bufferSize);
}

// The output the songs play through (an id from enumerateDevices, and
// its name, to show while it isn't connected); not set for the system
// default.
const SONG_OUTPUT_KEY = "songOutput";

function savedSongOutput(): SongOutput | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SONG_OUTPUT_KEY) ?? "null");
    return typeof saved?.id === "string" && typeof saved?.label === "string"
      ? saved
      : null;
  } catch {
    return null;
  }
}

// Windows mics: "exclusive" (not set for shared), and the buffer size an
// exclusive mic asks for (not set for the smallest).
const MIC_MODE_KEY = "micMode";
const MIC_BUFFER_KEY = "micBuffer";

function savedMicMode(): MicMode {
  return {
    exclusive: localStorage.getItem(MIC_MODE_KEY) === "exclusive",
    bufferSize: savedNumber(MIC_BUFFER_KEY),
  };
}

// "off" when DAM and Joysound songs show no pitch bars (the piano roll);
// not set for on.
const PITCH_BARS_KEY = "pitchBars";

// Settings' Use ASIO: "on" or "off". Not set, it's on only if the mic
// output or a saved mic is an ASIO device (set up before there was a
// switch).
const USE_ASIO_KEY = "useAsio";

const isAsio = (name: string | null) => name?.endsWith(" (ASIO)") ?? false;

function savedUseAsio(): boolean {
  const saved = localStorage.getItem(USE_ASIO_KEY);
  if (saved !== null) return saved === "on";
  return (
    isAsio(localStorage.getItem(MIC_OUTPUT_KEY)) ||
    readSavedMics().some((mic) => isAsio(mic.name))
  );
}

// The LAN address the QR code sends phones to, without the port, when the
// host picked one; not set for the default, this computer's first.
const HOSTNAME_KEY = "hostname";

// The custom URL the QR code sends phones to instead (Tailscale, a port
// forward, a proxy), when the host set one; one saved that no longer passes
// parseCustomUrl is left out.
const CUSTOM_URL_KEY = "customUrl";

function savedCustomUrl(): string | null {
  const saved = localStorage.getItem(CUSTOM_URL_KEY);
  if (saved === null) return null;
  const parsed = parseCustomUrl(saved);
  return "url" in parsed ? parsed.url : null;
}

// How often the display looks again at this computer's addresses, so the QR
// code follows a new network (or a new address from the router).
const ADDRESSES_MS = 10_000;

// The picked address, if this computer still has it (a new network gives a
// new address); its first LAN address if not, or "localhost" with none (no
// network: no phone could reach it anyway). With the port phones use.
function savedHostname(): string {
  const saved = localStorage.getItem(HOSTNAME_KEY);
  const addresses = window.karafriends.ipAddresses();
  const name =
    saved !== null && addresses.includes(saved)
      ? saved
      : (addresses[0] ?? "localhost");
  return `${name}:${window.karafriends.remoconPort()}`;
}

// How the phones tell the mics apart (MicInfo.id).
function micId(name: string, channel: number): string {
  return `${name}#${channel}`;
}

function readSavedMics(): SavedMic[] {
  const saved: SavedMic[] = JSON.parse(localStorage.getItem("mics") || "[]");
  return saved.map((mic) => ({ ...DEFAULT_LEVELS, ...mic }));
}

function openMic(name: string, channel: number, levels: MicLevels) {
  const mic = new InputDevice(name, channel);
  mic.setGain(levels.gain / 100);
  mic.setEcho(levels.echo / 100);
  mic.setGate(gateThreshold(levels.gate));
  return mic;
}

// An error's message, to show in Settings.
const reason = (err: unknown) => String((err as Error)?.message ?? err);

// Opened once per page: StrictMode calls App's initializer twice in
// `yarn dev`, and a second set would play every mic twice.
let openedSavedMics: InputDevice[] | null = null;

// Saved mics that weren't listed at launch (unplugged): kept in the saved
// list, to open at a later launch, unless the host picks one meanwhile.
let unlistedSavedMics: SavedMic[] = [];

// The mic output and the microphones picked last time that are still
// listed. One that won't open (busy, or the mic output won't) starts down,
// and its watchdog keeps trying it. The output and the mode first, so the
// mics open on the one and in the other.
function savedMics(): InputDevice[] {
  openedSavedMics ??= openSavedMics();
  return openedSavedMics;
}

function openSavedMics(): InputDevice[] {
  // Before anything lists or opens a device.
  setAsio(savedUseAsio());
  try {
    setOutputDevice(savedMicOutput());
  } catch (err) {
    // The mics start down, and say why.
    console.warn("The saved mic output won't open:", err);
  }
  setMicMode(savedMicMode());
  // None while the listing fails: the saved mics then wait, kept, for a
  // launch that lists them.
  const channelCounts = new Map(
    inputDevices().map(([id, , channels]) => [id, channels]),
  );
  const listed = ({ name, channel }: SavedMic) =>
    channel < (channelCounts.get(name) ?? 0);
  const saved = readSavedMics();
  unlistedSavedMics = saved.filter((mic) => !listed(mic));
  return saved.filter(listed).map((mic) => openMic(mic.name, mic.channel, mic));
}

function savedLevels(): Record<string, MicLevels> {
  return Object.fromEntries(
    readSavedMics().map(({ name, channel, gain, echo, gate }) => [
      micId(name, channel),
      { gain, echo, gate },
    ]),
  );
}

function App(props: { audio: KarafriendsAudio }) {
  // None until the display has painted (see below).
  const [mics, _setMics] = useState<InputDevice[]>([]);
  // Apart from the devices, so the piano roll keeps its mics (and what they
  // sang) while a level changes. By micId.
  const [levels, setLevels] = useState(savedLevels);
  // The latest levels, which changeLevels builds on: two admins'
  // setMicLevels can come before a render.
  const latestLevels = useRef(levels);
  const [micOutput, setMicOutput] = useState(savedMicOutput);
  const [micMode, setMicModeState] = useState(savedMicMode);
  const [songOutput, setSongOutput] = useState(savedSongOutput);
  const [avOffsetMs, setAvOffsetMs] = useState(() =>
    savedChoice(localStorage.getItem(AV_OFFSET_KEY), AV_OFFSETS, 0),
  );
  const [uiScale, setUiScale] = useState(() =>
    savedChoice(localStorage.getItem(UI_SCALE_KEY), UI_SCALES, 100),
  );
  const [hostname, setHostname] = useState(savedHostname);
  const [customUrl, setCustomUrl] = useState(savedCustomUrl);
  // Where the QR code sends phones.
  const remoteUrl = customUrl ?? `http://${hostname}`;
  const [pitchBars, setPitchBars] = useState(
    () => localStorage.getItem(PITCH_BARS_KEY) !== "off",
  );
  const [upNextVisible, setUpNextVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The setup screen, on a first start.
  const [setupOpen, setSetupOpen] = useState(false);
  // For the keys: S doesn't open Settings under the setup screen.
  const setupShown = useRef(false);
  setupShown.current = setupOpen;
  // Settings opens on its first tab every time.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(SETTINGS_TABS[0]);
  const [useAsio, setUseAsio] = useState(savedUseAsio);
  const [announcements, setAnnouncements] = useState<
    (Announcement & { id: number })[]
  >([]);
  const lastAnnouncementId = useRef(0);
  const idle = useLiveState((state) => !state?.currentSong);
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.karafriends.fullScreen.onChange(setFullScreen), []);

  // In full screen, the mouse pointer hides when the mouse is still, unless
  // Settings or the setup screen is up (index.css hides it).
  const hideStillPointer = fullScreen && !settingsOpen && !setupOpen;
  // Out of full screen, the window (which has no frame) moves by its top
  // edge: windowDragBar in index.css.
  useEffect(() => {
    if (!hideStillPointer) return;
    return watchIdleCursor(document, (hidden) =>
      document.body.classList.toggle("pointerHidden", hidden),
    );
  }, [hideStillPointer]);

  const announce = useCallback((announcement: Announcement) => {
    const id = ++lastAnnouncementId.current;
    setAnnouncements((shown) =>
      [...shown, { ...announcement, id }].slice(-MAX_ANNOUNCEMENTS),
    );
    setTimeout(
      () => setAnnouncements((shown) => shown.filter((a) => a.id !== id)),
      ANNOUNCE_MS,
    );
  }, []);

  const idOf = (mic: InputDevice) => micId(mic.name, mic.channelSelection);
  const levelsOf = (id: string) => levels[id] ?? DEFAULT_LEVELS;

  // Every row, down or not, and the saved mics that weren't listed.
  const saveMics = (
    newMics: InputDevice[],
    newLevels: Record<string, MicLevels>,
  ) => {
    const micsToSave: SavedMic[] = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
      ...(newLevels[idOf(mic)] ?? DEFAULT_LEVELS),
    }));
    localStorage.setItem(
      "mics",
      JSON.stringify([...micsToSave, ...unlistedSavedMics]),
    );
  };

  const setMics = (newMics: InputDevice[]) => {
    saveMics(newMics, levels);
    _setMics(newMics);
  };

  // New levels for some mics, by micId: on their devices (and any other row
  // on the same channel), and saved, all in one update.
  const changeLevels = (changes: Record<string, MicLevels>) => {
    const allLevels = { ...latestLevels.current, ...changes };
    latestLevels.current = allLevels;
    for (const mic of mics) {
      const newLevels = changes[idOf(mic)];
      if (!newLevels) continue;
      mic.setGain(newLevels.gain / 100);
      mic.setEcho(newLevels.echo / 100);
      mic.setGate(gateThreshold(newLevels.gate));
    }
    saveMics(mics, allLevels);
    setLevels(allLevels);
  };

  // The phones' list, whenever a mic or its levels change here.
  useEffect(() => {
    const list: MicInfo[] = mics.map((mic) => ({
      id: micId(mic.name, mic.channelSelection),
      label: mic.label,
      ...(levels[micId(mic.name, mic.channelSelection)] ?? DEFAULT_LEVELS),
    }));
    call("setMics", { mics: list }).catch((err) =>
      console.error("Couldn't list the mics for the phones:", err),
    );
  }, [mics, levels]);

  // An admin's setMicLevels: just the levels it gave, so a change the host
  // is making to the other one here stands.
  useLiveEvent("micLevels", ({ id, gain, echo, gate }) => {
    if (!mics.some((mic) => idOf(mic) === id)) return;
    const own = latestLevels.current[id] ?? DEFAULT_LEVELS;
    changeLevels({
      [id]: {
        gain: gain ?? own.gain,
        echo: echo ?? own.echo,
        gate: gate ?? own.gate,
      },
    });
  });

  // Kept only once it opened (or fell back to the default), so a choice
  // that fails can't break the next launch. Returns why it didn't, for
  // Settings to show.
  const changeMicOutput = (output: MicOutput): string | null => {
    try {
      setOutputDevice(output);
    } catch (err) {
      console.error(`Couldn't switch the mic output to ${output.name}:`, err);
      const name = output.name ?? "System default";
      return `Couldn't switch the mic output to ${name}: ${reason(err)}`;
    }
    // Mics that went down with the old output, or that resample to its old
    // rate, reopen now rather than at the watchdog's next look.
    for (const mic of mics) mic.check();
    saveMicOutput(output);
    setMicOutput(output);
    return null;
  };

  // The saved song output: one that isn't connected leaves the songs on
  // the system default until it is.
  useEffect(() => {
    const saved = savedSongOutput();
    if (saved) {
      props.audio.wantOutput(saved.id).catch((err) => {
        console.warn(`The song output ${saved.label} isn't there yet:`, err);
      });
    }
  }, [props.audio]);

  // Kept only once the songs play there. Resolves to why they don't, for
  // Settings to show.
  const changeSongOutput = async (
    output: SongOutput | null,
  ): Promise<string | null> => {
    const name = output?.label ?? "System default";
    try {
      await props.audio.setOutput(output?.id ?? "");
    } catch (err) {
      console.error(`Couldn't switch the songs to ${name}:`, err);
      return `Couldn't play the songs on ${name}: ${reason(err)}`;
    }
    if (output) localStorage.setItem(SONG_OUTPUT_KEY, JSON.stringify(output));
    else localStorage.removeItem(SONG_OUTPUT_KEY);
    setSongOutput(output);
    return null;
  };

  // Off is refused while the mic output or a mic is an ASIO device: it
  // would go from the lists while it plays.
  const changeUseAsio = (on: boolean): string | null => {
    if (
      !on &&
      (isAsio(micOutput.name) || mics.some((mic) => isAsio(mic.name)))
    ) {
      return "The mic output or a mic uses ASIO. Change it first.";
    }
    setAsio(on);
    localStorage.setItem(USE_ASIO_KEY, on ? "on" : "off");
    setUseAsio(on);
    return null;
  };

  // Every mic reopens in the new mode.
  const changeMicMode = (mode: MicMode) => {
    setMicMode(mode);
    for (const mic of mics) mic.reopen();
    save(MIC_MODE_KEY, mode.exclusive ? "exclusive" : null);
    save(MIC_BUFFER_KEY, mode.bufferSize);
    setMicModeState(mode);
  };

  const changeAvOffset = (offsetMs: number) => {
    localStorage.setItem(AV_OFFSET_KEY, String(offsetMs));
    setAvOffsetMs(offsetMs);
  };

  const changeUiScale = (scale: number) => {
    localStorage.setItem(UI_SCALE_KEY, String(scale));
    setUiScale(scale);
  };

  // A song that's playing gains or loses them at once.
  const changePitchBars = (on: boolean) => {
    save(PITCH_BARS_KEY, on ? null : "off");
    setPitchBars(on);
  };

  // "address:port": the address is kept, for the next launch to use with
  // its port, in place of a custom URL.
  const changeHostname = (picked: string) => {
    save(HOSTNAME_KEY, picked.slice(0, picked.lastIndexOf(":")));
    save(CUSTOM_URL_KEY, null);
    setHostname(picked);
    setCustomUrl(null);
  };

  const changeCustomUrl = (url: string) => {
    save(CUSTOM_URL_KEY, url);
    setCustomUrl(url);
  };

  // A new network, or a new address on this one: the QR code moves to it
  // (unless the address picked is still here).
  useEffect(() => {
    const timer = setInterval(() => setHostname(savedHostname()), ADDRESSES_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => props.audio.avOffset(avOffsetMs), [props.audio, avOffsetMs]);

  // index.css multiplies the root font size by it.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--kf-ui-scale",
      String(uiScale / 100),
    );
  }, [uiScale]);

  // A row's new device, or a new row at index mics.length, at the levels it
  // had last. A new row that won't open is added down (it says why, and
  // opens once it can); a row keeps its mic rather than change to one that
  // won't open, and why is returned, for Settings to show.
  const onChangeMic = (
    index: number,
    name: string,
    channel: number,
  ): string | null => {
    const newMic = openMic(name, channel, levelsOf(micId(name, channel)));
    const oldMic = mics[index];
    if (oldMic && newMic.error !== null) {
      newMic.stop();
      return `Couldn't open ${newMic.label}: ${newMic.error}`;
    }
    // Picked again: saved as a row from now on.
    unlistedSavedMics = unlistedSavedMics.filter(
      (mic) => micId(mic.name, mic.channel) !== micId(name, channel),
    );
    const updatedMics = [...mics];
    updatedMics.splice(index, 1, newMic);
    if (oldMic) oldMic.stop();
    setMics(updatedMics);
    return null;
  };

  const removeMic = (index: number) => {
    mics[index].stop();
    setMics(mics.filter((_, i) => i !== index));
  };

  // Q shows or hides the up-next strip, S opens Settings (Escape closes it:
  // see Settings). Not while typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if ((event.target as Element).closest?.("input, select, textarea")) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "q") setUpNextVisible((visible) => !visible);
      if (key === "s" && !setupShown.current) setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The saved mics open once the display has painted: listing and opening
  // sound devices can take seconds (a Linux sound system that's slow to
  // answer, ASIO drivers loading), and the screen would stay black
  // meanwhile. After the next frame, or half a second in a window that
  // draws none (hidden, under the tests).
  useEffect(() => {
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      const saved = savedMics();
      // None saved: the phones were sent none already.
      _setMics((current) =>
        saved.length === 0 && current.length === 0 ? current : saved,
      );
    };
    let afterFrame: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      afterFrame = setTimeout(open, 0);
    });
    const fallback = setTimeout(open, 500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(afterFrame);
      clearTimeout(fallback);
    };
  }, []);

  // A first start (no config.yaml at launch) opens the setup screen.
  useEffect(() => {
    call("getSettings", {}).then(
      ({ setup }) => setSetupOpen(setup),
      (err) => console.error("Couldn't load the settings:", err),
    );
  }, []);

  useLiveEvent("queueAdded", ({ item }) => {
    announce({ label: "Queued", song: item });
  });

  useLiveEvent("queueFailed", ({ item, reason }) => {
    announce({
      label: "Couldn't download",
      song: item,
      detail: reason,
      tone: "problem",
    });
  });

  // The Sound tab's, in Settings and on the setup screen.
  const soundProps: SoundProps = {
    mics,
    micLevels: (mic) => levelsOf(idOf(mic)),
    onChangeMic,
    onChangeLevels: (mic, newLevels) =>
      changeLevels({ [idOf(mic)]: newLevels }),
    onRemoveMic: removeMic,
    micOutput,
    onMicOutputChange: changeMicOutput,
    micMode,
    onMicModeChange: changeMicMode,
    useAsio,
    onUseAsioChange: changeUseAsio,
    songOutput,
    onSongOutputChange: changeSongOutput,
    songOutputPlace: () => props.audio.outputPlace(),
    avOffsetMs,
    onAvOffsetChange: changeAvOffset,
    audioLatencyMs: () => props.audio.latencyMs(),
  };

  return (
    <div className="app">
      {fullScreen ? null : <div className="windowDragBar" aria-hidden="true" />}
      <NoticeBar />
      <main className="appScreen">
        <div className="appStage">
          <Player
            mics={mics}
            audio={props.audio}
            announce={announce}
            avOffsetMs={avOffsetMs}
            pitchBars={pitchBars}
          />
          {!idle && !settingsOpen && !setupOpen ? (
            <QRCode url={remoteUrl} corner />
          ) : null}
          <Effects />
        </div>
        {!idle && upNextVisible ? <UpNext layout="strip" /> : null}
        {idle ? (
          <IdleScreen
            url={remoteUrl}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}
        <Announcements items={announcements} />
        {settingsOpen ? (
          <Settings
            tab={settingsTab}
            onTabChange={setSettingsTab}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsTab(SETTINGS_TABS[0]);
            }}
            hostname={hostname}
            onHostnameChange={changeHostname}
            customUrl={customUrl}
            onCustomUrlChange={changeCustomUrl}
            {...soundProps}
            uiScale={uiScale}
            onUiScaleChange={changeUiScale}
            pitchBars={pitchBars}
            onPitchBarsChange={changePitchBars}
          />
        ) : null}
        {setupOpen ? (
          <Setup {...soundProps} onDone={() => setSetupOpen(false)} />
        ) : null}
      </main>
    </div>
  );
}

export default App;
