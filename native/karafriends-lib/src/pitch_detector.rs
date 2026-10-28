use std::sync::Arc;

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use ringbuf::traits::{Consumer, Observer, Split};

// How many windows the ring between a mic's callback and the polls holds:
// 200 ms, more than any callback (mixer::MAX_BUFFER) or a late poll needs.
const RING_WINDOWS: usize = 8;

// The newest 1/40 s of a mic's sound, where its pitch is found. The mic's
// callback fills a ring; each poll (PianoRoll asks every 25 ms) takes what
// came since the last, keeps the newest window of it, and finds its pitch.
// So the pitch is never found in a window part empty (a poll after 20 ms of
// sound) or an old one (a poll that comes late).
pub struct PitchWindow {
    rx: ringbuf::HeapCons<f32>,
    window: Vec<f32>,
    // How much of the window is sound, up to all of it.
    filled: usize,
    detector: PitchDetector,
}

impl PitchWindow {
    // The callback's end of the ring, and the window.
    pub fn new(sample_rate: u32) -> (ringbuf::HeapProd<f32>, Self) {
        let sample_count = sample_rate.div_ceil(40) as usize;
        let (tx, rx) = ringbuf::HeapRb::new(sample_count * RING_WINDOWS).split();
        let window = PitchWindow {
            rx,
            window: vec![0.0; sample_count],
            filled: 0,
            detector: PitchDetector::new(sample_rate as f32, sample_count),
        };
        (tx, window)
    }

    // The pitch (a MIDI number) of the newest window, and how sure it is (0
    // to 1); (0, 0) when nothing came since the last poll, or a whole window
    // hasn't yet.
    pub fn pitch(&mut self) -> (f32, f32) {
        let new = self.rx.occupied_len();
        // A ring that went unasked a while (no pitch bars) filled up and
        // dropped the newest: what it holds is old.
        if self.rx.is_full() {
            self.rx.skip(new);
            self.filled = 0;
            return (0.0, 0.0);
        }
        if new == 0 {
            return (0.0, 0.0);
        }
        let n = self.window.len();
        let take = new.min(n);
        self.rx.skip(new - take);
        self.window.copy_within(take.., 0);
        self.rx.pop_slice(&mut self.window[n - take..]);
        self.filled = (self.filled + take).min(n);
        if self.filled < n {
            return (0.0, 0.0);
        }
        self.detector.detect(&self.window)
    }
}

pub struct PitchDetector {
    sample_rate: f32,
    fft: Arc<dyn RealToComplex<f32>>,
    rfft: Arc<dyn ComplexToReal<f32>>,
}

impl PitchDetector {
    pub fn new(sample_rate: f32, sample_count: usize) -> PitchDetector {
        PitchDetector {
            sample_rate,
            fft: RealFftPlanner::<f32>::new().plan_fft_forward(sample_count),
            rfft: RealFftPlanner::<f32>::new().plan_fft_inverse(sample_count),
        }
    }

    pub fn detect(&self, samples: &[f32]) -> (f32, f32) {
        // The FFT works in its input.
        let mut samples = samples.to_vec();
        let B = samples.len();
        let W = samples.len() / 2;

        let squares: Vec<f32> = samples.iter().map(|sample| sample * sample).collect();

        let mut sqdiff = vec![0.0; B];
        sqdiff[0] = squares[..W].iter().sum::<f32>() * 2.0;
        for tau in 1..W {
            sqdiff[tau] = sqdiff[tau - 1] - squares[tau - 1] + squares[W + tau - 1];
        }

        let mut kernel = self.fft.make_input_vec();
        for i in 0..W {
            kernel[i + 1] = samples[W - i - 1];
        }

        let mut fft_scratch = self.fft.make_scratch_vec();

        let mut samples_spectrum = self.fft.make_output_vec();
        self.fft
            .process_with_scratch(&mut samples, &mut samples_spectrum, &mut fft_scratch)
            .unwrap();

        let mut kernel_spectrum = self.fft.make_output_vec();
        self.fft
            .process_with_scratch(&mut kernel, &mut kernel_spectrum, &mut fft_scratch)
            .unwrap();

        let mut complex_product = kernel_spectrum
            .iter()
            .zip(samples_spectrum.iter())
            .map(|(k, s)| k * s)
            .collect::<Vec<_>>();

        let mut rt_of_tau = self.rfft.make_output_vec();
        self.rfft
            .process(&mut complex_product, &mut rt_of_tau)
            .unwrap();

        let mut yin = vec![0.0; W];
        yin[0] = 1.0;
        for tau in 1..W {
            yin[tau] = sqdiff[tau] - 2.0 * rt_of_tau[tau + W] / B as f32;
        }

        let mut tmp2 = 0.0;
        for tau in 1..W {
            tmp2 += yin[tau];
            if tmp2 != 0.0 {
                yin[tau] *= tau as f32 / tmp2;
            } else {
                yin[tau] = 1.0;
            }
            if tau > 4 {
                let period = tau - 3;
                if (yin[period] < 0.15) && (yin[period] < yin[period + 1]) {
                    return if yin[period] > -0.00001 {
                        (
                            freq2midi(self.sample_rate / quadratic_peak_pos(&yin, period)),
                            1.0 - yin[period].max(0.0),
                        )
                    } else {
                        (0.0, 0.0)
                    };
                }
            }
        }

        let min_index = yin
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(index, _)| index)
            .unwrap();
        if yin[min_index] > -0.00001 {
            (
                freq2midi(self.sample_rate / quadratic_peak_pos(&yin, min_index)),
                1.0 - yin[min_index].max(0.0),
            )
        } else {
            (0.0, 0.0)
        }
    }
}

fn quadratic_peak_pos(x: &[f32], pos: usize) -> f32 {
    if pos == 0 || pos == x.len() - 1 {
        return 0.0;
    }
    let x0 = pos - 1;
    let x2 = pos + 1;
    let s0 = x[x0];
    let s1 = x[pos];
    let s2 = x[x2];
    pos as f32 + 0.5 * (s0 - s2) / (s0 - 2.0 * s1 + s2)
}

pub fn freq2midi(freq: f32) -> f32 {
    if !(2.0..=100000.0).contains(&freq) {
        return 0.0;
    }
    (freq / 6.875).ln() / 2.0_f32.ln() * 12.0 - 3.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use wavegen::{sine, wf};

    #[test]
    fn test_simple_tones() {
        let sample_rate = 44100_usize;
        let sample_count = sample_rate.div_ceil(40);

        let pd = PitchDetector::new(sample_rate as f32, sample_count);

        for freq in 81..=1000 {
            let samples = wf!(
                f32,
                sample_rate as f32,
                sine!(freq as f32, 1.0_f32, 0.0_f32)
            )
            .iter()
            .take(sample_count)
            .collect::<Vec<_>>();
            let (midi_number, confidence) = pd.detect(&samples);

            assert_eq!(midi_number.round(), freq2midi(freq as f32).round());
            assert!(confidence > 0.99);
        }
    }

    fn tone(freq: f32, count: usize) -> Vec<f32> {
        wf!(f32, 48000.0_f32, sine!(freq, 1.0_f32, 0.0_f32))
            .iter()
            .take(count)
            .collect()
    }

    // A window part empty gives no pitch; a ring that filled up while no
    // one asked is old, dropped whole, and the window starts again.
    #[test]
    fn test_the_window_is_whole_and_new() {
        use ringbuf::traits::Producer;
        let (mut tx, mut window) = PitchWindow::new(48000);
        let n = 1200;
        tx.push_slice(&tone(200.0, n - 1));
        assert_eq!(window.pitch(), (0.0, 0.0));
        tx.push_slice(&tone(200.0, 1));
        assert!((window.pitch().0 - freq2midi(200.0)).abs() < 0.05);

        tx.push_slice(&tone(300.0, n * RING_WINDOWS + 100));
        assert_eq!(window.pitch(), (0.0, 0.0));
        tx.push_slice(&tone(400.0, n / 2));
        assert_eq!(window.pitch(), (0.0, 0.0));
        tx.push_slice(&tone(400.0, n));
        assert!((window.pitch().0 - freq2midi(400.0)).abs() < 0.05);
    }
}
