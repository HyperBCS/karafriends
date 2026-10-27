import React from "react";

import "./global";
import { InputDevice } from "./nativeAudio";

interface Props {
  mic: InputDevice | null;
  onChange: (mic: InputDevice) => void;
}

// One microphone: an input device and one of its channels.
export default function MicrophoneSetting({ mic, onChange }: Props) {
  return (
    <label className="kfLabel">
      Microphone
      <select
        className="kfField"
        value={mic ? `${mic.name}_${mic.channelSelection}` : ""}
        onChange={(e) => {
          const dataset = e.target.options[e.target.selectedIndex].dataset;
          onChange(new InputDevice(dataset.name!, Number(dataset.channel)));
        }}
      >
        <option value="" disabled={true}>
          Select a microphone
        </option>
        {window.karafriends.nativeAudio
          .inputDevices()
          .map(([name, channelCount]) =>
            [...Array(channelCount)].map((_, channel) => (
              <option
                key={`${name}_${channel}`}
                data-name={name}
                data-channel={channel}
                value={`${name}_${channel}`}
              >
                {`${name} (Channel ${channel})`}
              </option>
            )),
          )}
      </select>
    </label>
  );
}
