// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, mock, test } from "node:test";

// The native module as the preload hands it over: a mic that won't open
// while `busy` is set.
let busy = false;
let nextHandle = 0;
const native = {
  inputDevices: () => [["usb-mic", "USB Mic", 1]],
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
