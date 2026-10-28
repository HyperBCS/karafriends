import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import "./global";
import {
  channelLabel,
  exclusiveAvailable,
  type Input,
  InputDevice,
  type LinuxAudio,
  type OutputOptions,
  type MicMode,
  type MicOutput,
  outputFormat,
  outputOptions,
  outputStatus,
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
// the option's data carries the id. A mic whose input isn't listed (the
// listing failed) still shows its own.
function DeviceSelect(props: {
  label: string;
  inputs: Input[];
  mic: InputDevice | null;
  onChange: (name: string, channel: number) => void;
}) {
  const { mic } = props;
  const listed = props.inputs.some(
    ([name, , channels]) =>
      name === mic?.name && mic.channelSelection < channels,
  );
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
        {mic && !listed ? (
          <option value={`${mic.name}_${mic.channelSelection}`} disabled={true}>
            {mic.label}
          </option>
        ) : null}
        {props.inputs.map(([name, label, channelCount]) =>
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
export function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), STATUS_MS);
    return () => clearInterval(timer);
  }, []);
}

// A choice of numbers, or the device's own (null), named by `own`
// ("Default" unless given).
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
        <option value="">{props.own ?? "Default"}</option>
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
  // As listed when the Sound tab opened.
  outputs: string[];
  output: MicOutput;
  onChange: (output: MicOutput) => void;
}) {
  const { outputs, output } = props;
  const connected = output.name !== null && outputs.includes(output.name);
  // Asked for outside the render, before the paint.
  const [options, setOptions] = useState<OutputOptions | null>(null);
  useLayoutEffect(
    () =>
      setOptions(connected && output.name ? outputOptions(output.name) : null),
    [connected, output.name],
  );
  // The native side changes these outside React: the watchdog can move the
  // mics to the default output and back.
  useTick();
  const format = outputFormat();
  // What it says while the mics work ("ok: <note>"): that the chosen
  // output is missing or won't open, say.
  const status = outputStatus();
  const note = status?.startsWith("ok: ") ? status.slice(4) : null;
  return (
    <>
      <div className={options ? "settingsFields three" : "settingsFields"}>
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
      {format ? <p className="settingsHint">In use: {format}</p> : null}
      {note ? (
        <p className="settingsHint" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
}

// The buffer sizes an exclusive mic can ask for, above its smallest.
const EXCLUSIVE_BUFFERS = [128, 256, 512];

const samples = (frames: number) => `${frames} samples`;

// Shared or Exclusive for the Windows mics, and an exclusive mic's buffer.
// A mic Windows won't give stays shared, and its In use line says why. On
// Linux (`linux` set), the buffer of the mics and their output instead.
export function MicModeSetting(props: {
  mode: MicMode;
  linux: LinuxAudio | null;
  onChange: (mode: MicMode) => void;
}) {
  const [available] = useState(exclusiveAvailable);
  if (props.linux) {
    return (
      <LinuxBufferSetting
        linux={props.linux}
        mode={props.mode}
        onChange={props.onChange}
      />
    );
  }
  if (!available) return null;
  const { mode } = props;
  return (
    <>
      <div className="settingsFields">
        <label className="kfLabel">
          Mic mode
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
            show={samples}
            own="Smallest"
            onChange={(bufferSize) => props.onChange({ ...mode, bufferSize })}
          />
        ) : null}
      </div>
      {mode.exclusive ? (
        <p className="settingsHint">
          Less delay, but other programs can&apos;t use the mics meanwhile.
        </p>
      ) : null}
    </>
  );
}

// The Linux mics' buffer: one size for every mic and the mic output, so
// all of them run in step (PipeWire runs them in the same cycle).
function LinuxBufferSetting(props: {
  linux: LinuxAudio;
  mode: MicMode;
  onChange: (mode: MicMode) => void;
}) {
  const { linux, mode } = props;
  if (linux.bufferSizes.length < 2) return null;
  return (
    <>
      <div className="settingsFields">
        <NumberSelect
          label="Mic buffer"
          value={mode.bufferSize}
          choices={linux.bufferSizes}
          show={samples}
          own={`Default (${samples(linux.defaultBufferSize)})`}
          onChange={(bufferSize) =>
            props.onChange({ exclusive: false, bufferSize })
          }
        />
      </div>
      <p className="settingsHint">
        For every mic and the mic output: smaller is less delay, bigger if the
        mics crackle. With PipeWire, other programs run at it too while a mic is
        open.
      </p>
    </>
  );
}

// The meter's range: -60 dB (empty) to 0 dB (full); red from -6 dB.
const METER_FLOOR_DB = -60;
const METER_HOT = 0.9;

// The mic's level as it comes in (before Gain), each frame, falling back
// slowly after a peak. Drawn straight onto the bar, not through React.
function LevelMeter(props: { mic: InputDevice }) {
  const meter = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let shown = 0;
    let frame = requestAnimationFrame(function draw() {
      const peak = props.mic.level();
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      const level = Math.min(1, Math.max(0, 1 - db / METER_FLOOR_DB));
      shown = Math.max(level, shown - 0.02);
      if (bar.current && meter.current) {
        bar.current.style.width = `${shown * 100}%`;
        bar.current.classList.toggle("hot", shown > METER_HOT);
        meter.current.setAttribute("aria-valuenow", shown.toFixed(2));
      }
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.mic]);
  return (
    <div
      ref={meter}
      className="settingsMeter"
      role="meter"
      aria-label="Level"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={0}
    >
      <div ref={bar} className="settingsMeterBar" />
    </div>
  );
}

// A level from 0 to max. Its track fills to the value (ui.css).
function LevelSlider(props: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const fill = { "--kf-fill": `${(props.value / props.max) * 100}%` };
  return (
    <label className="kfLabel">
      {`${props.label} ${props.value}%`}
      <input
        className="kfSlider"
        style={fill as React.CSSProperties}
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
  // The inputs, as listed when the Sound tab opened.
  inputs: Input[];
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
        <DeviceSelect
          label="Microphone"
          inputs={props.inputs}
          mic={mic}
          onChange={props.onChange}
        />
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
      <LevelMeter mic={mic} />
      {mic.error ? (
        <p className="settingsMessage problem" role="status">
          {mic.error}
        </p>
      ) : mic.reopenedAfter ? (
        <p className="settingsHint" role="status">
          Reopened after: {mic.reopenedAfter}
        </p>
      ) : null}
      {format ? <p className="settingsHint">In use: {format}</p> : null}
    </div>
  );
}

// The last row: a select that adds a mic.
export function AddMicrophone(props: {
  inputs: Input[];
  onAdd: (name: string, channel: number) => void;
}) {
  return (
    <div className="settingsMicRow">
      <DeviceSelect
        label="Add a microphone"
        inputs={props.inputs}
        mic={null}
        onChange={props.onAdd}
      />
    </div>
  );
}
