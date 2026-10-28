import React, { useEffect, useState } from "react";

import {
  AddMicrophone,
  MicModeSetting,
  MicOutputSetting,
  MicrophoneSetting,
  type MicLevels,
  useTick,
} from "../MicrophoneSetting";
import type {
  InputDevice,
  LinuxAudio,
  MicMode,
  MicOutput,
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
  const { output } = props;
  const missing =
    output !== null &&
    outputs !== null &&
    !outputs.some(({ id }) => id === output.id);
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

// Where the songs play while it isn't the chosen output: looked at again
// every tick, as the output can go and come back while Settings is open.
function SongOutputPlace(props: {
  output: SongOutput | null;
  place: () => OutputPlace;
}) {
  useTick();
  const place = props.place();
  const name = props.output?.label ?? "System default";
  if (place === "chosen" || (place === "default" && !props.output)) {
    return null;
  }
  return (
    <p className="settingsHint" role="status">
      {place === "silent"
        ? `${name} went away: the songs play silently until it's back.`
        : `The songs play on System default until ${name} is connected.`}
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
    // As listed when Settings opened.
    outputs: string[];
    asioProblem: string | null;
    linux: LinuxAudio | null;
  },
) {
  const { messages, report, outputs, asioProblem, linux } = props;
  // What the native side says about the output while the mics work ("ok:
  // <note>"): that the chosen one is missing or won't open, say.
  const micStatus = props.mics[0]?.status();
  const outputNote = micStatus?.startsWith("ok: ") ? micStatus.slice(4) : null;

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
        <MicOutputSetting
          outputs={outputs}
          output={props.micOutput}
          onChange={(output) => report("mics", props.onMicOutputChange(output))}
        />
        {outputNote ? (
          <p className="settingsHint" role="status">
            {outputNote}
          </p>
        ) : null}
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
            levels={props.micLevels(mic)}
            onChange={(name, channel) =>
              report("mics", props.onChangeMic(i, name, channel))
            }
            onLevelsChange={(levels) => props.onChangeLevels(mic, levels)}
            onRemove={() => props.onRemoveMic(i)}
          />
        ))}
        <AddMicrophone
          onAdd={(name, channel) =>
            report("mics", props.onChangeMic(props.mics.length, name, channel))
          }
        />
      </SettingsSection>
    </>
  );
}
