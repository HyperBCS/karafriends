import React, { useCallback, useEffect, useRef, useState } from "react";

import type { MicInfo } from "../common/api";
import { call, useLiveEvent, useLiveState } from "../common/apiClient";
import { HOSTNAME } from "../common/constants";
import "./ui.css";
import "./App.css";
import Announcements from "./Announcements";
import Effects from "./Effects";
import IdleScreen from "./IdleScreen";
import type { MicLevels } from "./MicrophoneSetting";
import {
  InputDevice,
  inputDevices,
  type MicMode,
  type MicOutput,
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
import UpNext from "./UpNext";
import type { Announcement } from "./useSongPlayer";
import KarafriendsAudio, { type SongOutput } from "./webAudio";

// How long an announcement stays in the corner.
const ANNOUNCE_MS = 4000;
// The most announcements shown at once; older ones go first.
const MAX_ANNOUNCEMENTS = 3;

const DEFAULT_LEVELS: MicLevels = { gain: 100, echo: 40 };

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

// Settings' open tab, to open on it the next time.
const SETTINGS_TAB_KEY = "settingsTab";

function savedSettingsTab(): SettingsTab {
  const saved = localStorage.getItem(SETTINGS_TAB_KEY);
  return SETTINGS_TABS.find((tab) => tab === saved) ?? "accounts";
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
    readSavedMics().map(({ name, channel, gain, echo }) => [
      micId(name, channel),
      { gain, echo },
    ]),
  );
}

// A mic list's levels as one string, to tell this display's own setMics
// lists in the live state from an admin's setMicLevels.
function levelsKey(mics: MicInfo[]): string {
  return mics.map(({ id, gain, echo }) => `${id}:${gain}:${echo}`).join("|");
}

function App(props: { audio: KarafriendsAudio }) {
  const [mics, _setMics] = useState(savedMics);
  // Apart from the devices, so the piano roll keeps its mics (and what they
  // sang) while a level changes. By micId.
  const [levels, setLevels] = useState(savedLevels);
  const [micOutput, setMicOutput] = useState(savedMicOutput);
  const [micMode, setMicModeState] = useState(savedMicMode);
  const [songOutput, setSongOutput] = useState(savedSongOutput);
  // The mic lists this display sent with setMics lately, as levelsKey.
  const sentMics = useRef<string[]>([]);
  const seenLiveMics = useRef<MicInfo[] | undefined>(undefined);
  const liveMics = useLiveState((state) => state?.mics);
  const [avOffsetMs, setAvOffsetMs] = useState(() =>
    savedChoice(localStorage.getItem(AV_OFFSET_KEY), AV_OFFSETS, 0),
  );
  const [uiScale, setUiScale] = useState(() =>
    savedChoice(localStorage.getItem(UI_SCALE_KEY), UI_SCALES, 100),
  );
  const [hostname, setHostname] = useState(
    `${HOSTNAME}:${window.karafriends.remoconPort()}`,
  );
  const [pitchBars, setPitchBars] = useState(
    () => localStorage.getItem(PITCH_BARS_KEY) !== "off",
  );
  const [upNextVisible, setUpNextVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState(savedSettingsTab);
  const [announcements, setAnnouncements] = useState<
    (Announcement & { id: number })[]
  >([]);
  const lastAnnouncementId = useRef(0);
  const idle = useLiveState((state) => !state?.currentSong);

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
    const allLevels = { ...levels, ...changes };
    for (const mic of mics) {
      const newLevels = changes[idOf(mic)];
      if (!newLevels) continue;
      mic.setGain(newLevels.gain / 100);
      mic.setEcho(newLevels.echo / 100);
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
    sentMics.current = [...sentMics.current, levelsKey(list)].slice(-10);
    call("setMics", { mics: list }).catch((err) =>
      console.error("Couldn't list the mics for the phones:", err),
    );
  }, [mics, levels]);

  // An admin's setMicLevels: levels in the live state that differ from this
  // display's own, in a list it didn't send. A list it did send (even one a
  // later one overtook) is its own coming back, and is left alone, or two
  // quick changes here would undo each other.
  useEffect(() => {
    if (!liveMics || liveMics === seenLiveMics.current) return;
    seenLiveMics.current = liveMics;
    const sent = sentMics.current.indexOf(levelsKey(liveMics));
    if (sent >= 0) {
      sentMics.current = sentMics.current.slice(sent);
      return;
    }
    const changes: Record<string, MicLevels> = {};
    for (const { id, gain, echo } of liveMics) {
      if (!mics.some((mic) => idOf(mic) === id)) continue;
      const own = levelsOf(id);
      if (own.gain !== gain || own.echo !== echo) changes[id] = { gain, echo };
    }
    if (Object.keys(changes).length === 0) return;
    // The server already holds the list this display sends next, so that
    // one never comes back to trim the older ones: an admin's later return
    // to one of them would be taken for an echo.
    sentMics.current = [];
    changeLevels(changes);
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

  const changeSettingsTab = (tab: SettingsTab) => {
    localStorage.setItem(SETTINGS_TAB_KEY, tab);
    setSettingsTab(tab);
  };

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
      if (key === "s") setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The first launch, with no DAM or Joysound login, opens Settings on
  // Accounts.
  useEffect(() => {
    call("getSettings", {}).then(
      ({ isFirstRun }) => {
        if (!isFirstRun) return;
        setSettingsTab("accounts");
        setSettingsOpen(true);
      },
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

  return (
    <div className="app">
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
          {!idle && !settingsOpen ? (
            <QRCode hostname={hostname} corner />
          ) : null}
        </div>
        {!idle && upNextVisible ? <UpNext layout="strip" /> : null}
        {idle ? (
          <IdleScreen
            hostname={hostname}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}
        <Effects />
        <Announcements items={announcements} />
        {settingsOpen ? (
          <Settings
            tab={settingsTab}
            onTabChange={changeSettingsTab}
            onClose={() => setSettingsOpen(false)}
            hostname={hostname}
            onHostnameChange={setHostname}
            mics={mics}
            micLevels={(mic) => levelsOf(idOf(mic))}
            onChangeMic={onChangeMic}
            onChangeLevels={(mic, newLevels) =>
              changeLevels({ [idOf(mic)]: newLevels })
            }
            onRemoveMic={removeMic}
            micOutput={micOutput}
            onMicOutputChange={changeMicOutput}
            micMode={micMode}
            onMicModeChange={changeMicMode}
            songOutput={songOutput}
            onSongOutputChange={changeSongOutput}
            songOutputPlace={() => props.audio.outputPlace()}
            avOffsetMs={avOffsetMs}
            onAvOffsetChange={changeAvOffset}
            uiScale={uiScale}
            onUiScaleChange={changeUiScale}
            pitchBars={pitchBars}
            onPitchBarsChange={changePitchBars}
            audioLatencyMs={() => props.audio.latencyMs()}
          />
        ) : null}
      </main>
    </div>
  );
}

export default App;
