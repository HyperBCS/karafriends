const native = window.karafriends.nativeAudio;

// How often the watchdog asks each mic, and tries again to reopen one that
// is down.
const WATCH_MS = 2000;

// Every output device the mics can play through, with the host in
// parentheses.
export function outputDevices(): string[] {
  return native.outputDevices();
}

// Where every mic plays; null for the default output.
export function setOutputDevice(name: string | null) {
  native.setOutputDevice(name);
}

// "ASIO: <drivers>", "No ASIO drivers are installed", or "ASIO isn't in
// this build".
export function asioStatus(): string {
  return native.asioStatus();
}

// What the system calls an input, from its id; the id if it isn't listed.
function inputLabel(name: string): string {
  return native.inputDevices().find(([id]) => id === name)?.[1] ?? name;
}

// How Settings and the phones show one channel of an input.
export function channelLabel(label: string, channel: number): string {
  return `${label}, channel ${channel + 1}`;
}

// "ok", or "ok: <a note>" (the chosen output is missing, say): the mic works.
function working(status: string) {
  return status === "ok" || status.startsWith("ok: ");
}

export class InputDevice {
  deviceId: number;
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
  private open = true;
  private watchdog: ReturnType<typeof setInterval>;

  constructor(name: string, channelSelection: number) {
    this.name = name;
    this.label = channelLabel(inputLabel(name), channelSelection);
    this.channelSelection = channelSelection;
    this.deviceId = this.create();
    this.watchdog = setInterval(() => this.check(), WATCH_MS);
  }

  private create() {
    const deviceId = native.inputDevice_new(this.name, this.channelSelection);
    native.inputDevice_setGain(deviceId, this.gain);
    native.inputDevice_setEcho(deviceId, this.echo);
    return deviceId;
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
    try {
      this.deviceId = this.create();
      this.open = true;
      this.reopenedAfter = status;
      this.error = null;
    } catch (err) {
      this.error = String(err);
    }
  }

  // "ok", "ok: <a note>", or why it stopped.
  status(): string {
    if (this.open) return native.inputDevice_status(this.deviceId);
    return this.error ?? "stopped";
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
