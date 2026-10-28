const native = window.karafriends.nativeAudio;

const registry = new FinalizationRegistry(native.inputDevice_delete);

// The watchdog: how often it asks each mic, and how many reopens in a
// minute it tries before it gives up.
const WATCH_MS = 2000;
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 60_000;

// Every output device the mics can play through, with the host in
// parentheses.
export function outputDevices(): string[] {
  return native.outputDevices();
}

// Where every mic plays; null for the default output.
export function setOutputDevice(name: string | null) {
  native.setOutputDevice(name);
}

// "ok", or "ok: <a note>" (the chosen output is missing, say): the mic works.
function working(status: string) {
  return status === "ok" || status.startsWith("ok: ");
}

export class InputDevice {
  deviceId: number;
  name: string;
  channelSelection: number;
  // Why it was last reopened, while it works again.
  reopenedAfter: string | null = null;
  // Why it stopped for good: it failed too often, or couldn't reopen.
  error: string | null = null;
  private gain = 1;
  private echo = 0.4;
  private open = true;
  private failures: number[] = [];
  private watchdog: ReturnType<typeof setInterval>;

  constructor(name: string, channelSelection: number) {
    this.name = name;
    this.channelSelection = channelSelection;
    this.deviceId = this.create();
    this.watchdog = setInterval(() => this.check(), WATCH_MS);
  }

  private create() {
    const deviceId = native.inputDevice_new(this.name, this.channelSelection);
    registry.register(this, deviceId);
    native.inputDevice_setGain(deviceId, this.gain);
    native.inputDevice_setEcho(deviceId, this.echo);
    return deviceId;
  }

  // Reopens the mic when its stream stopped, up to MAX_FAILURES a minute.
  private check() {
    const status = this.status();
    if (working(status)) return;
    const now = Date.now();
    this.failures = [
      ...this.failures.filter((time) => now - time < FAILURE_WINDOW_MS),
      now,
    ];
    this.close();
    if (this.failures.length >= MAX_FAILURES) {
      console.error(`Mic ${this.name} gave up: ${status}`);
      this.error = status;
      clearInterval(this.watchdog);
      return;
    }
    console.warn(`Mic ${this.name} stopped (${status}); reopening`);
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
      console.warn(`Mic ${this.name} didn't stop cleanly:`, err);
    }
    native.inputDevice_delete(this.deviceId);
  }
}
