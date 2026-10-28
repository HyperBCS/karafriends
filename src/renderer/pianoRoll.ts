// The pitch bars' maths (PianoRoll.tsx draws them): where the notes and the
// free time go, which note is being sung, the mics' colours, and each mic's
// trace. Pure, so the unit tests reach it.
//
// The roll's coordinates: x in seconds of the song (the vertex shader shows
// TIME_WIDTH_SECS of it at a time), y from 0 (bottom) to 1 (top).
import Spline from "cubic-spline";
import getNormals from "polyline-normals";

import type { Melody, MelodyNote } from "./melody";

export const TIME_WIDTH_SECS = 5.0;
// The points of a trace's spline between two pitches.
const PITCH_RESOLUTION = 8;
// The trace's thickness.
const STROKE_WIDTH = 0.03;
// A trace keeps its last this many pitches: 5 s of them, read every 25 ms.
export const TRACE_POINTS = 200;
// Each pitch's piece of the trace: PITCH_RESOLUTION - 1 quads, of two
// triangles, of three (x, y) vertices.
export const SEGMENT_FLOATS = (PITCH_RESOLUTION - 1) * 12;

/*
  (x0, y0) - (x1, y0)
     |     \    |
  (x0, y1) - (x1, y1)

  As two triangles, counter-clockwise, as GL wants them.
*/
export function quadToTriangles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  return [x0, y0, x0, y1, x1, y1, x0, y0, x1, y1, x1, y0];
}

// The strip between two edges, as triangles.
function edgesToTriangles(top: number[][], bottom: number[][]): number[] {
  const triangles: number[] = [];
  for (let i = 0; i < top.length - 1; i++) {
    const [x0, y0] = top[i];
    const [x1, y1] = bottom[i];
    const [x2, y2] = top[i + 1];
    const [x3, y3] = bottom[i + 1];
    triangles.push(x0, y0, x1, y1, x2, y2, x1, y1, x2, y2, x3, y3);
  }
  return triangles;
}

export function median(nums: readonly number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// The roll shows 18 rows, and a note can sit on a row or between two, so
// 36 places; the melody's median note is dead centre.
export function midiNumberToYCoord(
  midiNumber: number,
  medianMidiNumber: number,
): number {
  return 0.5 + (midiNumber - medianMidiNumber) / 36;
}

// Where nobody sings: the gaps between lyrics, where gaps of 10 s or less
// don't count, and everything after the last lyrics.
export function freeTimeIntervals(
  lyricsIntervals: readonly [number, number][],
): [number, number][] {
  const sung: [number, number][] = [];
  for (const [start, end] of lyricsIntervals) {
    const last = sung.at(-1);
    if (last && start - last[1] <= 10) last[1] = end;
    else sung.push([start, end]);
  }
  const free: [number, number][] = [];
  let prevEnd = 0;
  for (const [start, end] of sung) {
    free.push([prevEnd, start]);
    prevEnd = end;
  }
  free.push([prevEnd, 9999]);
  return free;
}

// What the roll draws for a melody, as GL vertices. Drawn in the song's own
// key: a key change moves the median with the notes, so the bars stay put,
// and only the mics' pitches move against them (PitchTrace.push).
export interface RollLayout {
  notes: readonly MelodyNote[];
  median: number;
  notePositions: Float32Array;
  freeTimePositions: Float32Array;
  pogIntervals: readonly [number, number][];
}

export function rollLayout(melody: Melody): RollLayout {
  const notes = melody.notes;
  const mid = median(notes.map((note) => note.midiNumber));
  return {
    notes,
    median: mid,
    // Each note two rows high, centred on it.
    notePositions: Float32Array.from(
      notes.flatMap((note) =>
        quadToTriangles(
          note.startTime,
          midiNumberToYCoord(note.midiNumber + 1, mid),
          note.endTime,
          midiNumberToYCoord(note.midiNumber - 1, mid),
        ),
      ),
    ),
    freeTimePositions: Float32Array.from(
      freeTimeIntervals(melody.lyricsIntervals).flatMap(([start, end]) =>
        quadToTriangles(start, 1.0, end, 0.0),
      ),
    ),
    pogIntervals: melody.pogIntervals,
  };
}

// The note being sung at `time`: the first, from `index` on, that hasn't
// ended, or the last note. Notes are in time order, so the search goes on
// from the last answer.
export function currentNote(
  notes: readonly MelodyNote[],
  index: number,
  time: number,
): number {
  while (index < notes.length - 1 && notes[index].endTime < time) index++;
  return index;
}

// HSV (hue in degrees, saturation and value in %) as RGB, each 0 to 255,
// rounded the way color-convert does it.
export function hsvToRgb(h: number, s: number, v: number): number[] {
  const sector = h / 60;
  const f = sector - Math.floor(sector);
  const sat = s / 100;
  const val = v / 100;
  const max = 255 * val;
  const p = 255 * val * (1 - sat);
  const q = 255 * val * (1 - sat * f);
  const t = 255 * val * (1 - sat * (1 - f));
  const rgb = [
    [max, t, p],
    [q, max, p],
    [p, max, t],
    [p, q, max],
    [t, p, max],
    [max, p, q],
  ][Math.floor(sector) % 6];
  return rgb.map(Math.round);
}

// Mic i of `count`'s trace colour, as GL's 0 to 1: pale, with hues spread
// evenly round the wheel.
export function micColor(i: number, count: number): [number, number, number] {
  const [r, g, b] = hsvToRgb((360 / count) * i, 30, 100);
  return [r / 255, g / 255, b / 255];
}

// One mic's pitch trace: its last TRACE_POINTS pitches, each drawn as one
// segment of SEGMENT_FLOATS in a fixed ring (`segments`), so a frame
// uploads only the segments that changed. Slots 0 to `filled` - 1 are
// drawn; their order doesn't matter.
export class PitchTrace {
  readonly segments = new Float32Array(TRACE_POINTS * SEGMENT_FLOATS);
  // Pitches since the last clear; the newest is in slot (count - 1) %
  // TRACE_POINTS.
  private count = 0;
  // The last three pitches (time, y), newest last, for the spline.
  private readonly times = [0, 0, 0];
  private readonly ys = [0, 0, 0];
  private readonly midis = [0, 0, 0];
  // Octaves added to the mic's pitch, so it lands nearest the note.
  private pitchOffset = 0;
  // Slots written since takeChanged; "all" once there are too many.
  private changed: number[] | "all" = [];

  get filled(): number {
    return Math.min(this.count, TRACE_POINTS);
  }

  // A pitch heard at `time` (seconds of the song) while `target` is the note
  // sung; both MIDI numbers, in the melody's key, whose median is `median`.
  // A pitch at the same time as the last (the video stalled), or earlier,
  // replaces the last.
  push(pitch: number, target: number, mid: number, time: number) {
    this.pitchOffset +=
      Math.round((target - (pitch + this.pitchOffset)) / 12) * 12;
    const midi = pitch + this.pitchOffset;
    const y = midiNumberToYCoord(midi, mid);

    if (this.count === 0 || time > this.times[2]) {
      for (let i = 0; i < 2; i++) {
        this.times[i] = this.times[i + 1];
        this.ys[i] = this.ys[i + 1];
        this.midis[i] = this.midis[i + 1];
      }
      this.count++;
    }
    this.times[2] = time;
    this.ys[2] = y;
    this.midis[2] = midi;

    const slot = (this.count - 1) % TRACE_POINTS;
    this.segments.set(this.segment(), slot * SEGMENT_FLOATS);
    if (this.changed !== "all" && this.changed.at(-1) !== slot) {
      this.changed.push(slot);
      if (this.changed.length > TRACE_POINTS) this.changed = "all";
    }
  }

  // The newest pitch's segment: a spline through the last three pitches
  // when they're close in time and pitch, otherwise a dash at the newest.
  private segment(): number[] {
    const [t0, t1, t2] = this.times;
    const [m0, m1, m2] = this.midis;
    const timeGap = t2 - t0;
    const pitchGap = Math.max(
      Math.abs(m2 - m1),
      Math.abs(m1 - m0),
      Math.abs(m2 - m0),
    );
    // A spline needs the three in time order (a pitch that replaced the
    // last can be earlier than the one before).
    if (
      this.count < 3 ||
      !(t0 < t1 && t1 < t2) ||
      timeGap > 0.06 ||
      pitchGap > 7
    ) {
      const dash = quadToTriangles(
        t2 - 0.025,
        this.ys[2] - STROKE_WIDTH / 2,
        t2,
        this.ys[2] + STROKE_WIDTH / 2,
      );
      return Array<number[]>(PITCH_RESOLUTION - 1)
        .fill(dash)
        .flat();
    }

    const spline = new Spline(this.times, this.ys);
    const path: number[][] = [];
    for (let i = 0; i < PITCH_RESOLUTION; i++) {
      const x = t0 + i * (timeGap / PITCH_RESOLUTION);
      path.push([x, spline.at(x)]);
    }
    const normals = getNormals(path, false) as [number[], number][];
    const top: number[][] = [];
    const bottom: number[][] = [];
    path.forEach(([x, y], i) => {
      const [[nx, ny], miter] = normals[i];
      const half = (miter * STROKE_WIDTH) / 2;
      top.push([x + nx * half, y + ny * half]);
      bottom.push([x - nx * half, y - ny * half]);
    });
    return edgesToTriangles(top, bottom);
  }

  // The slots written since the last call (or "all"), for the GL buffer.
  takeChanged(): readonly number[] | "all" {
    const changed = this.changed;
    this.changed = [];
    return changed;
  }

  // After a seek, or for a new song: nothing drawn.
  clear() {
    this.count = 0;
    this.changed = [];
  }
}
