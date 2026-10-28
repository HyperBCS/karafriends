import type { LinuxAudio, OutputOptions } from "./global";

export type { LinuxAudio, OutputOptions };

// The mics and their output; each function is described in global.ts.
const native = window.karafriends.nativeAudio;

// How often the watchdog asks each mic, and tries again to reopen one that
// is down.
const WATCH_MS = 2000;

// An input as listed: its id (the key mics are saved and sent by), its
// label (what the system calls it) and its channel count.
export type Input = [id: string, label: string, channels: number];

// What list() answers, or fallback and why when it throws: one device that
// won't give its name can fail a whole listing. Logged, so no listing
// throws into a render.
function listed<T>(
  what: string,
  list: () => T,
  fallback: T,
): { value: T; problem: string | null } {
  try {
    return { value: list(), problem: null };
  } catch (err) {
    console.error(`Couldn't list ${what}:`, err);
    return { value: fallback, problem: String((err as Error)?.message ?? err) };
  }
}

// The inputs as listed; none while the listing fails.
export function inputDevices(): Input[] {
  return listed("the inputs", () => native.inputDevices(), []).value;
}

// What Settings shows as its Sound tab opens: the inputs (listed again on
// Linux, for a mic plugged in since), the outputs, the ASIO drivers'
// status and Linux's sound system. A listing that fails leaves its part
// empty, and problem says why.
export interface SoundDevices {
  inputs: Input[];
  outputs: string[];
  asioStatus: string;
  linux: LinuxAudio | null;
  problem: string | null;
}

export function soundDevices(): SoundDevices {
  const refreshed = listed(
    "the inputs",
    () => native.refreshInputDevices(),
    undefined,
  );
  const inputs = listed("the inputs", () => native.inputDevices(), []);
  const outputs = listed("the outputs", () => native.outputDevices(), []);
  const asio = listed("the ASIO drivers", () => native.asioStatus(), "");
  const linux = listed("the sound system", () => native.linuxAudio(), null);
  const problem = [refreshed, inputs, outputs, asio, linux].find(
    (answer) => answer.problem !== null,
  )?.problem;
  return {
    inputs: inputs.value,
    outputs: outputs.value,
    asioStatus: asio.value,
    linux: linux.value,
    problem: problem ? `Couldn't list the sound devices: ${problem}` : null,
  };
}

// Where every mic plays: the device (null for the default output), and for
// an ASIO one its rate in Hz and buffer size in frames (null for the
// driver's own).
export interface MicOutput {
  name: string | null;
  rate: number | null;
  bufferSize: number | null;
}

export function setOutputDevice(output: MicOutput) {
  native.setOutputDevice(output.name, output.rate, output.bufferSize);
}

// How the mics open on Windows: shared with other programs (Windows
// mixes, in 10 ms buffers), or exclusive, for less delay, with a buffer
// size in frames (null for the smallest the mic takes). On Linux only the
// buffer size counts, for the mics and their output alike (null for
// linuxAudio's default). Mics opened after it is set use it.
export interface MicMode {
  exclusive: boolean;
  bufferSize: number | null;
}

export function setMicMode(mode: MicMode) {
  native.setMicMode(mode.exclusive, mode.bufferSize);
}

export function exclusiveAvailable(): boolean {
  return native.exclusiveAvailable();
}

// Null too while they won't list.
export function outputOptions(name: string): OutputOptions | null {
  return listed(`${name}'s options`, () => native.outputOptions(name), null)
    .value;
}

export function outputFormat(): string | undefined {
  return native.outputFormat();
}

// Where the mics play, whichever mics are up ("ok", "ok: <a note>", or why
// the output stopped); undefined while no mic is open.
export function outputStatus(): string | undefined {
  return native.outputStatus();
}

// What the system calls an input, from its id; the id if it isn't listed.
function inputLabel(name: string): string {
  return inputDevices().find(([id]) => id === name)?.[1] ?? name;
}

// How Settings and the phones show one channel of an input.
export function channelLabel(label: string, channel: number): string {
  return `${label}, channel ${channel + 1}`;
}

// "ok", or "ok: <a note>" (the chosen output is missing, say): the mic works.
function working(status: string) {
  return status === "ok" || status.startsWith("ok: ");
}

// Each InputDevice's key, for as long as it lives.
let nextKey = 0;

export class InputDevice {
  // Its row's key in Settings: the native handle changes on every reopen.
  readonly key = nextKey++;
  // The native handle, while it's open.
  private deviceId = -1;
  // The input's id: the key it is saved and sent by.
  name: string;
  // What the system calls it, with the channel: what Settings and the
  // phones show.
  label: string;
  channelSelection: number;
  // Why it was last reopened, while it works again.
  reopenedAfter: string | null = null;
  // Why it won't reopen, while it is down (the watchdog keeps trying).
  error: string | null = null;
  private gain = 1;
  private echo = 0.4;
  private open = false;
  private watchdog: ReturnType<typeof setInterval>;

  // One that won't open (busy, or the mic output won't: a TV asleep)
  // starts down, with why in error, and the watchdog keeps trying it.
  constructor(name: string, channelSelection: number) {
    this.name = name;
    this.label = channelLabel(inputLabel(name), channelSelection);
    this.channelSelection = channelSelection;
    if (!this.openAgain()) {
      console.warn(`Mic ${this.label} didn't open (${this.error}); retrying`);
    }
    this.watchdog = setInterval(() => this.check(), WATCH_MS);
  }

  private create() {
    const deviceId = native.inputDevice_new(this.name, this.channelSelection);
    native.inputDevice_setGain(deviceId, this.gain);
    native.inputDevice_setEcho(deviceId, this.echo);
    return deviceId;
  }

  // Opens the device again; when it won't, keeps why (the watchdog tries
  // again).
  private openAgain(): boolean {
    try {
      this.deviceId = this.create();
      this.open = true;
      this.error = null;
      return true;
    } catch (err) {
      this.error = String(err);
      return false;
    }
  }

  // Reopens the mic when its stream stopped. One that won't reopen (a mic
  // unplugged, a TV asleep) is tried again every time, until it is back.
  check() {
    const status = this.status();
    if (working(status)) return;
    this.close();
    if (this.error === null) {
      console.warn(`Mic ${this.label} stopped (${status}); reopening`);
    }
    if (this.openAgain()) this.reopenedAfter = status;
  }

  // Opens it again as the mics are set now (see setMicMode).
  reopen() {
    this.close();
    this.openAgain();
  }

  // "ok", "ok: <a note>", or why it stopped.
  status(): string {
    if (this.open) return native.inputDevice_status(this.deviceId);
    return this.error ?? "stopped";
  }

  // The loudest sample, 0 to 1, since the last time it was asked; 0 while
  // it's down.
  level(): number {
    return this.open ? native.inputDevice_level(this.deviceId) : 0;
  }

  // How it is open ("Shared, 48 kHz, 480 samples (10.0 ms)"); null while
  // it's down.
  format(): string | null {
    return this.open ? native.inputDevice_format(this.deviceId) : null;
  }

  // Linear, 0 to 2.
  setGain(gain: number) {
    this.gain = gain;
    if (this.open) native.inputDevice_setGain(this.deviceId, gain);
  }

  // The amount of reverb, 0 to 1.
  setEcho(echo: number) {
    this.echo = echo;
    if (this.open) native.inputDevice_setEcho(this.deviceId, echo);
  }

  // No pitch (confidence 0) while it's stopped.
  getPitch() {
    if (!this.open) return { midiNumber: 0, confidence: 0 };
    return native.inputDevice_getPitch(this.deviceId);
  }

  stop() {
    clearInterval(this.watchdog);
    this.close();
  }

  // Stops the native device and lets it go. Pausing a stream whose device
  // is gone can fail; it is let go all the same.
  private close() {
    if (!this.open) return;
    this.open = false;
    try {
      native.inputDevice_stop(this.deviceId);
    } catch (err) {
      console.warn(`Mic ${this.label} didn't stop cleanly:`, err);
    }
    native.inputDevice_delete(this.deviceId);
  }
}
