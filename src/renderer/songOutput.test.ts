// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type SinkId, SongOutputKeeper } from "./songOutput";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Chromium 156's AudioContext as far as the song output goes
// (audio_context.cc): setSinkId suspends a running context while it
// switches and runs it again after sinkchange; an id that isn't listed is
// rejected; an explicitly chosen output that leaves the list fires 'error'
// and suspends it, and nothing runs it again but resume().
class FakeContext extends EventTarget {
  state = "running";
  sinkId: SinkId = "";
  calls: string[] = [];
  private given = false;

  constructor(private devices: FakeDevices) {
    super();
  }

  private setState(state: string) {
    this.state = state;
    setTimeout(() => this.dispatchEvent(new Event("statechange")));
  }

  async setSinkId(sinkId: SinkId) {
    const shown = typeof sinkId === "string" ? `'${sinkId}'` : sinkId.type;
    this.calls.push(`setSinkId ${shown}`);
    if (sinkId === this.sinkId) return;
    if (typeof sinkId === "string" && !this.devices.listed(sinkId)) {
      throw new DOMException(`the device ${sinkId} is not found`, "NotFound");
    }
    const wasRunning = this.state === "running";
    if (wasRunning) this.setState("suspended");
    await wait(1);
    this.sinkId = sinkId;
    this.given = true;
    setTimeout(() => {
      this.dispatchEvent(new Event("sinkchange"));
      if (wasRunning) this.setState("running");
    });
  }

  async resume() {
    this.calls.push("resume");
    if (this.state !== "running") this.setState("running");
  }

  // OnDevicesChanged: the output in use is gone.
  lost() {
    if (typeof this.sinkId !== "string" || this.devices.listed(this.sinkId)) {
      return;
    }
    if (!this.given) return;
    this.dispatchEvent(new Event("error"));
    this.setState("suspended");
  }
}

class FakeDevices extends EventTarget {
  outputs = new Set(["default", "laptop", "tv"]);
  // Until it's true, the context's own list lags the page's by one look
  // (Chromium updates them apart).
  lagging = false;
  // A machine with no output at all: Chromium then finds no default either.
  noDefault = false;

  listed(id: string) {
    if (this.lagging) {
      this.lagging = false;
      return false;
    }
    return (id === "" && !this.noDefault) || this.outputs.has(id);
  }

  async enumerateDevices() {
    return [...this.outputs].map((deviceId) => ({
      kind: "audiooutput",
      deviceId,
    }));
  }

  unplug(id: string, context: FakeContext) {
    this.outputs.delete(id);
    context.lost();
    this.dispatchEvent(new Event("devicechange"));
  }

  plug(id: string) {
    this.outputs.add(id);
    this.dispatchEvent(new Event("devicechange"));
  }
}

function setup() {
  const devices = new FakeDevices();
  const context = new FakeContext(devices);
  const keeper = new SongOutputKeeper(context, devices, {
    settleMs: 20,
    retryMs: 20,
  });
  return { devices, context, keeper };
}

// Waits for what a test expects to happen, which a slow machine (a busy CI
// runner) can take a while to get to. Gives up after 5 s and lets the
// assertions after it say what's wrong.
async function until(happened: () => boolean) {
  const giveUp = Date.now() + 5000;
  while (!happened() && Date.now() < giveUp) await wait(5);
}

// For checking that nothing more happens: long enough for the keeper's
// timers and the fake's events on a machine that isn't busy. (Waiting for
// something that should happen is until's job.)
const settled = () => wait(100);

const playsOn = (context: FakeContext, sinkId: SinkId) => () =>
  JSON.stringify(context.sinkId) === JSON.stringify(sinkId) &&
  context.state === "running";

describe("the songs' output", () => {
  test("switching outputs doesn't count as losing one", async () => {
    const { context, keeper } = setup();
    await keeper.choose("tv");
    await until(playsOn(context, "tv"));
    await settled();
    assert.equal(context.sinkId, "tv");
    assert.equal(context.state, "running");
    assert.equal(keeper.place(), "chosen");
    assert.deepEqual(context.calls, ["setSinkId 'tv'"]);
  });

  test("a chosen output that goes away plays silently, and comes back by itself", async () => {
    const { devices, context, keeper } = setup();
    await keeper.choose("tv");
    await until(playsOn(context, "tv"));

    devices.unplug("tv", context);
    await until(playsOn(context, { type: "none" }));
    // The video's clock runs again, on the silent sink, so the song goes
    // on without blasting the laptop speakers.
    assert.deepEqual(context.sinkId, { type: "none" });
    assert.equal(context.state, "running");
    assert.equal(keeper.place(), "silent");

    devices.plug("tv");
    await until(playsOn(context, "tv"));
    assert.equal(context.sinkId, "tv");
    assert.equal(context.state, "running");
    assert.equal(keeper.place(), "chosen");
  });

  test("an output that's back before the context lists it is tried again", async () => {
    const { devices, context, keeper } = setup();
    await keeper.choose("tv");
    devices.unplug("tv", context);
    await until(playsOn(context, { type: "none" }));
    assert.deepEqual(context.sinkId, { type: "none" });
    devices.lagging = true;
    devices.plug("tv");
    await until(playsOn(context, "tv"));
    assert.equal(context.sinkId, "tv");
    assert.equal(context.state, "running");
    // Chosen, refused once, then taken.
    assert.equal(
      context.calls.filter((call) => call === "setSinkId 'tv'").length,
      3,
    );
  });

  test("a saved output that isn't there at launch is used once it's listed", async () => {
    const { devices, context, keeper } = setup();
    devices.outputs.delete("tv");
    await assert.rejects(keeper.want("tv"), /not found/);
    await settled();
    assert.equal(context.sinkId, "");
    assert.equal(keeper.place(), "default");

    // Another device coming and going changes nothing.
    devices.plug("headphones");
    await settled();
    assert.equal(context.sinkId, "");

    devices.plug("tv");
    await until(playsOn(context, "tv"));
    assert.equal(context.sinkId, "tv");
    assert.equal(keeper.place(), "chosen");
  });

  test("a choice that fails keeps the output before it", async () => {
    const { devices, context, keeper } = setup();
    await keeper.choose("tv");
    devices.outputs.delete("laptop");
    await assert.rejects(keeper.choose("laptop"), /not found/);
    devices.plug("laptop");
    await settled();
    assert.equal(context.sinkId, "tv");
    assert.equal(keeper.place(), "chosen");
  });

  test("System default on a machine with no output at all is kept, and the songs play silently", async () => {
    const { devices, context, keeper } = setup();
    // A CI runner: no output, so even the default is "not found".
    devices.outputs.clear();
    devices.noDefault = true;
    await assert.rejects(keeper.want("e2e-gone"), /not found/);
    // With nothing to render on, the context errors at launch.
    context.dispatchEvent(new Event("error"));
    await until(playsOn(context, { type: "none" }));
    assert.equal(keeper.place(), "silent");
    await keeper.choose("");
    await settled();
    assert.equal(keeper.place(), "silent");
    assert.deepEqual(context.sinkId, { type: "none" });
    assert.ok(context.calls.includes("setSinkId none"));
  });

  test("System default while the chosen output is gone plays on the default", async () => {
    const { devices, context, keeper } = setup();
    await keeper.choose("tv");
    devices.unplug("tv", context);
    await until(playsOn(context, { type: "none" }));
    await keeper.choose("");
    await until(playsOn(context, ""));
    assert.equal(context.sinkId, "");
    assert.equal(context.state, "running");
    assert.equal(keeper.place(), "chosen");
  });

  test("a context left suspended (a switch that failed half way) runs again", async () => {
    const { context, keeper } = setup();
    context.state = "suspended";
    context.dispatchEvent(new Event("statechange"));
    await until(() => context.state === "running");
    assert.equal(context.state, "running");
    // Nothing went away: it stays on its output.
    assert.equal(context.sinkId, "");
    assert.equal(keeper.place(), "chosen");
  });
});
