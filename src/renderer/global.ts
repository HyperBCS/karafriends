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
        // the host, " (USB)", " (ASIO)" or " (Linux)". Listed once, as
        // first asked for (see refreshInputDevices).
        inputDevices: () => [string, string, number][];
        // On Linux, has inputDevices list the inputs again (Settings does
        // as it opens, for a mic plugged in since). Elsewhere they're
        // listed once.
        refreshInputDevices: () => void;
        // Every output device, with the host in parentheses.
        outputDevices: () => string[];
        // "ASIO: <drivers>", "No ASIO drivers are installed", or "ASIO
        // isn't in this build".
        asioStatus: () => string;
        // Where every mic plays (null for the default output), at a rate
        // and a buffer size in frames (null for the device's own).
        setOutputDevice: (
          name: string | null,
          rate: number | null,
          bufferSize: number | null,
        ) => void;
        // The rates and buffer sizes an ASIO output takes; null for other
        // outputs, where Windows sets them.
        outputOptions: (
          name: string,
        ) => { rates: number[]; bufferSizes: number[] } | null;
        // What the mic output runs at ("48 kHz, 512 samples (10.7 ms)");
        // null while no mic is open.
        outputFormat: () => string | null;
        // Windows mics opened from now on: exclusive or shared, and in
        // exclusive mode the buffer size in frames (null: the smallest).
        // On Linux the buffer size of the mics and their output (null:
        // linuxAudio's default); the output, if open, reopens at it.
        setMicMode: (exclusive: boolean, bufferSize: number | null) => void;
        // Whether there is an exclusive mode (Windows only).
        exclusiveAvailable: () => boolean;
        // On Linux: the sound system ("Sound system: PipeWire 1.6.2"), the
        // buffer sizes in frames it takes for the mics and their output,
        // and the one used until one is picked. Null elsewhere.
        linuxAudio: () => {
          status: string;
          bufferSizes: number[];
          defaultBufferSize: number;
        } | null;
        inputDevice_new: (name: string, channelSelection: number) => number;
        inputDevice_delete: (deviceId: number) => void;
        // Linear, 0 to 2.
        inputDevice_setGain: (deviceId: number, gain: number) => void;
        // The amount of reverb, 0 to 1.
        inputDevice_setEcho: (deviceId: number, echo: number) => void;
        // "ok", "ok: <a note>", or the error that stopped it.
        inputDevice_status: (deviceId: number) => string;
        // How it is open: "Shared, 48 kHz, 480 samples (10.0 ms)".
        inputDevice_format: (deviceId: number) => string;
        // The loudest sample, 0 to 1, since the last time it was asked.
        inputDevice_level: (deviceId: number) => number;
        inputDevice_getPitch: (deviceId: number) => {
          midiNumber: number;
          confidence: number;
        };
        inputDevice_stop: (deviceId: number) => void;
      };
    };
  }
}
