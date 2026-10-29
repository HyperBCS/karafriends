// A mic's noise gate (Gate in the native lib), in whole dB below full
// scale, the way the TV's level meter reads: GATE_OFF_DB, the meter's
// floor, is off; GATE_MAX_DB is as high as it goes, which only singing
// close to the mic gets over.
export const GATE_OFF_DB = -60;
export const GATE_MAX_DB = -20;

// The threshold the native gate takes: linear, 0 to 1, and 0 for off.
export function gateThreshold(db: number): number {
  return db <= GATE_OFF_DB ? 0 : 10 ** (Math.min(db, 0) / 20);
}
