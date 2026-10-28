// Where the songs play, over a whole party: the output the host chose, kept
// through it going away and coming back (a TV on standby or on another
// input, an HDMI blip, a DAC unplugged), and used once it shows up when it
// wasn't there at launch.
//
// Chromium (150, audio_context.cc) treats an explicitly chosen output that
// leaves the device list as a render error: it fires 'error' and suspends
// the context, and nothing but resume() runs it again. The video's sound
// goes only through the context, so the video, the lyrics and the pitch
// bars would stop with it. The context moves to the silent sink instead and
// runs on, and goes back to the chosen output when it's listed again.

// An output's id from enumerateDevices, "" for the system default, or
// Chromium's silent sink.
export type SinkId = string | { type: "none" };

// The parts of an AudioContext this uses (setSinkId and sinkId aren't in
// TypeScript's DOM types yet).
export interface OutputContext extends EventTarget {
  readonly state: string;
  readonly sinkId: SinkId;
  setSinkId(sinkId: SinkId): Promise<void>;
  resume(): Promise<void>;
}

// The parts of navigator.mediaDevices this uses.
export interface OutputDevices extends EventTarget {
  enumerateDevices(): Promise<{ kind: string; deviceId: string }[]>;
}

// Where the songs play now: on the chosen output; on another (the system
// default) while the chosen one hasn't been there; or silently, since the
// chosen one went away.
export type OutputPlace = "chosen" | "default" | "silent";

// A setSinkId suspends a running context until it's done, and runs it
// again a task after: a context still suspended this long after the last
// switch was left so (a switch that failed half way), and is run again.
const SETTLE_MS = 500;
// The page hears of a device before the context's own list has it, so an
// output that's listed again but refused is tried this often, a few times.
const RETRY_MS = 1000;
const RETRIES = 3;

export class SongOutputKeeper {
  // The output the songs should play on: "" for the system default.
  private wanted = "";
  // setSinkId calls running; their suspends aren't a problem.
  private switching = 0;
  private recovering = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private settleMs: number;
  private retryMs: number;

  constructor(
    private context: OutputContext,
    private devices: OutputDevices,
    timing: { settleMs?: number; retryMs?: number } = {},
  ) {
    this.settleMs = timing.settleMs ?? SETTLE_MS;
    this.retryMs = timing.retryMs ?? RETRY_MS;
    context.addEventListener("error", () => void this.playSilently());
    context.addEventListener("statechange", () => {
      if (context.state === "suspended") this.settle();
    });
    devices.addEventListener("devicechange", () => void this.reapply());
  }

  place(): OutputPlace {
    const { sinkId } = this.context;
    if (typeof sinkId !== "string") return "silent";
    return sinkId === this.wanted ? "chosen" : "default";
  }

  // The saved output, at launch: kept even when it isn't there now (the
  // promise rejects), and used once it's listed.
  want(id: string): Promise<void> {
    this.wanted = id;
    return this.apply();
  }

  // The host's choice: kept only if the songs play there.
  async choose(id: string): Promise<void> {
    const before = this.wanted;
    this.wanted = id;
    try {
      await this.apply();
    } catch (err) {
      this.wanted = before;
      throw err;
    }
  }

  private async apply() {
    const target = this.wanted;
    if (this.context.sinkId === target) return;
    await this.setSinkId(target);
  }

  private async setSinkId(sinkId: SinkId) {
    this.switching++;
    try {
      await this.context.setSinkId(sinkId);
    } finally {
      this.switching--;
      this.settle();
    }
  }

  // Runs the context again if it's still suspended once every switch is
  // done and has had time to finish.
  private settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.context.state !== "suspended" || this.switching > 0) return;
      this.context
        .resume()
        .catch((err) => console.warn("The songs' sound won't resume:", err));
    }, this.settleMs);
  }

  // The output went away: on to the silent sink, and run again.
  private async playSilently() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      if (typeof this.context.sinkId === "string") {
        console.warn("The song output went away; playing silently");
        await this.setSinkId({ type: "none" }).catch((err) =>
          console.warn("Couldn't play the songs silently:", err),
        );
      }
      await this.context
        .resume()
        .catch((err) => console.warn("The songs' sound won't resume:", err));
    } finally {
      this.recovering = false;
    }
  }

  // The devices changed: the wanted output again, if it's listed.
  private async reapply(tries = RETRIES) {
    clearTimeout(this.retryTimer);
    if (this.context.sinkId === this.wanted) return;
    let outputs: { deviceId: string }[];
    try {
      outputs = (await this.devices.enumerateDevices()).filter(
        ({ kind }) => kind === "audiooutput",
      );
    } catch {
      return;
    }
    const listed =
      this.wanted === ""
        ? outputs.length > 0
        : outputs.some(({ deviceId }) => deviceId === this.wanted);
    if (!listed) return;
    try {
      await this.apply();
    } catch (err) {
      if (tries > 1) {
        this.retryTimer = setTimeout(
          () => void this.reapply(tries - 1),
          this.retryMs,
        );
      } else {
        console.warn("The song output is back but won't open:", err);
      }
    }
  }
}
