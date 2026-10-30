import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { call, useLiveState } from "../../common/apiClient";
import useLiveSetter from "../../common/hooks/useLiveSetter";
import {
  AddMicrophone,
  LevelSlider,
  MicModeSetting,
  MicOutputSetting,
  MicrophoneSetting,
  type MicLevels,
  useTick,
} from "../MicrophoneSetting";
import {
  asioDrivers,
  type InputDevice,
  type MicMode,
  type MicOutput,
  listingIsSlow,
  type SoundDevices,
  soundDevices,
} from "../nativeAudio";
import { AV_OFFSETS } from "../playback";
import type { OutputPlace } from "../songOutput";
import type { SongOutput } from "../webAudio";
import type { Message, Section } from "./actions";
import { Checkbox, Hint, SettingsSection } from "./controls";

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
  // Off: no ASIO device is listed and no driver loaded. Returns why it
  // wasn't turned off, if it wasn't.
  useAsio: boolean;
  onUseAsioChange: (on: boolean) => string | null;
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
        No audio output connected.
      </p>
    );
  }
  let text = `${name} isn't connected. Using System default.`;
  if (place === "silent") {
    text = isMissing(props.output, outputs)
      ? `${name} isn't connected.`
      : `${name} disconnected.`;
  }
  return (
    <p className="settingsHint" role="status">
      {text}
    </p>
  );
}

// "Output latency: 20 ms", looked at again every tick: the context measures
// a new output only once it has played on it a while.
function OutputLatency(props: { latencyMs: () => number }) {
  useTick();
  return <>Output latency: {props.latencyMs()} ms</>;
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
  // Listed as the tab opens, and again as devices come and go, outside the
  // render (a listing can fail), so a mic plugged in since can be picked.
  const [devices, setDevices] = useState<SoundDevices | null>(null);
  // Saying "Looking for microphones…" through a listing that may be slow.
  const [looking, setLooking] = useState(false);
  const lastListed = useRef(0);
  // now: before the page goes on (the Add select's list opens with them).
  // When the last listing was slow, the line shows first, and the listing
  // follows once it has painted (it holds the page).
  const relist = useCallback((now = false) => {
    lastListed.current = Date.now();
    if (listingIsSlow()) {
      setLooking(true);
      requestAnimationFrame(() =>
        setTimeout(() => {
          setDevices(soundDevices());
          setLooking(false);
        }),
      );
    } else if (now) {
      flushSync(() => setDevices(soundDevices()));
    } else {
      setDevices(soundDevices());
    }
  }, []);
  useLayoutEffect(() => relist(), [relist]);
  // A device plugged in or out (Chromium hears of it from the system).
  useEffect(() => {
    const changed = () => relist();
    navigator.mediaDevices?.addEventListener("devicechange", changed);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", changed);
  }, [relist]);
  // Opening Add a microphone lists them again, unless they just were.
  const onOpenAdd = () => {
    if (Date.now() - lastListed.current > 1000) relist(true);
  };

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
          Positive values delay audio, negative values delay lyrics.{" "}
          <OutputLatency latencyMs={props.audioLatencyMs} />
        </Hint>
        <SongLevels />
      </SettingsSection>

      <SettingsSection title="Microphones" message={messages.mics}>
        {looking ? (
          <div className="settingsMessage busy" role="status">
            <p>Detecting microphones…</p>
          </div>
        ) : null}
        {devices ? (
          <Microphones
            {...props}
            devices={devices}
            onOpenAdd={onOpenAdd}
            relist={() => relist()}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}

// The song's volume and Joysound's guide melody, for every song, as an
// admin's phone sets them (the live state's songVolume and
// guideMelodyLevel): the display is always an admin.
function SongLevels() {
  const [volume, setVolume] = useLiveSetter(
    useLiveState((state) => state?.songVolume ?? 100),
    (volume: number) => call("setSongVolume", { volume }),
    "change the song volume",
  );
  const [guide, setGuide] = useLiveSetter(
    useLiveState((state) => state?.guideMelodyLevel ?? 0),
    (level: number) => call("setGuideMelodyLevel", { level }),
    "change the guide melody level",
  );
  return (
    <>
      <div className="settingsFields">
        <LevelSlider
          label="Song volume"
          value={volume}
          max={100}
          onChange={setVolume}
        />
        <LevelSlider
          label="Guide melody"
          value={Math.round(guide * 100)}
          max={100}
          step={5}
          onChange={(percent) => setGuide(percent / 100)}
        />
      </div>
      <Hint>
        Guide melody is for Joysound songs. On songs queued with a guide vocal,
        it sets the vocal&apos;s level.
      </Hint>
    </>
  );
}

// The Microphones section's fields, once the devices are listed.
function Microphones(
  props: SoundProps & {
    devices: SoundDevices;
    report: (section: Section, problem: string | null) => void;
    onOpenAdd: () => void;
    // Lists them again (Use ASIO adds or takes away ASIO's).
    relist: () => void;
  },
) {
  const { devices, report } = props;
  // Read from the registry: no driver is loaded for it.
  const [drivers] = useState(asioDrivers);
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
      {drivers.length > 0 ? (
        <Checkbox
          label="Use ASIO"
          checked={props.useAsio}
          hint="Loading ASIO drivers briefly interrupts all audio."
          onChange={async (on) => {
            const problem = props.onUseAsioChange(on);
            report("mics", problem);
            if (problem) return false;
            props.relist();
            return true;
          }}
        />
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
        onOpen={props.onOpenAdd}
      />
    </>
  );
}
