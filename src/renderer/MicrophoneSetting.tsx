import React, { useEffect, useState } from "react";

import "./global";
import { channelLabel, InputDevice } from "./nativeAudio";

// A mic's levels, in percent: gain 0 to 200, echo (the reverb) 0 to 100.
export interface MicLevels {
  gain: number;
  echo: number;
}

// How often a row looks again at its mic's status (the watchdog in
// nativeAudio.ts checks every 2 s).
const STATUS_MS = 2000;

// The device select: every channel of every input device, by its label;
// the option's data carries the id.
function DeviceSelect(props: {
  label: string;
  mic: InputDevice | null;
  onChange: (name: string, channel: number) => void;
}) {
  const { mic } = props;
  return (
    <label className="kfLabel">
      {props.label}
      <select
        className="kfField"
        value={mic ? `${mic.name}_${mic.channelSelection}` : ""}
        onChange={(e) => {
          const dataset = e.target.options[e.target.selectedIndex].dataset;
          props.onChange(dataset.name!, Number(dataset.channel));
        }}
      >
        <option value="" disabled={true}>
          Select a microphone
        </option>
        {window.karafriends.nativeAudio
          .inputDevices()
          .map(([name, label, channelCount]) =>
            [...Array(channelCount)].map((_, channel) => (
              <option
                key={`${name}_${channel}`}
                data-name={name}
                data-channel={channel}
                value={`${name}_${channel}`}
              >
                {channelLabel(label, channel)}
              </option>
            )),
          )}
      </select>
    </label>
  );
}

function LevelSlider(props: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="kfLabel">
      {`${props.label} ${props.value}%`}
      <input
        className="kfSlider"
        type="range"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

// One microphone: an input device and one of its channels, its levels, how
// it is doing, and a button that removes it.
export function MicrophoneSetting(props: {
  mic: InputDevice;
  levels: MicLevels;
  onChange: (name: string, channel: number) => void;
  onLevelsChange: (levels: MicLevels) => void;
  onRemove: () => void;
}) {
  const { mic, levels } = props;
  // The watchdog changes the status outside React.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), STATUS_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="settingsMic" role="group" aria-label={mic.label}>
      <div className="settingsMicRow">
        <DeviceSelect label="Microphone" mic={mic} onChange={props.onChange} />
        <LevelSlider
          label="Gain"
          value={levels.gain}
          max={200}
          onChange={(gain) => props.onLevelsChange({ ...levels, gain })}
        />
        <LevelSlider
          label="Echo"
          value={levels.echo}
          max={100}
          onChange={(echo) => props.onLevelsChange({ ...levels, echo })}
        />
        <button type="button" className="kfButton" onClick={props.onRemove}>
          Remove
        </button>
      </div>
      {mic.error ? (
        <p className="settingsMessage problem" role="status">
          {mic.error}
        </p>
      ) : mic.reopenedAfter ? (
        <p className="settingsNote" role="status">
          Reopened after: {mic.reopenedAfter}
        </p>
      ) : null}
    </div>
  );
}

// The last row: a select that adds a mic.
export function AddMicrophone(props: {
  onAdd: (name: string, channel: number) => void;
}) {
  return (
    <div className="settingsMicRow">
      <DeviceSelect
        label="Add a microphone"
        mic={null}
        onChange={props.onAdd}
      />
    </div>
  );
}
