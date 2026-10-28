// The one output stream every mic plays through.

use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, TryLockError};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer};

use crate::{
    _output_devices, _output_name, describe, error_callback, find_output, kept, lock, system_host,
    DeviceType, RateLimit, Result, Stall, Stream, StreamSlot,
};

pub(crate) static MIXER: LazyLock<Mutex<Mixer>> = LazyLock::new(|| Mutex::new(Mixer::default()));

// The largest output buffer Settings offers, in frames.
const MAX_BUFFER: u32 = 8192;

// A mic's buffer holds up to 200 ms at the output rate, and at least two
// of the largest output buffers with the Pacer's start and largest margin
// on top and a mic callback to spare, so it never fills in normal running
// (that would cut the sound). Its Pacer keeps it to what plays without
// gaps, so the room costs no delay.
pub(crate) fn ring_capacity(rate: cpal::SampleRate) -> usize {
    let largest = 2 * MAX_BUFFER as usize + frames(rate, START_MS + MARGIN_MAX_MS + 10);
    (rate as usize / 5).max(largest)
}

// The Pacer's times, in milliseconds. A mic first plays once its buffer
// holds START_MS more than it needs, and keeps MARGIN_MS spare above a read
// (MARGIN_STEP_MS more each time it runs dry, up to MARGIN_MAX_MS, and a
// step less after each CALM_MS without running dry). Every WINDOW_MS, or
// WINDOW_READS reads if those take longer, the level is steered: an excess
// over JUMP_MS is dropped at once, anything within DEADBAND_MS is left
// alone. (A window of only a few large reads would miss the level's low
// points and cut too much.)
const START_MS: usize = 20;
const MARGIN_MS: usize = 4;
const MARGIN_STEP_MS: usize = 2;
const MARGIN_MAX_MS: usize = 30;
const CALM_MS: usize = 60_000;
const WINDOW_MS: usize = 500;
const WINDOW_READS: usize = 16;
const JUMP_MS: usize = 5;
const DEADBAND_MS: usize = 1;

fn frames(rate: cpal::SampleRate, ms: usize) -> usize {
    rate as usize * ms / 1000
}

fn millis(rate: cpal::SampleRate, frames: usize) -> usize {
    frames * 1000 / rate as usize
}

// Every output device, with the host in parentheses. One that won't give
// its name is left out, not the whole list.
pub fn output_devices() -> Result<Vec<String>> {
    Ok(kept(
        "An output",
        _output_devices()?.map(|(device, device_type)| _output_name(&device, &device_type)),
    ))
}

// The output picked in Settings, with its rate and buffer size in frames
// (None: the device's own).
#[derive(Clone)]
struct OutputChoice {
    name: String,
    rate: Option<cpal::SampleRate>,
    buffer: Option<u32>,
}

// None: the default output, as Windows has it. Reopens the stream if the
// mics have one open. When that fails, nothing changes: the old choice
// stays, and its stream reopens.
pub fn set_output_device(
    name: Option<String>,
    rate: Option<cpal::SampleRate>,
    buffer: Option<u32>,
) -> Result<()> {
    let choice = name.map(|name| OutputChoice { name, rate, buffer });
    lock(&MIXER).choose(choice, Mixer::reopen)
}

// How often a chosen mic output that is missing, or won't open, is tried
// again while the default plays instead (see Mixer::retry_choice). Not
// every time a mic is asked: listing ASIO's outputs loads every driver.
const RETRY_OUTPUT: Duration = Duration::from_secs(10);

// The rates Settings offers: the usual PCM ones. Drivers also list DSD
// rates (2.8 MHz and up), which aren't for us.
const PCM_RATES: [cpal::SampleRate; 6] = [44100, 48000, 88200, 96000, 176400, 192000];

// What an ASIO output can be set to: its rates, and its buffer sizes in
// frames (the powers of two it takes, and its own limits). None for other
// outputs: in shared mode Windows sets both.
pub fn output_options(name: &str) -> Result<Option<(Vec<cpal::SampleRate>, Vec<u32>)>> {
    let Some((device, device_type)) = find_output(name)? else {
        return Ok(None);
    };
    if !device_type.is_asio() {
        return Ok(None);
    }
    let default_config = device.default_output_config()?;
    let mut rates: Vec<_> = device
        .supported_output_configs()?
        .filter(|range| range.channels() == default_config.channels())
        .flat_map(|range| {
            PCM_RATES.iter().copied().filter(move |rate| {
                (range.min_sample_rate()..=range.max_sample_rate()).contains(rate)
            })
        })
        .collect();
    rates.sort();
    rates.dedup();
    let buffers = match default_config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => buffer_choices(*min, *max),
        cpal::SupportedBufferSize::Unknown => vec![],
    };
    Ok(Some((rates, buffers)))
}

// The buffer sizes from min to max frames that Settings offers: the powers
// of two (what ASIO drivers take), and the driver's own limits, up to
// MAX_BUFFER (the mics' buffers hold no more).
fn buffer_choices(min: u32, max: u32) -> Vec<u32> {
    let max = max.min(MAX_BUFFER).max(min);
    let mut choices: Vec<u32> = (4..=MAX_BUFFER.ilog2())
        .map(|power| 1 << power)
        .filter(|frames| (min..=max).contains(frames))
        .chain([min, max])
        .collect();
    choices.sort();
    choices.dedup();
    choices
}

// Where the mics play: "ok", "ok: <a note>" (the chosen output is missing,
// and the default plays instead), or why the output stopped. None while no
// mic is open. Settings can show it whichever mics are up.
pub fn output_status() -> Option<String> {
    let mut mixer = lock(&MIXER);
    mixer.output.as_ref()?;
    Some(mixer.status())
}

// What the mic output runs at: "48 kHz, 512 samples (10.7 ms)", and why
// its thread isn't real-time if the system refused. None while no mic is
// open.
pub fn output_format() -> Option<String> {
    let mixer = lock(&MIXER);
    let (_, rate) = mixer.output.as_ref()?;
    let format = describe(*rate, mixer.frames.load(Relaxed));
    let realtime = lock(&mixer.output_realtime).clone();
    Some(match realtime {
        Some(why) => format!("{format}. Not real-time: {why}"),
        None => format,
    })
}

// One mic's output buffer (mono, at the output rate), as the mixer reads it.
pub(crate) struct Source {
    id: u64,
    rx: ringbuf::HeapCons<f32>,
    // The output rate the mic resamples to.
    rate: cpal::SampleRate,
    pacer: Pacer,
    // The mic's status, to have it reopened when the output rate changes.
    status: Arc<Mutex<Option<String>>>,
    // An ASIO mic's stream, to let go of its driver (see release_asio).
    asio: Option<StreamSlot>,
}

#[derive(Default)]
pub(crate) struct Mixer {
    // The output device picked in Settings; None for the default.
    choice: Option<OutputChoice>,
    // The stream and its rate, open while any mic is registered, and on
    // ASIO the buffer size it was asked for.
    output: Option<(Stream, cpal::SampleRate)>,
    asio_buffer: Option<u32>,
    // Why the stream stopped or couldn't open.
    output_error: Arc<Mutex<Option<String>>>,
    // Why its thread isn't real-time, if the system refused.
    output_realtime: Arc<Mutex<Option<String>>>,
    // Set when the chosen device is missing and the default plays instead,
    // and when to try the choice again (see retry_choice).
    note: Option<String>,
    retry_at: Option<Instant>,
    // The output callback only ever try_locks this, so the audio thread
    // never waits; the JS thread holds it just to add or remove a mic.
    sources: Arc<Mutex<Vec<Source>>>,
    next_id: u64,
    // Frames per output callback, as the output asks for them, and a count
    // of the callbacks, to see that they keep coming (see Stall).
    frames: Arc<AtomicU32>,
    callbacks: Arc<AtomicU32>,
    stall: Option<Stall>,
    // How many times the stream was opened, for the tests.
    #[cfg(test)]
    pub(crate) opens: usize,
}

impl Mixer {
    // The output rate, opening the stream if it isn't open or has stopped.
    pub fn open_if_needed(&mut self) -> Result<cpal::SampleRate> {
        self.check_stall();
        match &self.output {
            Some((_, rate)) if lock(&self.output_error).is_none() => Ok(*rate),
            _ => self.open(),
        }
    }

    // Takes `choice`, and has `reopen` open the stream on it. If that
    // fails, the old choice is put back and reopened, so a caller told of
    // the error can take it that nothing changed.
    fn choose(
        &mut self,
        choice: Option<OutputChoice>,
        mut reopen: impl FnMut(&mut Self) -> Result<()>,
    ) -> Result<()> {
        let previous = std::mem::replace(&mut self.choice, choice);
        if let Err(e) = reopen(self) {
            self.choice = previous;
            if let Err(again) = reopen(self) {
                eprintln!("The mic output didn't reopen as it was: {again}");
            }
            return Err(e);
        }
        Ok(())
    }

    // Opens the stream again, as set now, if it is open.
    pub fn reopen(&mut self) -> Result<()> {
        if self.output.is_some() {
            self.open()?;
        }
        Ok(())
    }

    fn open(&mut self) -> Result<cpal::SampleRate> {
        #[cfg(test)]
        {
            self.opens += 1;
        }
        // An ASIO output closing while ASIO mics hold its driver would leave
        // the driver looping its last output buffers (a buzz), and a new one
        // on the driver would get the old buffers, whatever size was asked
        // for. So the mics let the driver go first, and reopen after.
        if self
            .output
            .as_ref()
            .is_some_and(|(stream, _)| stream.is_asio())
        {
            self.release_asio(Some("The mic output changed"));
        }
        // ASIO allows one stream per driver: close the old one first.
        self.close();
        let opened = self.build();
        match opened {
            Ok((stream, rate, note)) => {
                let now = Instant::now();
                self.retry_at = note.as_ref().map(|_| now + RETRY_OUTPUT);
                self.note = note;
                self.opened(stream, rate, now);
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

    // `stream` is the output now, at `rate`.
    fn opened(&mut self, stream: Stream, rate: cpal::SampleRate, now: Instant) {
        self.output = Some((stream, rate));
        self.stall = Some(Stall::new(now));
        // A mic resampling to another rate would play at the wrong pitch:
        // its status has the display reopen it.
        for source in lock(&self.sources).iter().filter(|s| s.rate != rate) {
            *lock(&source.status) = Some(format!("The mic output changed to {rate} Hz"));
        }
    }

    // The choice to try again, while the default output plays for it, once
    // RETRY_OUTPUT has passed since the last try.
    fn retry_due(&mut self, now: Instant) -> Option<OutputChoice> {
        if self.retry_at.is_none_or(|at| now < at) {
            return None;
        }
        self.retry_at = Some(now + RETRY_OUTPUT);
        self.choice.clone()
    }

    // While the default output plays for a chosen one that was missing or
    // wouldn't open (a TV in standby, an interface switched off), the
    // choice is tried again now and then. Once it is listed and opens, the
    // mics move back to it. It opens beside the default, which plays on
    // until it does.
    fn retry_choice(&mut self, now: Instant) {
        if self.output.is_none() || lock(&self.output_error).is_some() {
            return;
        }
        let Some(OutputChoice { name, rate, buffer }) = self.retry_due(now) else {
            return;
        };
        let Ok(Some((device, device_type))) = find_output(&name) else {
            return;
        };
        match self.build_on(&device, &device_type, rate, buffer) {
            Ok((stream, rate)) => {
                println!("The mic output {name} is back");
                self.note = None;
                self.retry_at = None;
                let default = self.output.take();
                self.opened(stream, rate, now);
                drop(default);
            }
            Err(e) => {
                let note = format!(
                    "ok: {name} couldn't open ({e}); the mics play through the default output"
                );
                if self.note.as_ref() != Some(&note) {
                    eprintln!("The mic output {name} couldn't open: {e}");
                    self.note = Some(note);
                }
            }
        }
    }

    // The chosen device, or the default one with a note saying why when the
    // chosen one is missing or won't open.
    fn build(&mut self) -> Result<(Stream, cpal::SampleRate, Option<String>)> {
        let mut note = None;
        if let Some(OutputChoice { name, rate, buffer }) = self.choice.clone() {
            let built = find_output(&name)?
                .map(|(device, device_type)| self.build_on(&device, &device_type, rate, buffer));
            note = Some(match built {
                Some(Ok((stream, rate))) => return Ok((stream, rate, None)),
                Some(Err(e)) => {
                    eprintln!("The mic output {name} couldn't open: {e}");
                    format!(
                        "ok: {name} couldn't open ({e}); the mics play through the default output"
                    )
                }
                None => {
                    format!("ok: {name} isn't connected; the mics play through the default output")
                }
            });
        }
        let device = system_host()?
            .default_output_device()
            .ok_or("No default output device")?;
        let (stream, rate) = self.build_on(&device, &DeviceType::DefaultHost, None, None)?;
        Ok((stream, rate, note))
    }

    // The device's own format, at the chosen rate (else the mics', so they
    // needn't reopen) if it has it, and for ASIO the chosen buffer size if
    // the driver takes it. On Linux, in buffers of the size the mics use.
    fn build_on(
        &mut self,
        device: &cpal::Device,
        device_type: &DeviceType,
        rate: Option<cpal::SampleRate>,
        buffer: Option<u32>,
    ) -> Result<(Stream, cpal::SampleRate)> {
        let default_config = device.default_output_config()?;
        let mut config = default_config.config();
        if let Some(rate) = rate.or_else(|| lock(&self.sources).first().map(|s| s.rate)) {
            if crate::takes_rate(&default_config, device.supported_output_configs()?, rate) {
                config.sample_rate = rate;
            }
        }
        if let (Some(frames), cpal::SupportedBufferSize::Range { min, max }) =
            (buffer, default_config.buffer_size())
        {
            if device_type.is_asio() && (min..=max).contains(&&frames) {
                config.buffer_size = cpal::BufferSize::Fixed(frames);
            }
        }
        #[cfg(target_os = "linux")]
        {
            config.buffer_size =
                crate::linux::buffer_size(default_config.buffer_size(), crate::linux_buffer());
        }
        let channels = config.channels as usize;
        let output_error = Arc::new(Mutex::new(None));
        let output_realtime = Arc::new(Mutex::new(None));
        let stream = with_sample_type!(default_config.sample_format(), T => {
            let mut output_callback = output_data_callback::<T>(
                self.sources.clone(),
                channels,
                config.sample_rate,
                self.frames.clone(),
                self.callbacks.clone(),
            );
            Ok(device.build_output_stream(
                config,
                move |samples: &mut [T], _: &_| output_callback(samples),
                error_callback(output_error.clone(), output_realtime.clone(), "Mic output"),
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
        self.output_realtime = output_realtime;
        self.asio_buffer = match config.buffer_size {
            cpal::BufferSize::Fixed(frames) if device_type.is_asio() => Some(frames),
            _ => None,
        };
        Ok((Stream::new(stream, device_type), config.sample_rate))
    }

    // "ok", the note, or why the output stopped: an error, or its
    // callbacks stopping, which has the mics reopen it.
    pub fn status(&mut self) -> String {
        self.check_stall();
        if let Some(error) = lock(&self.output_error).clone() {
            return error;
        }
        self.retry_choice(Instant::now());
        self.note.clone().unwrap_or_else(|| "ok".to_string())
    }

    // An open stream whose callbacks stopped is as good as failed: its
    // error says so, and the next mic to open reopens it.
    fn check_stall(&mut self) {
        let callbacks = self.callbacks.load(Relaxed);
        let mut error = lock(&self.output_error);
        let (Some(stall), Some(_)) = (self.stall.as_mut(), &self.output) else {
            return;
        };
        if error.is_none() && stall.stalled(callbacks, Instant::now()) {
            let stalled = "The mic output stopped playing (nothing for 2 seconds)";
            eprintln!("{stalled}");
            *error = Some(stalled.to_string());
        }
    }

    // The buffer size, in frames, an ASIO mic on the output's driver opens
    // with; None when the output isn't ASIO or took the driver's own.
    pub fn asio_buffer(&self) -> Option<u32> {
        self.asio_buffer.filter(|_| self.output.is_some())
    }

    // Closes the ASIO mics' streams, so their driver can go: with `why`
    // every one, saying so in its status, else those that already failed.
    // The display then reopens them.
    pub fn release_asio(&mut self, why: Option<&str>) {
        let streams: Vec<_> = lock(&self.sources)
            .iter()
            .filter_map(|source| {
                let slot = source.asio.as_ref()?;
                let mut status = lock(&source.status);
                match why {
                    Some(why) => {
                        status.get_or_insert_with(|| why.to_string());
                    }
                    None if status.is_none() => return None,
                    None => {}
                }
                lock(slot).take()
            })
            .collect();
        // Dropped once the output callback can have the sources again.
        drop(streams);
    }

    // Adds a mic, reading from `rx` at `rate`, with its status and, for an
    // ASIO mic, its stream (see release_asio).
    pub fn register(
        &mut self,
        rx: ringbuf::HeapCons<f32>,
        rate: cpal::SampleRate,
        status: Arc<Mutex<Option<String>>>,
        asio: Option<StreamSlot>,
    ) -> u64 {
        self.next_id += 1;
        lock(&self.sources).push(Source {
            id: self.next_id,
            rx,
            rate,
            pacer: Pacer::new(rate),
            status,
            asio,
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
            self.close();
        }
    }

    // Closes the stream. Closing, it can say its device went (PipeWire's
    // do), which isn't news: its error is set first, so that goes unsaid.
    fn close(&mut self) {
        if self.output.is_some() {
            lock(&self.output_error).get_or_insert_with(|| "closed".to_string());
        }
        self.output = None;
    }
}

// Paces one mic's buffer so it holds as little as plays without gaps: that
// is the mic's delay. Before each read the buffer must hold the frames the
// read takes; whatever it held beyond that at its lowest over a window was
// never needed. So after each window the level is steered to a read plus a
// margin: a large excess (after a start or a refill) is dropped at once; a
// small one, or a shortfall as the mic's and the output's clocks drift
// apart, a frame per read (one dropped, or the last one played twice),
// which can't be heard. A buffer that runs dry plays what it has, keeps a
// larger margin from then on, and refills before it plays again, so it
// gaps once instead of stuttering. After a long calm the margin shrinks
// back a step, so a few gaps in a long night don't keep the delay up.
struct Pacer {
    rate: cpal::SampleRate,
    // False until the buffer first fills, and again after it runs dry.
    playing: bool,
    // Frames kept above what a read takes, and the frames read since it
    // last ran dry or shrank the margin.
    margin: usize,
    calm: usize,
    // The lowest level before a read, and the frames read, this window.
    low: usize,
    window: usize,
    // Frames still to drop (above 0) or to repeat (below 0), one per read.
    drift: isize,
}

// One read of a mic's buffer: drop the `skip` oldest frames, play the next
// `read`, then the last of those `repeat` more times.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Read {
    skip: usize,
    read: usize,
    repeat: usize,
}

impl Pacer {
    fn new(rate: cpal::SampleRate) -> Self {
        Pacer {
            rate,
            playing: false,
            margin: frames(rate, MARGIN_MS),
            calm: 0,
            low: usize::MAX,
            window: 0,
            drift: 0,
        }
    }

    // A read for an output callback that wants `wanted` frames, from a
    // buffer holding `occupied` of `capacity`.
    fn plan(&mut self, occupied: usize, wanted: usize, capacity: usize) -> Read {
        let setpoint = wanted + self.margin;
        if !self.playing {
            if occupied < (setpoint + frames(self.rate, START_MS)).min(capacity) {
                return Read::default();
            }
            self.playing = true;
            self.new_window();
        }
        let mut skip = 0;
        if occupied + wanted > capacity {
            // Nearly full (the output stalled): back to the setpoint now.
            skip = occupied.saturating_sub(setpoint);
            self.drift = 0;
            self.new_window();
        } else {
            self.low = self.low.min(occupied);
            self.window += wanted;
            if self.window >= frames(self.rate, WINDOW_MS).max(WINDOW_READS * wanted) {
                self.calm += self.window;
                if self.calm >= frames(self.rate, CALM_MS) {
                    self.calm = 0;
                    self.margin = (self
                        .margin
                        .saturating_sub(frames(self.rate, MARGIN_STEP_MS)))
                    .max(frames(self.rate, MARGIN_MS));
                }
                let excess = self.low as isize - (wanted + self.margin) as isize;
                self.drift = 0;
                if excess > frames(self.rate, JUMP_MS) as isize {
                    skip = excess as usize;
                } else if excess.unsigned_abs() > frames(self.rate, DEADBAND_MS) {
                    self.drift = excess;
                }
                self.new_window();
            }
        }
        let mut repeat = 0;
        if self.drift > 0 && skip == 0 && occupied > 0 {
            skip = 1;
            self.drift -= 1;
        } else if self.drift < 0 && wanted > 0 {
            repeat = 1;
            self.drift += 1;
        }
        let real = wanted - repeat;
        let read = (occupied - skip).min(real);
        if read < real {
            self.playing = false;
            self.drift = 0;
            self.calm = 0;
            self.margin = (self.margin + frames(self.rate, MARGIN_STEP_MS))
                .min(frames(self.rate, MARGIN_MAX_MS));
            return Read {
                skip,
                read,
                repeat: 0,
            };
        }
        Read { skip, read, repeat }
    }

    fn new_window(&mut self) {
        self.low = usize::MAX;
        self.window = 0;
    }
}

// What one mix did that is worth a line in the console.
#[derive(Default)]
struct MixEvents {
    // A mic ran dry: the spare it keeps from now on, in frames.
    ran_dry: Option<usize>,
    // The most frames a mic dropped at once, to cut its delay.
    cut: usize,
}

// Adds every mic into `mix` (silence where one has nothing). A mic still
// resampling to an old output rate would play at the wrong pitch: it stays
// silent until the display reopens it.
fn mix_into(sources: &mut [Source], mix: &mut [f32], rate: cpal::SampleRate) -> MixEvents {
    let mut events = MixEvents::default();
    for source in sources.iter_mut().filter(|s| s.rate == rate) {
        let was_playing = source.pacer.playing;
        let Read { skip, read, repeat } = source.pacer.plan(
            source.rx.occupied_len(),
            mix.len(),
            source.rx.capacity().get(),
        );
        source.rx.skip(skip);
        let mut last = 0.0;
        for (out, sample) in mix.iter_mut().zip(source.rx.pop_iter().take(read)) {
            *out += sample;
            last = sample;
        }
        for out in &mut mix[read..read + repeat] {
            *out += last;
        }
        if was_playing && !source.pacer.playing {
            events.ran_dry = Some(source.pacer.margin);
        }
        // A single frame is drift, not a cut.
        if skip > 1 {
            events.cut = events.cut.max(skip);
        }
    }
    events
}

// The loudest a mix sample is written. The integer conversions take -1.0 up
// to just below 1.0, as integers have one more step below 0 than above:
// a 24-bit sample at 1.0 would wrap round to full scale negative (a click).
// Just below 1.0 is the top step of every integer format, and inaudibly
// below 1.0 for floats.
const FULL_SCALE: f32 = 1.0 - f32::EPSILON;

// The output callback: sums the mics, mono to every channel. Notes in
// `frames` how many each callback asks for, and counts itself in
// `callbacks`.
fn output_data_callback<Sample: cpal::Sample + cpal::FromSample<f32>>(
    sources: Arc<Mutex<Vec<Source>>>,
    channels: usize,
    rate: cpal::SampleRate,
    frames: Arc<AtomicU32>,
    callbacks: Arc<AtomicU32>,
) -> impl FnMut(&mut [Sample]) + Send + 'static {
    let mut mix: Vec<f32> = Vec::with_capacity(rate as usize / 10);
    let mut dry_prints = RateLimit::default();
    let mut cut_prints = RateLimit::default();
    move |samples: &mut [Sample]| {
        mix.clear();
        mix.resize(samples.len() / channels, 0.0);
        frames.store(mix.len() as u32, Relaxed);
        callbacks.fetch_add(1, Relaxed);
        let sources = match sources.try_lock() {
            Ok(sources) => Some(sources),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            // A mic is being added or removed: one callback of silence.
            Err(TryLockError::WouldBlock) => None,
        };
        if let Some(mut sources) = sources {
            let events = mix_into(&mut sources, &mut mix, rate);
            if let Some(margin) = events.ran_dry {
                if dry_prints.ready() {
                    eprintln!(
                        "mic fell behind: refilling, and keeping {} ms spare from now on",
                        millis(rate, margin)
                    );
                }
            }
            if events.cut > 0 && cut_prints.ready() {
                eprintln!(
                    "mic delay: dropped {} ms it didn't need",
                    millis(rate, events.cut)
                );
            }
        }
        for (frame, sample) in samples.chunks_mut(channels).zip(&mix) {
            frame.fill(Sample::from_sample(sample.clamp(-1.0, FULL_SCALE)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::{Producer, Split};

    // At this rate a frame is a millisecond: with 10 frames wanted, the
    // setpoint is 14 (a read and the 4 ms margin) and a mic starts at 34.
    const RATE: cpal::SampleRate = 1000;
    const WANTED: usize = 10;
    const CAPACITY: usize = 200;

    // `reads` reads at the same level, as when the mic keeps pace.
    fn plan_at(pacer: &mut Pacer, occupied: usize, reads: usize) -> Vec<Read> {
        (0..reads)
            .map(|_| pacer.plan(occupied, WANTED, CAPACITY))
            .collect()
    }

    fn plays(read: usize) -> Read {
        Read {
            skip: 0,
            read,
            repeat: 0,
        }
    }

    #[test]
    fn test_pacer_waits_for_the_start_level() {
        let mut pacer = Pacer::new(RATE);
        assert_eq!(pacer.plan(33, WANTED, CAPACITY), Read::default());
        assert!(!pacer.playing);
        assert_eq!(pacer.plan(34, WANTED, CAPACITY), plays(10));
        assert!(pacer.playing);
    }

    // A window is 50 reads of 10 frames; the last one steers.
    #[test]
    fn test_pacer_drops_a_large_excess_at_once() {
        let mut pacer = Pacer::new(RATE);
        let reads = plan_at(&mut pacer, 100, 51);
        assert!(reads[..49].iter().all(|r| *r == plays(10)));
        // Lowest at 100, 86 over the setpoint: dropped in one go.
        assert_eq!(
            reads[49],
            Read {
                skip: 86,
                read: 10,
                repeat: 0
            }
        );
        assert_eq!(reads[50], plays(10));
    }

    #[test]
    fn test_pacer_drops_a_small_excess_a_frame_per_read() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        // Lowest at 17: 3 over the setpoint.
        let reads = plan_at(&mut pacer, 17, 53);
        assert!(reads[..48].iter().all(|r| *r == plays(10)));
        let drop_one = Read {
            skip: 1,
            read: 10,
            repeat: 0,
        };
        assert_eq!(&reads[48..51], &[drop_one, drop_one, drop_one]);
        assert_eq!(&reads[51..], &[plays(10), plays(10)]);
    }

    #[test]
    fn test_pacer_repeats_a_frame_per_read_when_short() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        // Lowest at 11: 3 under the setpoint.
        let reads = plan_at(&mut pacer, 11, 52);
        let repeat_one = Read {
            skip: 0,
            read: 9,
            repeat: 1,
        };
        assert!(reads[..48].iter().all(|r| *r == plays(10)));
        assert_eq!(&reads[48..51], &[repeat_one, repeat_one, repeat_one]);
        assert_eq!(reads[51], plays(10));
    }

    #[test]
    fn test_pacer_leaves_the_deadband_alone() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        for level in [13, 15] {
            assert!(plan_at(&mut pacer, level, 100)
                .iter()
                .all(|r| *r == plays(10)));
        }
    }

    #[test]
    fn test_pacer_runs_dry_then_refills_with_more_margin() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        // What's left plays, then it waits for 10 + 6 + 20.
        assert_eq!(pacer.plan(5, WANTED, CAPACITY), plays(5));
        assert!(!pacer.playing);
        assert_eq!(pacer.plan(35, WANTED, CAPACITY), Read::default());
        assert_eq!(pacer.plan(36, WANTED, CAPACITY), plays(10));
        // The margin stops growing at 30.
        for _ in 0..20 {
            pacer.plan(0, WANTED, CAPACITY);
            pacer.plan(CAPACITY, WANTED, CAPACITY);
        }
        assert_eq!(pacer.margin, 30);
    }

    // A minute without running dry takes a step of margin back, down to
    // the first margin.
    #[test]
    fn test_pacer_margin_shrinks_back_after_a_calm_minute() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        pacer.plan(5, WANTED, CAPACITY);
        assert_eq!(pacer.plan(36, WANTED, CAPACITY), plays(10));
        assert_eq!(pacer.margin, 6);
        // 50 reads to a window, 120 windows to a minute.
        plan_at(&mut pacer, 16, 5990);
        assert_eq!(pacer.margin, 6);
        plan_at(&mut pacer, 16, 20);
        assert_eq!(pacer.margin, 4);
        plan_at(&mut pacer, 14, 12_000);
        assert_eq!(pacer.margin, 4);
    }

    #[test]
    fn test_pacer_drops_to_the_setpoint_when_nearly_full() {
        let mut pacer = Pacer::new(RATE);
        pacer.plan(34, WANTED, CAPACITY);
        assert_eq!(pacer.plan(190, WANTED, CAPACITY), plays(10));
        assert_eq!(
            pacer.plan(191, WANTED, CAPACITY),
            Read {
                skip: 177,
                read: 10,
                repeat: 0
            }
        );
    }

    // What a simulated mic did: the gaps after the start, the fullest its
    // buffer was before a read once settled (in ms), how many frames were
    // dropped or repeated one at a time, the larger cuts after the start,
    // and the frames lost to a full buffer.
    #[derive(Debug)]
    struct Simulated {
        gaps: usize,
        fullest_ms: f64,
        nudges: usize,
        cuts: usize,
        overflowed: usize,
    }

    // A mic sending 10 ms callbacks (a Yeti through WASAPI) into an output
    // reading `chunk_out` frames per callback, for two minutes: the mic's
    // clock `ppm` off the output's, and each mic callback up to 3 ms late.
    fn simulate(rate: cpal::SampleRate, chunk_out: usize, ppm: f64) -> Simulated {
        let chunk_in = rate as usize / 100;
        let in_period = 0.010 / (1.0 + ppm / 1e6);
        let out_period = chunk_out as f64 / rate as f64;
        let capacity = ring_capacity(rate);
        let mut pacer = Pacer::new(rate);
        let mut seed: u64 = 1;
        let mut late = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 33) as f64 / (1u64 << 31) as f64 * 0.003
        };
        let (mut level, mut i, mut k) = (0, 0, 0);
        let mut next_in = late();
        let mut sim = Simulated {
            gaps: 0,
            fullest_ms: 0.0,
            nudges: 0,
            cuts: 0,
            overflowed: 0,
        };
        let mut fullest = 0;
        let mut started = false;
        loop {
            let next_out = k as f64 * out_period;
            if next_out > 120.0 {
                break;
            }
            if next_in <= next_out {
                sim.overflowed += (level + chunk_in).saturating_sub(capacity);
                level = (level + chunk_in).min(capacity);
                i += 1;
                next_in = i as f64 * in_period + late();
                continue;
            }
            let was_playing = pacer.playing;
            let read = pacer.plan(level, chunk_out, capacity);
            if next_out > 2.0 {
                fullest = fullest.max(level);
            }
            if was_playing && !pacer.playing {
                sim.gaps += 1;
            }
            if read.skip == 1 || read.repeat == 1 {
                sim.nudges += 1;
            }
            // The first cut, to the setpoint once playing, is the start.
            if read.skip > 1 && started {
                sim.cuts += 1;
            }
            started |= read.skip > 1;
            level -= read.skip + read.read;
            k += 1;
        }
        sim.fullest_ms = fullest as f64 * 1000.0 / rate as f64;
        sim
    }

    // The largest buffers Settings offers an ASIO output still play whole.
    #[test]
    fn test_pacer_keeps_up_with_large_output_buffers() {
        for rate in [44100, 48000] {
            for (chunk_out, ppm) in [2048, 4096, MAX_BUFFER as usize]
                .iter()
                .flat_map(|&chunk_out| [(chunk_out, -100.0), (chunk_out, 0.0), (chunk_out, 100.0)])
            {
                let sim = simulate(rate, chunk_out, ppm);
                println!("{} Hz, {} frames, {} ppm: {:?}", rate, chunk_out, ppm, sim);
                assert_eq!(sim.overflowed, 0, "{} Hz, {}: {:?}", rate, chunk_out, sim);
                assert_eq!(sim.gaps, 0, "{} Hz, {}: {:?}", rate, chunk_out, sim);
                assert_eq!(sim.cuts, 0, "{} Hz, {}: {:?}", rate, chunk_out, sim);
            }
        }
    }

    // A Yeti into a Topping (512 frames per ASIO callback), both at 48 kHz.
    #[test]
    fn test_pacer_keeps_a_yeti_into_a_topping_short_and_whole() {
        for ppm in [-100.0, 0.0, 100.0] {
            let Simulated {
                gaps,
                fullest_ms,
                nudges,
                ..
            } = simulate(48000, 512, ppm);
            println!(
                "{} ppm: fullest {:.1} ms, {} nudges",
                ppm, fullest_ms, nudges
            );
            assert_eq!(gaps, 0, "{} ppm", ppm);
            // The old fixed target held 50 ms at least.
            assert!(fullest_ms < 30.0, "{} ppm: {} ms", ppm, fullest_ms);
            // 100 ppm is 4.8 frames a second, 576 in two minutes.
            assert!(nudges < 1500, "{} ppm: {} nudges", ppm, nudges);
        }
    }

    fn source(id: u64, samples: &[f32], capacity: usize) -> Source {
        let (mut tx, rx) = ringbuf::HeapRb::new(capacity).split();
        tx.push_slice(samples);
        Source {
            id,
            rx,
            rate: RATE,
            pacer: Pacer::new(RATE),
            status: Arc::new(Mutex::new(None)),
            asio: None,
        }
    }

    // Enough for a 4-frame read to start: 4 + 4 + 20.
    const START: usize = 28;

    #[test]
    fn test_output_sums_the_mics_to_every_channel() {
        let mut first = vec![0.1, 0.2, 0.3, 0.4];
        first.resize(START, 0.0);
        let a = source(1, &first, 64);
        let b = source(2, &[0.5; START], 64);
        let sources = Arc::new(Mutex::new(vec![a, b]));
        let mut callback =
            output_data_callback::<f32>(sources, 2, RATE, Arc::default(), Arc::default());
        let mut out = [9.0; 8];
        callback(&mut out);
        let expected = [0.6, 0.6, 0.7, 0.7, 0.8, 0.8, 0.9, 0.9];
        for (a, b) in out.iter().zip(expected) {
            assert!((a - b).abs() < 1e-6, "{:?}", out);
        }
    }

    #[test]
    fn test_mix_drops_or_repeats_a_frame() {
        let samples: Vec<f32> = (1..=START).map(|n| n as f32 / 100.0).collect();
        let mut drops = source(1, &samples, 64);
        drops.pacer.playing = true;
        drops.pacer.drift = 1;
        let mut mix = [0.0; 4];
        mix_into(std::slice::from_mut(&mut drops), &mut mix, RATE);
        assert_eq!(mix, [0.02, 0.03, 0.04, 0.05]);

        let mut repeats = source(2, &samples, 64);
        repeats.pacer.playing = true;
        repeats.pacer.drift = -1;
        let mut mix = [0.0; 4];
        mix_into(std::slice::from_mut(&mut repeats), &mut mix, RATE);
        assert_eq!(mix, [0.01, 0.02, 0.03, 0.03]);
    }

    #[test]
    fn test_a_mic_at_another_rate_is_silent() {
        let mut stale = source(1, &[0.5; START], 64);
        stale.rate = RATE * 2;
        let sources = Arc::new(Mutex::new(vec![stale, source(2, &[0.25; START], 64)]));
        let mut callback =
            output_data_callback::<f32>(sources, 1, RATE, Arc::default(), Arc::default());
        let mut out = [9.0; 4];
        callback(&mut out);
        assert_eq!(out, [0.25; 4]);
    }

    #[test]
    fn test_output_underrun_is_silence() {
        // Empty, and below the start: zeros, whatever was in the buffer.
        let sources = Arc::new(Mutex::new(vec![
            source(1, &[], 64),
            source(2, &[0.5; START - 1], 64),
        ]));
        let mut callback =
            output_data_callback::<f32>(sources, 1, RATE, Arc::default(), Arc::default());
        let mut out = [9.0; 4];
        callback(&mut out);
        assert_eq!(out, [0.0; 4]);

        // Playing, then running dry mid-callback: the rest is silence.
        let sources = Arc::new(Mutex::new(vec![source(1, &[0.5; START + 2], 64)]));
        let mut callback =
            output_data_callback::<f32>(sources, 1, RATE, Arc::default(), Arc::default());
        let mut out = [9.0; 4];
        for _ in 0..START / 4 {
            callback(&mut out);
            assert_eq!(out, [0.5; 4]);
        }
        callback(&mut out);
        assert_eq!(out, [0.5, 0.5, 0.0, 0.0]);
        // And it waits to refill before playing again.
        callback(&mut out);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn test_output_with_no_mics_is_silence() {
        let mut callback = output_data_callback::<i16>(
            Arc::new(Mutex::new(vec![])),
            2,
            RATE,
            Arc::default(),
            Arc::default(),
        );
        let mut out = [7_i16; 8];
        callback(&mut out);
        assert_eq!(out, [0; 8]);
    }

    // A clipped mix lands on each format's ends, not past them (dasp's
    // 24-bit conversions don't saturate).
    fn clipped<T: cpal::Sample + cpal::FromSample<f32>>() -> (T, T) {
        let mut samples = [1.5, -1.5].repeat(START / 2);
        samples.resize(START, 0.0);
        let sources = Arc::new(Mutex::new(vec![source(1, &samples, 64)]));
        let mut callback =
            output_data_callback::<T>(sources, 1, RATE, Arc::default(), Arc::default());
        let mut out = [T::EQUILIBRIUM; 4];
        callback(&mut out);
        (out[0], out[1])
    }

    #[test]
    fn test_output_clips_at_full_scale() {
        let (high, low) = clipped::<cpal::I24>();
        assert_eq!((high.inner(), low.inner()), (8_388_607, -8_388_608));
        let (high, low) = clipped::<cpal::U24>();
        assert_eq!((high.inner(), low.inner()), (16_777_215, 0));
        assert_eq!(clipped::<i16>(), (i16::MAX, i16::MIN));
        assert_eq!(clipped::<u8>(), (u8::MAX, 0));
        assert_eq!(clipped::<i32>(), (i32::MAX - 255, i32::MIN));
        let (high, low) = clipped::<f32>();
        assert!(high < 1.0 && high > 0.999_999 && low == -1.0);
    }

    #[test]
    fn test_buffer_choices() {
        // The Topping's driver.
        assert_eq!(
            buffer_choices(8, 2048),
            [8, 16, 32, 64, 128, 256, 512, 1024, 2048]
        );
        // Realtek's takes one size.
        assert_eq!(buffer_choices(528, 528), [528]);
        assert_eq!(buffer_choices(100, 1000), [100, 128, 256, 512, 1000]);
        // Nothing larger than the mics' buffers hold.
        assert_eq!(buffer_choices(4096, 32768), [4096, 8192]);
        assert_eq!(buffer_choices(10000, 20000), [10000]);
    }

    // A choice that won't open leaves the old one, reopened.
    #[test]
    fn test_a_failed_choice_changes_nothing() {
        let choice = |name: &str| {
            Some(OutputChoice {
                name: name.to_string(),
                rate: None,
                buffer: None,
            })
        };
        let mut opened = Vec::new();
        let mut reopen = |mixer: &mut Mixer| -> Result<()> {
            let name = mixer.choice.as_ref().map(|c| c.name.clone());
            opened.push(name.clone());
            match name.as_deref() {
                Some("TV") => Err("it's asleep".into()),
                _ => Ok(()),
            }
        };
        let mut mixer = Mixer::default();
        mixer.choose(choice("Speakers"), &mut reopen).unwrap();
        assert!(mixer.choose(choice("TV"), &mut reopen).is_err());
        assert_eq!(mixer.choice.as_ref().unwrap().name, "Speakers");
        mixer.choose(None, &mut reopen).unwrap();
        assert!(mixer.choice.is_none());
        let opened: Vec<_> = opened.iter().map(Option::as_deref).collect();
        assert_eq!(
            opened,
            [Some("Speakers"), Some("TV"), Some("Speakers"), None]
        );
    }

    // The output callback counts itself for the stall check.
    #[test]
    fn test_the_output_callback_counts_its_calls() {
        let callbacks = Arc::new(AtomicU32::new(0));
        let mut callback = output_data_callback::<f32>(
            Arc::new(Mutex::new(vec![])),
            2,
            RATE,
            Arc::default(),
            callbacks.clone(),
        );
        for _ in 0..3 {
            callback(&mut [0.0; 8]);
        }
        assert_eq!(callbacks.load(Relaxed), 3);
    }

    // An ASIO mic's stream, counting when it closes.
    struct FakeAsio(Arc<AtomicU32>);

    impl crate::MicStream for FakeAsio {
        fn is_asio(&self) -> bool {
            true
        }
    }

    impl Drop for FakeAsio {
        fn drop(&mut self) {
            self.0.fetch_add(1, Relaxed);
        }
    }

    // The ASIO mics let go of their driver: those that failed, or all of
    // them, saying why. Other mics are left alone.
    #[test]
    fn test_asio_mics_release_their_driver() {
        let closed = Arc::new(AtomicU32::new(0));
        let mut mixer = Mixer::default();
        let asio = |status: Option<&str>| {
            let slot: StreamSlot = Arc::new(Mutex::new(Some(Box::new(FakeAsio(closed.clone())))));
            let status = Arc::new(Mutex::new(status.map(str::to_string)));
            (slot, status)
        };
        let (failed, failed_status) = asio(Some("The driver was reset"));
        let (working, working_status) = asio(None);
        let other_status: Arc<Mutex<Option<String>>> = Arc::default();
        for (slot, status) in [
            (Some(failed.clone()), failed_status.clone()),
            (Some(working.clone()), working_status.clone()),
            (None, other_status.clone()),
        ] {
            let (_tx, rx) = ringbuf::HeapRb::new(4).split();
            mixer.register(rx, 48000, status, slot);
        }
        mixer.release_asio(None);
        assert_eq!(closed.load(Relaxed), 1);
        assert!(lock(&failed).is_none());
        assert!(lock(&working).is_some());
        assert_eq!(*lock(&working_status), None);

        mixer.release_asio(Some("The mic output changed"));
        assert_eq!(closed.load(Relaxed), 2);
        assert!(lock(&working).is_none());
        assert_eq!(
            lock(&working_status).as_deref(),
            Some("The mic output changed")
        );
        assert_eq!(
            lock(&failed_status).as_deref(),
            Some("The driver was reset")
        );
        assert_eq!(*lock(&other_status), None);
        // No output, no ASIO buffer.
        assert_eq!(mixer.asio_buffer(), None);
    }

    // While the default plays for a missing choice, the choice is tried
    // again every RETRY_OUTPUT, not each time a mic is asked.
    #[test]
    fn test_a_missing_choice_is_tried_again_now_and_then() {
        let start = Instant::now();
        let mut mixer = Mixer {
            choice: Some(OutputChoice {
                name: "TV".to_string(),
                rate: None,
                buffer: None,
            }),
            ..Mixer::default()
        };
        // Playing on the choice (or the default when none is chosen): no
        // retries.
        assert!(mixer.retry_due(start + RETRY_OUTPUT * 2).is_none());
        mixer.retry_at = Some(start + RETRY_OUTPUT);
        assert!(mixer.retry_due(start).is_none());
        assert!(mixer.retry_due(start + RETRY_OUTPUT / 2).is_none());
        let due = start + RETRY_OUTPUT;
        assert_eq!(mixer.retry_due(due).map(|c| c.name).as_deref(), Some("TV"));
        assert!(mixer.retry_due(due + Duration::from_secs(1)).is_none());
        assert!(mixer.retry_due(due + RETRY_OUTPUT).is_some());
    }

    #[test]
    fn test_mixer_registers_and_deregisters() {
        let mut mixer = Mixer::default();
        assert_eq!(mixer.status(), "ok");
        let (_tx, rx) = ringbuf::HeapRb::new(4).split();
        let id = mixer.register(rx, 48000, Arc::new(Mutex::new(None)), None);
        assert_eq!(lock(&mixer.sources).len(), 1);
        mixer.deregister(id);
        assert!(lock(&mixer.sources).is_empty());
        assert!(mixer.output.is_none());
    }
}
