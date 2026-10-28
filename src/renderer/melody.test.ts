// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { damMelody, joysoundMelody } from "./melody";

// DAM's scoring data for these 32-bit words: bytes, little-endian.
function scoringData(words: number[]): number[] {
  return Array.from(new Uint8Array(Uint32Array.from(words).buffer));
}

describe("the pitch bars' melody", () => {
  test("DAM's scoring data gives its notes and intervals, in seconds", () => {
    const data = scoringData([
      // Counts: 2 notes, 1 lyrics interval, 1 time window, 2 kiai.
      0, 2, 1, 1, 2, 0,
      // The notes: start, end (ms), MIDI number, one more word.
      1000, 1500, 60, 7, 1600, 2250, 62, 7,
      // Lyrics, DAM's time window, then the kiai intervals.
      900, 2300, 0, 5000, 1000, 1500, 1600, 2250,
    ]);
    assert.deepEqual(damMelody(data), {
      notes: [
        { startTime: 1, endTime: 1.5, midiNumber: 60 },
        { startTime: 1.6, endTime: 2.25, midiNumber: 62 },
      ],
      lyricsIntervals: [[0.9, 2.3]],
      pogIntervals: [
        [1, 1.5],
        [1.6, 2.25],
      ],
    });
  });

  test("no scoring data (no DAM login) is no notes", () => {
    const empty = { notes: [], lyricsIntervals: [], pogIntervals: [] };
    assert.deepEqual(damMelody([]), empty);
    // Not whole words: what's there is read, the rest isn't.
    assert.deepEqual(damMelody([0, 0, 0, 0, 0]), empty);
  });

  test("a Joysound song's notes are sung where they are; none, no bars", () => {
    const notes = [
      { startTime: 1, endTime: 1.5, midiNumber: 72 },
      { startTime: 20, endTime: 20.4, midiNumber: 74 },
    ];
    assert.deepEqual(joysoundMelody(notes), {
      notes,
      lyricsIntervals: [
        [1, 1.5],
        [20, 20.4],
      ],
      pogIntervals: [],
    });
    assert.equal(joysoundMelody([]), null);
  });
});
