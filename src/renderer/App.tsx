import React, { useCallback, useEffect, useRef, useState } from "react";

import { call, useLiveEvent, useLiveState } from "../common/apiClient";
import { HOSTNAME } from "../common/constants";
import { KuroshiroSingleton } from "../common/joysoundParser";
import "./ui.css";
import "./App.css";
import Announcements from "./Announcements";
import Effects from "./Effects";
import IdleScreen from "./IdleScreen";
import { InputDevice } from "./nativeAudio";
import NoticeBar from "./NoticeBar";
import Player from "./Player";
import Settings from "./Settings";
import UpNext from "./UpNext";
import type { Announcement } from "./useSongPlayer";
import KarafriendsAudio from "./webAudio";

// How long an announcement stays in the corner.
const ANNOUNCE_MS = 4000;
// The most announcements shown at once; older ones go first.
const MAX_ANNOUNCEMENTS = 3;

interface SavedMic {
  name: string;
  channel: number;
}

// The microphones picked last time, those still plugged in.
function savedMics(): InputDevice[] {
  const saved: SavedMic[] = JSON.parse(localStorage.getItem("mics") || "[]");
  const channelCounts = new Map(window.karafriends.nativeAudio.inputDevices());
  return saved
    .filter(({ name, channel }) => channel < (channelCounts.get(name) ?? 0))
    .map(({ name, channel }) => new InputDevice(name, channel));
}

function App(props: {
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const [mics, _setMics] = useState(savedMics);
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

  const setMics = (newMics: InputDevice[]) => {
    const micsToSave: SavedMic[] = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
    }));
    localStorage.setItem("mics", JSON.stringify(micsToSave));
    _setMics(newMics);
  };

  const onChangeMic = (index: number, newMic: InputDevice) => {
    const updatedMics = [...mics];
    const oldMic = updatedMics.splice(index, 1, newMic)[0];
    if (oldMic) oldMic.stop();
    setMics(updatedMics);
  };

  const clearMics = () => {
    mics.forEach((mic) => mic.stop());
    setMics([]);
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
    announce({
      label: "Queued",
      title: item.name,
      detail: [item.artistName, item.user.nickname].filter(Boolean).join(" · "),
    });
  });

  useLiveEvent("queueFailed", ({ item, reason }) => {
    announce({
      label: "Couldn't download",
      title: item.name,
      detail: `for ${item.user.nickname}: ${reason}`,
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
          />
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
            onChangeMic={onChangeMic}
            onClearMics={clearMics}
          />
        ) : null}
      </main>
    </div>
  );
}

export default App;
