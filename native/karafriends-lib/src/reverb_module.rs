// The mics' reverb: these stages one after the other, each a delay in
// seconds and an amplitude.
pub const REVERB_TAPS: [(f32, f32); 5] = [
    (0.09920, 0.750),
    (0.06930, 0.720),
    (0.04836, 0.691),
    (0.03570, 0.649),
    (0.02196, 0.662),
];

// One stage: what goes into the delay line is the sample plus `amplitude` of
// the one that comes out, and the sample becomes the one that comes out less
// `amplitude` of what went in. In place, with no allocation: it runs in the
// mic's callback.
pub struct ReverbModule {
    amplitude: f32,
    // The last delay's worth of what went in; `pos` is the oldest.
    delay: Vec<f32>,
    pos: usize,
}

impl ReverbModule {
    pub fn new(sample_rate: u32, delay_secs: f32, amplitude: f32) -> Self {
        let latency_sample_count = (sample_rate as f32 * delay_secs) as usize;
        ReverbModule {
            amplitude,
            delay: vec![0.0; latency_sample_count],
            pos: 0,
        }
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples {
            let delayed = self.delay[self.pos];
            let fed = *sample + delayed * self.amplitude;
            self.delay[self.pos] = fed;
            *sample = fed * -self.amplitude + delayed;
            self.pos += 1;
            if self.pos == self.delay.len() {
                self.pos = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // An impulse through one stage of 5 samples at 0.5: -0.5 at once, then
    // 0.75, 0.375, 0.1875 every 5 samples. However the samples are split.
    #[test]
    fn test_the_impulse_response() {
        let mut expected = [0.0; 20];
        for (i, value) in [(0, -0.5), (5, 0.75), (10, 0.375), (15, 0.1875)] {
            expected[i] = value;
        }
        for split in [20, 3, 7] {
            let mut reverb = ReverbModule::new(1000, 0.0051, 0.5);
            let mut samples = [0.0; 20];
            samples[0] = 1.0;
            for chunk in samples.chunks_mut(split) {
                reverb.process(chunk);
            }
            assert_eq!(samples, expected, "in pieces of {split}");
        }
    }
}
