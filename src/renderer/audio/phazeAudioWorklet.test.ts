// Runs on Node's test runner through tsx (yarn test:unit).
//
// The key change's worklet, run for real: the module is loaded under Node
// with the two AudioWorklet globals it uses faked, and fed 128-frame quanta
// the way Chromium's audio thread feeds it. Tones go in; what comes out is
// measured with a Hann-weighted DFT.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { before, describe, test } from "node:test";

import FFT from "fft.js";

const SAMPLE_RATE = 48000;
const QUANTUM = 128;
// The vocoder's window, less one quantum: how late its output is.
const LATENCY = 2048 - QUANTUM;

interface Processor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcessorClass = new (options: object) => Processor;

let PhaseVocoder: ProcessorClass;

before(async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.AudioWorkletProcessor = class {};
  scope.sampleRate = SAMPLE_RATE;
  scope.registerProcessor = (name: string, processor: ProcessorClass) => {
    assert.equal(name, "phase-vocoder");
    PhaseVocoder = processor;
  };
  await import("./phazeAudioWorklet");
});

// The options webAudio.ts creates the node with.
function newVocoder(): Processor {
  return new PhaseVocoder({
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });
}

const semitonesFactor = (semitones: number) => Math.pow(2, semitones / 12);

// Feeds a stereo signal through, a quantum at a time, at a key that may
// change: key(i) is the factor for quantum i.
function run(
  vocoder: Processor,
  left: Float32Array,
  right: Float32Array,
  factor: number | ((quantum: number) => number),
): [Float32Array, Float32Array] {
  const outLeft = new Float32Array(left.length);
  const outRight = new Float32Array(right.length);
  const blockLeft = new Float32Array(QUANTUM);
  const blockRight = new Float32Array(QUANTUM);
  const pitchFactor = new Float32Array(1);
  for (let start = 0, i = 0; start + QUANTUM <= left.length; i++) {
    pitchFactor[0] = typeof factor === "number" ? factor : factor(i);
    blockLeft.fill(0);
    blockRight.fill(0);
    vocoder.process(
      [
        [
          left.subarray(start, start + QUANTUM),
          right.subarray(start, start + QUANTUM),
        ],
      ],
      [[blockLeft, blockRight]],
      { pitchFactor },
    );
    outLeft.set(blockLeft, start);
    outRight.set(blockRight, start);
    start += QUANTUM;
  }
  return [outLeft, outRight];
}

// Samples in that many seconds, in whole quanta.
const samples = (seconds: number) =>
  Math.ceil((seconds * SAMPLE_RATE) / QUANTUM) * QUANTUM;

function sine(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const x = new Float32Array(samples(seconds));
  for (let n = 0; n < x.length; n++) {
    x[n] = amplitude * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);
  }
  return x;
}

// A small deterministic noise source (an LCG), uniform in [-1, 1).
function noise(length: number, amplitude: number, seed = 1): Float32Array {
  const x = new Float32Array(length);
  let state = seed >>> 0;
  for (let n = 0; n < length; n++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    x[n] = amplitude * (state / 2 ** 31 - 1);
  }
  return x;
}

function mix(...signals: Float32Array[]): Float32Array {
  const x = new Float32Array(signals[0].length);
  for (const signal of signals) {
    for (let n = 0; n < x.length; n++) x[n] += signal[n];
  }
  return x;
}

// A sawtooth with its harmonics up to `topHz`.
function sawtooth(
  hz: number,
  topHz: number,
  seconds: number,
  amplitude: number,
) {
  const harmonics: Float32Array[] = [];
  for (let k = 1; k * hz <= topHz; k++) {
    harmonics.push(sine(k * hz, seconds, amplitude / k));
  }
  return mix(...harmonics);
}

function hann(n: number, length: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / length));
}

// The strongest frequency in x[start, start + length), between lowHz and
// highHz: a zero-padded FFT finds the peak bin, then a golden-section search
// on the Hann-weighted DTFT finds the peak between bins.
function peakHz(
  x: Float32Array,
  start: number,
  length: number,
  lowHz = 20,
  highHz = SAMPLE_RATE / 2,
): number {
  const segment = new Float64Array(length);
  for (let n = 0; n < length; n++) segment[n] = x[start + n] * hann(n, length);

  const size = 1 << Math.ceil(Math.log2(length * 2));
  const fft = new FFT(size);
  const padded = new Float64Array(size);
  padded.set(segment);
  const spectrum = fft.createComplexArray();
  fft.realTransform(spectrum, padded);
  let best = 0;
  let bestPower = -1;
  const lowest = Math.ceil((lowHz * size) / SAMPLE_RATE);
  const highest = Math.min(size / 2, Math.floor((highHz * size) / SAMPLE_RATE));
  for (let k = lowest; k < highest; k++) {
    const power = spectrum[2 * k] ** 2 + spectrum[2 * k + 1] ** 2;
    if (power > bestPower) {
      bestPower = power;
      best = k;
    }
  }

  // |DTFT| at hz, by a rotating phasor (resynced every 1024 samples).
  const magnitude = (hz: number) => {
    const step = (2 * Math.PI * hz) / SAMPLE_RATE;
    const stepRe = Math.cos(step);
    const stepIm = -Math.sin(step);
    let re = 0;
    let im = 0;
    let pRe = 1;
    let pIm = 0;
    for (let n = 0; n < length; n++) {
      if (n % 1024 === 0) {
        pRe = Math.cos(step * n);
        pIm = -Math.sin(step * n);
      }
      re += segment[n] * pRe;
      im += segment[n] * pIm;
      const next = pRe * stepRe - pIm * stepIm;
      pIm = pRe * stepIm + pIm * stepRe;
      pRe = next;
    }
    return Math.hypot(re, im);
  };
  const binHz = SAMPLE_RATE / size;
  let a = (best - 1) * binHz;
  let b = (best + 1) * binHz;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = magnitude(c);
  let fd = magnitude(d);
  while (b - a > 1e-4) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = magnitude(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = magnitude(d);
    }
  }
  return (a + b) / 2;
}

// Mean power in [lowHz, highHz), from Hann-windowed 4096-sample frames.
function bandPower(
  x: Float32Array,
  start: number,
  lowHz: number,
  highHz: number,
) {
  const size = 4096;
  const fft = new FFT(size);
  const frame = new Float64Array(size);
  const spectrum = fft.createComplexArray();
  const low = Math.ceil((lowHz * size) / SAMPLE_RATE);
  const high = Math.min(size / 2, Math.ceil((highHz * size) / SAMPLE_RATE));
  let total = 0;
  let frames = 0;
  for (let at = start; at + size <= x.length; at += size / 2, frames++) {
    for (let n = 0; n < size; n++) frame[n] = x[at + n] * hann(n, size);
    fft.realTransform(spectrum, frame);
    for (let k = low; k < high; k++) {
      total += spectrum[2 * k] ** 2 + spectrum[2 * k + 1] ** 2;
    }
  }
  return total / frames;
}

const dB = (power: number) => 10 * Math.log10(power);

function rms(x: Float32Array, start = 0, end = x.length): number {
  let sum = 0;
  for (let n = start; n < end; n++) sum += x[n] * x[n];
  return Math.sqrt(sum / (end - start));
}

// How alike left and right are from `start` on: 1 the same, 0 unrelated.
function correlation(left: Float32Array, right: Float32Array, start = 0) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let n = start; n < left.length; n++) {
    lr += left[n] * right[n];
    ll += left[n] * left[n];
    rr += right[n] * right[n];
  }
  return lr / Math.sqrt(ll * rr);
}

// Skipped before measuring: the window filling, and a little more.
const SETTLE = 12000;

describe("the key change's vocoder", () => {
  // Bass to soprano, through the shifts guests use.
  const TONES = [82, 110, 165, 220, 440, 880, 1760];
  const SHIFTS = [-5, -2, -1, 1, 2, 5];

  for (const shift of SHIFTS) {
    test(`moves tones by ${shift > 0 ? "+" : ""}${shift} semitones`, (t) => {
      const errors: string[] = [];
      const measured: string[] = [];
      for (const hz of TONES) {
        const tone = sine(hz, 1);
        const [left, right] = run(
          newVocoder(),
          tone,
          tone,
          semitonesFactor(shift),
        );
        const moved = 12 * Math.log2(peakHz(left, SETTLE, 32768) / hz);
        const movedRight = 12 * Math.log2(peakHz(right, SETTLE, 32768) / hz);
        measured.push(`${hz} Hz → ${moved.toFixed(3)}`);
        // Within a tenth of a semitone (10 cents), on both sides.
        for (const value of [moved, movedRight]) {
          if (Math.abs(value - shift) > 0.1) {
            errors.push(`${hz} Hz moved ${value.toFixed(3)} semitones`);
          }
        }
      }
      t.diagnostic(measured.join(", "));
      assert.deepEqual(errors, []);
    });
  }

  test("a bass under a chord stays in tune with it", (t) => {
    // A2 with its harmonics, under an A major triad (A3, C#4, E4): the
    // review's case, where the old shifter left the bass behind.
    const notes = [110, 220 * 2 ** (4 / 12), 220 * 2 ** (7 / 12)];
    const bass: Float32Array[] = [];
    for (let k = 1; k <= 8; k++) bass.push(sine(110 * k, 1, 0.15 / k));
    const song = mix(...bass, ...notes.slice(1).map((hz) => sine(hz, 1, 0.08)));
    // Each note, looked for within a third of a semitone of where it should
    // be: the first two partials of the bass, and the third and fifth. The
    // third sits 2.25 bins from the fifth (and the bass's third partial), too
    // close for a 2048-sample window to keep apart entirely: it lands a few
    // cents off, so these get the tones' tenth of a semitone too.
    const partials = [110, 220, notes[1], notes[2]];
    for (const shift of [-2, -1, 1, 2]) {
      const [left] = run(newVocoder(), song, song, semitonesFactor(shift));
      const moved = partials.map((hz) => {
        const target = hz * semitonesFactor(shift);
        const found = peakHz(left, SETTLE, 32768, target / 1.02, target * 1.02);
        return 12 * Math.log2(found / hz);
      });
      t.diagnostic(`${shift}: ${moved.map((m) => m.toFixed(3)).join(", ")}`);
      for (const value of moved) {
        assert.ok(Math.abs(value - shift) < 0.1, `${shift}: ${value}`);
      }
    }
  });

  test("adds nothing above the song's top when the key goes down", (t) => {
    // A 220 Hz sawtooth to 8 kHz over a noise floor 60 dB down: what's
    // above 8 kHz in the input is the floor alone.
    const song = mix(sawtooth(220, 8000, 1.5, 0.3), noise(samples(1.5), 0.001));
    const reference = bandPower(song, SETTLE, 0, 8000);
    const bands: [number, number][] = [
      [12000, 16000],
      [16000, 18000],
      [18000, 20000],
      [20000, 24000],
    ];
    const errors: string[] = [];
    for (const shift of [-2, -5]) {
      const [left] = run(newVocoder(), song, song, semitonesFactor(shift));
      const report: string[] = [];
      for (const [low, high] of bands) {
        const input = dB(bandPower(song, SETTLE, low, high) / reference);
        const output = dB(bandPower(left, SETTLE, low, high) / reference);
        report.push(
          `${low / 1000}-${high / 1000} kHz ${output.toFixed(1)} dB (in ${input.toFixed(1)})`,
        );
        if (output > input + 3) {
          errors.push(
            `${shift}: ${low}-${high} Hz at ${output.toFixed(1)} dB, input ${input.toFixed(1)}`,
          );
        }
      }
      t.diagnostic(`${shift}: ${report.join(", ")}`);
    }
    assert.deepEqual(errors, []);
  });

  test("keeps the song's level at key 0 and at ±1", (t) => {
    // A bass, a triad above it and a little noise.
    const song = mix(
      sine(110, 1.5, 0.2),
      sine(220, 1.5, 0.1),
      sine(277.2, 1.5, 0.1),
      sine(329.6, 1.5, 0.1),
      sawtooth(440, 6000, 1.5, 0.05),
      noise(samples(1.5), 0.02),
    );
    const level = rms(song, SETTLE);
    const errors: string[] = [];
    const report: string[] = [];
    for (const shift of [0, -1, 1, -2, 2, -5, 5]) {
      const [left] = run(newVocoder(), song, song, semitonesFactor(shift));
      const change = 20 * Math.log10(rms(left, SETTLE) / level);
      report.push(`${shift}: ${change.toFixed(2)} dB`);
      if (Math.abs(shift) <= 1 && Math.abs(change) > 1) {
        errors.push(`${shift}: ${change.toFixed(2)} dB`);
      }
    }
    t.diagnostic(report.join(", "));
    assert.deepEqual(errors, []);
  });

  test("at key 0 it is the song, late by its window", () => {
    const song = mix(sawtooth(196, 8000, 0.5, 0.3), noise(samples(0.5), 0.01));
    const [left, right] = run(newVocoder(), song, song, 1);
    let worst = 0;
    for (let n = 2 * LATENCY; n < song.length; n++) {
      worst = Math.max(worst, Math.abs(left[n] - song[n - LATENCY]));
      worst = Math.max(worst, Math.abs(right[n] - song[n - LATENCY]));
    }
    assert.ok(worst < 1e-4, `off by ${worst}`);
  });

  test("keeps left and right apart", () => {
    const [, right] = run(
      newVocoder(),
      sine(440, 1),
      new Float32Array(samples(1)),
      semitonesFactor(2),
    );
    assert.ok(rms(right, SETTLE) < 1e-5, `right at ${rms(right, SETTLE)}`);
  });

  test("keeps a centred voice centred", (t) => {
    // A melody in the middle (a singer, Joysound's guide melody) over a
    // backing that differs between the sides, as reverb does. If the two
    // sides of the melody drift out of phase with each other, it sounds
    // smeared on headphones, as if underwater. Shifting each channel on its
    // own took this from 0.90 to between -0.6 and 0.5.
    const length = samples(1.5);
    const voice = sawtooth(330, 6000, 1.5, 0.2);
    const left = mix(voice, noise(length, 0.1, 1));
    const right = mix(voice, noise(length, 0.1, 2));
    const before = correlation(left, right, SETTLE);
    const report: string[] = [];
    const errors: string[] = [];
    for (const shift of [-2, -1, 1, 2]) {
      const [outLeft, outRight] = run(
        newVocoder(),
        left,
        right,
        semitonesFactor(shift),
      );
      const after = correlation(outLeft, outRight, SETTLE);
      report.push(`${shift}: ${after.toFixed(3)}`);
      if (after < before - 0.05) errors.push(`${shift}: ${after.toFixed(3)}`);
    }
    t.diagnostic(`in ${before.toFixed(3)}, out ${report.join(", ")}`);
    assert.deepEqual(errors, []);
  });

  test("moving the key off 0 doesn't drop the song", () => {
    // A steady tone at key 0, then +1 from half a second in.
    const tone = sine(330, 1.5, 0.5);
    const switchAt = Math.round(SAMPLE_RATE / 2 / QUANTUM);
    const [left] = run(newVocoder(), tone, tone, (i) =>
      i < switchAt ? 1 : semitonesFactor(1),
    );
    const steady = rms(tone);
    for (let i = switchAt; i < left.length / QUANTUM; i++) {
      const level = rms(left, i * QUANTUM, (i + 1) * QUANTUM);
      assert.ok(
        level > steady / 2,
        `quantum ${i - switchAt} after the switch at ${level}`,
      );
    }
  });

  test("a quantum with nothing connected is a moment's silence, not a reset", () => {
    // Chromium gives an input with no channels when nothing upstream plays.
    const vocoder = newVocoder();
    const tone = sine(330, 1, 0.5);
    run(vocoder, tone, tone, semitonesFactor(2));
    const pitchFactor = new Float32Array([semitonesFactor(2)]);
    vocoder.process(
      [[]],
      [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]],
      {
        pitchFactor,
      },
    );
    const [left] = run(
      vocoder,
      tone.subarray(0, 12800),
      tone.subarray(0, 12800),
      semitonesFactor(2),
    );
    const steady = rms(tone);
    for (let i = 0; i < 20; i++) {
      const level = rms(left, i * QUANTUM, (i + 1) * QUANTUM);
      assert.ok(level > steady / 2, `quantum ${i} after it at ${level}`);
    }
  });

  test("stays well inside the audio thread's budget after a long party", (t) => {
    // 128 frames at 48 kHz: what one quantum may take, at most.
    const budgetMs = (QUANTUM / SAMPLE_RATE) * 1000;
    const song = mix(
      sawtooth(110, 12000, 1, 0.2),
      sawtooth(330, 12000, 1, 0.1),
      noise(samples(1), 0.02),
    );
    const quanta = song.length / QUANTUM;
    const vocoder = newVocoder();
    const timed = (seconds: number, factor: number) => {
      const started = performance.now();
      for (let s = 0; s < seconds; s++) run(vocoder, song, song, factor);
      return (performance.now() - started) / (seconds * quanta);
    };
    const freshShifted = timed(10, semitonesFactor(2));
    // Twenty minutes at key 0 (the vocoder is fed all along), then a minute
    // at each.
    for (let s = 0; s < 20 * 60; s++) run(vocoder, song, song, 1);
    const atZero = timed(60, 1);
    const shifted = timed(60, semitonesFactor(2));
    t.diagnostic(
      `per quantum: key 0 ${(atZero * 1000).toFixed(1)} µs, +2 ${(shifted * 1000).toFixed(1)} µs ` +
        `(fresh ${(freshShifted * 1000).toFixed(1)} µs), budget ${(budgetMs * 1000).toFixed(0)} µs`,
    );
    assert.ok(atZero < budgetMs / 4, `key 0 takes ${atZero} ms a quantum`);
    assert.ok(shifted < budgetMs / 4, `+2 takes ${shifted} ms a quantum`);
    // The cost doesn't grow with how long the party has run.
    assert.ok(
      shifted < freshShifted * 1.5,
      `+2 went from ${freshShifted} to ${shifted} ms`,
    );
  });
});
