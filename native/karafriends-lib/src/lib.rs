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
            cpal::SampleFormat::U24 => {
                type $T = cpal::U24;
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
            cpal::SampleFormat::I24 => {
                type $T = cpal::I24;
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
#[cfg(target_os = "linux")]
mod linux;
mod mixer;
mod pitch_detector;
mod reverb_module;

use std::collections::HashMap;
use std::iter::Iterator;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, TryLockError, Weak};
use std::time::{Duration, Instant};

#[cfg(not(target_os = "linux"))]
use cpal::traits::HostTrait;
use cpal::traits::{DeviceTrait, StreamTrait};
use neon::prelude::Finalize;
use ringbuf::traits::{Producer, Split};
use rubato::Resampler;
use rubato::audioadapter_buffers::direct::InterleavedSlice;

pub use mixer::{output_devices, output_format, output_options, output_status, set_output_device};

// How the platform's mics open: exclusive (Windows only, see exclusive.rs)
// with a buffer size in frames (None: the mic's smallest), or shared. On
// Linux the buffer size is for the mics and their output alike (None:
// linux::default_buffer).
#[derive(Clone, Copy)]
struct MicMode {
    exclusive: bool,
    buffer: Option<u32>,
}

static MIC_MODE: Mutex<MicMode> = Mutex::new(MicMode {
    exclusive: false,
    buffer: None,
});

// For the mics opened from now on. On Linux the mic output, if open,
// reopens at the new buffer size.
pub fn set_mic_mode(exclusive: bool, buffer: Option<u32>) {
    *lock(&MIC_MODE) = MicMode { exclusive, buffer };
    #[cfg(target_os = "linux")]
    if let Err(e) = lock(&mixer::MIXER).reopen() {
        eprintln!("The mic output didn't reopen: {e}");
    }
}

// The buffer size in frames the mics and their output ask for on Linux.
#[cfg(target_os = "linux")]
fn linux_buffer() -> u32 {
    lock(&MIC_MODE).buffer.unwrap_or_else(linux::default_buffer)
}

// For Settings on Linux: the sound system ("Sound system: PipeWire 1.6.2"),
// the buffer sizes it takes, and the one used until one is picked. None
// elsewhere.
pub struct LinuxAudio {
    pub status: String,
    pub buffer_sizes: Vec<u32>,
    pub default_buffer: u32,
}

pub fn linux_audio() -> Option<LinuxAudio> {
    #[cfg(target_os = "linux")]
    return Some(match linux::system_host() {
        Ok((host, why)) => LinuxAudio {
            status: linux::status(&host, why),
            buffer_sizes: linux::buffer_sizes(&host),
            default_buffer: linux::default_buffer(),
        },
        Err(e) => LinuxAudio {
            status: linux::status_without_host(&e.to_string()),
            buffer_sizes: Vec::new(),
            default_buffer: linux::default_buffer(),
        },
    });
    #[cfg(not(target_os = "linux"))]
    None
}

// The platform's own host: WASAPI, CoreAudio, or on Linux the sound system
// linux.rs picks (PipeWire, PulseAudio or ALSA), shared for a second.
fn system_host() -> Result<std::rc::Rc<cpal::Host>> {
    #[cfg(target_os = "linux")]
    return Ok(linux::system_host()?.0);
    #[cfg(not(target_os = "linux"))]
    Ok(std::rc::Rc::new(cpal::default_host()))
}

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

// A console window for the module's prints, on Windows. A process that has
// one (started from a terminal) is refused with "Access is denied (os
// error 5)", which the main process lets pass.
pub fn alloc_console() -> Result<()> {
    #[cfg(windows)]
    {
        use windows::Win32::System::Console::{AllocConsole, SetConsoleTitleW};
        // As the system's own code ("os error 5"): a failed call's HRESULT
        // holds it in its low 16 bits.
        let os_error =
            |e: windows::core::Error| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF);
        unsafe {
            AllocConsole().map_err(os_error)?;
            SetConsoleTitleW(windows::core::w!("karafriends native console")).map_err(os_error)?;
        }
    }
    Ok(())
}

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

#[derive(Clone)]
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

    fn is_asio(&self) -> bool {
        self._asio.is_some()
    }
}

unsafe impl Send for Stream {}

// A mic's open stream, held to be dropped, which closes it.
trait MicStream: Send {
    // The mic stopped sending sound (see Stall): a stream other mics share
    // isn't joined again.
    fn stalled(&self, _why: &str) {}

    // Whether it holds an ASIO driver (see Mixer::release_asio).
    fn is_asio(&self) -> bool {
        false
    }
}

impl MicStream for Stream {
    fn is_asio(&self) -> bool {
        Stream::is_asio(self)
    }
}

// Where a mic's stream is held: None once stopped, which lets the device go
// at once, not when JS gets round to collecting the mic. Shared with the
// mixer for an ASIO mic, which it may have to let go of first (see
// Mixer::release_asio).
type StreamSlot = Arc<Mutex<Option<Box<dyn MicStream>>>>;

// Streams that several mics read: in exclusive mode Windows gives a mic to
// one stream at a time, and each packet has every channel, so the mics on
// its channels share one. Built everywhere, so its tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
mod shared {
    use super::*;

    // A mic's callback, given its stream's samples (every channel,
    // interleaved).
    pub(crate) type MicCallback = Box<dyn FnMut(&[f32]) + Send>;

    // One mic reading a shared stream: its callback, and its status, which
    // the stream sets when it stops.
    struct Tap {
        id: u64,
        callback: MicCallback,
        status: Arc<Mutex<Option<String>>>,
    }

    // What a shared stream's thread shares with the mics on it: their
    // callbacks, why it stopped (or stalled), why it isn't real-time, and
    // the packets it lost.
    #[derive(Clone, Default)]
    pub(crate) struct Taps {
        taps: Arc<Mutex<Vec<Tap>>>,
        failed: Arc<Mutex<Option<String>>>,
        pub(crate) realtime: Arc<Mutex<Option<String>>>,
        pub(crate) lost: Arc<AtomicU32>,
    }

    impl Taps {
        // For the stream's thread: hands each packet to every mic. While a
        // mic is added or removed (the JS thread holds the lock only for
        // that), the packet is dropped rather than the thread made to wait.
        pub(crate) fn on_data(&self) -> impl FnMut(&[f32]) + Send + 'static + use<> {
            let taps = self.taps.clone();
            move |data| {
                let mut taps = match taps.try_lock() {
                    Ok(taps) => taps,
                    Err(TryLockError::Poisoned(e)) => e.into_inner(),
                    Err(TryLockError::WouldBlock) => return,
                };
                for tap in taps.iter_mut() {
                    (tap.callback)(data);
                }
            }
        }

        // For the stream's thread, when the stream stops by itself.
        pub(crate) fn on_error(&self) -> impl FnOnce(String) + Send + 'static + use<> {
            let taps = self.clone();
            move |e| {
                eprintln!("Mic stopped: {e}");
                taps.fail(&e);
            }
        }

        // The stream is done: every mic on it says why (the first reason
        // stands), so the display reopens them.
        fn fail(&self, why: &str) {
            lock(&self.failed).get_or_insert_with(|| why.to_string());
            for tap in lock(&self.taps).iter() {
                lock(&tap.status).get_or_insert_with(|| why.to_string());
            }
        }
    }

    // One stream, `S`, that several mics read, opened with `request` at
    // `format`.
    pub(crate) struct SharedInput<S, F, R> {
        request: R,
        pub(crate) format: F,
        // None once closed.
        stream: Mutex<Option<S>>,
        pub(crate) taps: Taps,
        next_id: AtomicU64,
    }

    impl<S, F, R> SharedInput<S, F, R> {
        // Whether it still runs: open, and it hasn't failed or stalled.
        pub(crate) fn running(&self) -> bool {
            lock(&self.stream).is_some() && lock(&self.taps.failed).is_none()
        }

        // Closes the stream now, letting the device go, and has the mics on
        // it reopened.
        fn close(&self, why: &str) {
            let stream = lock(&self.stream).take();
            drop(stream);
            self.taps.fail(why);
        }

        // A mic on the stream, with its callback and status, until dropped.
        pub(crate) fn tap(
            self: &Arc<Self>,
            callback: MicCallback,
            status: Arc<Mutex<Option<String>>>,
        ) -> SharedTap<S, F, R> {
            let id = self.next_id.fetch_add(1, Relaxed);
            lock(&self.taps.taps).push(Tap {
                id,
                callback,
                status,
            });
            SharedTap {
                input: self.clone(),
                id,
            }
        }
    }

    // A mic's place on a shared stream: dropping it takes its callback off,
    // and the last one off closes the stream.
    pub(crate) struct SharedTap<S, F, R> {
        input: Arc<SharedInput<S, F, R>>,
        id: u64,
    }

    impl<S, F, R> Drop for SharedTap<S, F, R> {
        fn drop(&mut self) {
            let mut taps = lock(&self.input.taps.taps);
            let gone = taps
                .iter()
                .position(|tap| tap.id == self.id)
                .map(|i| taps.remove(i));
            drop(taps);
            // The callback goes after the lock: it holds the mic's buffers.
            drop(gone);
        }
    }

    impl<S: Send, F: Send + Sync, R: Send + Sync> MicStream for SharedTap<S, F, R> {
        fn stalled(&self, why: &str) {
            lock(&self.input.taps.failed).get_or_insert_with(|| why.to_string());
        }
    }

    // The shared streams open now, by device.
    pub(crate) struct SharedInputs<S, F, R> {
        inputs: HashMap<String, Weak<SharedInput<S, F, R>>>,
    }

    impl<S, F, R> Default for SharedInputs<S, F, R> {
        fn default() -> Self {
            SharedInputs {
                inputs: HashMap::new(),
            }
        }
    }

    impl<S, F, R: PartialEq> SharedInputs<S, F, R> {
        // The stream open on `key` if it was opened with `request` and
        // still runs. Else a new one that `open` opens, given what its
        // thread shares with the mics, at the format it returns. Another
        // stream on `key` is closed first, as the device takes one at a
        // time, and the mics on it are reopened onto the new one.
        pub(crate) fn get_or_open(
            &mut self,
            key: &str,
            request: R,
            open: impl FnOnce(&Taps) -> Result<(S, F)>,
        ) -> Result<Arc<SharedInput<S, F, R>>> {
            if let Some(input) = self.inputs.get(key).and_then(Weak::upgrade) {
                if input.request == request && input.running() {
                    return Ok(input);
                }
                input.close("Another mic on this device reopened it with new settings");
            }
            self.inputs.retain(|_, input| input.strong_count() > 0);
            let taps = Taps::default();
            let (stream, format) = open(&taps)?;
            let input = Arc::new(SharedInput {
                request,
                format,
                stream: Mutex::new(Some(stream)),
                taps,
                next_id: AtomicU64::new(0),
            });
            self.inputs.insert(key.to_string(), Arc::downgrade(&input));
            Ok(input)
        }

        // Closes the stream on `key`, if one is open, and has the mics on it
        // reopened.
        pub(crate) fn close(&mut self, key: &str, why: &str) {
            if let Some(input) = self.inputs.remove(key).and_then(|input| input.upgrade()) {
                input.close(why);
            }
        }
    }
}

#[cfg(any(windows, test))]
use shared::SharedInputs;
#[cfg(test)]
use shared::{MicCallback, SharedInput};

// Windows' exclusive streams, by endpoint id, opened at a rate and buffer
// size.
#[cfg(windows)]
type ExclusiveInputs =
    SharedInputs<exclusive::ExclusiveInput, exclusive::ExclusiveFormat, (u32, Option<u32>)>;

#[cfg(windows)]
static EXCLUSIVE: LazyLock<Mutex<ExclusiveInputs>> = LazyLock::new(Mutex::default);

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
// running, so those are only logged; the first refusal is also kept for the
// format line (`realtime`), as it makes a small buffer crackle.
fn error_callback(
    status: Arc<Mutex<Option<String>>>,
    realtime: Arc<Mutex<Option<String>>>,
    what: &'static str,
) -> impl FnMut(cpal::Error) + Send + 'static {
    let mut harmless_prints = RateLimit::default();
    move |e| {
        if e.kind() == cpal::ErrorKind::RealtimeDenied {
            let mut realtime = lock(&realtime);
            if realtime.is_none() {
                eprintln!("{what} isn't real-time: {e}");
                *realtime = Some(e.to_string());
            }
            return;
        }
        if matches!(
            e.kind(),
            cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged
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
// for floats of one sign the bits order as the values do). For its status,
// a count of its callbacks (see Stall). And for its pitch, whether its
// noise gate let its latest sound through.
#[derive(Default)]
struct Meters {
    frames: AtomicU32,
    peak: AtomicU32,
    callbacks: AtomicU32,
    gate_open: AtomicBool,
}

// A mic's noise gate: its sound fades out once it stays under the threshold
// (the loudest sample, before the gain, as the meter shows it) for
// GATE_HOLD, so the gaps between words don't chop, and fades back in within
// GATE_OPEN of a sample over it.
const GATE_OPEN: Duration = Duration::from_millis(2);
const GATE_HOLD: Duration = Duration::from_millis(200);
const GATE_CLOSE: Duration = Duration::from_millis(150);

struct Gate {
    // How far the gate's gain moves each sample, opening and closing.
    open_step: f32,
    close_step: f32,
    hold_frames: u32,
    // Samples left before it starts to close.
    held: u32,
    gain: f32,
}

impl Gate {
    fn new(rate: u32) -> Self {
        let frames = |time: Duration| (time.as_secs_f32() * rate as f32).max(1.0);
        Gate {
            open_step: 1.0 / frames(GATE_OPEN),
            close_step: 1.0 / frames(GATE_CLOSE),
            hold_frames: frames(GATE_HOLD) as u32,
            held: 0,
            gain: 1.0,
        }
    }

    // Gates the samples in place by threshold (0 to 1; 0 is off, which
    // passes everything). Whether any of them got through.
    fn process(&mut self, samples: &mut [f32], threshold: f32) -> bool {
        if threshold <= 0.0 {
            self.held = self.hold_frames;
            self.gain = 1.0;
            return true;
        }
        let mut through = false;
        for sample in samples.iter_mut() {
            if sample.abs() >= threshold {
                self.held = self.hold_frames;
            } else {
                self.held = self.held.saturating_sub(1);
            }
            self.gain = if self.held > 0 {
                (self.gain + self.open_step).min(1.0)
            } else {
                (self.gain - self.close_step).max(0.0)
            };
            *sample *= self.gain;
            through |= self.gain > 0.0;
        }
        through
    }
}

// A stream that stops calling back without saying so (an ASIO driver that
// stops calling bufferSwitch, a WASAPI client that stops getting events, a
// PulseAudio source that went away) is as good as stopped: its status says
// so, and the display reopens it. A stream gets STALL_START to call back the
// first time (a Bluetooth headset can take a moment to switch its mic on),
// then STALL between callbacks. The display asks every 2 seconds.
const STALL: Duration = Duration::from_millis(1900);
const STALL_START: Duration = Duration::from_secs(5);

// Whether a stream's callback count has moved, as its status is asked.
struct Stall {
    count: u32,
    // When the count was last seen to move (or the stream opened).
    since: Instant,
}

impl Stall {
    fn new(now: Instant) -> Self {
        Stall {
            count: 0,
            since: now,
        }
    }

    // True once `count` has stood still too long.
    fn stalled(&mut self, count: u32, now: Instant) -> bool {
        if count != self.count {
            self.count = count;
            self.since = now;
            return false;
        }
        let limit = if count == 0 { STALL_START } else { STALL };
        now.saturating_duration_since(self.since) >= limit
    }
}

// A mic's levels, set from JS and read once per callback, as f32 bits. The
// noise gate starts off.
struct Levels {
    gain: AtomicU32,
    echo: AtomicU32,
    gate: AtomicU32,
}

impl Levels {
    fn new(gain: f32, echo: f32) -> Self {
        Levels {
            gain: AtomicU32::new(gain.to_bits()),
            echo: AtomicU32::new(echo.to_bits()),
            gate: AtomicU32::new(0.0_f32.to_bits()),
        }
    }
}

pub struct InputDevice {
    // The open stream, a cpal one or an exclusive one (see StreamSlot).
    input_stream: StreamSlot,
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
    // Why its thread isn't real-time, if the system refused, and how many
    // packets the system lost (exclusive mode says).
    realtime: Arc<Mutex<Option<String>>>,
    lost: Arc<AtomicU32>,
    // Whether its callbacks stopped (see Stall).
    stall: Mutex<Stall>,
    pitch: pitch_detector::PitchWindow,
    // On PipeWire, the node it opened on, for status to see it go.
    #[cfg(target_os = "linux")]
    node: Option<linux::OpenedNode>,
}

impl Finalize for InputDevice {}

impl Drop for InputDevice {
    fn drop(&mut self) {
        self.stop_stream();
        lock(&mixer::MIXER).deregister(self.source_id);
    }
}

impl InputDevice {
    // Each input's id (its key, as saved), its label (what Settings shows)
    // and the channels Settings offers. An input that won't say is left
    // out, not the whole list.
    pub fn collect_devices() -> Result<Vec<(String, String, u16)>> {
        Ok(kept(
            "An input",
            _input_devices()?.map(|(input_device, device_type)| -> Result<_> {
                let name = _device_name(&input_device, &device_type)?;
                let channels =
                    listed_channels(&input_device).map_err(|e| format!("{name}: {e}"))?;
                let label = _device_label(&input_device, &device_type, &name);
                Ok((name, label, channels))
            }),
        ))
    }

    pub fn new(name: &str, channel_selection: usize) -> Result<Self> {
        let (input_device, device_type) = find_input(name)?;
        let opened = Self::open(&input_device, &device_type, channel_selection);
        #[cfg(target_os = "linux")]
        let opened = opened.map(|mut device| {
            device.node = linux::opened_node(&input_device);
            device
        });
        // Looked up afresh next time: on macOS a mic plugged in again is a
        // new CoreAudio device, and on Windows a cached device can keep a
        // dead client. (An ASIO device is only a description, and listing
        // them again would load every ASIO driver.)
        if opened.is_err() && !device_type.is_asio() {
            lock(&INPUT_DEVICES).remove(name);
        }
        opened
    }

    fn open(
        input_device: &cpal::Device,
        device_type: &DeviceType,
        channel_selection: usize,
    ) -> Result<Self> {
        let mode = *lock(&MIC_MODE);
        let exclusive = mode.exclusive && !device_type.is_asio();
        // Windows won't share a mic that another mic's row holds in exclusive
        // mode (after Mic mode changes to Shared): that row reopens shared.
        #[cfg(windows)]
        if !exclusive && !device_type.is_asio() {
            let id = input_device.id()?.to_string();
            let endpoint = id.strip_prefix("wasapi:").unwrap_or(&id);
            lock(&EXCLUSIVE).close(endpoint, "The mic mode changed to Shared");
        }
        // What the mic takes, asked before the output opens: a mic that is
        // gone then fails without opening and closing the output (and on
        // Windows loading every ASIO driver) each time the display tries
        // it again. Exclusive mode asks the mic itself.
        let configs = match exclusive {
            true => None,
            false => Some(InputConfigs::probe(input_device, channel_selection)?),
        };
        let mut mixer = lock(&mixer::MIXER);
        let output_rate = mixer.open_if_needed()?;
        let device = Self::open_on(
            input_device,
            device_type,
            channel_selection,
            configs,
            mode,
            output_rate,
            &mut mixer,
        );
        if device.is_err() {
            mixer.close_if_unused();
        }
        device
    }

    fn open_on(
        input_device: &cpal::Device,
        device_type: &DeviceType,
        channel_selection: usize,
        configs: Option<InputConfigs>,
        mode: MicMode,
        output_rate: cpal::SampleRate,
        mixer: &mut mixer::Mixer,
    ) -> Result<Self> {
        // Exclusive when it's set (InputDevice::open hasn't asked what the
        // mic takes shared) and Windows gives the mic; else shared, saying
        // why.
        let mut note = None;
        if configs.is_none() {
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
        // When shared mode fails too, the error says why exclusive did.
        match Self::open_shared(
            input_device,
            device_type,
            channel_selection,
            configs,
            output_rate,
            mixer,
        ) {
            Ok(mut device) => {
                device.note = note;
                Ok(device)
            }
            Err(e) => Err(match note {
                Some(note) => format!("{e}. {note}").into(),
                None => e,
            }),
        }
    }

    // A mic through cpal: shared on Windows, or ASIO, CoreAudio, or Linux's
    // sound system. `configs` is what it takes, if it has been asked.
    fn open_shared(
        input_device: &cpal::Device,
        device_type: &DeviceType,
        channel_selection: usize,
        configs: Option<InputConfigs>,
        output_rate: cpal::SampleRate,
        mixer: &mut mixer::Mixer,
    ) -> Result<Self> {
        let configs = match configs {
            Some(configs) => configs,
            None => InputConfigs::probe(input_device, channel_selection)?,
        };
        let (mut input_config, sample_format) = input_stream_config(configs, output_rate);
        if device_type.is_asio() {
            // The mic output's buffer size, when it is on this driver: the
            // driver's buffers are one size for both, and the input would
            // otherwise rebuild them at the driver's own.
            if let Some(frames) = mixer.asio_buffer() {
                input_config.buffer_size = cpal::BufferSize::Fixed(frames);
            }
            // A mic on this driver that failed (after an ASIO reset, every
            // stream on it fails) would keep the dead driver loaded, and
            // this one would open on it: let it go first, so the driver
            // really reloads.
            mixer.release_asio(None);
        }

        println!(
            "Created input device {} with config {:#?}, sample format {:#?}",
            input_device.id()?,
            input_config,
            sample_format,
        );

        let status = Arc::new(Mutex::new(None));
        let realtime = Arc::new(Mutex::new(None));
        with_sample_type!(sample_format, T => {
            Self::assemble::<T, _>(
                &input_config,
                output_rate,
                channel_selection,
                mixer,
                input_kind(input_device, device_type),
                status.clone(),
                realtime.clone(),
                |mut callback| {
                    let stream = input_device.build_input_stream(
                        input_config,
                        move |samples: &[T], _: &_| callback(samples),
                        error_callback(status.clone(), realtime.clone(), "Mic"),
                        None,
                    )?;
                    stream.play()?;
                    Ok(Stream::new(stream, device_type))
                },
            )
        })
    }

    // The mic around a stream that `start` opens, given the mic's callback:
    // the pitch and mixer buffers it feeds, its levels, and its place in the
    // mixer. `status` is where the stream says why it stopped, `realtime`
    // why its thread isn't real-time.
    #[allow(clippy::too_many_arguments)]
    fn assemble<Sample, S: MicStream + 'static>(
        input_config: &cpal::StreamConfig,
        output_rate: cpal::SampleRate,
        channel_selection: usize,
        mixer: &mut mixer::Mixer,
        kind: &'static str,
        status: Arc<Mutex<Option<String>>>,
        realtime: Arc<Mutex<Option<String>>>,
        start: impl FnOnce(Box<dyn FnMut(&[Sample]) + Send>) -> Result<S>,
    ) -> Result<Self>
    where
        Sample: cpal::Sample + Copy + 'static,
        f32: cpal::FromSample<Sample>,
    {
        let (pitch_tx, pitch) = pitch_detector::PitchWindow::new(input_config.sample_rate);
        let (output_tx, output_rx) =
            ringbuf::HeapRb::new(mixer::ring_capacity(output_rate)).split();
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
        let stream: Box<dyn MicStream> = Box::new(start(Box::new(callback))?);
        let asio = stream.is_asio();
        let stream = Arc::new(Mutex::new(Some(stream)));

        let source_id = mixer.register(
            output_rx,
            output_rate,
            status.clone(),
            asio.then(|| stream.clone()),
        );
        Ok(InputDevice {
            input_stream: stream,
            kind,
            note: None,
            rate: input_config.sample_rate,
            meters,
            source_id,
            levels,
            status,
            realtime,
            lost: Arc::default(),
            stall: Mutex::new(Stall::new(Instant::now())),
            pitch,
            #[cfg(target_os = "linux")]
            node: None,
        })
    }

    // A Windows mic in exclusive mode (see exclusive.rs), at the output's
    // rate if it takes it. Every channel of the mic comes in each packet, and
    // Windows gives the mic to one exclusive stream at a time, so the mics
    // on its channels share one stream.
    #[cfg(windows)]
    fn open_exclusive(
        input_device: &cpal::Device,
        channel_selection: usize,
        output_rate: cpal::SampleRate,
        buffer: Option<u32>,
        mixer: &mut mixer::Mixer,
    ) -> Result<Self> {
        let id = input_device.id()?.to_string();
        let endpoint = id.strip_prefix("wasapi:").unwrap_or(&id);
        let input = lock(&EXCLUSIVE).get_or_open(endpoint, (output_rate, buffer), |taps| {
            exclusive::ExclusiveInput::open(
                endpoint,
                output_rate,
                buffer,
                taps.realtime.clone(),
                taps.lost.clone(),
                taps.on_data(),
                taps.on_error(),
            )
        })?;
        let format = input.format;
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
        println!(
            "Created input device {id} channel {channel_selection} in exclusive mode with config \
             {input_config:#?}"
        );
        let status: Arc<Mutex<Option<String>>> = Arc::default();
        let tap_status = status.clone();
        let mut device = Self::assemble::<f32, _>(
            &input_config,
            output_rate,
            channel_selection,
            mixer,
            "Exclusive",
            status,
            input.taps.realtime.clone(),
            |callback| Ok(input.tap(callback, tap_status)),
        )?;
        device.lost = input.taps.lost.clone();
        Ok(device)
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

    // The pitch of its newest 1/40 s, as a MIDI number, and how sure that
    // is (0 to 1); see PitchWindow. Not sure at all while the noise gate
    // holds the mic quiet, so the TV draws no pitch for a noise.
    pub fn get_pitch(&mut self) -> (f32, f32) {
        let (pitch, confidence) = self.pitch.pitch();
        if self.meters.gate_open.load(Relaxed) {
            (pitch, confidence)
        } else {
            (pitch, 0.0)
        }
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

    // The noise gate's threshold, linear, 0 to 1 (0 is off): see Gate.
    pub fn set_gate(&self, threshold: f32) {
        self.levels
            .gate
            .store(threshold.clamp(0.0, 1.0).to_bits(), Relaxed);
    }

    // "ok"; "ok: <note>" while it works but something is worth saying; or
    // the error that stopped it (the display then reopens it).
    pub fn status(&self) -> String {
        if let Some(error) = lock(&self.status).clone() {
            return error;
        }
        // Unplugged: its stream would go on calling back, in silence.
        #[cfg(target_os = "linux")]
        if let Some(node) = &self.node
            && !linux::node_is_there(node)
        {
            let gone = "The mic is gone (unplugged?)".to_string();
            eprintln!("{gone}");
            return lock(&self.status).get_or_insert(gone).clone();
        }
        let callbacks = self.meters.callbacks.load(Relaxed);
        if lock(&self.stall).stalled(callbacks, Instant::now()) {
            let stalled = "The mic stopped sending sound (nothing for 2 seconds)".to_string();
            eprintln!("{stalled}");
            if let Some(stream) = lock(&self.input_stream).as_ref() {
                stream.stalled(&stalled);
            }
            return lock(&self.status).get_or_insert(stalled).clone();
        }
        lock(&mixer::MIXER).status()
    }

    // "Shared, 48 kHz, 480 samples (10.0 ms)": how the mic is open, and why
    // not as asked if it isn't.
    pub fn format(&self) -> String {
        let mut format = format!(
            "{}, {}",
            self.kind,
            describe(self.rate, self.meters.frames.load(Relaxed))
        );
        if let Some(note) = &self.note {
            format = format!("{format}. {note}");
        }
        if let Some(why) = lock(&self.realtime).as_ref() {
            format = format!("{format}. Not real-time: {why}");
        }
        let lost = self.lost.load(Relaxed);
        if lost > 0 {
            format = format!("{format}. Packets lost: {lost} (a larger Mic buffer may help)");
        }
        format
    }

    // The loudest sample, 0 to 1, since the last time this was asked: what
    // Settings' level meter shows.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.meters.peak.swap(0, Relaxed))
    }

    pub fn stop(&mut self) {
        // A stream closing can say its device went (PipeWire's do): that
        // isn't news, so it goes unsaid (the error callback keeps only the
        // first error).
        lock(&self.status).get_or_insert_with(|| "stopped".to_string());
        // The stream first: closing the output while an ASIO mic still held
        // the driver would leave it looping the output's last buffers.
        self.stop_stream();
        lock(&mixer::MIXER).deregister(self.source_id);
    }

    fn stop_stream(&self) {
        let stream = lock(&self.input_stream).take();
        drop(stream);
    }

    // The input callback: the chosen channel goes to the pitch buffer as it
    // is, and through the noise gate, with gain, reverb and resampling to
    // the output rate, to the mixer's buffer (mono).
    fn input_data_callback<Sample: cpal::Sample + Copy>(
        input_config: &cpal::StreamConfig,
        output_rate: cpal::SampleRate,
        channel_selection: usize,
        levels: Arc<Levels>,
        meters: Arc<Meters>,
        mut pitch_tx: ringbuf::HeapProd<f32>,
        mut output_tx: ringbuf::HeapProd<f32>,
    ) -> Result<impl FnMut(&[Sample]) + Send + 'static + use<Sample>>
    where
        f32: cpal::FromSample<Sample>,
    {
        let input_rate = input_config.sample_rate;
        let input_channels = input_config.channels as usize;

        let mut reverbs = reverb_module::REVERB_TAPS.map(|(delay, amplitude)| {
            reverb_module::ReverbModule::new(input_rate, delay, amplitude)
        });

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

        let mut gate = Gate::new(input_rate);
        // The chosen channel, and its reverb: sized by the first callback.
        let mut mono: Vec<f32> = Vec::new();
        let mut wet: Vec<f32> = Vec::new();
        let mut full_prints = RateLimit::default();
        let mut error_prints = RateLimit::default();

        Ok(move |samples: &[Sample]| {
            meters
                .frames
                .store((samples.len() / input_channels) as u32, Relaxed);
            meters.callbacks.fetch_add(1, Relaxed);
            mono.clear();
            mono.extend(samples.chunks(input_channels).map(|frame| {
                frame
                    .get(channel_selection)
                    .map_or(0.0, |sample| <f32 as cpal::Sample>::from_sample(*sample))
            }));

            pitch_tx.push_slice(&mono);
            let peak = mono.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
            meters.peak.fetch_max(peak.to_bits(), Relaxed);
            let threshold = f32::from_bits(levels.gate.load(Relaxed));
            let open = gate.process(&mut mono, threshold);
            meters.gate_open.store(open, Relaxed);

            let gain = f32::from_bits(levels.gain.load(Relaxed));
            let echo = f32::from_bits(levels.echo.load(Relaxed));
            mono.iter_mut().for_each(|sample| *sample *= gain);
            wet.clear();
            wet.extend(mono.iter().map(|s| s * 0.5 * echo));
            for reverb in &mut reverbs {
                reverb.process(&mut wet);
            }
            mono.iter_mut().zip(&wet).for_each(|(dry, wet)| *dry += wet);

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

// The channels an input is listed with (what Settings offers): on Linux
// those it opens with, its own (ALSA's plugins take up to 64, which Settings
// would offer one by one); elsewhere its best config's.
#[cfg(target_os = "linux")]
fn listed_channels(input_device: &cpal::Device) -> Result<u16> {
    Ok(input_device.default_input_config()?.channels())
}

#[cfg(not(target_os = "linux"))]
fn listed_channels(input_device: &cpal::Device) -> Result<u16> {
    let best = best_config(input_device.supported_input_configs()?, None)
        .ok_or("No supported input configs")?;
    Ok(best.channels())
}

// What a mic takes with the chosen channel, asked before the mic output
// opens (see InputDevice::open). On Linux its own config and its ranges.
#[cfg(target_os = "linux")]
struct InputConfigs {
    default: cpal::SupportedStreamConfig,
    ranges: Vec<cpal::SupportedStreamConfigRange>,
}

#[cfg(target_os = "linux")]
impl InputConfigs {
    fn probe(input_device: &cpal::Device, channel_selection: usize) -> Result<Self> {
        let default = input_device.default_input_config()?;
        if channel_selection >= default.channels() as usize {
            return Err(format!("The mic has {} channels", default.channels()).into());
        }
        let ranges = input_device.supported_input_configs()?.collect();
        Ok(InputConfigs { default, ranges })
    }
}

// Elsewhere the configs that have the chosen channel.
#[cfg(not(target_os = "linux"))]
struct InputConfigs(Vec<cpal::SupportedStreamConfigRange>);

#[cfg(not(target_os = "linux"))]
impl InputConfigs {
    fn probe(input_device: &cpal::Device, channel_selection: usize) -> Result<Self> {
        let configs: Vec<_> = input_device
            .supported_input_configs()?
            .filter(|config| channel_selection < config.channels() as usize)
            .collect();
        if configs.is_empty() {
            return Err("No supported input configs".into());
        }
        Ok(InputConfigs(configs))
    }
}

// How a mic opens, at the output's rate when it takes it: its config and
// sample format. On Linux in its own channels and format, in buffers of the
// size Settings picked.
#[cfg(target_os = "linux")]
fn input_stream_config(
    configs: InputConfigs,
    output_rate: cpal::SampleRate,
) -> (cpal::StreamConfig, cpal::SampleFormat) {
    let config = linux::stream_config(
        &configs.default,
        configs.ranges.into_iter(),
        output_rate,
        linux_buffer(),
    );
    (config, configs.default.sample_format())
}

// Elsewhere the best config, the output's rate first.
#[cfg(not(target_os = "linux"))]
fn input_stream_config(
    configs: InputConfigs,
    output_rate: cpal::SampleRate,
) -> (cpal::StreamConfig, cpal::SampleFormat) {
    let best = best_config(configs.0.into_iter(), Some(output_rate))
        .expect("InputConfigs::probe keeps one at least");
    (
        supported_config_to_config(&best, Some(output_rate)),
        best.sample_format(),
    )
}

// Whether one of a device's `ranges` takes its own channels and sample
// format (`default`'s) at `rate`.
fn takes_rate(
    default: &cpal::SupportedStreamConfig,
    mut ranges: impl Iterator<Item = cpal::SupportedStreamConfigRange>,
    rate: cpal::SampleRate,
) -> bool {
    ranges.any(|range| {
        range.channels() == default.channels()
            && range.sample_format() == default.sample_format()
            && range.contains_rate(rate)
    })
}

// The best of a mic's configs on Windows and macOS: one with `rate` (the
// output's) first, then the highest rate, then the most channels, then
// cpal's order (F32 first, then 48 kHz); the last of equals. The buffer
// sizes can't choose: CoreAudio and ASIO give every config the same, and
// Windows sets its own.
#[cfg(any(test, not(target_os = "linux")))]
fn best_config(
    configs: impl Iterator<Item = cpal::SupportedStreamConfigRange>,
    rate: Option<cpal::SampleRate>,
) -> Option<cpal::SupportedStreamConfigRange> {
    let key = |config: &cpal::SupportedStreamConfigRange| {
        (
            rate.is_some_and(|rate| config.contains_rate(rate)),
            config.max_sample_rate(),
            config.channels(),
        )
    };
    configs.max_by(|a, b| {
        key(a)
            .cmp(&key(b))
            .then_with(|| a.cmp_default_heuristics(b))
    })
}

// The buffer size a macOS mic and the mic output ask for, within what the
// device takes. Its smallest (CoreAudio's can be 15 frames) would call back
// thousands of times a second, for little less delay.
#[cfg(all(not(windows), any(test, not(target_os = "linux"))))]
const MIC_BUFFER: u32 = 128;

// MIC_BUFFER within a device's range, else the device's own.
#[cfg(all(not(windows), any(test, not(target_os = "linux"))))]
fn mic_buffer_size(range: &cpal::SupportedBufferSize) -> cpal::BufferSize {
    match *range {
        cpal::SupportedBufferSize::Range { min, max } if min <= max && max > 0 => {
            cpal::BufferSize::Fixed(MIC_BUFFER.clamp(min, max))
        }
        _ => cpal::BufferSize::Default,
    }
}

// The desired sample rate when the range has it, else its highest.
#[cfg(any(test, not(target_os = "linux")))]
fn supported_config_to_config(
    config_range: &cpal::SupportedStreamConfigRange,
    desired_sample_rate: Option<cpal::SampleRate>,
) -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels: config_range.channels(),
        sample_rate: desired_sample_rate
            .filter(|rate| config_range.contains_rate(*rate))
            .unwrap_or(config_range.max_sample_rate()),
        // WASAPI lies about buffer size ranges and doesn't repect fixed size
        // requests (and ASIO mics take the output's, see open_shared).
        #[cfg(windows)]
        buffer_size: cpal::BufferSize::Default,
        #[cfg(not(windows))]
        buffer_size: mic_buffer_size(config_range.buffer_size()),
    }
}

// The mics: the system host's (on Linux only its mics, see linux.rs), and
// ASIO's.
fn _input_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let devices = system_inputs()?;
    #[cfg(all(windows, feature = "asio"))]
    let devices = devices.chain(asio_devices(DeviceTrait::supports_input));
    Ok(devices)
}

fn system_inputs() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let host = system_host()?;
    #[cfg(target_os = "linux")]
    let devices = linux::input_devices(&host)?.into_iter();
    #[cfg(not(target_os = "linux"))]
    let devices = host.input_devices()?;
    Ok(devices.map(|device| (device, DeviceType::DefaultHost)))
}

fn _output_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let devices = system_outputs()?;
    #[cfg(all(windows, feature = "asio"))]
    let devices = devices.chain(asio_devices(DeviceTrait::supports_output));
    Ok(devices)
}

fn system_outputs() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let host = system_host()?;
    #[cfg(target_os = "linux")]
    let devices = linux::output_devices(&host)?.into_iter();
    #[cfg(not(target_os = "linux"))]
    let devices = host.output_devices()?;
    Ok(devices.map(|device| (device, DeviceType::DefaultHost)))
}

// Whether a mic's key or an output's name is ASIO's: it ends "(ASIO)".
fn names_asio(name: &str) -> bool {
    cfg!(all(windows, feature = "asio")) && name.ends_with(" (ASIO)")
}

// The input saved as `name`, looked up among its own host's inputs only:
// listing ASIO's loads every ASIO driver, which a WASAPI mic needn't wait
// for. On Windows and macOS the one found before, if it is (InputDevice::new
// forgets it when it won't open). On Linux always afresh: a PipeWire mic
// plugged in again is a new node, and a stale one would quietly record the
// default mic instead.
fn find_input(name: &str) -> Result<(cpal::Device, DeviceType)> {
    let mut input_devices = lock(&INPUT_DEVICES);
    if let Some(found) = input_devices
        .get(name)
        .filter(|_| !cfg!(target_os = "linux"))
    {
        return Ok(found.clone());
    }
    let is_named = |(device, device_type): &(cpal::Device, DeviceType)| {
        _device_name(device, device_type).is_ok_and(|n| n == name)
    };
    let found = match names_asio(name) {
        #[cfg(all(windows, feature = "asio"))]
        true => asio_devices(DeviceTrait::supports_input).find(is_named),
        _ => system_inputs()?.find(is_named),
    }
    // Said under the mic's row while it's unplugged: its key is no news.
    .ok_or("The mic isn't connected")?;
    if !cfg!(target_os = "linux") {
        input_devices.insert(name.to_string(), found.clone());
    }
    Ok(found)
}

// The output named `name` (see _output_name), looked up among its own
// host's outputs only, as find_input does.
fn find_output(name: &str) -> Result<Option<(cpal::Device, DeviceType)>> {
    let is_named = |(device, device_type): &(cpal::Device, DeviceType)| {
        _output_name(device, device_type).is_ok_and(|n| n == name)
    };
    Ok(match names_asio(name) {
        #[cfg(all(windows, feature = "asio"))]
        true => asio_devices(DeviceTrait::supports_output).find(is_named),
        _ => system_outputs()?.find(is_named),
    })
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

// How a mic is open, for its format line: on Linux the sound system
// ("PipeWire").
fn input_kind(device: &cpal::Device, device_type: &DeviceType) -> &'static str {
    match device_type {
        #[cfg(all(windows, feature = "asio"))]
        DeviceType::Asio => "ASIO",
        DeviceType::DefaultHost if cfg!(windows) => "Shared",
        DeviceType::DefaultHost if cfg!(target_os = "linux") => {
            device.id().map_or("System", |id| id.host().name())
        }
        DeviceType::DefaultHost => "System",
    }
}

// What an input's id and label end with.
fn input_host(device_type: &DeviceType) -> &'static str {
    match device_type {
        #[cfg(all(windows, feature = "asio"))]
        DeviceType::Asio => "ASIO",
        DeviceType::DefaultHost if cfg!(target_os = "linux") => "Linux",
        DeviceType::DefaultHost => "USB",
    }
}

// An input's key: its id and "(USB)" for the default host ("(Linux)" on
// Linux), the form saved mics have. An input without an id has no key, and
// isn't listed.
fn _device_name(device: &cpal::Device, device_type: &DeviceType) -> Result<String> {
    Ok(format!("{} ({})", device.id()?, input_host(device_type)))
}

// An input's label: what the system calls it ("Yeti Stereo Microphone
// (USB)"), or its key (`name`) if the system won't say.
fn _device_label(device: &cpal::Device, device_type: &DeviceType, name: &str) -> String {
    #[cfg(target_os = "linux")]
    if let Some(label) = linux::label(device) {
        return format!("{label} ({})", input_host(device_type));
    }
    match device.description() {
        Ok(description) => format!("{} ({})", description.name(), input_host(device_type)),
        Err(_) => name.to_string(),
    }
}

// The listing's items that came, each failure printed and left out: one
// device that won't say doesn't empty Settings' list.
fn kept<T, E: std::fmt::Display>(
    what: &str,
    items: impl IntoIterator<Item = std::result::Result<T, E>>,
) -> Vec<T> {
    items
        .into_iter()
        .filter_map(|item| item.map_err(|e| eprintln!("{what} is left out: {e}")).ok())
        .collect()
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
    #[cfg(target_os = "linux")]
    if let Some(label) = linux::label(device) {
        return Ok(format!("{label} ({host})"));
    }
    Ok(format!("{} ({host})", device.description()?.name()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitch_detector::{PitchDetector, freq2midi};
    use ringbuf::traits::Consumer;
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

        let mut reverbs = reverb_module::REVERB_TAPS
            .map(|(delay, amplitude)| reverb_module::ReverbModule::new(rate, delay, amplitude));
        let mut expected = Vec::new();
        for chunk in samples.chunks(256) {
            let mut wet: Vec<f32> = chunk.iter().map(|s| s * 0.2).collect();
            for reverb in &mut reverbs {
                reverb.process(&mut wet);
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
        let (midi_number, confidence) = pd.detect(&output[..pitch_sample_count]);
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

    // The pitch is found in the newest 1/40 s of the mic, however its
    // callbacks and the polls fall (PianoRoll asks every 25 ms; WASAPI calls
    // back every 10 ms): never in a window part empty, or in an old one when
    // a poll comes late.
    #[test]
    fn test_the_pitch_is_the_newest_window() -> Result<()> {
        let rate = 48000;
        const LOW: f32 = 95.0;
        let (pitch_tx, mut pitch) = pitch_detector::PitchWindow::new(rate);
        let (output_tx, _output_rx) = ringbuf::HeapRb::new(rate as usize).split();
        let mut callback = InputDevice::input_data_callback::<f32>(
            &config(rate),
            rate,
            0,
            Arc::new(Levels::new(1.0, 0.4)),
            Arc::default(),
            pitch_tx,
            output_tx,
        )?;
        let tone = |freq: f32, ms: usize| -> Vec<f32> {
            wf!(f32, rate as f32, sine!(freq, 1.0_f32, 0.0_f32))
                .iter()
                .take(rate as usize * ms / 1000)
                .collect()
        };
        let low = tone(LOW, 500);
        let mut rest = &low[..];
        // 20 ms: not a whole window yet, so no pitch.
        let (first, next) = rest.split_at(960);
        callback(first);
        assert_eq!(pitch.pitch(), (0.0, 0.0));
        rest = next;
        // Then 30 ms and 20 ms in turn, a poll after each.
        for ms in [30, 20].iter().cycle().take(12) {
            let (part, next) = rest.split_at(rate as usize * ms / 1000);
            callback(part);
            rest = next;
            let (midi_number, confidence) = pitch.pitch();
            assert!(
                (midi_number - freq2midi(LOW)).abs() < 0.05,
                "after {ms} ms: {midi_number}, not {}",
                freq2midi(LOW)
            );
            assert!(confidence > 0.9);
        }
        // Nothing new since: no pitch.
        assert_eq!(pitch.pitch(), (0.0, 0.0));
        // A poll 50 ms late finds the newest 25 ms.
        let mut late = tone(100.0, 25);
        late.extend(tone(150.0, 25));
        callback(&late);
        let (midi_number, _) = pitch.pitch();
        assert!(
            (midi_number - freq2midi(150.0)).abs() < 0.05,
            "{midi_number}, not {}",
            freq2midi(150.0)
        );
        Ok(())
    }

    // The noise gate: a quiet sound under the threshold fades out once the
    // hold is over and stays out; a loud one comes back at once, whole; the
    // meters say which. The pitch buffer gets every sample either way.
    #[test]
    fn test_the_gate_mutes_what_stays_under_it() -> Result<()> {
        let rate = 48000;
        let tone = |amplitude: f32, ms: usize| -> Vec<f32> {
            wf!(f32, rate as f32, sine!(220.0_f32, amplitude, 0.0_f32))
                .iter()
                .take(rate as usize * ms / 1000)
                .collect()
        };
        let levels = Arc::new(Levels::new(1.0, 0.0));
        levels.gate.store(0.1_f32.to_bits(), Relaxed);
        let meters = Arc::new(Meters::default());
        let (pitch_tx, mut pitch_rx) = ringbuf::HeapRb::new(rate as usize * 2).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(rate as usize * 2).split();
        let mut callback = InputDevice::input_data_callback::<f32>(
            &config(rate),
            rate,
            0,
            levels.clone(),
            meters.clone(),
            pitch_tx,
            output_tx,
        )?;
        let ms = |n: usize| rate as usize * n / 1000;

        // Loud: through whole, after the first 2 ms.
        let loud = tone(0.5, 100);
        callback(&loud);
        assert!(meters.gate_open.load(Relaxed));
        let out: Vec<f32> = output_rx.pop_iter().collect();
        assert_eq!(&out[ms(2)..], &loud[ms(2)..]);

        // Quiet: through for the hold, then fading, then nothing.
        let quiet = tone(0.05, 600);
        for part in quiet.chunks(480) {
            callback(part);
        }
        assert!(!meters.gate_open.load(Relaxed));
        let out: Vec<f32> = output_rx.pop_iter().collect();
        assert_eq!(&out[..ms(150)], &quiet[..ms(150)]);
        assert!(out[ms(400)..].iter().all(|&s| s == 0.0));

        // Loud again: open within 2 ms of the first sample over it (the
        // sine's 7th).
        callback(&loud);
        assert!(meters.gate_open.load(Relaxed));
        let out: Vec<f32> = output_rx.pop_iter().collect();
        assert_eq!(out[..5], [0.0; 5]);
        assert_eq!(&out[ms(3)..], &loud[ms(3)..]);

        // The pitch buffer had all of it.
        assert_eq!(pitch_rx.pop_iter().count(), loud.len() * 2 + quiet.len());

        // Off: everything goes through.
        levels.gate.store(0.0_f32.to_bits(), Relaxed);
        callback(&quiet);
        assert!(meters.gate_open.load(Relaxed));
        let out: Vec<f32> = output_rx.pop_iter().collect();
        assert_eq!(out, quiet);
        Ok(())
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

    // A mic in 24-bit samples (PulseAudio's s24le, an Int24 ASIO driver)
    // opens like any other: its samples reach the mixer as floats.
    #[test]
    fn test_24_bit_mics_open() -> Result<()> {
        for format in [cpal::SampleFormat::I24, cpal::SampleFormat::U24] {
            let (pitch_tx, _pitch_rx) = ringbuf::HeapRb::new(16).split();
            let (output_tx, mut output_rx) = ringbuf::HeapRb::new(16).split();
            with_sample_type!(format, T => {
                let mut callback = InputDevice::input_data_callback::<T>(
                    &config(48000),
                    48000,
                    0,
                    Arc::new(Levels::new(1.0, 0.0)),
                    Arc::default(),
                    pitch_tx,
                    output_tx,
                )?;
                callback(&[
                    <T as cpal::Sample>::from_sample(0.5_f32),
                    <T as cpal::Sample>::from_sample(-1.0_f32),
                ]);
                Ok(())
            })?;
            let output: Vec<f32> = output_rx.pop_iter().collect();
            assert_eq!(output, [0.5, -1.0], "{format}");
        }
        Ok(())
    }

    // A stream stalls once its count stands still for STALL (STALL_START
    // before its first callback), however often it is asked.
    #[test]
    fn test_a_stream_that_stops_calling_back_stalls() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut stall = Stall::new(start);
        assert!(!stall.stalled(0, at(2000)));
        assert!(!stall.stalled(0, at(4999)));
        assert!(stall.stalled(0, at(5000)));

        let mut stall = Stall::new(start);
        assert!(!stall.stalled(5, at(10)));
        assert!(!stall.stalled(9, at(2000)));
        assert!(!stall.stalled(9, at(3000)));
        assert!(!stall.stalled(9, at(3899)));
        assert!(stall.stalled(9, at(3900)));
        // It calls back again: not stalled, and counted from there.
        assert!(!stall.stalled(10, at(4000)));
        assert!(!stall.stalled(10, at(5000)));
        // A count that wraps round still moves.
        let mut stall = Stall::new(start);
        assert!(!stall.stalled(u32::MAX, at(10)));
        assert!(!stall.stalled(0, at(2000)));
    }

    fn range(
        channels: u16,
        rates: std::ops::RangeInclusive<u32>,
        format: cpal::SampleFormat,
    ) -> cpal::SupportedStreamConfigRange {
        cpal::SupportedStreamConfigRange::new(
            channels,
            *rates.start(),
            *rates.end(),
            cpal::SupportedBufferSize::Range { min: 14, max: 4096 },
            format,
        )
    }

    // A Windows or macOS mic opens at the output's rate when a config has
    // it, else at the highest rate; then with the most channels, then in
    // floats rather than integers; the last of equals.
    #[test]
    fn test_the_best_config() {
        use cpal::SampleFormat::{F32, I16};
        let best = |configs: &[cpal::SupportedStreamConfigRange], rate| {
            best_config(configs.iter().cloned(), rate).unwrap()
        };
        let configs = [range(2, 44100..=44100, F32), range(2, 96000..=96000, F32)];
        assert_eq!(best(&configs, Some(44100)), configs[0]);
        assert_eq!(best(&configs, Some(48000)), configs[1]);
        assert_eq!(best(&configs, None), configs[1]);
        // In range is good enough.
        let configs = [range(2, 8000..=192000, F32), range(2, 96000..=96000, F32)];
        assert_eq!(best(&configs, Some(48000)), configs[0]);
        let configs = [range(4, 48000..=48000, F32), range(2, 48000..=48000, F32)];
        assert_eq!(best(&configs, Some(48000)), configs[0]);
        let configs = [range(2, 48000..=48000, F32), range(2, 48000..=48000, I16)];
        assert_eq!(best(&configs, Some(48000)), configs[0]);
        assert_eq!(best_config(std::iter::empty(), None), None);
    }

    // The config it opens with: the output's rate if the range has it, else
    // its highest; on macOS 128 frames, within what the device takes, not
    // its smallest. (Windows sets its own.)
    #[test]
    fn test_a_config_range_to_open() {
        let config = supported_config_to_config(
            &range(2, 8000..=96000, cpal::SampleFormat::F32),
            Some(44100),
        );
        assert_eq!((config.channels, config.sample_rate), (2, 44100));
        let config = supported_config_to_config(
            &range(1, 44100..=48000, cpal::SampleFormat::F32),
            Some(96000),
        );
        assert_eq!(config.sample_rate, 48000);
        #[cfg(not(windows))]
        {
            assert_eq!(config.buffer_size, cpal::BufferSize::Fixed(MIC_BUFFER));
            let buffers = |min, max| {
                let range = cpal::SupportedStreamConfigRange::new(
                    1,
                    48000,
                    48000,
                    cpal::SupportedBufferSize::Range { min, max },
                    cpal::SampleFormat::F32,
                );
                supported_config_to_config(&range, None).buffer_size
            };
            assert_eq!(buffers(256, 4096), cpal::BufferSize::Fixed(256));
            assert_eq!(buffers(14, 64), cpal::BufferSize::Fixed(64));
            assert_eq!(buffers(0, 0), cpal::BufferSize::Default);
        }
        #[cfg(windows)]
        assert_eq!(config.buffer_size, cpal::BufferSize::Default);
    }

    // Counts each thread's allocations, for the test that the mic's callback
    // makes none.
    struct CountingAllocator;

    thread_local! {
        static ALLOCATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn allocations() -> usize {
        ALLOCATIONS.with(|count| count.get())
    }

    unsafe impl std::alloc::GlobalAlloc for CountingAllocator {
        // Each passes its caller's GlobalAlloc contract on to System.
        unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
            unsafe { std::alloc::System.alloc(layout) }
        }

        unsafe fn realloc(
            &self,
            ptr: *mut u8,
            layout: std::alloc::Layout,
            new_size: usize,
        ) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
            unsafe { std::alloc::System.realloc(ptr, layout, new_size) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
            unsafe { std::alloc::System.dealloc(ptr, layout) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    // The mic's callback runs on the audio thread: once its first call has
    // sized its buffers, it allocates nothing, resampling or not.
    #[test]
    fn test_the_input_callback_doesnt_allocate() -> Result<()> {
        for (input_rate, output_rate) in [(48000, 48000), (44100, 48000)] {
            let (pitch_tx, _pitch) = pitch_detector::PitchWindow::new(input_rate);
            let (output_tx, _output_rx) = ringbuf::HeapRb::new(output_rate as usize).split();
            let mut callback = InputDevice::input_data_callback::<f32>(
                &config(input_rate),
                output_rate,
                0,
                Arc::new(Levels::new(1.0, 0.4)),
                Arc::default(),
                pitch_tx,
                output_tx,
            )?;
            let samples = sine_samples(input_rate, 128);
            callback(&samples);
            let before = allocations();
            for _ in 0..100 {
                callback(&samples);
            }
            let made = allocations() - before;
            assert_eq!(
                made, 0,
                "{input_rate} -> {output_rate}: {made} in 100 callbacks"
            );
        }
        Ok(())
    }

    // The input callback counts itself for the stall check.
    #[test]
    fn test_the_input_callback_counts_its_calls() -> Result<()> {
        let (pitch_tx, _pitch_rx) = ringbuf::HeapRb::new(16).split();
        let (output_tx, _output_rx) = ringbuf::HeapRb::new(16).split();
        let meters = Arc::new(Meters::default());
        let mut callback = InputDevice::input_data_callback::<f32>(
            &config(48000),
            48000,
            0,
            Arc::new(Levels::new(1.0, 0.0)),
            meters.clone(),
            pitch_tx,
            output_tx,
        )?;
        for _ in 0..3 {
            callback(&[0.0; 4]);
        }
        assert_eq!(meters.callbacks.load(Relaxed), 3);
        Ok(())
    }

    // A fake shared stream: its thread's half, as a test drives it.
    struct FakeStream(Arc<AtomicUsize>);

    impl Drop for FakeStream {
        fn drop(&mut self) {
            self.0.fetch_add(1, Relaxed);
        }
    }

    type FakeInputs = SharedInputs<FakeStream, u16, u32>;

    // Opens a fake stream at `request`, counting opens and closes.
    fn fake_open(
        inputs: &mut FakeInputs,
        request: u32,
        opens: &AtomicUsize,
        closes: &Arc<AtomicUsize>,
        data: &mut Vec<MicCallback>,
    ) -> Arc<SharedInput<FakeStream, u16, u32>> {
        inputs
            .get_or_open("mic", request, |taps| {
                opens.fetch_add(1, Relaxed);
                data.push(Box::new(taps.on_data()));
                Ok((FakeStream(closes.clone()), 2))
            })
            .unwrap()
    }

    // Collects what a mic's callback gets.
    fn heard() -> (Arc<Mutex<Vec<f32>>>, MicCallback) {
        let heard: Arc<Mutex<Vec<f32>>> = Arc::default();
        let into = heard.clone();
        (
            heard,
            Box::new(move |data: &[f32]| lock(&into).extend_from_slice(data)),
        )
    }

    // Two mics on the channels of one exclusive device share its stream:
    // it opens once, each gets every packet, and it closes when the last
    // one leaves.
    #[test]
    fn test_mics_on_one_device_share_its_stream() {
        let mut inputs = FakeInputs::default();
        let (opens, closes) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
        let mut data = Vec::new();
        let first = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let (heard_1, callback) = heard();
        let tap_1 = first.tap(callback, Arc::default());
        let second = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let (heard_2, callback) = heard();
        let tap_2 = second.tap(callback, Arc::default());
        assert_eq!(opens.load(Relaxed), 1);
        assert_eq!(second.format, 2);
        data[0](&[0.25, -0.5]);
        assert_eq!(*lock(&heard_1), [0.25, -0.5]);
        assert_eq!(*lock(&heard_2), [0.25, -0.5]);

        drop((first, second));
        drop(tap_1);
        data[0](&[1.0, 1.0]);
        assert_eq!(lock(&heard_1).len(), 2);
        assert_eq!(lock(&heard_2).len(), 4);
        assert_eq!(closes.load(Relaxed), 0);
        drop(tap_2);
        assert_eq!(closes.load(Relaxed), 1);
        // Opened again once nothing holds it.
        let _again = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        assert_eq!(opens.load(Relaxed), 2);
    }

    // A mic asking for other settings (an output at another rate, a new
    // buffer size) closes the stream first, as the device takes one at a
    // time, and the mics on the old one are told to reopen.
    #[test]
    fn test_new_settings_reopen_a_shared_stream() {
        let mut inputs = FakeInputs::default();
        let (opens, closes) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
        let mut data = Vec::new();
        let old = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let status: Arc<Mutex<Option<String>>> = Arc::default();
        let (_, callback) = heard();
        let _old_tap = old.tap(callback, status.clone());
        let _new = fake_open(&mut inputs, 44100, &opens, &closes, &mut data);
        assert_eq!((opens.load(Relaxed), closes.load(Relaxed)), (2, 1));
        assert!(lock(&status).is_some());
        assert!(!old.running());
    }

    // A stream that stopped, by itself or by stalling, isn't joined: the
    // next mic opens a new one, and every mic on it is told why.
    #[test]
    fn test_a_failed_shared_stream_isnt_joined() {
        let mut inputs = FakeInputs::default();
        let (opens, closes) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
        let mut data = Vec::new();
        let input = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let statuses: [Arc<Mutex<Option<String>>>; 2] = Default::default();
        let taps: Vec<_> = statuses
            .iter()
            .map(|status| input.tap(heard().1, status.clone()))
            .collect();
        input.taps.on_error()("The mic was unplugged or turned off".to_string());
        for status in &statuses {
            assert_eq!(
                lock(status).as_deref(),
                Some("The mic was unplugged or turned off")
            );
        }
        let _next = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        assert_eq!(opens.load(Relaxed), 2);

        let stalled = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let tap = stalled.tap(heard().1, Arc::default());
        tap.stalled("The mic stopped sending sound");
        let _next = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        assert_eq!(opens.load(Relaxed), 3);
        drop(taps);

        // Closed outright (the mic mode is now Shared), with its mics told.
        let input = fake_open(&mut inputs, 48000, &opens, &closes, &mut data);
        let status: Arc<Mutex<Option<String>>> = Arc::default();
        let _tap = input.tap(heard().1, status.clone());
        let closed = closes.load(Relaxed);
        inputs.close("mic", "The mic mode changed to Shared");
        assert_eq!(closes.load(Relaxed), closed + 1);
        assert!(lock(&status).is_some());
    }

    #[test]
    fn test_an_xrun_keeps_the_stream() {
        let status = Arc::new(Mutex::new(None));
        let realtime = Arc::new(Mutex::new(None));
        let mut callback = error_callback(status.clone(), realtime.clone(), "Mic");
        callback(cpal::Error::new(cpal::ErrorKind::Xrun));
        callback(cpal::Error::new(cpal::ErrorKind::DeviceChanged));
        assert_eq!(*lock(&status), None);
        // A refused real-time priority too; it is kept for the format line.
        callback(cpal::Error::new(cpal::ErrorKind::RealtimeDenied));
        assert_eq!(*lock(&status), None);
        assert!(lock(&realtime).is_some());
        // Anything else stops it.
        callback(cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable));
        assert!(lock(&status).is_some());
    }

    // The tests that list devices take turns: two threads loading ASIO
    // drivers at once crash (the app lists them from one thread only).
    static DEVICES: Mutex<()> = Mutex::new(());

    // A device that fails is left out, and the others still list.
    #[test]
    fn test_kept_skips_failures() {
        let items: Vec<std::result::Result<&str, String>> =
            vec![Ok("Mic 1"), Err("no id".to_string()), Ok("Mic 2")];
        assert_eq!(kept("A device", items), ["Mic 1", "Mic 2"]);
        let none: Vec<std::result::Result<&str, String>> = vec![Err("gone".to_string())];
        assert!(kept("A device", none).is_empty());
    }

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
        if let Ok(devices) = InputDevice::collect_devices() {
            for (id, label, _) in &devices {
                let host = if id.ends_with(" (ASIO)") {
                    " (ASIO)"
                } else if cfg!(target_os = "linux") {
                    " (Linux)"
                } else {
                    " (USB)"
                };
                assert!(id.ends_with(host), "{}", id);
                assert!(label.ends_with(host), "{}: {}", id, label);
            }
        }
    }

    // A mic that isn't there fails before the mic output opens, so the
    // display's retries don't open and close it.
    #[test]
    fn test_a_missing_mic_leaves_the_output_closed() {
        let _devices = lock(&DEVICES);
        let missing = if cfg!(target_os = "linux") {
            "nothing (Linux)"
        } else {
            "nothing (USB)"
        };
        let opens = lock(&mixer::MIXER).opens;
        assert!(InputDevice::new(missing, 0).is_err());
        assert_eq!(lock(&mixer::MIXER).opens, opens);
        assert_eq!(output_format(), None);
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
