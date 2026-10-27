import type { DisplayApi } from "../common/ipc";

// What the preload (src/preload/index.ts) gives the display window. Phones
// don't have it.
declare global {
  interface Window {
    karafriends: {
      ipAddresses(): string[];
      // The phones' server port, for the remote's address.
      remoconPort(): number;
      // Calls listener with why phones can't connect (the server couldn't
      // listen), at once if it is known. Returns a function that stops it.
      onRemoconProblem(listener: (message: string) => void): () => void;
      api: DisplayApi;
      nativeAudio: {
        inputDevices: () => [string, number][];
        outputDevices: () => string[];
        inputDevice_new: (name: string, channelSelection: number) => number;
        inputDevice_delete: (deviceId: number) => void;
        inputDevice_getPitch: (deviceId: number) => {
          midiNumber: number;
          confidence: number;
        };
        inputDevice_stop: (deviceId: number) => void;
      };
    };
  }
}
