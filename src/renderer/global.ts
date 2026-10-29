import type { DisplayApi, DisplayFiles } from "../common/ipc";

// On Linux: the sound system the mics use ("Sound system: PipeWire
// 1.6.2"), the buffer sizes in frames it takes for the mics and their
// output, and the one used until one is picked.
export interface LinuxAudio {
  status: string;
  bufferSizes: number[];
  defaultBufferSize: number;
}

// The rates and buffer sizes in frames an ASIO output takes.
export interface OutputOptions {
  rates: number[];
  bufferSizes: number[];
}

// The mics and their output, as the preload hands them to the display: the
// native module's functions (see src/vite-env.d.ts), with each mic as a
// number. The preload's fakes for the e2e tests are typed by it too.
export interface NativeAudio {
  // Each input's id (the key mics are saved and sent by), its label (what
  // the system calls it) and its channel count; both end with the host,
  // " (USB)", " (ASIO)" or " (Linux)". Listed once, as first asked for
  // (see refreshInputDevices).
  inputDevices: () => [string, string, number][];
  // Has inputDevices list the inputs again: Settings does as its Sound tab
  // opens and as devices come and go, for a mic plugged in since.
  refreshInputDevices: () => void;
  // Every output device, with the host in parentheses.
  outputDevices: () => string[];
  // "ASIO: <drivers>", "No ASIO drivers are installed", or "ASIO isn't in
  // this build".
  asioStatus: () => string;
  // Where every mic plays (null for the default output), at a rate and a
  // buffer size in frames (null for the device's own). Throws, changing
  // nothing, when it won't open.
  setOutputDevice: (
    name: string | null,
    rate: number | null,
    bufferSize: number | null,
  ) => void;
  // The rates and buffer sizes an ASIO output takes; null for other
  // outputs, where Windows sets them.
  outputOptions: (name: string) => OutputOptions | null;
  // What the mic output runs at ("48 kHz, 512 samples (10.7 ms)"), and why
  // its thread isn't real-time if the system refused; undefined while no
  // mic is open.
  outputFormat: () => string | undefined;
  // Where the mics play: "ok", "ok: <a note>" (the chosen output is
  // missing, and the default plays instead), or why the output stopped;
  // undefined while no mic is open.
  outputStatus: () => string | undefined;
  // Windows mics opened from now on: exclusive or shared, and in exclusive
  // mode the buffer size in frames (null: the smallest). On Linux the
  // buffer size of the mics and their output (null: linuxAudio's default);
  // the output, if open, reopens at it.
  setMicMode: (exclusive: boolean, bufferSize: number | null) => void;
  // Whether there is an exclusive mode (Windows only).
  exclusiveAvailable: () => boolean;
  // On Linux, see LinuxAudio; null elsewhere.
  linuxAudio: () => LinuxAudio | null;
  // Opens one channel of an input; throws when it won't open.
  inputDevice_new: (name: string, channelSelection: number) => number;
  inputDevice_delete: (deviceId: number) => void;
  // Linear, 0 to 2.
  inputDevice_setGain: (deviceId: number, gain: number) => void;
  // The amount of reverb, 0 to 1.
  inputDevice_setEcho: (deviceId: number, echo: number) => void;
  // The noise gate's threshold, linear, 0 to 1; 0 is off.
  inputDevice_setGate: (deviceId: number, threshold: number) => void;
  // "ok", "ok: <a note>", or the error that stopped it.
  inputDevice_status: (deviceId: number) => string;
  // How it is open: "Shared, 48 kHz, 480 samples (10.0 ms)".
  inputDevice_format: (deviceId: number) => string;
  // The loudest sample, 0 to 1, since the last time it was asked.
  inputDevice_level: (deviceId: number) => number;
  // The pitch of its newest 25 ms, as a MIDI number, and how sure that is
  // (0 to 1); confidence 0 when nothing new came since the last ask.
  inputDevice_getPitch: (deviceId: number) => {
    midiNumber: number;
    confidence: number;
  };
  inputDevice_stop: (deviceId: number) => void;
}

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
      api: DisplayApi;
      nativeAudio: NativeAudio;
    };
  }
}
