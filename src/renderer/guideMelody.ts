import type { MelodyNote } from "./melody";

// Reads a Joysound song's melody from its guide channel: the ogg's third
// channel (centre) is a synthesised melody line, one note at a time, silent
// where nobody sings (notes/M8-guide-vocal-spike.md). A pitch every 10 ms
// (YIN), then runs of one MIDI note. Pure, so the worker and the unit tests
// share it.
//
// Checked against DAM's notes for 千本桜, Lemon and 夜に駆ける: the guide
// plays DAM's melody an octave up, and these notes match it over 93 to 98%
// of the sung time.

// The pitches looked for, as MIDI numbers: C2 to C7.
const LOWEST_MIDI = 36;
const HIGHEST_MIDI = 96;
// One pitch every 10 ms, each over 30 ms of sound (two periods of the
// lowest note).
const HOP_SECONDS = 0.01;
const WINDOW_SECONDS = 0.03;
// YIN's threshold: a frame is pitched where the normalised difference first
// dips under it. The guide's notes dip to about 0.1, and their fading tails
// higher.
const YIN_THRESHOLD = 0.3;
// A shorter lag that divides the first dip's is the period if it dips
// under this.
const SUBHARMONIC_THRESHOLD = 0.45;
// Quieter frames are silence: -50 dBFS.
const SILENCE_RMS = 10 ** (-50 / 20);
// Shorter runs of one note are blips (a frame across two notes), dropped.
const MIN_NOTE_SECONDS = 0.08;
// Two runs of one note this close, with only blips between them, are one
// note.
const MAX_BLIP_GAP_SECONDS = 0.05;
// A note played again: its level climbs this many dB in this many frames.
const ATTACK_DB = 3;
const ATTACK_FRAMES = 3;
// A note this short, over an octave from the notes on both sides of it (as
// near as this), is the tail of a note fading out: dropped.
const MAX_LEAP_SEMITONES = 12;
const MAX_LEAP_NOTE_SECONDS = 0.2;
const NEIGHBOUR_SECONDS = 0.3;

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// Each 10 ms frame's pitch, as a MIDI number with cents (NaN where it's
// silent or not one clear pitch), and its level in dBFS. Frame i is the
// sound from i * 10 ms for 30 ms.
export interface PitchTrack {
  midi: Float32Array;
  level: Float32Array;
}

export function pitchTrack(
  samples: Float32Array,
  sampleRate: number,
): PitchTrack {
  const hop = Math.round(HOP_SECONDS * sampleRate);
  const span = Math.round(WINDOW_SECONDS * sampleRate);
  const minLag = Math.max(2, Math.floor(sampleRate / midiToHz(HIGHEST_MIDI)));
  const maxLag = Math.ceil(sampleRate / midiToHz(LOWEST_MIDI));
  // Each frame reads span + maxLag + 1 samples.
  const frames = Math.max(
    0,
    Math.floor((samples.length - span - maxLag - 1) / hop) + 1,
  );
  const midi = new Float32Array(frames).fill(NaN);
  const level = new Float32Array(frames);
  // YIN's cumulative mean normalised difference, by lag.
  const cmnd = new Float32Array(maxLag + 2);

  for (let frame = 0; frame < frames; frame++) {
    const start = frame * hop;
    let energy = 0;
    for (let i = start; i < start + span; i++) {
      energy += samples[i] * samples[i];
    }
    level[frame] = 10 * Math.log10(energy / span + 1e-12);
    if (energy / span < SILENCE_RMS * SILENCE_RMS) continue;

    // Only as far as the bottom of the first dip under the threshold.
    let sum = 0;
    let lag = 0;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      let difference = 0;
      for (let i = start; i < start + span; i++) {
        const delta = samples[i] - samples[i + tau];
        difference += delta * delta;
      }
      sum += difference;
      cmnd[tau] = sum > 0 ? (difference * tau) / sum : 1;
      if (lag > 0) {
        if (cmnd[tau] >= cmnd[lag]) break;
        lag = tau;
      } else if (tau >= minLag && tau <= maxLag && cmnd[tau] < YIN_THRESHOLD) {
        lag = tau;
      }
    }
    if (lag === 0 || lag > maxLag) continue;
    // A note fading out, or two notes in one frame, can dip lower at a
    // multiple of the period than at the period: the shortest lag that
    // divides the dip's, with a dip of its own, is the period.
    for (let shorter = minLag; shorter < lag; shorter++) {
      if (
        cmnd[shorter] < SUBHARMONIC_THRESHOLD &&
        cmnd[shorter] <= cmnd[shorter - 1] &&
        cmnd[shorter] <= cmnd[shorter + 1] &&
        isMultiple(lag, shorter)
      ) {
        lag = shorter;
        break;
      }
    }

    // Between samples: the parabola through the bottom and its neighbours.
    const before = cmnd[lag - 1];
    const at = cmnd[lag];
    const after = cmnd[lag + 1];
    const curve = before - 2 * at + after;
    const shift = curve > 0 ? (before - after) / (2 * curve) : 0;
    midi[frame] = hzToMidi(sampleRate / (lag + shift));
  }
  return { midi, level };
}

// Whether lag is about a whole number (2 or more) of shorter.
function isMultiple(lag: number, shorter: number): boolean {
  const ratio = lag / shorter;
  return Math.round(ratio) >= 2 && Math.abs(ratio - Math.round(ratio)) < 0.1;
}

// A run of frames on one MIDI number, first to last.
interface Run {
  first: number;
  last: number;
  midi: number;
}

// The notes in a pitch track: runs of frames on one MIDI number, with
// blips and stray leaps dropped, silence as gaps, and a note played again
// (its level jumps) split. Times in seconds.
export function trackNotes(
  track: PitchTrack,
  sampleRate: number,
): MelodyNote[] {
  const hop = Math.round(HOP_SECONDS * sampleRate) / sampleRate;
  const span = Math.round(WINDOW_SECONDS * sampleRate) / sampleRate;

  const runs: Run[] = [];
  for (let frame = 0; frame < track.midi.length; frame++) {
    if (Number.isNaN(track.midi[frame])) continue;
    const midi = Math.round(track.midi[frame]);
    const run = runs.at(-1);
    if (run && run.midi === midi && run.last === frame - 1) run.last = frame;
    else runs.push({ first: frame, last: frame, midi });
  }

  const minFrames = Math.round(MIN_NOTE_SECONDS / hop);
  const maxGap = Math.round(MAX_BLIP_GAP_SECONDS / hop);
  const joined: Run[] = [];
  for (const run of runs) {
    if (run.last - run.first + 1 < minFrames) continue;
    const before = joined.at(-1);
    if (
      before &&
      before.midi === run.midi &&
      run.first - before.last - 1 <= maxGap &&
      allPitched(track.midi, before.last + 1, run.first)
    ) {
      before.last = run.last;
    } else {
      joined.push({ ...run });
    }
  }
  const notes = joined.flatMap((note) =>
    splitAtAttacks(note, track.level, minFrames),
  );

  const maxLeapFrames = Math.round(MAX_LEAP_NOTE_SECONDS / hop);
  const neighbourFrames = Math.round(NEIGHBOUR_SECONDS / hop);
  const isStrayLeap = (note: Run, i: number) => {
    if (note.last - note.first + 1 > maxLeapFrames) return false;
    const neighbours = [notes[i - 1], notes[i + 1]].filter(
      (other) =>
        other &&
        Math.max(other.first - note.last, note.first - other.last) <=
          neighbourFrames,
    );
    return (
      neighbours.length > 0 &&
      neighbours.every(
        (other) => Math.abs(other.midi - note.midi) > MAX_LEAP_SEMITONES,
      )
    );
  };

  // A frame's sound is centred half its span in: a note runs from half
  // a hop before its first frame's centre to half a hop after its last's.
  return notes
    .filter((note, i) => !isStrayLeap(note, i))
    .map(({ first, last, midi }) => ({
      startTime: first * hop + (span - hop) / 2,
      endTime: last * hop + (span + hop) / 2,
      midiNumber: midi,
    }));
}

// Whether the frames from first up to (not including) end all have a
// pitch.
function allPitched(midi: Float32Array, first: number, end: number) {
  for (let frame = first; frame < end; frame++) {
    if (Number.isNaN(midi[frame])) return false;
  }
  return true;
}

// A note cut where it's played again: its level climbs ATTACK_DB in
// ATTACK_FRAMES from a dip. The dip's frame goes, so the two show apart.
// Parts shorter than minFrames aren't cut off.
function splitAtAttacks(
  note: Run,
  level: Float32Array,
  minFrames: number,
): Run[] {
  const parts: Run[] = [];
  let first = note.first;
  let rising = false;
  for (let frame = first + ATTACK_FRAMES; frame <= note.last; frame++) {
    let dip = frame - ATTACK_FRAMES;
    for (let i = dip + 1; i < frame; i++) {
      if (level[i] < level[dip]) dip = i;
    }
    const attack = level[frame] - level[dip] >= ATTACK_DB;
    if (
      attack &&
      !rising &&
      dip - first >= minFrames &&
      note.last - dip >= minFrames
    ) {
      parts.push({ first, last: dip - 1, midi: note.midi });
      first = dip + 1;
    }
    rising = attack;
  }
  parts.push({ first, last: note.last, midi: note.midi });
  return parts;
}

// The guide melody's notes, from its samples (mono).
export function guideMelodyNotes(
  samples: Float32Array,
  sampleRate: number,
): MelodyNote[] {
  return trackNotes(pitchTrack(samples, sampleRate), sampleRate);
}
