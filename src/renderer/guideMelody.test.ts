// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { guideMelodyNotes, pitchTrack } from "./guideMelody";
import type { MelodyNote } from "./melody";

// The rate the display decodes at (useGuideMelody.ts).
const RATE = 11025;

type Wave = "sine" | "square";

// A note: a MIDI number for some seconds, at a level (0.3 by default), with
// the level at each moment from shape (1 throughout by default); or a rest.
type Part =
  | {
      midi: number;
      seconds: number;
      wave?: Wave;
      level?: number;
      shape?: (t: number) => number;
    }
  | { rest: number };

// Synthesised sound, one part after another, as a guide melody's channel
// would be. The last 45 ms has no frame of its own (a frame reads 30 ms,
// and as far again as the lowest note's period), so a test ends on a rest.
function synth(parts: Part[], rate = RATE): Float32Array {
  const samples: number[] = [];
  let phase = 0;
  for (const part of parts) {
    if ("rest" in part) {
      for (let i = 0; i < part.rest * rate; i++) samples.push(0);
      continue;
    }
    const hz = 440 * 2 ** ((part.midi - 69) / 12);
    for (let i = 0; i < part.seconds * rate; i++) {
      phase += hz / rate;
      const cycle = phase % 1;
      const value =
        part.wave === "square"
          ? cycle < 0.5
            ? 1
            : -1
          : Math.sin(2 * Math.PI * cycle);
      const level = (part.level ?? 0.3) * (part.shape?.(i / rate) ?? 1);
      samples.push(value * level);
    }
  }
  return Float32Array.from(samples);
}

// Each note as [start, end, MIDI number], to compare with expected times
// to the nearest 30 ms.
function assertNotes(notes: MelodyNote[], expected: number[][]) {
  assert.equal(
    notes.length,
    expected.length,
    `notes: ${JSON.stringify(notes)}`,
  );
  notes.forEach((note, i) => {
    const [start, end, midi] = expected[i];
    assert.equal(note.midiNumber, midi, `note ${i}'s number`);
    assert.ok(
      Math.abs(note.startTime - start) <= 0.03,
      `note ${i} starts at ${note.startTime}, not ${start}`,
    );
    assert.ok(
      Math.abs(note.endTime - end) <= 0.03,
      `note ${i} ends at ${note.endTime}, not ${end}`,
    );
  });
}

describe("the guide melody's notes", () => {
  test("sine notes with rests between them are those notes, at their times", () => {
    const sound = synth([
      { rest: 0.5 },
      { midi: 60, seconds: 0.5 },
      { rest: 0.2 },
      { midi: 64, seconds: 0.4 },
      { rest: 0.3 },
      { midi: 67, seconds: 0.6 },
      { rest: 0.2 },
      { midi: 72, seconds: 0.25 },
      { rest: 0.5 },
    ]);
    assertNotes(guideMelodyNotes(sound, RATE), [
      [0.5, 1.0, 60],
      [1.2, 1.6, 64],
      [1.9, 2.5, 67],
      [2.7, 2.95, 72],
    ]);
  });

  test("square notes, one straight after another, are those notes", () => {
    const sound = synth([
      ...[57, 62, 69, 74, 81, 76].map((midi) => ({
        midi,
        seconds: 0.3,
        wave: "square" as const,
      })),
      { rest: 0.1 },
    ]);
    assertNotes(guideMelodyNotes(sound, RATE), [
      [0, 0.3, 57],
      [0.3, 0.6, 62],
      [0.6, 0.9, 69],
      [0.9, 1.2, 74],
      [1.2, 1.5, 81],
      [1.5, 1.8, 76],
    ]);
  });

  test("any rate gives the same notes", () => {
    const parts: Part[] = [
      { midi: 45, seconds: 0.4 },
      { rest: 0.1 },
      { midi: 88, seconds: 0.4 },
      { rest: 0.1 },
    ];
    for (const rate of [8000, 44100, 48000]) {
      assertNotes(guideMelodyNotes(synth(parts, rate), rate), [
        [0, 0.4, 45],
        [0.5, 0.9, 88],
      ]);
    }
  });

  test("silence, or sound too quiet to be the melody, is no notes", () => {
    assert.deepEqual(guideMelodyNotes(new Float32Array(RATE * 3), RATE), []);
    const quiet = synth([{ midi: 69, seconds: 2, level: 0.001 }]);
    assert.deepEqual(guideMelodyNotes(quiet, RATE), []);
    assert.deepEqual(guideMelodyNotes(new Float32Array(10), RATE), []);
  });

  test("a frame's pitch has its cents, and silence none", () => {
    const { midi, level } = pitchTrack(
      synth([{ midi: 69.3, seconds: 0.3 }, { rest: 0.3 }]),
      RATE,
    );
    assert.ok(Math.abs(midi[10] - 69.3) < 0.05, `${midi[10]}`);
    assert.ok(Number.isNaN(midi[45]));
    assert.ok(level[10] > -15 && level[45] < -100);
  });

  test("a blip between two notes is dropped", () => {
    const sound = synth([
      { midi: 64, seconds: 0.4 },
      { midi: 76, seconds: 0.04 },
      { midi: 65, seconds: 0.4 },
      { rest: 0.2 },
      { midi: 67, seconds: 0.4 },
      { midi: 79, seconds: 0.04 },
      { midi: 67, seconds: 0.4 },
      { rest: 0.1 },
    ]);
    // The second blip splits nothing: the note goes on either side of it.
    assertNotes(guideMelodyNotes(sound, RATE), [
      [0, 0.42, 64],
      [0.42, 0.84, 65],
      [1.04, 1.88, 67],
    ]);
  });

  test("a note played again, its level dipping between, is two notes", () => {
    // Down to a fifth for 20 ms, as a synth's new note starts.
    const dip = (t: number) => (t >= 0.38 && t < 0.4 ? 0.2 : 1);
    const sound = synth([
      { midi: 69, seconds: 0.4, shape: dip },
      { midi: 69, seconds: 0.4 },
      { rest: 0.2 },
    ]);
    const notes = guideMelodyNotes(sound, RATE);
    assertNotes(notes, [
      [0, 0.39, 69],
      [0.4, 0.8, 69],
    ]);
    assert.ok(notes[1].startTime > notes[0].endTime, "the two show apart");
    // A steady note isn't cut.
    const steady = synth([{ midi: 69, seconds: 2 }, { rest: 0.1 }]);
    assertNotes(guideMelodyNotes(steady, RATE), [[0, 2, 69]]);
  });

  test("a note with a quieter partial two octaves down is the note", () => {
    const samples = new Float32Array(Math.round(1.1 * RATE));
    for (let i = 0; i < RATE; i++) {
      const phase = (2 * Math.PI * 523.25 * i) / RATE;
      samples[i] = 0.3 * Math.sin(phase) + 0.18 * Math.sin(phase / 4);
    }
    assertNotes(guideMelodyNotes(samples, RATE), [[0, 1, 72]]);
  });

  test("a note fading out leaves no low stray notes", () => {
    // As Joysound's synth: each note has a quiet partial two octaves down,
    // which fades slower than the note, and is all that's left of it for a
    // moment. C5 for 0.4 s, then D5 after a rest.
    const note = (hz: number, t: number) => {
      const fade = (seconds: number) =>
        t < 0.4 ? 1 : Math.exp(-(t - 0.4) / seconds);
      return (
        0.3 * fade(0.025) * Math.sin(2 * Math.PI * hz * t) +
        0.08 * fade(0.06) * Math.sin((2 * Math.PI * hz * t) / 4)
      );
    };
    const samples = new Float32Array(Math.round(2 * RATE));
    for (let i = 0; i < samples.length; i++) {
      const t = i / RATE;
      samples[i] =
        t < 0.9 ? note(523.25, t) : t < 1.8 ? note(587.33, t - 0.9) : 0;
    }
    const notes = guideMelodyNotes(samples, RATE);
    assert.deepEqual(
      notes.map((n) => n.midiNumber),
      [72, 74],
      JSON.stringify(notes),
    );
  });
});
