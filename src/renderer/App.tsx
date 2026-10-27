import React, { useEffect, useState } from "react";

import { useLiveEvent } from "../common/apiClient";
import { HOSTNAME } from "../common/constants";
import { KuroshiroSingleton } from "../common/joysoundParser";
import "./ui.css";
import "./App.css";
import Effects from "./Effects";
import HostnameSetting from "./HostnameSetting";
import MicrophoneSetting from "./MicrophoneSetting";
import { InputDevice } from "./nativeAudio";
import Player from "./Player";
import QRCode from "./QRCode";
import Queue from "./Queue";
import RemoconNotice from "./RemoconNotice";
import toast from "./toast";
import KarafriendsAudio from "./webAudio";

interface SavedMic {
  name: string;
  channel: number;
}

function App(props: {
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const [mics, _setMics] = useState<InputDevice[]>([]);
  const [hostname, setHostname] = useState(HOSTNAME);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const setMics = (newMics: InputDevice[]) => {
    const micsToSave = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
    }));
    localStorage.setItem("mics", JSON.stringify(micsToSave));
    _setMics(newMics);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "q" || event.key === "Q") {
      setSidebarVisible(!sidebarVisible);
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);

    const savedMicInfo = JSON.parse(localStorage.getItem("mics") || "[]");
    const inputDevices = window.karafriends.nativeAudio.inputDevices();
    const channelCounts: { [key: string]: number } = inputDevices.reduce(
      (acc, cur) => ({
        ...acc,
        [cur[0]]: cur[1],
      }),
      {},
    );

    const savedMics = savedMicInfo
      .filter(
        ({ name, channel }: SavedMic) =>
          name in channelCounts && channel < channelCounts[name],
      )
      .map(({ name, channel }: SavedMic) => new InputDevice(name, channel));

    setMics(savedMics);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sidebarVisible]);

  useLiveEvent("queueAdded", ({ item }) => {
    toast(`${item.name} - ${item.artistName}`, { heading: true });
  });

  useLiveEvent("queueFailed", ({ item, reason }) => {
    toast(
      `Couldn't download ${item.name} for ${item.user.nickname}: ${reason}`,
    );
  });

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

  return (
    <div className="appMainContainer row">
      <RemoconNotice />
      <div
        className={`appPlayer col ${
          sidebarVisible ? "s11" : "s12"
        } valign-wrapper`}
      >
        <Player
          mics={mics}
          kuroshiro={props.kuroshiro}
          audio={props.audio}
          announce={({ title, problem }) => {
            if (problem) toast(`Error loading song ${title}! Skipping...`);
          }}
        />
        <Effects />
      </div>
      {sidebarVisible && (
        <div className="appSidebar col s1">
          <QRCode hostname={hostname} />
          <nav className="center-align">Settings</nav>
          <div className="section center-align">
            <HostnameSetting hostname={hostname} onChange={setHostname} />
            {mics.map((mic, i) => (
              <MicrophoneSetting
                key={mic.deviceId}
                onChange={onChangeMic.bind(null, i)}
                mic={mic}
              />
            ))}
            <MicrophoneSetting
              onChange={onChangeMic.bind(null, mics.length)}
              mic={null}
            />
            <button className="btn" onClick={clearMics}>
              Clear mics
            </button>
          </div>
          <nav className="center-align">Queue</nav>
          <Queue />
        </div>
      )}
    </div>
  );
}

export default App;
