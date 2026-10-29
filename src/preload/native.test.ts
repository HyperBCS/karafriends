// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type native from "../../native/index.node";

// Every function the native module's type declares (src/vite-env.d.ts): an
// object, so that a name left out here or extra is a type error.
const DECLARED: Record<keyof typeof native, true> = {
  allocConsole: true,
  asioStatus: true,
  inputDevice_format: true,
  inputDevice_getPitch: true,
  inputDevice_level: true,
  inputDevice_new: true,
  inputDevice_setEcho: true,
  inputDevice_setGain: true,
  inputDevice_setGate: true,
  inputDevice_status: true,
  inputDevice_stop: true,
  inputDevices: true,
  linuxAudio: true,
  outputDevices: true,
  outputFormat: true,
  outputOptions: true,
  outputStatus: true,
  setMicMode: true,
  setOutputDevice: true,
};

// Built by yarn build-native-dev (or -prod). Loading it opens no device.
const MODULE = path.join(__dirname, "../../native/index.node");

test(
  "the native module exports the functions its type declares",
  { skip: !existsSync(MODULE) && "native/index.node isn't built" },
  () => {
    const exports = Object.keys(require(MODULE)).sort();
    assert.deepEqual(exports, Object.keys(DECLARED).sort());
  },
);
