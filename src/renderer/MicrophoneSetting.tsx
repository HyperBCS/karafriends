import React, { useEffect, useMemo, useState } from "react";

import "./global";
import {
  channelLabel,
  exclusiveAvailable,
  InputDevice,
  type MicMode,
  type MicOutput,
  outputFormat,
  outputOptions,
} from "./nativeAudio";

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

// Re-renders every STATUS_MS, for what the native side says now.
function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), STATUS_MS);
    return () => clearInterval(timer);
  }, []);
}

// A choice of numbers, or the device's own (null), named by `own`.
function NumberSelect(props: {
  label: string;
  value: number | null;
  choices: number[];
  show: (value: number) => string;
  onChange: (value: number | null) => void;
  own?: string;
}) {
  return (
    <label className="kfLabel">
      {props.label}
      <select
        className="kfField"
        value={props.value ?? ""}
        onChange={(e) =>
          props.onChange(e.target.value ? Number(e.target.value) : null)
        }
      >
        <option value="">{props.own ?? "Driver's setting"}</option>
        {props.choices.map((value) => (
          <option key={value} value={value}>
            {props.show(value)}
          </option>
        ))}
      </select>
    </label>
  );
}

// The output every mic plays through; for an ASIO one, its buffer size and
// sample rate too; and what it runs at.
export function MicOutputSetting(props: {
  // As listed when Settings opened.
  outputs: string[];
  output: MicOutput;
  onChange: (output: MicOutput) => void;
}) {
  const { outputs, output } = props;
  const connected = output.name !== null && outputs.includes(output.name);
  const options = useMemo(
    () => (connected && output.name ? outputOptions(output.name) : null),
    [connected, output.name],
  );
  useTick();
  const format = outputFormat();
  return (
    <>
      <div className="settingsFields">
        <label className="kfLabel">
          Mic output
          <select
            className="kfField"
            value={output.name ?? ""}
            onChange={(event) =>
              props.onChange({
                name: event.target.value || null,
                rate: null,
                bufferSize: null,
              })
            }
          >
            <option value="">System default</option>
            {output.name !== null && !connected ? (
              <option value={output.name} disabled={true}>
                {`${output.name} (not connected)`}
              </option>
            ) : null}
            {outputs.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {options && options.bufferSizes.length > 1 ? (
          <NumberSelect
            label="Buffer"
            value={output.bufferSize}
            choices={options.bufferSizes}
            show={(frames) => `${frames} samples`}
            onChange={(bufferSize) => props.onChange({ ...output, bufferSize })}
          />
        ) : null}
        {options && options.rates.length > 1 ? (
          <NumberSelect
            label="Sample rate"
            value={output.rate}
            choices={options.rates}
            show={(rate) => `${rate / 1000} kHz`}
            onChange={(rate) => props.onChange({ ...output, rate })}
          />
        ) : null}
      </div>
      {format ? <p className="settingsNote">In use: {format}</p> : null}
      {options ? (
        <p className="settingsNote">
          A smaller buffer means less delay; if the mics crackle, pick a bigger
          one. The sample rate is the interface&apos;s own, so Windows sound
          through it changes too.
        </p>
      ) : null}
    </>
  );
}

// The buffer sizes an exclusive mic can ask for, above its smallest.
const EXCLUSIVE_BUFFERS = [128, 256, 512];

// Shared or Exclusive for the Windows mics, and an exclusive mic's buffer.
export function MicModeSetting(props: {
  mode: MicMode;
  onChange: (mode: MicMode) => void;
}) {
  const [available] = useState(exclusiveAvailable);
  if (!available) return null;
  const { mode } = props;
  return (
    <>
      <div className="settingsFields">
        <label className="kfLabel">
          Windows mics
          <select
            className="kfField"
            value={mode.exclusive ? "exclusive" : "shared"}
            onChange={(e) =>
              props.onChange({
                exclusive: e.target.value === "exclusive",
                bufferSize: null,
              })
            }
          >
            <option value="shared">Shared</option>
            <option value="exclusive">Exclusive</option>
          </select>
        </label>
        {mode.exclusive ? (
          <NumberSelect
            label="Mic buffer"
            value={mode.bufferSize}
            choices={EXCLUSIVE_BUFFERS}
            show={(frames) => `${frames} samples`}
            own="Smallest"
            onChange={(bufferSize) => props.onChange({ ...mode, bufferSize })}
          />
        ) : null}
      </div>
      <p className="settingsNote">
        Exclusive cuts a USB mic&apos;s delay (from 10 ms to about 3), but no
        other program can use the mic meanwhile, and Windows must allow it: in
        Sound settings, open the mic&apos;s Properties, Advanced, and tick
        &quot;Allow applications to take exclusive control of this device&quot;.
        A mic Windows won&apos;t give stays shared, and says why.
      </p>
    </>
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
  useTick();
  const format = mic.format();
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
      {format ? <p className="settingsNote">In use: {format}</p> : null}
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
