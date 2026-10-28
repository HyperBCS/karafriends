// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  currentNote,
  freeTimeIntervals,
  hsvToRgb,
  median,
  micColor,
  midiNumberToYCoord,
  PitchTrace,
  rollLayout,
  SEGMENT_FLOATS,
  TRACE_POINTS,
} from "./pianoRoll";

const note = (startTime: number, endTime: number, midiNumber: number) => ({
  startTime,
  endTime,
  midiNumber,
});

// A segment's vertices' y coordinates.
function ys(trace: PitchTrace, slot: number): number[] {
  const segment = trace.segments.subarray(
    slot * SEGMENT_FLOATS,
    (slot + 1) * SEGMENT_FLOATS,
  );
  return Array.from(segment.filter((_, i) => i % 2 === 1));
}

describe("the pitch bars' layout", () => {
  test("the median compares MIDI numbers as numbers", () => {
    // Sorted as strings, 100 and 101 came first.
    assert.equal(median([100, 60, 72]), 72);
    assert.equal(median([100, 60, 72, 99, 101]), 99);
    assert.equal(median([101, 60, 100, 62]), 81);
    assert.equal(median([64]), 64);
  });

  test("a note is two rows high round its own; the median note is dead centre", () => {
    const layout = rollLayout({
      notes: [note(1, 2, 60), note(2, 3, 64), note(3, 4, 72)],
      lyricsIntervals: [[1, 4]],
      pogIntervals: [[3, 4]],
    });
    assert.equal(layout.median, 64);
    // Two triangles of three (x, y) vertices a note.
    assert.equal(layout.notePositions.length, 3 * 12);
    const middle = Array.from(layout.notePositions.subarray(12, 24));
    const [top, bottom] = [0.5 + 1 / 36, 0.5 - 1 / 36].map(Math.fround);
    assert.deepEqual(
      middle,
      [2, top, 2, bottom, 3, bottom, 2, top, 3, bottom, 3, top].map(
        Math.fround,
      ),
    );
    assert.equal(midiNumberToYCoord(64 + 18, 64), 1);
    assert.deepEqual(layout.pogIntervals, [[3, 4]]);
    // Free time before and after the lyrics: two quads.
    assert.equal(layout.freeTimePositions.length, 2 * 12);
  });

  test("free time is the gaps between lyrics over 10 s, and after the last", () => {
    assert.deepEqual(
      freeTimeIntervals([
        [1, 2],
        [5, 6],
        [16, 17],
        [27.5, 30],
      ]),
      [
        [0, 1],
        [17, 27.5],
        [30, 9999],
      ],
    );
    // No lyrics: all of it.
    assert.deepEqual(freeTimeIntervals([]), [[0, 9999]]);
  });

  test("the current note goes on to the last one, and stays there", () => {
    const notes = [note(0, 1, 64), note(1, 2, 66), note(2, 3, 76)];
    assert.equal(currentNote(notes, 0, 0.5), 0);
    assert.equal(currentNote(notes, 0, 1.5), 1);
    // The last note is sung: it's the current one.
    assert.equal(currentNote(notes, 1, 2.5), 2);
    assert.equal(currentNote(notes, 0, 2.5), 2);
    assert.equal(currentNote(notes, 2, 60), 2);
    assert.equal(currentNote([note(0, 1, 60)], 0, 5), 0);
  });

  test("the mics' colours are color-convert's HSV, exactly", () => {
    // From color-convert 3.1.3's hsv.rgb, which this replaces.
    const reference: [number, number[][]][] = [
      [1, [[255, 179, 179]]],
      [
        2,
        [
          [255, 179, 179],
          [179, 255, 255],
        ],
      ],
      [
        3,
        [
          [255, 179, 179],
          [179, 255, 179],
          [179, 179, 255],
        ],
      ],
      [
        4,
        [
          [255, 179, 179],
          [217, 255, 179],
          [179, 255, 255],
          [217, 179, 255],
        ],
      ],
      [
        7,
        [
          [255, 179, 179],
          [255, 244, 179],
          [200, 255, 179],
          [179, 255, 222],
          [179, 222, 255],
          [200, 179, 255],
          [255, 179, 244],
        ],
      ],
    ];
    for (const [count, colours] of reference) {
      for (let i = 0; i < count; i++) {
        assert.deepEqual(
          micColor(i, count),
          colours[i].map((c) => c / 255),
          `mic ${i} of ${count}`,
        );
      }
    }
    assert.deepEqual(hsvToRgb(119, 30, 100), [180, 255, 179]);
    assert.deepEqual(hsvToRgb(13.7, 55, 40), [102, 59, 46]);
    assert.deepEqual(hsvToRgb(360, 30, 100), [255, 179, 179]);
  });
});

describe("a mic's pitch trace", () => {
  test("a pitch alone is a dash at its height", () => {
    const trace = new PitchTrace();
    trace.push(64, 64, 64, 1);
    assert.equal(trace.filled, 1);
    // At the median: centred on 0.5, the stroke's width high. (It used to
    // be drawn at y = 64, off the roll.)
    const heights = ys(trace, 0);
    assert.equal(heights.length, SEGMENT_FLOATS / 2);
    for (const y of heights)
      assert.ok(Math.abs(y - 0.5) <= 0.015 + 1e-6, `${y}`);
  });

  test("a pitch an octave off the note is folded onto it", () => {
    const trace = new PitchTrace();
    // The note is E5 (76); the singer's E4 is read as E5.
    trace.push(64, 76, 64, 1);
    const target = midiNumberToYCoord(76, 64);
    for (const y of ys(trace, 0)) assert.ok(Math.abs(y - target) < 0.02);
  });

  test("close pitches are a smooth line through them", () => {
    const trace = new PitchTrace();
    trace.push(64, 64, 64, 1);
    trace.push(64.5, 64, 64, 1.025);
    trace.push(65, 64, 64, 1.05);
    assert.equal(trace.filled, 3);
    const segment = Array.from(
      trace.segments.subarray(2 * SEGMENT_FLOATS, 3 * SEGMENT_FLOATS),
    );
    assert.ok(segment.every(Number.isFinite));
    const xs = segment.filter((_, i) => i % 2 === 0);
    assert.ok(Math.min(...xs) >= 1 - 0.01 && Math.max(...xs) <= 1.05 + 0.01);
    // Rising from 64 towards 65.
    const heights = ys(trace, 2);
    assert.ok(Math.min(...heights) >= midiNumberToYCoord(64, 64) - 0.03);
    assert.ok(Math.max(...heights) <= midiNumberToYCoord(65, 64) + 0.03);
  });

  test("one segment a pitch, in a ring of TRACE_POINTS", () => {
    const trace = new PitchTrace();
    for (let i = 0; i < TRACE_POINTS; i++) trace.push(60, 60, 60, i * 0.025);
    assert.equal(trace.filled, TRACE_POINTS);
    assert.equal(trace.segments.length, TRACE_POINTS * SEGMENT_FLOATS);
    const changed = trace.takeChanged();
    assert.deepEqual(
      changed,
      Array.from({ length: TRACE_POINTS }, (_, i) => i),
    );
    // The next goes over the oldest.
    trace.push(60, 60, 60, TRACE_POINTS * 0.025);
    assert.equal(trace.filled, TRACE_POINTS);
    assert.deepEqual(trace.takeChanged(), [0]);
    // Its line starts at the pitch two before it.
    assert.ok(trace.segments[0] > (TRACE_POINTS - 3) * 0.025);
  });

  test("while the video stalls, the last pitch is replaced, not added", () => {
    const trace = new PitchTrace();
    trace.push(60, 60, 60, 1);
    trace.push(60, 60, 60, 1.025);
    trace.takeChanged();
    // 20 s of pitches at a frozen time (an HLS stall), and some earlier.
    for (let i = 0; i < 800; i++) trace.push(60 + (i % 3), 60, 60, 1.025);
    trace.push(62, 60, 60, 1.01);
    assert.equal(trace.filled, 2);
    assert.deepEqual(trace.takeChanged(), [1]);
    assert.ok(trace.segments.every(Number.isFinite));
    // Time moves on: a new slot.
    trace.push(60, 60, 60, 1.05);
    assert.equal(trace.filled, 3);
    assert.deepEqual(trace.takeChanged(), [2]);
  });

  test("unread changes are bounded: past a ring's worth, all of it", () => {
    const trace = new PitchTrace();
    // No frame drew for a while (a hidden window): 30 s of pitches.
    for (let i = 0; i < 1200; i++) trace.push(60, 60, 60, i * 0.025);
    assert.equal(trace.takeChanged(), "all");
    assert.deepEqual(trace.takeChanged(), []);
  });

  test("a seek clears it", () => {
    const trace = new PitchTrace();
    for (let i = 0; i < 10; i++) trace.push(60, 60, 60, i * 0.025);
    trace.clear();
    assert.equal(trace.filled, 0);
    assert.deepEqual(trace.takeChanged(), []);
    trace.push(60, 60, 60, 0.5);
    assert.equal(trace.filled, 1);
    assert.deepEqual(trace.takeChanged(), [0]);
  });
});
