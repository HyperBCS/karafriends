import React, { useEffect, useLayoutEffect, useState } from "react";

import {
  AddMicrophone,
  MicModeSetting,
  MicOutputSetting,
  MicrophoneSetting,
  type MicLevels,
  useTick,
} from "../MicrophoneSetting";
import {
  type InputDevice,
  type MicMode,
  type MicOutput,
  type SoundDevices,
  soundDevices,
} from "../nativeAudio";
import { AV_OFFSETS } from "../playback";
import type { OutputPlace } from "../songOutput";
import type { SongOutput } from "../webAudio";
import type { Message, Section } from "./actions";
import { Hint, SettingsSection } from "./controls";

// What the Sound tab shows and changes, from App.
export interface SoundProps {
  mics: InputDevice[];
  micLevels: (mic: InputDevice) => MicLevels;
  // index is mics.length for a new mic. These three return why the device
  // didn't open, if it didn't.
  onChangeMic: (index: number, name: string, channel: number) => string | null;
  onChangeLevels: (mic: InputDevice, levels: MicLevels) => void;
  onRemoveMic: (index: number) => void;
  micOutput: MicOutput;
  onMicOutputChange: (output: MicOutput) => string | null;
  micMode: MicMode;
  onMicModeChange: (mode: MicMode) => void;
  songOutput: SongOutput | null;
  onSongOutputChange: (output: SongOutput | null) => Promise<string | null>;
  // Where the songs play now (see songOutput.ts).
  songOutputPlace: () => OutputPlace;
  avOffsetMs: number;
  onAvOffsetChange: (offsetMs: number) => void;
  // What the song output adds, in ms, as the context says now.
  audioLatencyMs: () => number;
}

// Where the songs play: the system default, or an output as Chromium lists
// it, listed again as devices come and go. A saved one that isn't
// connected shows as such.
function SongOutputSetting(props: {
  output: SongOutput | null;
  onChange: (output: SongOutput | null) => void;
}) {
  const outputs = useOutputs();
  const { output } = props;
  const missing = isMissing(output, outputs);
  return (
    <label className="kfLabel">
      Song output
      <select
        className="kfField"
        value={output?.id ?? ""}
        onChange={(event) =>
          props.onChange(
            outputs?.find(({ id }) => id === event.target.value) ?? null,
          )
        }
      >
        <option value="">System default</option>
        {output !== null && (outputs === null || missing) ? (
          <option value={output.id} disabled={missing}>
            {missing ? `${output.label} (not connected)` : output.label}
          </option>
        ) : null}
        {(outputs ?? []).map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Whether a saved output isn't among the listed ones (null while the list
// hasn't come yet).
function isMissing(output: SongOutput | null, outputs: SongOutput[] | null) {
  return (
    output !== null &&
    outputs !== null &&
    !outputs.some(({ id }) => id === output.id)
  );
}

// The outputs as Chromium lists them, listed again as devices come and go;
// null until the first list.
function useOutputs() {
  const [outputs, setOutputs] = useState<SongOutput[] | null>(null);
  useEffect(() => {
    const list = () =>
      navigator.mediaDevices.enumerateDevices().then(
        (devices) =>
          setOutputs(
            devices
              // "default" and "communications" are the system's choices:
              // System default stands for them.
              .filter(
                ({ kind, deviceId }) =>
                  kind === "audiooutput" &&
                  deviceId !== "default" &&
                  deviceId !== "communications",
              )
              .map(({ deviceId, label }) => ({
                id: deviceId,
                label: label || "Unnamed output",
              })),
          ),
        () => setOutputs([]),
      );
    list();
    navigator.mediaDevices.addEventListener("devicechange", list);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", list);
  }, []);
  return outputs;
}

// Where the songs play while it isn't the chosen output: looked at again
// every tick, as the output can go and come back while Settings is open. A
// chosen output that isn't listed "is connected" later, whether the songs
// play on the default meanwhile or silently (a machine with no output at
// all); one that is listed but lost "went away".
function SongOutputPlace(props: {
  output: SongOutput | null;
  place: () => OutputPlace;
}) {
  useTick();
  const outputs = useOutputs();
  const place = props.place();
  const name = props.output?.label ?? "System default";
  if (place === "chosen" || (place === "default" && !props.output)) {
    return null;
  }
  if (!props.output) {
    return (
      <p className="settingsHint" role="status">
        No sound output is connected: the songs play silently until one is.
      </p>
    );
  }
  const where = place === "silent" ? "silently" : "on System default";
  return (
    <p className="settingsHint" role="status">
      {place === "silent" && !isMissing(props.output, outputs)
        ? `${name} went away: the songs play silently until it's back.`
        : `The songs play ${where} until ${name} is connected.`}
    </p>
  );
}

// "Output latency: 20 ms", looked at again every tick: the context measures
// a new output only once it has played on it a while.
function OutputLatency(props: { latencyMs: () => number }) {
  useTick();
  return <>Output latency: {props.latencyMs()} ms.</>;
}

// The songs' output and offset, and the mics: their output, their mode,
// and a row for each.
export default function SoundTab(
  props: SoundProps & {
    messages: Partial<Record<Section, Message | null>>;
    // Why a device didn't open, under its section; null clears it.
    report: (section: Section, problem: string | null) => void;
  },
) {
  const { messages, report } = props;
  // Listed each time the tab opens, outside the render (a listing can
  // fail): the outputs, and on Linux the inputs too, so a mic plugged in
  // since can be picked.
  const [devices, setDevices] = useState<SoundDevices | null>(null);
  useLayoutEffect(() => setDevices(soundDevices()), []);

  return (
    <>
      <SettingsSection title="Sound" message={messages.sound}>
        <div className="settingsFields">
          <SongOutputSetting
            output={props.songOutput}
            onChange={(output) =>
              props
                .onSongOutputChange(output)
                .then((problem) => report("sound", problem))
            }
          />
          <label className="kfLabel">
            Audio/video offset
            <select
              className="kfField"
              value={props.avOffsetMs}
              onChange={(event) =>
                props.onAvOffsetChange(Number(event.target.value))
              }
            >
              {AV_OFFSETS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms > 0 ? `+${ms}` : ms} ms
                </option>
              ))}
            </select>
          </label>
        </div>
        <SongOutputPlace
          output={props.songOutput}
          place={props.songOutputPlace}
        />
        <Hint>
          Plus delays the sound, minus delays the lyrics.{" "}
          <OutputLatency latencyMs={props.audioLatencyMs} />
        </Hint>
      </SettingsSection>

      <SettingsSection title="Microphones" message={messages.mics}>
        {devices ? <Microphones {...props} devices={devices} /> : null}
      </SettingsSection>
    </>
  );
}

// The Microphones section's fields, once the devices are listed.
function Microphones(
  props: SoundProps & {
    devices: SoundDevices;
    report: (section: Section, problem: string | null) => void;
  },
) {
  const { devices, report } = props;
  const { inputs, linux } = devices;
  // Shown only when a driver won't load or ASIO didn't start.
  const asioProblem = /won't load|didn't start/.test(devices.asioStatus)
    ? devices.asioStatus
    : null;
  return (
    <>
      {devices.problem ? (
        <p className="settingsMessage problem" role="status">
          {devices.problem}
        </p>
      ) : null}
      <MicOutputSetting
        outputs={devices.outputs}
        output={props.micOutput}
        onChange={(output) => report("mics", props.onMicOutputChange(output))}
      />
      {linux ? <Hint>{linux.status}</Hint> : null}
      {asioProblem ? <Hint>{asioProblem}</Hint> : null}
      <MicModeSetting
        mode={props.micMode}
        linux={linux}
        onChange={props.onMicModeChange}
      />
      {props.mics.map((mic, i) => (
        <MicrophoneSetting
          key={mic.key}
          mic={mic}
          inputs={inputs}
          levels={props.micLevels(mic)}
          onChange={(name, channel) =>
            report("mics", props.onChangeMic(i, name, channel))
          }
          onLevelsChange={(levels) => props.onChangeLevels(mic, levels)}
          onRemove={() => props.onRemoveMic(i)}
        />
      ))}
      <AddMicrophone
        inputs={inputs}
        onAdd={(name, channel) =>
          report("mics", props.onChangeMic(props.mics.length, name, channel))
        }
      />
    </>
  );
}
