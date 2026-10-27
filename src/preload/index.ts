import { fileURLToPath } from "url";

import { default as nativeAudioUrl } from "url:../../native/index.node";
const nativeAudio = require(fileURLToPath(nativeAudioUrl));

import { contextBridge, ipcRenderer } from "electron";
import { memoize } from "lodash";

import type { LiveEvent } from "../common/api";
import { IPC_CHANNELS, REMOCON_PORT_ARG, type DisplayApi } from "../common/ipc";
import ipAddresses from "../common/ipAddresses";

let inputDeviceCount = 0;
const inputDevices: { [deviceId: number]: any } = {};

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

contextBridge.exposeInMainWorld("karafriends", {
  ipAddresses,
  remoconPort: (): number => remoconPort,
  api,
  nativeAudio: {
    // Repeatedly asking CPAL for input devices seems to cause unexpected
    // breakages, like the default output device being released. Let's avoid
    // that.
    inputDevices: memoize(nativeAudio.inputDevices),
    outputDevices: nativeAudio.outputDevices,
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
    inputDevice_getPitch(deviceId: number) {
      return nativeAudio.inputDevice_getPitch(inputDevices[deviceId]);
    },
    inputDevice_stop(deviceId: number) {
      return nativeAudio.inputDevice_stop(inputDevices[deviceId]);
    },
  },
});
