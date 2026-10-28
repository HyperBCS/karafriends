#![allow(non_snake_case)]

// Runs `$body` with `$T` as the Rust type of a cpal sample format.
macro_rules! with_sample_type {
    ($format:expr, $T:ident => $body:expr) => {
        match $format {
            cpal::SampleFormat::U8 => {
                type $T = u8;
                $body
            }
            cpal::SampleFormat::U16 => {
                type $T = u16;
                $body
            }
            cpal::SampleFormat::U32 => {
                type $T = u32;
                $body
            }
            cpal::SampleFormat::U64 => {
                type $T = u64;
                $body
            }
            cpal::SampleFormat::I8 => {
                type $T = i8;
                $body
            }
            cpal::SampleFormat::I16 => {
                type $T = i16;
                $body
            }
            cpal::SampleFormat::I32 => {
                type $T = i32;
                $body
            }
            cpal::SampleFormat::I64 => {
                type $T = i64;
                $body
            }
            cpal::SampleFormat::F32 => {
                type $T = f32;
                $body
            }
            cpal::SampleFormat::F64 => {
                type $T = f64;
                $body
            }
            _ => Err::<_, Box<dyn std::error::Error + Send + Sync>>(
                cpal::Error::new(cpal::ErrorKind::UnsupportedConfig).into(),
            ),
        }
    };
}

#[cfg(windows)]
mod exclusive;
mod mixer;
mod pitch_detector;
mod reverb_module;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::iter::{FromIterator, Iterator};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use neon::prelude::Finalize;
use ringbuf::traits::{Consumer, Producer, Split};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::Resampler;

pub use mixer::{output_devices, output_format, output_options, set_output_device};

// How the platform's mics open: exclusive (Windows only, see exclusive.rs)
// with a buffer size in frames (None: the mic's smallest), or shared.
#[derive(Clone, Copy)]
struct MicMode {
    exclusive: bool,
    buffer: Option<u32>,
}

static MIC_MODE: Mutex<MicMode> = Mutex::new(MicMode {
    exclusive: false,
    buffer: None,
});

// For the mics opened from now on.
pub fn set_mic_mode(exclusive: bool, buffer: Option<u32>) {
    *lock(&MIC_MODE) = MicMode { exclusive, buffer };
}

pub fn exclusive_available() -> bool {
    cfg!(windows)
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

// Rubato is fed whole chunks of this many frames, whatever size the mic's
// callbacks are; the remainder waits for the next callback. Small, since a
// chunk waits before it plays: a mic resampled for an output at another
// rate is about 4 ms late with 128, 24 ms with 1024.
const RESAMPLER_CHUNK: usize = 128;

// The ASIO host, and what Settings says about ASIO (see asio_status).
#[cfg(all(windows, feature = "asio"))]
struct Asio {
    // None when it didn't start; the status says why.
    host: Option<cpal::Host>,
    status: String,
    // The devices as last listed with no ASIO stream open (see asio_devices).
    devices: Mutex<Vec<cpal::Device>>,
}

// Made the first time anything lists or opens a device, before any ASIO
// driver is open.
#[cfg(all(windows, feature = "asio"))]
static ASIO: LazyLock<Asio> = LazyLock::new(|| {
    // The host first: it sets up COM on this thread, which loading a driver
    // needs.
    match cpal::host_from_id(cpal::HostId::Asio) {
        Ok(host) => Asio {
            host: Some(host),
            status: asio_drivers(),
            devices: Mutex::new(Vec::new()),
        },
        Err(e) => {
            eprintln!("The ASIO host didn't start: {e}");
            let status = if asio_sys::Asio::new().driver_names().is_empty() {
                "No ASIO drivers are installed".to_string()
            } else {
                format!("ASIO didn't start: {e}")
            };
            Asio {
                host: None,
                status,
                devices: Mutex::new(Vec::new()),
            }
        }
    }
});

// Every registered ASIO driver, each loaded once to see that it works: an
// interface's own driver and a wrapper (ASIO4ALL, FlexASIO) alike. This
// handle is our own, used before cpal's loads anything: ASIO holds one
// driver at a time.
#[cfg(all(windows, feature = "asio"))]
fn asio_drivers() -> String {
    let asio = asio_sys::Asio::new();
    let names = asio.driver_names();
    if names.is_empty() {
        return "No ASIO drivers are installed".to_string();
    }
    let drivers: Vec<String> = names
        .into_iter()
        .map(|name| match asio.load_driver(&name) {
            Ok(_) => name,
            Err(asio_sys::LoadDriverError::LoadDriverFailed) => {
                format!("{name} (won't load: the driver didn't start; is its device connected?)")
            }
            Err(e) => format!("{name} (won't load: {e})"),
        })
        .collect();
    format!("ASIO: {}", drivers.join(", "))
}

// One line for Settings: "ASIO: <drivers>", "No ASIO drivers are
// installed", or that this build has no ASIO.
pub fn asio_status() -> String {
    #[cfg(all(windows, feature = "asio"))]
    return ASIO.status.clone();
    #[cfg(not(all(windows, feature = "asio")))]
    "ASIO isn't in this build".to_string()
}

static INPUT_DEVICES: LazyLock<Mutex<HashMap<String, (cpal::Device, DeviceType)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

enum DeviceType {
    #[cfg(all(windows, feature = "asio"))]
    Asio,
    // The platform's default host (WASAPI, CoreAudio, ALSA).
    DefaultHost,
}

impl DeviceType {
    fn is_asio(&self) -> bool {
        match self {
            #[cfg(all(windows, feature = "asio"))]
            DeviceType::Asio => true,
            DeviceType::DefaultHost => false,
        }
    }
}

// The ASIO streams open now (see asio_devices).
static ASIO_STREAMS: AtomicUsize = AtomicUsize::new(0);

// Counts one open ASIO stream until it is dropped.
struct AsioInUse;

impl Drop for AsioInUse {
    fn drop(&mut self) {
        ASIO_STREAMS.fetch_sub(1, Relaxed);
    }
}

// cpal streams aren't Send on purpose: some hosts need a stream dropped on the
// thread that made it. That holds here: every stream is built, paused and
// dropped by the neon functions, which all run on the JS thread; the audio
// threads only ever see the callbacks, never the stream.
struct Stream {
    // Held, not read: dropping it closes the stream.
    _stream: cpal::Stream,
    // After the stream, so it counts until the stream has let its driver go.
    _asio: Option<AsioInUse>,
}

impl Stream {
    fn new(stream: cpal::Stream, device_type: &DeviceType) -> Self {
        let asio = device_type.is_asio().then(|| {
            ASIO_STREAMS.fetch_add(1, Relaxed);
            AsioInUse
        });
        Stream {
            _stream: stream,
            _asio: asio,
        }
    }
}

unsafe impl Send for Stream {}

// A rate and a buffer size as Settings shows them: "48 kHz, 512 samples
// (10.7 ms)", or "48 kHz" before the first callback.
fn describe(rate: cpal::SampleRate, frames: u32) -> String {
    let khz = format!("{}", rate as f64 / 1000.0);
    if frames == 0 {
        return format!("{khz} kHz");
    }
    let ms = frames as f64 * 1000.0 / rate as f64;
    format!("{khz} kHz, {frames} samples ({ms:.1} ms)")
}

// A panic elsewhere shouldn't take the mics down with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// Lets a callback print a kind of message at most once a second.
#[derive(Default)]
struct RateLimit(Option<Instant>);

impl RateLimit {
    fn ready(&mut self) -> bool {
        let now = Instant::now();
        if self
            .0
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(1))
        {
            return false;
        }
        self.0 = Some(now);
        true
    }
}

// A stream's error callback: keeps the first error for `status` and logs it.
// An xrun (a WASAPI capture glitch, an ASIO overload), a default device that
// changed under the stream, or a refused real-time priority leave the stream
// running, so those are only logged.
fn error_callback(
    status: Arc<Mutex<Option<String>>>,
    what: &'static str,
) -> impl FnMut(cpal::Error) + Send + 'static {
    let mut harmless_prints = RateLimit::default();
    move |e| {
        if matches!(
            e.kind(),
            cpal::ErrorKind::Xrun
                | cpal::ErrorKind::DeviceChanged
                | cpal::ErrorKind::RealtimeDenied
        ) {
            if harmless_prints.ready() {
                eprintln!("{what} keeps running after: {e}");
            }
            return;
        }
        let mut status = lock(&status);
        if status.is_none() {
            eprintln!("{what} stopped: {e}");
            *status = Some(e.to_string());
        }
    }
}

// What a mic's callback notes for Settings: the frames per callback, and
// the loudest sample since Settings last asked, before the gain (f32 bits:
// for floats of one sign the bits order as the values do).
#[derive(Default)]
struct Meters {
    frames: AtomicU32,
    peak: AtomicU32,
}

// A mic's levels, set from JS and read once per callback, as f32 bits.
struct Levels {
    gain: AtomicU32,
    echo: AtomicU32,
}

impl Levels {
    fn new(gain: f32, echo: f32) -> Self {
        Levels {
            gain: AtomicU32::new(gain.to_bits()),
            echo: AtomicU32::new(echo.to_bits()),
        }
    }
}

pub struct InputDevice {
    // The open stream, a cpal one or an exclusive one, held to be dropped:
    // None once stopped, which lets the device go at once, not when JS gets
    // round to collecting this.
    input_stream: Option<Box<dyn Send>>,
    // How the mic is open ("Shared", "Exclusive", "ASIO"), and why not as
    // asked if it isn't; its rate (see format), and its meters.
    kind: &'static str,
    note: Option<String>,
    rate: cpal::SampleRate,
    meters: Arc<Meters>,
    source_id: u64,
    levels: Arc<Levels>,
    // Why the input stream stopped, or why the mixer wants it reopened.
    status: Arc<Mutex<Option<String>>>,
    pitch_rx: ringbuf::HeapCons<f32>,
    pitch_sample_count: usize,
    pitch_detector: pitch_detector::PitchDetector,
}

impl Finalize for InputDevice {}

impl Drop for InputDevice {
    fn drop(&mut self) {
        lock(&mixer::MIXER).deregister(self.source_id);
    }
}

impl InputDevice {
    // Each input's id (its key, as saved), its label (what Settings shows)
    // and its best config.
    pub fn collect_devices<Collector: FromIterator<(String, String, cpal::StreamConfig)>>(
    ) -> Result<Collector> {
        _input_devices()?
            .map(|(input_device, device_type)| {
                let mut supported_input_configs: Vec<_> =
                    input_device.supported_input_configs()?.collect();
                supported_input_configs.sort_by(|a, b| compare_configs(a, b, None));
                let best_supported_input_config = supported_input_configs
                    .last()
                    .ok_or("No supported input configs")?;
                let input_config = supported_config_to_config(best_supported_input_config, None);
                Ok((
                    _device_name(&input_device, &device_type),
                    _device_label(&input_device, &device_type),
                    input_config,
                ))
            })
            .collect::<Result<Collector>>()
    }

    pub fn new(name: &str, channel_selection: usize) -> Result<Self> {
        let mut mixer = lock(&mixer::MIXER);
        let output_rate = mixer.open_if_needed()?;
        let device = Self::open(name, channel_selection, output_rate, &mut mixer);
        if device.is_err() {
            mixer.close_if_unused();
        }
        device
    }

    fn open(
        name: &str,
        channel_selection: usize,
        output_rate: cpal::SampleRate,
        mixer: &mut mixer::Mixer,
    ) -> Result<Self> {
        let mut input_devices = lock(&INPUT_DEVICES);
        let (input_device, device_type) = match input_devices.get(name) {
            Some(device) => device,
            None => {
                input_devices.insert(
                    name.to_string(),
                    _input_devices()?
                        .find(|(input_device, device_type)| {
                            _device_name(input_device, device_type) == name
                        })
                        .ok_or(format!("Could not find device: {}", name))?,
                );
                &input_devices[name]
            }
        };
        // Exclusive when it's set and Windows gives the mic; else shared,
        // saying why.
        let mode = *lock(&MIC_MODE);
        let mut note = None;
        if mode.exclusive && !device_type.is_asio() {
            match Self::open_exclusive(
                input_device,
                channel_selection,
                output_rate,
                mode.buffer,
                mixer,
            ) {
                Ok(device) => return Ok(device),
                Err(e) => {
                    eprintln!("Exclusive mode was refused: {e}");
                    note = Some(format!("Exclusive mode was refused: {e}"));
                }
            }
        }

        // Only configs that have the chosen channel, the output's rate first.
        let mut supported_input_configs: Vec<_> = input_device
            .supported_input_configs()?
            .filter(|config| channel_selection < config.channels() as usize)
            .collect();
        supported_input_configs.sort_by(|a, b| compare_configs(a, b, Some(output_rate)));
        let best_supported_input_config = supported_input_configs
            .last()
            .ok_or("No supported input configs")?;
        let input_config =
            supported_config_to_config(best_supported_input_config, Some(output_rate));

        println!(
            "Created input device {} with config {:#?}, sample format {:#?}",
            input_device.id()?,
            input_config,
            best_supported_input_config.sample_format(),
        );

        let status = Arc::new(Mutex::new(None));
        let mut device = with_sample_type!(best_supported_input_config.sample_format(), T => {
            Self::assemble::<T, _>(
                &input_config,
                output_rate,
                channel_selection,
                mixer,
                input_kind(device_type),
                status.clone(),
                |mut callback| {
                    let stream = input_device.build_input_stream(
                        input_config,
                        move |samples: &[T], _: &_| callback(samples),
                        error_callback(status.clone(), "Mic"),
                        None,
                    )?;
                    stream.play()?;
                    Ok(Stream::new(stream, device_type))
                },
            )
        })?;
        device.note = note;
        Ok(device)
    }

    // The mic around a stream that `start` opens, given the mic's callback:
    // the pitch and mixer buffers it feeds, its levels, and its place in the
    // mixer. `status` is where the stream says why it stopped.
    fn assemble<Sample, S: Send + 'static>(
        input_config: &cpal::StreamConfig,
        output_rate: cpal::SampleRate,
        channel_selection: usize,
        mixer: &mut mixer::Mixer,
        kind: &'static str,
        status: Arc<Mutex<Option<String>>>,
        start: impl FnOnce(Box<dyn FnMut(&[Sample]) + Send>) -> Result<S>,
    ) -> Result<Self>
    where
        Sample: cpal::Sample + Copy + 'static,
        f32: cpal::FromSample<Sample>,
    {
        let pitch_sample_count = input_config.sample_rate.div_ceil(40) as usize;
        let (pitch_tx, pitch_rx) = ringbuf::HeapRb::new(pitch_sample_count).split();
        let (output_tx, output_rx) =
            ringbuf::HeapRb::new(mixer::ring_capacity(output_rate)).split();
        let pitch_detector =
            pitch_detector::PitchDetector::new(input_config.sample_rate as f32, pitch_sample_count);
        let levels = Arc::new(Levels::new(1.0, 0.4));
        let meters = Arc::new(Meters::default());

        let callback = Self::input_data_callback::<Sample>(
            input_config,
            output_rate,
            channel_selection,
            levels.clone(),
            meters.clone(),
            pitch_tx,
            output_tx,
        )?;
        let stream = start(Box::new(callback))?;

        let source_id = mixer.register(output_rx, output_rate, status.clone());
        Ok(InputDevice {
            input_stream: Some(Box::new(stream)),
            kind,
            note: None,
            rate: input_config.sample_rate,
            meters,
            source_id,
            levels,
            status,
            pitch_rx,
            pitch_sample_count,
            pitch_detector,
        })
    }

    // A Windows mic in exclusive mode (see exclusive.rs), at the output's
    // rate if it takes it.
    #[cfg(windows)]
    fn open_exclusive(
        input_device: &cpal::Device,
        channel_selection: usize,
        output_rate: cpal::SampleRate,
        buffer: Option<u32>,
        mixer: &mut mixer::Mixer,
    ) -> Result<Self> {
        type Callback = Box<dyn FnMut(&[f32]) + Send>;
        let id = input_device.id()?.to_string();
        let endpoint = id.strip_prefix("wasapi:").unwrap_or(&id);
        let status: Arc<Mutex<Option<String>>> = Arc::default();
        // The stream runs before its format is known, and so before the
        // mic's callback can be made: until it is (a period or two), the
        // sound is dropped.
        let slot: Arc<Mutex<Option<Callback>>> = Arc::default();
        let feed = slot.clone();
        let failed = status.clone();
        let (input, format) = exclusive::ExclusiveInput::open(
            endpoint,
            output_rate,
            buffer,
            move |data| {
                if let Ok(mut callback) = feed.try_lock() {
                    if let Some(callback) = callback.as_mut() {
                        callback(data);
                    }
                }
            },
            move |e| {
                eprintln!("Mic stopped: {e}");
                let mut status = lock(&failed);
                if status.is_none() {
                    *status = Some(e);
                }
            },
        )?;
        if channel_selection >= format.channels as usize {
            return Err(
                format!("The mic has {} channels in exclusive mode", format.channels).into(),
            );
        }
        let input_config = cpal::StreamConfig {
            channels: format.channels,
            sample_rate: format.rate,
            buffer_size: cpal::BufferSize::Fixed(format.frames),
        };
        println!("Created input device {id} in exclusive mode with config {input_config:#?}");
        Self::assemble::<f32, _>(
            &input_config,
            output_rate,
            channel_selection,
            mixer,
            "Exclusive",
            status,
            |callback| {
                *lock(&slot) = Some(callback);
                Ok(input)
            },
        )
    }

    #[cfg(not(windows))]
    fn open_exclusive(
        _: &cpal::Device,
        _: usize,
        _: cpal::SampleRate,
        _: Option<u32>,
        _: &mut mixer::Mixer,
    ) -> Result<Self> {
        Err("exclusive mode is for Windows only".into())
    }

    pub fn get_pitch(&mut self) -> Result<(f32, f32)> {
        let mut samples = vec![0.0; self.pitch_sample_count];
        self.pitch_rx.pop_slice(&mut samples);
        Ok(self.pitch_detector.detect(samples))
    }

    // Linear, 0 to 2: multiplies the dry signal before the reverb.
    pub fn set_gain(&self, gain: f32) {
        self.levels
            .gain
            .store(gain.clamp(0.0, 2.0).to_bits(), Relaxed);
    }

    // 0 to 1: the amount of reverb; 0.4 is the old fixed level.
    pub fn set_echo(&self, echo: f32) {
        self.levels
            .echo
            .store(echo.clamp(0.0, 1.0).to_bits(), Relaxed);
    }

    // "ok"; "ok: <note>" while it works but something is worth saying; or
    // the error that stopped it (the display then reopens it).
    pub fn status(&self) -> String {
        if let Some(error) = lock(&self.status).clone() {
            return error;
        }
        lock(&mixer::MIXER).status()
    }

    // "Shared, 48 kHz, 480 samples (10.0 ms)": how the mic is open, and why
    // not as asked if it isn't.
    pub fn format(&self) -> String {
        let format = format!(
            "{}, {}",
            self.kind,
            describe(self.rate, self.meters.frames.load(Relaxed))
        );
        match &self.note {
            Some(note) => format!("{format}. {note}"),
            None => format,
        }
    }

    // The loudest sample, 0 to 1, since the last time this was asked: what
    // Settings' level meter shows.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.meters.peak.swap(0, Relaxed))
    }

    pub fn stop(&mut self) {
        lock(&mixer::MIXER).deregister(self.source_id);
        self.input_stream = None;
    }

    // The input callback: the chosen channel goes to the pitch buffer as it
    // is, and with gain, reverb and resampling to the output rate to the
    // mixer's buffer (mono).
    fn input_data_callback<Sample: cpal::Sample + Copy>(
        input_config: &cpal::StreamConfig,
        output_rate: cpal::SampleRate,
        channel_selection: usize,
        levels: Arc<Levels>,
        meters: Arc<Meters>,
        mut pitch_tx: ringbuf::HeapProd<f32>,
        mut output_tx: ringbuf::HeapProd<f32>,
    ) -> Result<impl FnMut(&[Sample]) + Send + 'static>
    where
        f32: cpal::FromSample<Sample>,
    {
        let input_rate = input_config.sample_rate;
        let input_channels = input_config.channels as usize;

        let mut reverbs = [
            reverb_module::ReverbModule::new(input_rate, 0.09920, 0.750)?,
            reverb_module::ReverbModule::new(input_rate, 0.06930, 0.720)?,
            reverb_module::ReverbModule::new(input_rate, 0.04836, 0.691)?,
            reverb_module::ReverbModule::new(input_rate, 0.03570, 0.649)?,
            reverb_module::ReverbModule::new(input_rate, 0.02196, 0.662)?,
        ];

        let mut resampler = if input_rate == output_rate {
            None
        } else {
            Some(rubato::Fft::<f32>::new(
                input_rate as usize,
                output_rate as usize,
                RESAMPLER_CHUNK,
                1,
                rubato::FixedSync::Input,
            )?)
        };
        // Rubato may round the chunk size to suit the two rates.
        let chunk_len = resampler.as_ref().map_or(0, |r| r.input_frames_next());
        let mut pending: Vec<f32> = Vec::with_capacity(chunk_len);
        let mut resampled = vec![0.0; resampler.as_ref().map_or(0, |r| r.output_frames_max())];
        // The FFT resampler primes its overlap-add buffers with silence, so the
        // first `output_delay()` output frames are the algorithmic delay. Drop
        // them once at startup so the output stays aligned with the input.
        let mut resampler_delay = resampler.as_ref().map_or(0, |r| r.output_delay());

        let mut mono: Vec<f32> = Vec::new();
        let mut full_prints = RateLimit::default();
        let mut error_prints = RateLimit::default();

        Ok(move |samples: &[Sample]| {
            meters
                .frames
                .store((samples.len() / input_channels) as u32, Relaxed);
            mono.clear();
            mono.extend(samples.chunks(input_channels).map(|frame| {
                frame
                    .get(channel_selection)
                    .map_or(0.0, |sample| <f32 as cpal::Sample>::from_sample(*sample))
            }));

            pitch_tx.push_slice(&mono);
            let peak = mono.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
            meters.peak.fetch_max(peak.to_bits(), Relaxed);

            let gain = f32::from_bits(levels.gain.load(Relaxed));
            let echo = f32::from_bits(levels.echo.load(Relaxed));
            mono.iter_mut().for_each(|sample| *sample *= gain);
            let mut reverb_samples: Vec<_> = mono.iter().map(|s| s * 0.5 * echo).collect();
            for reverb in &mut reverbs {
                reverb_samples = reverb.process(reverb_samples.as_slice());
            }
            mono.iter_mut()
                .zip(reverb_samples)
                .for_each(|(dry, wet)| *dry += wet);

            let mut dropped = 0;
            match &mut resampler {
                None => dropped += mono.len() - output_tx.push_slice(&mono),
                Some(resampler) => {
                    for &sample in &mono {
                        pending.push(sample);
                        if pending.len() < chunk_len {
                            continue;
                        }
                        match resample_chunk(resampler, &pending, &mut resampled) {
                            Ok(produced) => {
                                let skip = resampler_delay.min(produced);
                                resampler_delay -= skip;
                                let chunk = &resampled[skip..produced];
                                dropped += chunk.len() - output_tx.push_slice(chunk);
                            }
                            Err(e) => {
                                if error_prints.ready() {
                                    eprintln!("resampling error: {e}");
                                }
                            }
                        }
                        pending.clear();
                    }
                }
            }
            if dropped > 0 && full_prints.ready() {
                eprintln!("mic buffer full: dropped {dropped} samples");
            }
        })
    }
}

// Resamples one whole chunk; returns how many output frames it made.
fn resample_chunk(
    resampler: &mut rubato::Fft<f32>,
    chunk: &[f32],
    output: &mut [f32],
) -> Result<usize> {
    let input = InterleavedSlice::new(chunk, 1, chunk.len())?;
    let output_len = output.len();
    let mut output = InterleavedSlice::new_mut(output, 1, output_len)?;
    let (_consumed, produced) = resampler.process_into_buffer(&input, &mut output, None)?;
    Ok(produced)
}

fn compare_configs(
    a: &cpal::SupportedStreamConfigRange,
    b: &cpal::SupportedStreamConfigRange,
    desired_sample_rate: Option<cpal::SampleRate>,
) -> Ordering {
    // Our priorities in order are the desired sample rate (being in range is
    // good enough), buffer size (lower is better), sample rate (higher is
    // better), and channel count (higher is better).
    if let Some(sample_rate) = desired_sample_rate {
        let a_in_range = sample_rate >= a.min_sample_rate() && sample_rate <= a.max_sample_rate();
        let b_in_range = sample_rate >= b.min_sample_rate() && sample_rate <= b.max_sample_rate();
        if !a_in_range && b_in_range {
            return Ordering::Less;
        }
        if a_in_range && !b_in_range {
            return Ordering::Greater;
        }
    }
    if a.buffer_size() == &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() != &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Less;
    }
    if a.buffer_size() != &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() == &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Greater;
    }
    if let cpal::SupportedBufferSize::Range { min, max: _ } = a.buffer_size() {
        let a_min = min;
        if let cpal::SupportedBufferSize::Range { min, max: _ } = b.buffer_size() {
            let b_min = min;
            let buffer_size_cmp = a_min.cmp(b_min);
            if buffer_size_cmp != Ordering::Equal {
                return buffer_size_cmp.reverse();
            }
        }
    }

    let sample_rate_cmp = a.max_sample_rate().cmp(&b.max_sample_rate());
    if sample_rate_cmp != Ordering::Equal {
        return sample_rate_cmp;
    }

    let channels_cmp = a.channels().cmp(&b.channels());
    if channels_cmp != Ordering::Equal {
        return channels_cmp;
    }

    a.cmp_default_heuristics(b)
}

// The desired sample rate when the range has it, else its highest.
fn supported_config_to_config(
    config_range: &cpal::SupportedStreamConfigRange,
    desired_sample_rate: Option<cpal::SampleRate>,
) -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels: config_range.channels(),
        sample_rate: desired_sample_rate
            .filter(|rate| {
                (config_range.min_sample_rate()..=config_range.max_sample_rate()).contains(rate)
            })
            .unwrap_or(config_range.max_sample_rate()),
        buffer_size: match config_range.buffer_size() {
            // WASAPI lies about buffer size ranges and doesn't repect fixed size requests
            #[cfg(not(windows))]
            cpal::SupportedBufferSize::Range { min, max: _ } => cpal::BufferSize::Fixed(*min),
            _ => cpal::BufferSize::Default,
        },
    }
}

fn _input_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let devices = cpal::default_host()
        .input_devices()?
        .map(|device| (device, DeviceType::DefaultHost));
    #[cfg(all(windows, feature = "asio"))]
    let devices = devices.chain(asio_devices(DeviceTrait::supports_input));
    Ok(devices)
}

fn _output_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let devices = cpal::default_host()
        .output_devices()?
        .map(|device| (device, DeviceType::DefaultHost));
    #[cfg(all(windows, feature = "asio"))]
    let devices = devices.chain(asio_devices(DeviceTrait::supports_output));
    Ok(devices)
}

// The ASIO host's devices that `wanted` keeps; none when it didn't start
// (the ASIO status says why), so the platform's devices always list. ASIO
// holds one driver at a time, and while a stream has one, cpal's listing
// stops at the first other driver: the interface the mics play through
// would vanish from Settings. So they are listed while no ASIO stream is
// open, and that list stands meanwhile. (A cpal ASIO device is only a
// description: a stream loads its driver when it opens.)
#[cfg(all(windows, feature = "asio"))]
fn asio_devices(
    wanted: fn(&cpal::Device) -> bool,
) -> std::vec::IntoIter<(cpal::Device, DeviceType)> {
    let Some(host) = ASIO.host.as_ref() else {
        return Vec::new().into_iter();
    };
    let mut devices = lock(&ASIO.devices);
    if ASIO_STREAMS.load(Relaxed) == 0 {
        match host.devices() {
            Ok(listed) => *devices = listed.collect(),
            Err(e) => eprintln!("The ASIO devices are left out: {e}"),
        }
    }
    devices
        .iter()
        .filter(|device| wanted(device))
        .map(|device| (device.clone(), DeviceType::Asio))
        .collect::<Vec<_>>()
        .into_iter()
}

// How a mic is open, for its format line.
fn input_kind(device_type: &DeviceType) -> &'static str {
    match device_type {
        #[cfg(all(windows, feature = "asio"))]
        DeviceType::Asio => "ASIO",
        DeviceType::DefaultHost if cfg!(windows) => "Shared",
        DeviceType::DefaultHost => "System",
    }
}

// What an input's id and label end with.
fn input_host(device_type: &DeviceType) -> &'static str {
    match device_type {
        #[cfg(all(windows, feature = "asio"))]
        DeviceType::Asio => "ASIO",
        DeviceType::DefaultHost => "USB",
    }
}

// An input's key: its id and "(USB)" for the default host, the form saved
// mics have.
fn _device_name(device: &cpal::Device, device_type: &DeviceType) -> String {
    format!("{} ({})", device.id().unwrap(), input_host(device_type))
}

// An input's label: what the system calls it ("Yeti Stereo Microphone
// (USB)"), or its id if the system won't say.
fn _device_label(device: &cpal::Device, device_type: &DeviceType) -> String {
    match device.description() {
        Ok(description) => format!("{} ({})", description.name(), input_host(device_type)),
        Err(_) => _device_name(device, device_type),
    }
}

// An output's name: what the system calls it, and the host.
fn _output_name(device: &cpal::Device, device_type: &DeviceType) -> Result<String> {
    let host = match device_type {
        #[cfg(all(windows, feature = "asio"))]
        DeviceType::Asio => "ASIO",
        DeviceType::DefaultHost if cfg!(windows) => "Windows",
        DeviceType::DefaultHost if cfg!(target_os = "macos") => "Mac",
        DeviceType::DefaultHost => "Linux",
    };
    Ok(format!("{} ({host})", device.description()?.name()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitch_detector::{freq2midi, PitchDetector};
    use wavegen::{sine, wf};

    fn config(sample_rate: cpal::SampleRate) -> cpal::StreamConfig {
        cpal::StreamConfig {
            channels: 1,
            sample_rate,
            buffer_size: cpal::BufferSize::Default,
        }
    }

    fn sine_samples(sample_rate: cpal::SampleRate, count: usize) -> Vec<f32> {
        wf!(f32, sample_rate as f32, sine!(185.0_f32, 1.0_f32, 0.0_f32))
            .iter()
            .take(count)
            .collect()
    }

    // Runs the input callback over `samples` in callbacks of `sizes` (in
    // turn), returning what reached the pitch and output buffers.
    fn run_input_callback(
        input_rate: cpal::SampleRate,
        output_rate: cpal::SampleRate,
        levels: Levels,
        samples: &[f32],
        sizes: &[usize],
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let (pitch_tx, mut pitch_rx) = ringbuf::HeapRb::new(samples.len() + 1).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(samples.len() * 4 + 1).split();
        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &config(input_rate),
            output_rate,
            0,
            Arc::new(levels),
            Arc::default(),
            pitch_tx,
            output_tx,
        )?;
        let mut rest = samples;
        for size in sizes.iter().cycle() {
            if rest.is_empty() {
                break;
            }
            let (callback, next) = rest.split_at((*size).min(rest.len()));
            input_callback(callback);
            rest = next;
        }
        Ok((
            pitch_rx.pop_iter().collect(),
            output_rx.pop_iter().collect(),
        ))
    }

    // Odd sizes, as WASAPI hands them out; none a multiple of the chunk.
    const ODD_SIZES: &[usize] = &[441, 37, 1000, 3, 777, 2049, 128];

    // Nothing is lost across callbacks: one second in makes one second out,
    // short by at most one chunk waiting for the next callback (and the
    // resampler's delay, dropped once at the start).
    fn assert_no_sample_loss(input_rate: cpal::SampleRate, output_rate: cpal::SampleRate) {
        let samples = sine_samples(input_rate, input_rate as usize);
        let (pitch, output) = run_input_callback(
            input_rate,
            output_rate,
            Levels::new(1.0, 0.4),
            &samples,
            ODD_SIZES,
        )
        .unwrap();
        assert_eq!(pitch.len(), samples.len());
        let resampler = rubato::Fft::<f32>::new(
            input_rate as usize,
            output_rate as usize,
            RESAMPLER_CHUNK,
            1,
            rubato::FixedSync::Input,
        )
        .unwrap();
        let expected = samples.len() as f64 * output_rate as f64 / input_rate as f64
            - resampler.output_delay() as f64;
        let one_chunk = resampler.output_frames_max() as f64;
        let produced = output.len() as f64;
        assert!(
            produced <= expected + 1.0 && produced >= expected - one_chunk,
            "{} -> {}: expected about {}, got {}",
            input_rate,
            output_rate,
            expected,
            produced
        );
    }

    #[test]
    fn test_no_sample_loss_44_1_to_48() {
        assert_no_sample_loss(44100, 48000);
    }

    #[test]
    fn test_no_sample_loss_96_to_48() {
        assert_no_sample_loss(96000, 48000);
    }

    #[test]
    fn test_same_rate_passes_every_sample() -> Result<()> {
        let samples = sine_samples(48000, 48000);
        let (_, output) =
            run_input_callback(48000, 48000, Levels::new(1.0, 0.0), &samples, ODD_SIZES)?;
        assert_eq!(output, samples);
        Ok(())
    }

    #[test]
    fn test_gain_scales_the_output_not_the_pitch() -> Result<()> {
        let samples = sine_samples(48000, 4800);
        for gain in [0.0, 0.5, 2.0] {
            let (pitch, output) =
                run_input_callback(48000, 48000, Levels::new(gain, 0.0), &samples, ODD_SIZES)?;
            assert_eq!(pitch, samples);
            let scaled: Vec<f32> = samples.iter().map(|s| s * gain).collect();
            assert_eq!(output, scaled);
        }
        Ok(())
    }

    // Echo 0.4 at gain 1 is the old sound: the dry signal plus the reverb of
    // 0.2 of it. The echo rings on in the output after the input goes
    // silent, while the pitch buffer gets the clean signal.
    #[test]
    fn test_echo_is_the_reverb() -> Result<()> {
        let rate = 44100;
        let mut samples = sine_samples(rate, 4410);
        samples.extend(vec![0.0; 4410]);
        let (pitch, output) =
            run_input_callback(rate, rate, Levels::new(1.0, 0.4), &samples, &[256])?;
        assert_eq!(pitch, samples);

        let mut reverbs = [
            reverb_module::ReverbModule::new(rate, 0.09920, 0.750)?,
            reverb_module::ReverbModule::new(rate, 0.06930, 0.720)?,
            reverb_module::ReverbModule::new(rate, 0.04836, 0.691)?,
            reverb_module::ReverbModule::new(rate, 0.03570, 0.649)?,
            reverb_module::ReverbModule::new(rate, 0.02196, 0.662)?,
        ];
        let mut expected = Vec::new();
        for chunk in samples.chunks(256) {
            let mut wet: Vec<f32> = chunk.iter().map(|s| s * 0.2).collect();
            for reverb in &mut reverbs {
                wet = reverb.process(&wet);
            }
            expected.extend(chunk.iter().zip(wet).map(|(dry, wet)| dry + wet));
        }
        assert_eq!(output.len(), expected.len());
        for (a, b) in output.iter().zip(&expected) {
            assert!((a - b).abs() < 1e-6);
        }
        assert!(output[4410..].iter().any(|s| s.abs() > 0.01));

        // One callback longer than the reverb's delays sounds the same.
        let (_, long) = run_input_callback(rate, rate, Levels::new(1.0, 0.4), &samples, &[8820])?;
        assert_eq!(long.len(), output.len());
        for (a, b) in long.iter().zip(&output) {
            assert!((a - b).abs() < 1e-6);
        }

        // No echo: no tail.
        let (_, dry) = run_input_callback(rate, rate, Levels::new(1.0, 0.0), &samples, &[256])?;
        assert_eq!(dry, samples);
        Ok(())
    }

    // Resampling keeps the pitch; the pitch buffer gets the mic's own rate.
    fn assert_resampled_pitch(input_rate: cpal::SampleRate, output_rate: cpal::SampleRate) {
        let samples = sine_samples(input_rate, input_rate as usize / 4);
        let (pitch, output) = run_input_callback(
            input_rate,
            output_rate,
            Levels::new(1.0, 0.0),
            &samples,
            &[256],
        )
        .unwrap();
        let pitch_sample_count = output_rate.div_ceil(40) as usize;
        let pd = PitchDetector::new(output_rate as f32, pitch_sample_count);
        let (midi_number, confidence) = pd.detect(output[..pitch_sample_count].to_vec());
        assert!((midi_number - freq2midi(185.0)).abs() < 0.001);
        assert!(confidence > 0.999);
        assert_eq!(pitch, samples);
    }

    #[test]
    fn test_input_callback_upsampling() {
        assert_resampled_pitch(44100, 96000);
    }

    #[test]
    fn test_input_callback_downsampling() {
        assert_resampled_pitch(96000, 44100);
    }

    // The meter sees the mic before the gain, and starts over once read.
    #[test]
    fn test_the_meter_holds_the_loudest_sample() -> Result<()> {
        let (pitch_tx, _pitch_rx) = ringbuf::HeapRb::new(16).split();
        let (output_tx, _output_rx) = ringbuf::HeapRb::new(16).split();
        let meters = Arc::new(Meters::default());
        let mut callback = InputDevice::input_data_callback::<f32>(
            &config(48000),
            48000,
            0,
            Arc::new(Levels::new(0.0, 0.0)),
            meters.clone(),
            pitch_tx,
            output_tx,
        )?;
        callback(&[0.1, -0.5, 0.25]);
        callback(&[0.2]);
        assert_eq!(f32::from_bits(meters.peak.swap(0, Relaxed)), 0.5);
        assert_eq!(f32::from_bits(meters.peak.load(Relaxed)), 0.0);
        assert_eq!(meters.frames.load(Relaxed), 1);
        Ok(())
    }

    #[test]
    fn test_an_xrun_keeps_the_stream() {
        let status = Arc::new(Mutex::new(None));
        let mut callback = error_callback(status.clone(), "Mic");
        callback(cpal::Error::new(cpal::ErrorKind::Xrun));
        callback(cpal::Error::new(cpal::ErrorKind::DeviceChanged));
        assert_eq!(*lock(&status), None);
        // Anything else stops it.
        callback(cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable));
        assert!(lock(&status).is_some());
    }

    // The tests that list devices take turns: two threads loading ASIO
    // drivers at once crash (the app lists them from one thread only).
    static DEVICES: Mutex<()> = Mutex::new(());

    // Lists the outputs without opening any. CI machines may have no audio
    // system at all, so only the names are checked.
    #[test]
    fn test_output_device_names() {
        let _devices = lock(&DEVICES);
        if let Ok(names) = output_devices() {
            for name in names {
                assert!(
                    name.ends_with(" (Windows)")
                        || name.ends_with(" (Mac)")
                        || name.ends_with(" (Linux)")
                        || name.ends_with(" (ASIO)"),
                    "{}",
                    name
                );
            }
        }
    }

    // Lists the inputs without opening any: each has its key and a label,
    // with the same host.
    #[test]
    fn test_input_device_ids_and_labels() {
        let _devices = lock(&DEVICES);
        if let Ok(devices) = InputDevice::collect_devices::<Vec<_>>() {
            for (id, label, _) in &devices {
                let host = if id.ends_with(" (ASIO)") {
                    " (ASIO)"
                } else {
                    " (USB)"
                };
                assert!(id.ends_with(host), "{}", id);
                assert!(label.ends_with(host), "{}: {}", id, label);
            }
        }
    }

    #[test]
    fn test_asio_status() {
        let _devices = lock(&DEVICES);
        let status = asio_status();
        if cfg!(all(windows, feature = "asio")) {
            assert!(
                status == "No ASIO drivers are installed"
                    || status.starts_with("ASIO: ")
                    || status.starts_with("ASIO didn't start: "),
                "{}",
                status
            );
        } else {
            assert_eq!(status, "ASIO isn't in this build");
        }
    }
}
