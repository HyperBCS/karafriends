// How late the default mic plays through the mic output, measured through
// the speakers: a burst of noise plays on the default output and the mic
// records it, first with the mic (opened as the app opens it) at gain 0,
// then at gain 2. The second recording also holds the burst as
// the mic output played it back; the first, taken away, leaves only that.
// The time between the two bursts is the whole delay from mic to speaker.
//
// It makes 16 short ticks. Turn the volume to about half, with no
// headphones: the speakers have to reach the mic. The terminal needs
// microphone access (System Settings › Privacy & Security › Microphone).
//
//   cargo run --release --manifest-path native/Cargo.toml -p karafriends-lib --example mic_latency [mic]
//
// `mic` is part of a mic's name ("Yeti"); the default mic without it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::thread::sleep;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use karafriends_lib::{InputDevice, Result};
use ringbuf::traits::{Consumer, Producer, Split};

const TRIALS: usize = 8;
const BURST_MS: u32 = 5;
// How long each recording runs after the burst starts, and where its echo
// is looked for after the burst.
const RECORD: Duration = Duration::from_millis(450);
const ECHO_MS: (f32, f32) = (1.0, 200.0);

// Noise in a Hann window: one sharp peak when correlated with itself.
fn burst(rate: u32) -> Vec<f32> {
    let len = (rate * BURST_MS / 1000) as usize;
    let mut seed: u32 = 0x9e37_79b9;
    (0..len)
        .map(|i| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 8) as f32 / (1 << 23) as f32 - 1.0;
            let window = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / len as f32).cos();
            0.9 * noise * window
        })
        .collect()
}

// |correlation| of `signal` with `template` at each offset.
fn correlate(signal: &[f32], template: &[f32]) -> Vec<f32> {
    (0..signal.len().saturating_sub(template.len()))
        .map(|i| {
            signal[i..]
                .iter()
                .zip(template)
                .map(|(s, t)| s * t)
                .sum::<f32>()
                .abs()
        })
        .collect()
}

fn argmax(values: &[f32]) -> usize {
    values
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0, |(i, _)| i)
}

fn main() -> Result<()> {
    let host = cpal::default_host();
    let input = match std::env::args().nth(1) {
        Some(name) => host
            .input_devices()?
            .find(|device| {
                device
                    .description()
                    .is_ok_and(|description| description.name().contains(&name))
            })
            .ok_or_else(|| format!("No mic named {name}"))?,
        None => host.default_input_device().ok_or("No default input")?,
    };
    let output = host.default_output_device().ok_or("No default output")?;

    // The mic as the app opens it, playing through the default output.
    let id = input.id()?.to_string();
    let (key, label, _) = InputDevice::collect_devices()?
        .into_iter()
        .find(|(key, _, _)| key.starts_with(&id))
        .ok_or("The default input isn't among karafriends' mics")?;
    let mic = InputDevice::new(&key, 0)?;
    mic.set_echo(0.0);
    mic.set_gain(0.0);

    // A recorder on the same mic, at its own rate, channel 0.
    let in_config = input.default_input_config()?.config();
    let rate = in_config.sample_rate;
    let channels = in_config.channels as usize;
    let (mut rec_tx, mut rec_rx) = ringbuf::HeapRb::<f32>::new(rate as usize * 10).split();
    // What the system says each side's delay is, buffer included, in µs.
    let mic_delay = Arc::new(AtomicU32::new(0));
    let speaker_delay = Arc::new(AtomicU32::new(0));
    let rec_delay = mic_delay.clone();
    let recorder = input.build_input_stream(
        in_config,
        move |samples: &[f32], info: &cpal::InputCallbackInfo| {
            let at = info.timestamp();
            let delay = at.callback.duration_since(at.capture);
            rec_delay.store(delay.as_micros() as u32, Relaxed);
            for frame in samples.chunks(channels) {
                let _ = rec_tx.try_push(frame[0]);
            }
        },
        |e| eprintln!("recorder: {e}"),
        None,
    )?;
    recorder.play()?;

    // The burst, on demand, on the default output.
    let out_config = output.default_output_config()?.config();
    let out_channels = out_config.channels as usize;
    let out_burst = burst(out_config.sample_rate);
    let fire = Arc::new(AtomicBool::new(false));
    let fired = fire.clone();
    let mut at = usize::MAX;
    let play_delay = speaker_delay.clone();
    let player = output.build_output_stream(
        out_config,
        move |samples: &mut [f32], info: &cpal::OutputCallbackInfo| {
            let stamp = info.timestamp();
            let delay = stamp.playback.duration_since(stamp.callback);
            play_delay.store(delay.as_micros() as u32, Relaxed);
            if fired.swap(false, Relaxed) {
                at = 0;
            }
            for frame in samples.chunks_mut(out_channels) {
                frame.fill(out_burst.get(at).copied().unwrap_or(0.0));
                at = at.saturating_add(1);
            }
        },
        |e| eprintln!("player: {e}"),
        None,
    )?;
    player.play()?;

    // Let the mic output's buffer settle (it drops its start-up excess).
    sleep(Duration::from_secs(3));
    println!("Mic: {label}: {}", mic.format());
    println!(
        "Mic output: {}",
        karafriends_lib::output_format().unwrap_or_default()
    );
    println!(
        "The system's own figures, buffers included: mic {:.1} ms, speakers {:.1} ms",
        mic_delay.load(Relaxed) as f32 / 1000.0,
        speaker_delay.load(Relaxed) as f32 / 1000.0,
    );

    let template = burst(rate);
    let mut record = |gain: f32| -> Vec<f32> {
        mic.set_gain(gain);
        sleep(Duration::from_millis(300));
        rec_rx.clear();
        fire.store(true, Relaxed);
        sleep(RECORD);
        rec_rx.pop_iter().collect()
    };
    let frames = |ms: f32| (ms * rate as f32 / 1000.0) as usize;
    let ms = |frames: usize| frames as f32 * 1000.0 / rate as f32;
    // Nothing comes back sooner than the two devices' own delays: an
    // echo before that is the room's.
    let system_ms = (mic_delay.load(Relaxed) + speaker_delay.load(Relaxed)) as f32 / 1000.0;
    let (from, to) = (frames(ECHO_MS.0.max(system_ms)), frames(ECHO_MS.1));
    // The peak of a difference, and how far it stands out from the rest.
    let peak = |difference: &[f32]| {
        let peak = argmax(difference);
        let mut sorted: Vec<f32> = difference.iter().map(|d| d.abs()).collect();
        sorted.sort_by(f32::total_cmp);
        (peak, difference[peak] / sorted[sorted.len() / 2].max(1e-9))
    };
    let mut total = vec![0.0; to - from];
    let mut trials = Vec::new();
    for trial in 1..=TRIALS {
        let quiet = correlate(&record(0.0), &template);
        // At full gain, for the loudest echo.
        let echoed = correlate(&record(2.0), &template);
        let (quiet_at, echoed_at) = (argmax(&quiet), argmax(&echoed));
        if quiet[quiet_at] < 1e-4 {
            return Err("The mic records silence: give the terminal microphone access".into());
        }
        // The echoed recording less the quiet one, lined up on the burst
        // and scaled to it: the room's own echoes cancel.
        let (burst_level, scale) = (quiet[quiet_at], echoed[echoed_at] / quiet[quiet_at]);
        let difference: Vec<f32> = (from..to)
            .map(|lag| {
                let echoed = echoed.get(echoed_at + lag).copied().unwrap_or(0.0);
                let quiet = quiet.get(quiet_at + lag).copied().unwrap_or(0.0);
                (echoed - scale * quiet) / burst_level
            })
            .collect();
        total.iter_mut().zip(&difference).for_each(|(t, d)| *t += d);
        let (at, strength) = peak(&difference);
        println!(
            "Trial {trial}: {:.1} ms ({strength:.0}x the noise)",
            ms(from + at)
        );
        trials.push(from + at);
    }
    mic.set_gain(0.0);
    // The trials added up: the echo is in each at the same place, the
    // noise isn't.
    let (at, strength) = peak(&total);
    // An echo that hardly stands out is the room, not the mic output.
    if strength < 8.0 {
        return Err(format!(
            "No echo found ({strength:.0}x the noise): turn the volume up or move the mic nearer the speakers"
        )
        .into());
    }
    let agree = trials
        .iter()
        .filter(|&&trial| trial.abs_diff(from + at) <= frames(1.0))
        .count();
    println!(
        "Mic to speaker: {:.1} ms ({strength:.0}x the noise over {TRIALS} trials; {agree} agree within 1 ms)",
        ms(from + at),
    );
    Ok(())
}
