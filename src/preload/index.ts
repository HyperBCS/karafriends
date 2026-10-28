// The native module is copied next to the bundle and loaded with require().
import nativeAudio from "../../native/index.node";

import { contextBridge, ipcRenderer } from "electron";

import type { LiveEvent } from "../common/api";
import {
  IPC_CHANNELS,
  REMOCON_PORT_ARG,
  type DisplayApi,
  type DisplayFiles,
} from "../common/ipc";
import ipAddresses from "../common/ipAddresses";

let inputDeviceCount = 0;
const inputDevices: { [deviceId: number]: any } = {};

// The inputs as last listed (see inputDevices below).
let inputList: [string, string, number][] | null = null;

// The phones' server port, from the main process (see index.ts).
const remoconPort = Number(
  process.argv
    .find((arg) => arg.startsWith(REMOCON_PORT_ARG))
    ?.slice(REMOCON_PORT_ARG.length),
);

// The live events, from the main process. This page asks for them once, as
// it loads, and the live state comes first; the latest one is kept for
// listeners that start later.
type LiveListener = (event: LiveEvent) => void;
const liveListeners = new Set<LiveListener>();
let liveState: LiveEvent | null = null;

ipcRenderer.on(IPC_CHANNELS.live, (_event, liveEvent: LiveEvent) => {
  if (liveEvent.type === "state") liveState = liveEvent;
  for (const listener of liveListeners) {
    try {
      listener(liveEvent);
    } catch (err) {
      console.error(`A ${liveEvent.type} listener failed:`, err);
    }
  }
});
ipcRenderer.send(IPC_CHANNELS.liveSubscribe);

// The display's API transport (src/common/ipc.ts).
const api: DisplayApi = {
  call: (method, input) => ipcRenderer.invoke(IPC_CHANNELS.call, method, input),
  onLive(listener) {
    liveListeners.add(listener);
    if (liveState) listener(liveState);
    return () => {
      liveListeners.delete(listener);
    };
  },
};

// Export and import config: the dialogs are handled in src/main/index.ts.
const files: DisplayFiles = {
  saveTextFile: (suggestedName, text) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTextFile, suggestedName, text),
  openTextFile: () => ipcRenderer.invoke(IPC_CHANNELS.openTextFile),
};

// Why phones can't connect, if they can't: asked for as the page loads (it
// usually happens first), and sent when it happens.
type ProblemListener = (message: string) => void;
const problemListeners = new Set<ProblemListener>();
let remoconProblem: string | null = null;

const setRemoconProblem = (message: unknown) => {
  if (typeof message !== "string" || message === remoconProblem) return;
  remoconProblem = message;
  for (const listener of problemListeners) listener(message);
};
ipcRenderer.on(IPC_CHANNELS.remoconProblem, (_event, message: unknown) =>
  setRemoconProblem(message),
);
ipcRenderer
  .invoke(IPC_CHANNELS.remoconProblem)
  .then(setRemoconProblem)
  .catch((err) => console.error("Couldn't ask about the remote:", err));

// KARAFRIENDS_FAKE_AUDIO=1 (the e2e fixture sets it): no real mic or output
// is ever opened, or even listed. Two fake inputs (ids like Windows'
// endpoint ids, and labels) and two fake outputs, and every call is kept,
// for the tests to read with window.karafriendsFakeAudio.calls().
// KARAFRIENDS_FAKE_AUDIO=linux: the same, as on Linux with PipeWire.
type FakeAudioCall = [string, ...unknown[]];
const fakeAudio = process.env.KARAFRIENDS_FAKE_AUDIO;
const fakeAudioCalls: FakeAudioCall[] | null =
  fakeAudio === "1" || fakeAudio === "linux" ? [] : null;

function fakeNativeAudio(calls: FakeAudioCall[]) {
  return fakeAudio === "linux"
    ? fakeLinuxAudio(calls)
    : fakeWindowsAudio(calls);
}

// Records each call of a fake, then answers it.
function faker(calls: FakeAudioCall[]) {
  return <T>(name: string, answer: (...args: any[]) => T) =>
    (...args: unknown[]): T => {
      calls.push([name, ...args]);
      return answer(...args);
    };
}

function fakeWindowsAudio(calls: FakeAudioCall[]) {
  let nextDeviceId = 0;
  let exclusive = false;
  const fake = faker(calls);
  return {
    inputDevices: fake("inputDevices", (): [string, string, number][] => [
      ["{0.0.1.00000000}.{e2e-mic} (USB)", "E2E Mic (USB)", 1],
      ["{0.0.1.00000000}.{e2e-interface} (USB)", "E2E Interface (USB)", 2],
    ]),
    refreshInputDevices: fake("refreshInputDevices", () => undefined),
    linuxAudio: fake("linuxAudio", () => null),
    outputDevices: fake("outputDevices", () => [
      "E2E Speakers (Windows)",
      "E2E Interface (ASIO)",
    ]),
    asioStatus: fake("asioStatus", () => "ASIO: E2E Interface"),
    setOutputDevice: fake("setOutputDevice", () => undefined),
    // The ASIO output has options; the Windows one has none.
    outputOptions: fake("outputOptions", (name: string) =>
      name.endsWith(" (ASIO)")
        ? { rates: [44100, 48000, 96000], bufferSizes: [64, 128, 256, 512] }
        : null,
    ),
    outputFormat: fake("outputFormat", () => "48 kHz, 256 samples (5.3 ms)"),
    setMicMode: fake("setMicMode", (on: boolean) => {
      exclusive = on;
    }),
    exclusiveAvailable: fake("exclusiveAvailable", () => true),
    // Not kept with the calls: Settings asks for it every frame.
    inputDevice_level: () => 0.25,
    inputDevice_format: fake("inputDevice_format", () =>
      exclusive
        ? "Exclusive, 48 kHz, 144 samples (3.0 ms)"
        : "Shared, 48 kHz, 480 samples (10.0 ms)",
    ),
    inputDevice_new: fake("inputDevice_new", () => nextDeviceId++),
    inputDevice_delete: fake("inputDevice_delete", () => undefined),
    inputDevice_setGain: fake("inputDevice_setGain", () => undefined),
    inputDevice_setEcho: fake("inputDevice_setEcho", () => undefined),
    inputDevice_status: fake("inputDevice_status", () => "ok"),
    inputDevice_getPitch: fake("inputDevice_getPitch", () => ({
      midiNumber: 0,
      confidence: 0,
    })),
    inputDevice_stop: fake("inputDevice_stop", () => undefined),
  };
}

// As on Linux with PipeWire: the system default mic, no exclusive mode and
// no ASIO, and a buffer size for the mics. A USB mic "plugged in" after
// launch shows once Settings opens a second time and lists them again.
type FakeInput = [string, string, number];
const LINUX_DEFAULT_MIC: FakeInput = [
  "pipewire:input_default (Linux)",
  "System default (Linux)",
  2,
];
const LINUX_USB_MIC: FakeInput = [
  "pipewire:alsa_input.usb-e2e (Linux)",
  "E2E USB Mic (Linux)",
  1,
];

function fakeLinuxAudio(calls: FakeAudioCall[]) {
  const fake = faker(calls);
  let nextDeviceId = 0;
  let bufferSize: number | null = null;
  let listings = 0;
  const windows = fakeWindowsAudio(calls);
  return {
    ...windows,
    inputDevices: fake("inputDevices", (): FakeInput[] =>
      listings > 1 ? [LINUX_DEFAULT_MIC, LINUX_USB_MIC] : [LINUX_DEFAULT_MIC],
    ),
    refreshInputDevices: fake("refreshInputDevices", () => {
      listings++;
    }),
    outputDevices: fake("outputDevices", () => ["E2E Speakers (Linux)"]),
    asioStatus: fake("asioStatus", () => "ASIO isn't in this build"),
    outputOptions: fake("outputOptions", () => null),
    outputFormat: fake(
      "outputFormat",
      () => `48 kHz, ${bufferSize ?? 128} samples`,
    ),
    setMicMode: fake("setMicMode", (_: boolean, size: number | null) => {
      bufferSize = size;
    }),
    exclusiveAvailable: fake("exclusiveAvailable", () => false),
    linuxAudio: fake("linuxAudio", () => ({
      status: "Sound system: PipeWire 1.6.2",
      bufferSizes: [64, 128, 256, 512, 1024],
      defaultBufferSize: 128,
    })),
    inputDevice_new: fake("inputDevice_new", () => nextDeviceId++),
    inputDevice_format: fake(
      "inputDevice_format",
      () => `PipeWire, 48 kHz, ${bufferSize ?? 128} samples`,
    ),
  };
}

if (fakeAudioCalls) {
  contextBridge.exposeInMainWorld("karafriendsFakeAudio", {
    calls: (): FakeAudioCall[] => fakeAudioCalls,
  });
}

contextBridge.exposeInMainWorld("karafriends", {
  ipAddresses,
  remoconPort: (): number => remoconPort,
  // Calls listener with why phones can't connect, at once if it is known.
  // Returns a function that stops it.
  onRemoconProblem: (listener: ProblemListener): (() => void) => {
    problemListeners.add(listener);
    if (remoconProblem !== null) listener(remoconProblem);
    return () => {
      problemListeners.delete(listener);
    };
  },
  api,
  ...files,
  nativeAudio: fakeAudioCalls
    ? fakeNativeAudio(fakeAudioCalls)
    : {
        // Repeatedly asking CPAL for input devices seems to cause unexpected
        // breakages, like the default output device being released. Let's avoid
        // that: they're listed once. Except on Linux, where Settings lists
        // them again as it opens, for a mic plugged in since (PipeWire and
        // PulseAudio list them without opening any).
        inputDevices: () => (inputList ??= nativeAudio.inputDevices()),
        refreshInputDevices() {
          if (process.platform === "linux") inputList = null;
        },
        // Outputs are listed again each time Settings opens, so an interface
        // switched on after launch can be picked.
        outputDevices: nativeAudio.outputDevices,
        // Found once, as the first device is listed.
        asioStatus: nativeAudio.asioStatus,
        setOutputDevice(
          name: string | null,
          rate: number | null,
          bufferSize: number | null,
        ) {
          return nativeAudio.setOutputDevice(name, rate, bufferSize);
        },
        outputOptions: nativeAudio.outputOptions,
        outputFormat: nativeAudio.outputFormat,
        setMicMode(exclusive: boolean, bufferSize: number | null) {
          return nativeAudio.setMicMode(exclusive, bufferSize);
        },
        exclusiveAvailable: nativeAudio.exclusiveAvailable,
        linuxAudio: nativeAudio.linuxAudio,
        inputDevice_new(name: string, channelSelection: number) {
          console.debug(
            `preload: creating input device ${inputDeviceCount}: ${name}`,
          );
          inputDevices[inputDeviceCount++] = nativeAudio.inputDevice_new(
            name,
            channelSelection,
          );
          return inputDeviceCount - 1;
        },
        inputDevice_delete(deviceId: number) {
          console.debug(`preload: deleting input device ${deviceId}`);
          delete inputDevices[deviceId];
        },
        inputDevice_setGain(deviceId: number, gain: number) {
          return nativeAudio.inputDevice_setGain(inputDevices[deviceId], gain);
        },
        inputDevice_setEcho(deviceId: number, echo: number) {
          return nativeAudio.inputDevice_setEcho(inputDevices[deviceId], echo);
        },
        inputDevice_status(deviceId: number) {
          return nativeAudio.inputDevice_status(inputDevices[deviceId]);
        },
        inputDevice_format(deviceId: number) {
          return nativeAudio.inputDevice_format(inputDevices[deviceId]);
        },
        inputDevice_level(deviceId: number) {
          return nativeAudio.inputDevice_level(inputDevices[deviceId]);
        },
        inputDevice_getPitch(deviceId: number) {
          return nativeAudio.inputDevice_getPitch(inputDevices[deviceId]);
        },
        inputDevice_stop(deviceId: number) {
          return nativeAudio.inputDevice_stop(inputDevices[deviceId]);
        },
      },
});
