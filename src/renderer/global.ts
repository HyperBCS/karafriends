import type { DisplayApi, DisplayFiles } from "../common/ipc";

// What the preload (src/preload/index.ts) gives the display window. Phones
// don't have it.
declare global {
  interface Window {
    // saveTextFile and openTextFile: the dialogs for Export and Import
    // config.
    karafriends: DisplayFiles & {
      ipAddresses(): string[];
      // The phones' server port, for the remote's address.
      remoconPort(): number;
      // Calls listener with why phones can't connect (the server couldn't
      // listen), at once if it is known. Returns a function that stops it.
      onRemoconProblem(listener: (message: string) => void): () => void;
      api: DisplayApi;
      nativeAudio: {
        // Each input's id (the key mics are saved and sent by), its label
        // (what the system calls it) and its channel count; both end with
        // the host, " (USB)" or " (ASIO)".
        inputDevices: () => [string, string, number][];
        // Every output device, with the host in parentheses.
        outputDevices: () => string[];
        // "ASIO: <drivers>", "No ASIO drivers are installed", or "ASIO
        // isn't in this build".
        asioStatus: () => string;
        // Where every mic plays; null for the default output.
        setOutputDevice: (name: string | null) => void;
        inputDevice_new: (name: string, channelSelection: number) => number;
        inputDevice_delete: (deviceId: number) => void;
        // Linear, 0 to 2.
        inputDevice_setGain: (deviceId: number, gain: number) => void;
        // The amount of reverb, 0 to 1.
        inputDevice_setEcho: (deviceId: number, echo: number) => void;
        // "ok", "ok: <a note>", or the error that stopped it.
        inputDevice_status: (deviceId: number) => string;
        inputDevice_getPitch: (deviceId: number) => {
          midiNumber: number;
          confidence: number;
        };
        inputDevice_stop: (deviceId: number) => void;
      };
    };
  }
}
