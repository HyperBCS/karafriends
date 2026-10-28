// The one output stream every mic plays through.

use std::sync::{Arc, LazyLock, Mutex, TryLockError};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer};

use crate::{_output_devices, _output_name, error_callback, lock, RateLimit, Result, Stream};

pub(crate) static MIXER: LazyLock<Mutex<Mixer>> = LazyLock::new(|| Mutex::new(Mixer::default()));

// A mic's buffer holds 200 ms at the output rate; it plays from 50 ms.
pub(crate) fn ring_capacity(rate: cpal::SampleRate) -> usize {
    rate as usize / 5
}

fn target_fill(rate: cpal::SampleRate) -> usize {
    rate as usize / 20
}

// Every output device, with the host in parentheses.
pub fn output_devices() -> Result<Vec<String>> {
    _output_devices()?
        .map(|(device, device_type)| _output_name(&device, &device_type))
        .collect()
}

// None: the default output. Reopens the stream if the mics have one open.
pub fn set_output_device(name: Option<String>) -> Result<()> {
    let mut mixer = lock(&MIXER);
    mixer.choice = name;
    if mixer.output.is_some() {
        mixer.open()?;
    }
    Ok(())
}

// One mic's output buffer (mono, at the output rate), as the mixer reads it.
pub(crate) struct Source {
    id: u64,
    rx: ringbuf::HeapCons<f32>,
    // The output rate the mic resamples to.
    rate: cpal::SampleRate,
    // False while the buffer refills to the target after running dry.
    playing: bool,
    // The mic's status, to have it reopened when the output rate changes.
    status: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
pub(crate) struct Mixer {
    // The output device picked in Settings; None for the default.
    choice: Option<String>,
    // The stream and its rate, open while any mic is registered.
    output: Option<(Stream, cpal::SampleRate)>,
    // Why the stream stopped or couldn't open.
    output_error: Arc<Mutex<Option<String>>>,
    // Set when the chosen device is missing and the default plays instead.
    note: Option<String>,
    // The output callback only ever try_locks this, so the audio thread
    // never waits; the JS thread holds it just to add or remove a mic.
    sources: Arc<Mutex<Vec<Source>>>,
    next_id: u64,
}

impl Mixer {
    // The output rate, opening the stream if it isn't open or has stopped.
    pub fn open_if_needed(&mut self) -> Result<cpal::SampleRate> {
        match &self.output {
            Some((_, rate)) if lock(&self.output_error).is_none() => Ok(*rate),
            _ => self.open(),
        }
    }

    fn open(&mut self) -> Result<cpal::SampleRate> {
        // ASIO allows one stream per driver: close the old one first.
        self.output = None;
        let opened = self.build();
        match opened {
            Ok((stream, rate, note)) => {
                self.output = Some((stream, rate));
                self.note = note;
                // A mic resampling to another rate would play at the wrong
                // pitch: its status has the display reopen it.
                for source in lock(&self.sources).iter().filter(|s| s.rate != rate) {
                    *lock(&source.status) = Some(format!("The mic output changed to {rate} Hz"));
                }
                Ok(rate)
            }
            Err(e) => {
                self.output_error = Arc::new(Mutex::new(Some(format!(
                    "The mic output couldn't open: {e}"
                ))));
                Err(e)
            }
        }
    }

    fn build(&mut self) -> Result<(Stream, cpal::SampleRate, Option<String>)> {
        let mut note = None;
        let mut device = None;
        if let Some(name) = &self.choice {
            device = _output_devices()?
                .find(|(device, device_type)| {
                    _output_name(device, device_type).is_ok_and(|n| &n == name)
                })
                .map(|(device, _)| device);
            if device.is_none() {
                note = Some(format!(
                    "ok: {name} isn't connected; the mics play through the default output"
                ));
            }
        }
        let device = match device {
            Some(device) => device,
            None => cpal::default_host()
                .default_output_device()
                .ok_or("No default output device")?,
        };

        // The device's own format, at the mics' rate if it has it.
        let default_config = device.default_output_config()?;
        let mut config = default_config.config();
        if let Some(rate) = lock(&self.sources).first().map(|s| s.rate) {
            if device.supported_output_configs()?.any(|range| {
                range.channels() == config.channels
                    && range.sample_format() == default_config.sample_format()
                    && (range.min_sample_rate()..=range.max_sample_rate()).contains(&rate)
            }) {
                config.sample_rate = rate;
            }
        }
        let channels = config.channels as usize;
        let output_error = Arc::new(Mutex::new(None));
        let stream = with_sample_type!(default_config.sample_format(), T => {
            let mut output_callback =
                output_data_callback::<T>(self.sources.clone(), channels, config.sample_rate);
            Ok(device.build_output_stream(
                config,
                move |samples: &mut [T], _: &_| output_callback(samples),
                error_callback(output_error.clone(), "Mic output"),
                None,
            )?)
        })?;
        stream.play()?;
        println!(
            "Opened the mic output {} with config {:#?}, sample format {:#?}",
            device.id()?,
            config,
            default_config.sample_format(),
        );
        self.output_error = output_error;
        Ok((Stream(stream), config.sample_rate, note))
    }

    // "ok", the note, or why the output stopped.
    pub fn status(&self) -> String {
        if let Some(error) = lock(&self.output_error).clone() {
            return error;
        }
        self.note.clone().unwrap_or_else(|| "ok".to_string())
    }

    pub fn register(
        &mut self,
        rx: ringbuf::HeapCons<f32>,
        rate: cpal::SampleRate,
        status: Arc<Mutex<Option<String>>>,
    ) -> u64 {
        self.next_id += 1;
        lock(&self.sources).push(Source {
            id: self.next_id,
            rx,
            rate,
            playing: false,
            status,
        });
        self.next_id
    }

    pub fn deregister(&mut self, id: u64) {
        lock(&self.sources).retain(|source| source.id != id);
        self.close_if_unused();
    }

    // No mics, no stream: nothing holds the device (or an ASIO driver).
    pub fn close_if_unused(&mut self) {
        if lock(&self.sources).is_empty() {
            self.output = None;
        }
    }
}

// What to do with one mic's buffer in an output callback that wants
// `wanted` frames: how many of the oldest samples to drop, and how many to
// play. A buffer close to full drops back to the target (two clocks drift,
// and latency shouldn't grow with them); one that ran dry waits until it
// has refilled to the target, so it gaps once instead of stuttering.
fn plan_read(
    occupied: usize,
    wanted: usize,
    target: usize,
    capacity: usize,
    playing: &mut bool,
) -> (usize, usize) {
    let skip = if occupied + target > capacity {
        occupied - target
    } else {
        0
    };
    let available = occupied - skip;
    if !*playing {
        if available < target {
            return (skip, 0);
        }
        *playing = true;
    }
    let read = available.min(wanted);
    if read < wanted {
        *playing = false;
    }
    (skip, read)
}

// Adds every mic into `mix` (silence where one has nothing). Returns
// whether any ran dry and whether any dropped samples.
fn mix_into(sources: &mut [Source], mix: &mut [f32], target: usize) -> (bool, bool) {
    let (mut ran_dry, mut dropped) = (false, false);
    for source in sources {
        let was_playing = source.playing;
        let (skip, read) = plan_read(
            source.rx.occupied_len(),
            mix.len(),
            target,
            source.rx.capacity().get(),
            &mut source.playing,
        );
        source.rx.skip(skip);
        mix.iter_mut()
            .zip(source.rx.pop_iter().take(read))
            .for_each(|(out, sample)| *out += sample);
        ran_dry |= was_playing && !source.playing;
        dropped |= skip > 0;
    }
    (ran_dry, dropped)
}

// The output callback: sums the mics, mono to every channel.
fn output_data_callback<Sample: cpal::Sample + cpal::FromSample<f32>>(
    sources: Arc<Mutex<Vec<Source>>>,
    channels: usize,
    rate: cpal::SampleRate,
) -> impl FnMut(&mut [Sample]) + Send + 'static {
    let target = target_fill(rate);
    let mut mix: Vec<f32> = Vec::with_capacity(rate as usize / 10);
    let mut dry_prints = RateLimit::default();
    let mut dropped_prints = RateLimit::default();
    move |samples: &mut [Sample]| {
        mix.clear();
        mix.resize(samples.len() / channels, 0.0);
        let sources = match sources.try_lock() {
            Ok(sources) => Some(sources),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            // A mic is being added or removed: one callback of silence.
            Err(TryLockError::WouldBlock) => None,
        };
        if let Some(mut sources) = sources {
            let (ran_dry, dropped) = mix_into(&mut sources, &mut mix, target);
            if ran_dry && dry_prints.ready() {
                eprintln!("mic fell behind: refilling");
            }
            if dropped && dropped_prints.ready() {
                eprintln!("mic ran ahead: dropped the oldest samples");
            }
        }
        for (frame, sample) in samples.chunks_mut(channels).zip(&mix) {
            frame.fill(Sample::from_sample(sample.clamp(-1.0, 1.0)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::{Producer, Split};

    #[test]
    fn test_plan_read_refills_before_playing() {
        let (target, capacity) = (50, 200);
        let mut playing = false;
        // Below the target: nothing plays.
        assert_eq!(plan_read(10, 20, target, capacity, &mut playing), (0, 0));
        assert!(!playing);
        assert_eq!(plan_read(49, 20, target, capacity, &mut playing), (0, 0));
        // At the target it plays, and keeps playing while it has enough.
        assert_eq!(plan_read(50, 20, target, capacity, &mut playing), (0, 20));
        assert!(playing);
        assert_eq!(plan_read(20, 20, target, capacity, &mut playing), (0, 20));
        assert!(playing);
        // Running dry plays what's left, then waits for the target again.
        assert_eq!(plan_read(5, 20, target, capacity, &mut playing), (0, 5));
        assert!(!playing);
        assert_eq!(plan_read(30, 20, target, capacity, &mut playing), (0, 0));
        assert_eq!(plan_read(60, 20, target, capacity, &mut playing), (0, 20));
        assert!(playing);
    }

    #[test]
    fn test_plan_read_drops_the_oldest_when_nearly_full() {
        let (target, capacity) = (50, 200);
        let mut playing = true;
        assert_eq!(plan_read(150, 20, target, capacity, &mut playing), (0, 20));
        // Within the target of full: back down to the target.
        assert_eq!(
            plan_read(151, 20, target, capacity, &mut playing),
            (101, 20)
        );
        assert_eq!(
            plan_read(200, 20, target, capacity, &mut playing),
            (150, 20)
        );
        assert!(playing);
    }

    fn source(id: u64, samples: &[f32], capacity: usize) -> Source {
        let (mut tx, rx) = ringbuf::HeapRb::new(capacity).split();
        tx.push_slice(samples);
        Source {
            id,
            rx,
            rate: 48000,
            playing: false,
            status: Arc::new(Mutex::new(None)),
        }
    }

    // 4 frames wanted per callback, a target of 1/20 of the rate.
    const RATE: cpal::SampleRate = 80;

    #[test]
    fn test_output_sums_the_mics_to_every_channel() {
        let a = source(1, &[0.1, 0.2, 0.3, 0.4], 16);
        let b = source(2, &[0.5, 0.5, 0.5, 0.5], 16);
        let sources = Arc::new(Mutex::new(vec![a, b]));
        let mut callback = output_data_callback::<f32>(sources, 2, RATE);
        let mut out = [9.0; 8];
        callback(&mut out);
        let expected = [0.6, 0.6, 0.7, 0.7, 0.8, 0.8, 0.9, 0.9];
        for (a, b) in out.iter().zip(expected) {
            assert!((a - b).abs() < 1e-6, "{:?}", out);
        }
    }

    #[test]
    fn test_output_underrun_is_silence() {
        // Empty, and below the target: zeros, whatever was in the buffer.
        let sources = Arc::new(Mutex::new(vec![
            source(1, &[], 16),
            source(2, &[0.5; 3], 16),
        ]));
        let mut callback = output_data_callback::<f32>(sources, 1, RATE);
        let mut out = [9.0; 4];
        callback(&mut out);
        assert_eq!(out, [0.0; 4]);

        // Playing, then running dry mid-callback: the rest is silence.
        let sources = Arc::new(Mutex::new(vec![source(1, &[0.5; 6], 16)]));
        let mut callback = output_data_callback::<f32>(sources, 1, RATE);
        let mut out = [9.0; 4];
        callback(&mut out);
        assert_eq!(out, [0.5; 4]);
        callback(&mut out);
        assert_eq!(out, [0.5, 0.5, 0.0, 0.0]);
        // And it waits for the target before playing again.
        callback(&mut out);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn test_output_with_no_mics_is_silence() {
        let mut callback = output_data_callback::<i16>(Arc::new(Mutex::new(vec![])), 2, RATE);
        let mut out = [7_i16; 8];
        callback(&mut out);
        assert_eq!(out, [0; 8]);
    }

    #[test]
    fn test_mixer_registers_and_deregisters() {
        let mut mixer = Mixer::default();
        assert_eq!(mixer.status(), "ok");
        let (_tx, rx) = ringbuf::HeapRb::new(4).split();
        let id = mixer.register(rx, 48000, Arc::new(Mutex::new(None)));
        assert_eq!(lock(&mixer.sources).len(), 1);
        mixer.deregister(id);
        assert!(lock(&mixer.sources).is_empty());
        assert!(mixer.output.is_none());
    }
}
