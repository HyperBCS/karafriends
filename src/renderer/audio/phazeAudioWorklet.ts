import FFT from "fft.js";

// The key change: a stereo phase vocoder that shifts pitch by pitchFactor
// (2^(semitones/12)) without changing the tempo.
//
// It is peak-locked pitch shifting after Laroche and Dolson ("New
// phase-vocoder techniques for real-time pitch shifting, chorusing,
// harmonizing and other exotic audio modifications", JAES 1999), on the
// frame layout of olvb/phaze, which this file started as. Each quantum it
// takes the last 2048 samples, Hann-windowed, to the frequency domain and
// finds the spectral peaks. Each peak's true frequency comes from how far its
// phase turned since the frame one quantum earlier. The bins around a peak
// (its region) move together, by the whole number of bins nearest to
// (factor - 1) x that frequency, and are turned by one phase per region
// which advances, quantum to quantum, by (factor - 1) x the peak's phase
// advance. So the shifted peak's phase runs at factor x its true frequency,
// and its frequency comes out right however coarse the bins are (23 Hz at
// 48 kHz); only the place of its window in the spectrum is rounded, which
// costs it up to about 1 dB of level (2 dB for a moment while a note glides
// between bins). A region turns as one, so a peak's bins stay in phase with
// each other (less of the vocoder's "phasiness" than turning each bin alone,
// as Bernsee's smbPitchShift does), and a peak takes its phase from the
// region it was in a quantum earlier, so a note that drifts between bins
// keeps its phase. Regions end at the quietest bin between two peaks.
//
// Left and right share one analysis: the peaks come from both channels'
// power, each peak's phase advance from both channels' phases, and each
// region of both channels moves and turns alike. So a bin's left and right
// keep the phase between them that they came in with, and a centred sound (a
// singer, Joysound's guide melody) stays centred. Shifting each channel on its
// own lets their phases wander apart wherever their peaks differ, which in a
// real mix is almost everywhere: a centred voice then sounds smeared, as if
// underwater, most of all on headphones.
//
// Frames overlap 16 times (hop 128, one quantum) and are Hann-windowed again
// on the way out. At factor 1 a frame is the windowed input itself, added
// without an FFT: the output is then the input exactly, 1920 samples late,
// and a key change fades in (and out) over one window as frames of the other
// kind take over, with no gap. The output is at the input's level; webAudio.ts
// sets the songs' level.

const QUANTUM = 128;
const FFT_SIZE = 2048;
// Bins 0 (DC) to FFT_SIZE / 2 (Nyquist): all a real signal has.
const BINS = FFT_SIZE / 2 + 1;
// A Hann window in and out, overlapping FFT_SIZE / QUANTUM times: the
// squared windows sum to 16 x 3/8 = 6 at every sample.
const OUTPUT_SCALE = 1 / ((FFT_SIZE / QUANTUM) * (3 / 8));
const TWO_PI = 2 * Math.PI;
// How far a bin's phase turns in one hop at the bin's own frequency, per bin.
const BIN_ADVANCE = (TWO_PI * QUANTUM) / FFT_SIZE;

// To (-π, π].
function wrap(phase: number): number {
  return phase - TWO_PI * Math.round(phase / TWO_PI);
}

class Channel {
  // The last FFT_SIZE + QUANTUM samples, oldest first: the current frame
  // and, one quantum earlier, the frame before it.
  readonly history = new Float32Array(FFT_SIZE + QUANTUM);
  // The overlap-add of the frames so far; [0, QUANTUM) is due out next.
  readonly output = new Float32Array(FFT_SIZE);
  // This frame's spectrum and the last one (bins 0 to BINS - 1, re/im
  // interleaved; fft.js leaves scratch above them), swapped each frame.
  spectrum = new Float64Array(2 * FFT_SIZE);
  previous = new Float64Array(2 * FFT_SIZE);
  // The shifted spectrum, bins 0 to BINS - 1.
  readonly shifted = new Float64Array(2 * BINS);

  constructor(readonly index: number) {}
}

class PhaseVocoderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pitchFactor", defaultValue: 1, automationRate: "k-rate" }];
  }

  private readonly fft = new FFT(FFT_SIZE);
  private readonly window = new Float32Array(FFT_SIZE);
  // The window squared, times OUTPUT_SCALE: an unshifted frame's weights.
  private readonly windowSquared = new Float32Array(FFT_SIZE);
  private readonly channels = [new Channel(0), new Channel(1)];
  // Whether the last frame was shifted: when a shift starts, the frame one
  // quantum earlier is analysed first, for the phase advance.
  private shifting = false;
  // Per analysis bin, the phase turn of the region the bin was in last
  // frame (both channels').
  private readonly regionTurn = new Float64Array(BINS);

  // Scratch, shared by the channels.
  private readonly frame = new Float64Array(FFT_SIZE);
  private readonly magnitudes = new Float64Array(BINS);
  private readonly peaks = new Int32Array(BINS);
  private readonly peakShift = new Int32Array(BINS);
  private readonly peakTurn = new Float64Array(BINS);
  // Both channels' shifted spectra as one: left + i x right, so a single
  // complex inverse FFT gives left in its real part and right in its
  // imaginary part.
  private readonly packed = new Float64Array(2 * FFT_SIZE);
  private readonly time = new Float64Array(2 * FFT_SIZE);

  constructor() {
    super();
    for (let n = 0; n < FFT_SIZE; n++) {
      this.window[n] = 0.5 * (1 - Math.cos((TWO_PI * n) / FFT_SIZE));
      this.windowSquared[n] = this.window[n] * this.window[n] * OUTPUT_SCALE;
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ) {
    const factor = parameters.pitchFactor[parameters.pitchFactor.length - 1];
    // Two channels in while anything upstream plays (the node's channel
    // count is fixed at 2), none while nothing does: silence then.
    const input = inputs[0];
    for (const channel of this.channels) {
      const history = channel.history;
      history.copyWithin(0, QUANTUM);
      const block = input[channel.index] ?? input[0];
      if (block) history.set(block, FFT_SIZE);
      else history.fill(0, FFT_SIZE);
    }

    if (factor === 1) {
      this.shifting = false;
      for (const channel of this.channels) this.addUnshiftedFrame(channel);
    } else {
      if (!this.shifting) {
        this.shifting = true;
        for (const channel of this.channels) {
          this.analyse(channel.history, 0, channel.previous);
        }
        this.regionTurn.fill(0);
      }
      this.addShiftedFrames(factor);
    }

    const output = outputs[0];
    for (const channel of this.channels) {
      const out = channel.output;
      if (channel.index < output.length) {
        output[channel.index].set(out.subarray(0, QUANTUM));
      }
      out.copyWithin(0, QUANTUM);
      out.fill(0, FFT_SIZE - QUANTUM);
    }
    return true;
  }

  // The current frame windowed twice: what the vocoder makes of it at
  // factor 1, without the round trip through the FFT.
  private addUnshiftedFrame(channel: Channel) {
    const { history, output } = channel;
    const squared = this.windowSquared;
    for (let n = 0; n < FFT_SIZE; n++) {
      output[n] += history[QUANTUM + n] * squared[n];
    }
  }

  private analyse(history: Float32Array, start: number, into: Float64Array) {
    const frame = this.frame;
    const window = this.window;
    for (let n = 0; n < FFT_SIZE; n++)
      frame[n] = history[start + n] * window[n];
    this.fft.realTransform(into, frame);
  }

  private addShiftedFrames(factor: number) {
    const [left, right] = this.channels;
    for (const channel of this.channels) {
      this.analyse(channel.history, QUANTUM, channel.spectrum);
    }
    this.shift(factor);

    // Each channel's spectrum is that of a real signal: bin FFT_SIZE - k is
    // the conjugate of bin k. Packed as left + i x right:
    //   bin k:            (lRe - rIm) + i (lIm + rRe)
    //   bin FFT_SIZE - k: (lRe + rIm) + i (rRe - lIm)
    // DC and Nyquist keep only their real parts, as a real signal's do.
    const packed = this.packed;
    const l = left.shifted;
    const r = right.shifted;
    packed[0] = l[0];
    packed[1] = r[0];
    packed[FFT_SIZE] = l[FFT_SIZE];
    packed[FFT_SIZE + 1] = r[FFT_SIZE];
    for (let k = 1; k < BINS - 1; k++) {
      const lRe = l[2 * k];
      const lIm = l[2 * k + 1];
      const rRe = r[2 * k];
      const rIm = r[2 * k + 1];
      packed[2 * k] = lRe - rIm;
      packed[2 * k + 1] = lIm + rRe;
      const mirror = 2 * (FFT_SIZE - k);
      packed[mirror] = lRe + rIm;
      packed[mirror + 1] = rRe - lIm;
    }
    this.fft.inverseTransform(this.time, packed);

    const time = this.time;
    const window = this.window;
    const leftOut = left.output;
    const rightOut = right.output;
    for (let n = 0; n < FFT_SIZE; n++) {
      const w = window[n] * OUTPUT_SCALE;
      leftOut[n] += time[2 * n] * w;
      rightOut[n] += time[2 * n + 1] * w;
    }

    for (const channel of this.channels) {
      const last = channel.previous;
      channel.previous = channel.spectrum;
      channel.spectrum = last;
    }
  }

  // Moves both channels' spectra to their `shifted`, peak by peak.
  private shift(factor: number) {
    const [left, right] = this.channels;
    const { magnitudes, peaks, peakShift, peakTurn, regionTurn } = this;
    const l = left.spectrum;
    const r = right.spectrum;
    const lastL = left.previous;
    const lastR = right.previous;

    // Both channels' power.
    for (let k = 0; k < BINS; k++) {
      magnitudes[k] =
        l[2 * k] ** 2 + l[2 * k + 1] ** 2 + r[2 * k] ** 2 + r[2 * k + 1] ** 2;
    }
    // Peaks: louder than the bins either side.
    let count = 0;
    for (let k = 1; k < BINS - 1; k++) {
      const m = magnitudes[k];
      if (m > magnitudes[k - 1] && m >= magnitudes[k + 1]) {
        peaks[count++] = k;
        k += 1;
      }
    }

    // Every peak's shift and phase turn, before any region's turn is
    // overwritten below.
    for (let i = 0; i < count; i++) {
      const p = peaks[i];
      const re = 2 * p;
      const im = re + 1;
      // The phase advance at bin p since the last frame: the bin's own
      // advance plus the deviation the phases show, so the true frequency.
      // It's the angle of this frame times the last one's conjugate, summed
      // over the channels, so the louder channel counts for more.
      const turned = Math.atan2(
        l[im] * lastL[re] -
          l[re] * lastL[im] +
          r[im] * lastR[re] -
          r[re] * lastR[im],
        l[re] * lastL[re] +
          l[im] * lastL[im] +
          r[re] * lastR[re] +
          r[im] * lastR[im],
      );
      const expected = BIN_ADVANCE * p;
      const advance = expected + wrap(turned - expected);
      peakShift[i] = Math.round(((factor - 1) * advance) / BIN_ADVANCE);
      peakTurn[i] = wrap(regionTurn[p] + (factor - 1) * advance);
    }

    left.shifted.fill(0);
    right.shifted.fill(0);
    let start = 0;
    for (let i = 0; i < count; i++) {
      const p = peaks[i];
      // The region: from the quietest bin between this peak and the last
      // to the quietest one before the next, or to the ends.
      let end = BINS;
      if (i < count - 1) {
        end = p + 1;
        for (let k = p + 2; k <= peaks[i + 1]; k++) {
          if (magnitudes[k] < magnitudes[end]) end = k;
        }
      }
      const delta = peakShift[i];
      const turn = peakTurn[i];
      for (let k = start; k < end; k++) regionTurn[k] = turn;

      // Moving a frame's spectrum by delta bins flips the phase at its middle
      // when delta is odd; the turn is kept for the middle, where the window
      // is, so a peak that changes bins doesn't jump.
      let cos = Math.cos(turn);
      let sin = Math.sin(turn);
      if (delta & 1) {
        cos = -cos;
        sin = -sin;
      }
      // Only bins in [0, BINS) are read or written.
      const from = Math.max(start, -delta);
      const to = Math.min(end, BINS - delta);
      for (const { spectrum, shifted } of this.channels) {
        for (let k = from; k < to; k++) {
          const re = spectrum[2 * k];
          const im = spectrum[2 * k + 1];
          const into = 2 * (k + delta);
          shifted[into] += re * cos - im * sin;
          shifted[into + 1] += re * sin + im * cos;
        }
      }
      start = end;
    }
  }
}

registerProcessor("phase-vocoder", PhaseVocoderProcessor);
