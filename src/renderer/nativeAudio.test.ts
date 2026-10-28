// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, mock, test } from "node:test";

// The native module as the preload hands it over: a mic that won't open
// while `busy` is set, and the outputs' listing throwing while
// `outputsFail` is (as cpal's does when one output won't give its name).
let busy = false;
let outputsFail = false;
let nextHandle = 0;
const native = {
  inputDevices: () => [["usb-mic", "USB Mic", 1]],
  refreshInputDevices: () => undefined,
  outputDevices: () => {
    if (outputsFail) throw new Error("could not open property store");
    return ["Speakers (Windows)"];
  },
  outputOptions: () => {
    if (outputsFail) throw new Error("could not open property store");
    return null;
  },
  asioStatus: () => "No ASIO drivers are installed",
  linuxAudio: () => null,
  inputDevice_new: () => {
    if (busy) throw new Error("The device is busy");
    return nextHandle++;
  },
  inputDevice_setGain: () => undefined,
  inputDevice_setEcho: () => undefined,
  inputDevice_status: () => "ok",
  inputDevice_level: () => 0.5,
  inputDevice_format: () => "Shared, 48 kHz",
  inputDevice_stop: () => undefined,
  inputDevice_delete: () => undefined,
};
Object.assign(globalThis, { window: { karafriends: { nativeAudio: native } } });
// Imported once the window is there: nativeAudio.ts reads it as it loads.
let InputDevice: typeof import("./nativeAudio").InputDevice;

describe("a mic", () => {
  before(async () => {
    ({ InputDevice } = await import("./nativeAudio"));
  });
  beforeEach(() => {
    busy = false;
    mock.timers.enable({ apis: ["setInterval"] });
    mock.method(console, "warn", () => undefined);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  test("that won't open at first starts down, and the watchdog opens it once it can", () => {
    busy = true;
    const mic = new InputDevice("usb-mic", 0);
    assert.equal(mic.label, "USB Mic, channel 1");
    assert.equal(mic.status(), "Error: The device is busy");
    assert.equal(mic.error, "Error: The device is busy");
    assert.equal(mic.level(), 0);
    assert.equal(mic.format(), null);
    // Levels set while it's down are used once it opens.
    mic.setGain(1.5);

    mock.timers.tick(2000);
    assert.equal(mic.status(), "Error: The device is busy");

    busy = false;
    const setGain = mock.method(native, "inputDevice_setGain");
    mock.timers.tick(2000);
    assert.equal(mic.status(), "ok");
    assert.equal(mic.error, null);
    assert.equal(mic.reopenedAfter, "Error: The device is busy");
    assert.equal(mic.level(), 0.5);
    assert.equal(setGain.mock.calls[0].arguments[1], 1.5);
    mic.stop();
  });

  test("keeps its key through a reopen; each mic has its own", () => {
    const mic = new InputDevice("usb-mic", 0);
    const other = new InputDevice("usb-mic", 0);
    const key = mic.key;
    mic.reopen();
    assert.equal(mic.key, key);
    assert.notEqual(other.key, key);
    mic.stop();
    other.stop();
  });
});

describe("the device listings", () => {
  let nativeAudio: typeof import("./nativeAudio");
  before(async () => {
    nativeAudio = await import("./nativeAudio");
  });
  beforeEach(() => {
    outputsFail = false;
    mock.method(console, "error", () => undefined);
  });
  afterEach(() => mock.restoreAll());

  test("list the inputs and outputs, with no problem", () => {
    assert.deepEqual(nativeAudio.soundDevices(), {
      inputs: [["usb-mic", "USB Mic", 1]],
      outputs: ["Speakers (Windows)"],
      asioStatus: "No ASIO drivers are installed",
      linux: null,
      problem: null,
    });
  });

  test("that throw don't: the inputs still list, and the problem says why", () => {
    outputsFail = true;
    const devices = nativeAudio.soundDevices();
    assert.deepEqual(devices.inputs, [["usb-mic", "USB Mic", 1]]);
    assert.deepEqual(devices.outputs, []);
    assert.equal(
      devices.problem,
      "Couldn't list the sound devices: could not open property store",
    );
    assert.equal(nativeAudio.outputOptions("Speakers (Windows)"), null);
  });
});
