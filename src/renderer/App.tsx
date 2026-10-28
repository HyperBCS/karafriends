import React, { useCallback, useEffect, useRef, useState } from "react";

import type { MicInfo } from "../common/api";
import { call, useLiveEvent, useLiveState } from "../common/apiClient";
import { HOSTNAME } from "../common/constants";
import { KuroshiroSingleton } from "../common/joysoundParser";
import "./ui.css";
import "./App.css";
import Announcements from "./Announcements";
import Effects from "./Effects";
import IdleScreen from "./IdleScreen";
import type { MicLevels } from "./MicrophoneSetting";
import { InputDevice, setOutputDevice } from "./nativeAudio";
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
import Settings from "./Settings";
import UpNext from "./UpNext";
import type { Announcement } from "./useSongPlayer";
import KarafriendsAudio from "./webAudio";

// How long an announcement stays in the corner.
const ANNOUNCE_MS = 4000;
// The most announcements shown at once; older ones go first.
const MAX_ANNOUNCEMENTS = 3;

const DEFAULT_LEVELS: MicLevels = { gain: 100, echo: 40 };

// localStorage's "mics": each device's name, its channel and its levels.
// Entries saved before the levels existed get the defaults.
type SavedMic = { name: string; channel: number } & MicLevels;

// The output device the mics play through; not set for the system default.
const MIC_OUTPUT_KEY = "micOutput";

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

// Opened once per page: StrictMode calls App's initializer twice in
// `yarn dev`, and a second set would play every mic twice.
let openedSavedMics: InputDevice[] | null = null;

// The mic output and the microphones picked last time, those still plugged
// in and that open. The output first, so the mics open on it.
function savedMics(): InputDevice[] {
  openedSavedMics ??= openSavedMics();
  return openedSavedMics;
}

function openSavedMics(): InputDevice[] {
  setOutputDevice(localStorage.getItem(MIC_OUTPUT_KEY));
  const channelCounts = new Map(
    window.karafriends.nativeAudio
      .inputDevices()
      .map(([id, , channels]) => [id, channels]),
  );
  return readSavedMics()
    .filter(({ name, channel }) => channel < (channelCounts.get(name) ?? 0))
    .flatMap((mic) => {
      try {
        return [openMic(mic.name, mic.channel, mic)];
      } catch (err) {
        console.warn(`Couldn't open the saved mic ${mic.name}:`, err);
        return [];
      }
    });
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

function App(props: {
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const [mics, _setMics] = useState(savedMics);
  // Apart from the devices, so the piano roll keeps its mics (and what they
  // sang) while a level changes. By micId.
  const [levels, setLevels] = useState(savedLevels);
  const [micOutput, setMicOutput] = useState(() =>
    localStorage.getItem(MIC_OUTPUT_KEY),
  );
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
  const [upNextVisible, setUpNextVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const saveMics = (
    newMics: InputDevice[],
    newLevels: Record<string, MicLevels>,
  ) => {
    const micsToSave: SavedMic[] = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
      ...(newLevels[idOf(mic)] ?? DEFAULT_LEVELS),
    }));
    localStorage.setItem("mics", JSON.stringify(micsToSave));
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
  // that fails can't break the next launch. Mics that went down with the
  // old output reopen on the new one at once.
  const changeMicOutput = (name: string | null) => {
    try {
      setOutputDevice(name);
    } catch (err) {
      console.error(`Couldn't switch the mic output to ${name}:`, err);
      return;
    }
    for (const mic of mics.filter((m) => m.error)) mic.check();
    if (name === null) localStorage.removeItem(MIC_OUTPUT_KEY);
    else localStorage.setItem(MIC_OUTPUT_KEY, name);
    setMicOutput(name);
  };

  const changeAvOffset = (offsetMs: number) => {
    localStorage.setItem(AV_OFFSET_KEY, String(offsetMs));
    setAvOffsetMs(offsetMs);
  };

  const changeUiScale = (scale: number) => {
    localStorage.setItem(UI_SCALE_KEY, String(scale));
    setUiScale(scale);
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
  // had last.
  const onChangeMic = (index: number, name: string, channel: number) => {
    const newMic = openMic(name, channel, levelsOf(micId(name, channel)));
    const updatedMics = [...mics];
    const oldMic = updatedMics.splice(index, 1, newMic)[0];
    if (oldMic) oldMic.stop();
    setMics(updatedMics);
  };

  const removeMic = (index: number) => {
    mics[index].stop();
    setMics(mics.filter((_, i) => i !== index));
  };

  // Q shows or hides the up-next strip, S opens Settings, Escape closes it.
  // Not while typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        return;
      }
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

  // The first launch, with no DAM or Joysound login, opens Settings.
  useEffect(() => {
    call("getSettings", {}).then(
      ({ isFirstRun }) => {
        if (isFirstRun) setSettingsOpen(true);
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
            kuroshiro={props.kuroshiro}
            audio={props.audio}
            announce={announce}
            avOffsetMs={avOffsetMs}
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
            avOffsetMs={avOffsetMs}
            onAvOffsetChange={changeAvOffset}
            uiScale={uiScale}
            onUiScaleChange={changeUiScale}
            audioLatencyMs={props.audio.latencyMs()}
          />
        ) : null}
      </main>
    </div>
  );
}

export default App;
