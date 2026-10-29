import assert from "node:assert/strict";
import { test } from "node:test";

import { GATE_MAX_DB, GATE_OFF_DB, gateThreshold } from "./micGate";

test("the gate's floor is off, and the rest are linear levels", () => {
  assert.equal(gateThreshold(GATE_OFF_DB), 0);
  assert.equal(gateThreshold(GATE_OFF_DB - 10), 0);
  assert.ok(Math.abs(gateThreshold(-40) - 0.01) < 1e-9);
  assert.ok(Math.abs(gateThreshold(GATE_MAX_DB) - 0.1) < 1e-9);
  assert.equal(gateThreshold(6), 1);
});
