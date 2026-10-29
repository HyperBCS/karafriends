// WASAPI exclusive mode for the mics (cpal only has shared mode): the mic is
// ours alone, at its shortest period, with no Windows mixer in between.
//
// Everything runs on a thread of its own, so the COM objects stay on the
// thread that made them. Every Windows call is unsafe in the windows crate;
// the ones here only pass locals that outlive the call.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{
    CloseHandle, ERROR_NOT_FOUND, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_BUFFER_ERROR,
    AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_E_DEVICE_INVALIDATED,
    AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_SHAREMODE_EXCLUSIVE,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, IMMEndpoint, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0, eCapture,
};
use windows::Win32::Media::KernelStreaming::{
    KSDATAFORMAT_SUBTYPE_PCM, SPEAKER_FRONT_CENTER, SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT,
    WAVE_FORMAT_EXTENSIBLE,
};
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
    WaitForSingleObject,
};
use windows::core::{Error, GUID, HRESULT, HSTRING, Interface, PCWSTR, w};

type Outcome<T> = std::result::Result<T, String>;

// Rates tried after the one asked for.
const FALLBACK_RATES: [u32; 3] = [48000, 44100, 96000];
// How often the thread looks at its stop flag when the mic is quiet. (A
// mic that stops sending altogether is caught by InputDevice::status, as on
// every host.)
const WAIT_MS: u32 = 100;

const NOT_ALLOWED: &str = "Windows doesn't allow exclusive use of this mic: in Sound settings, \
     open the mic's Properties, Advanced, and tick 'Allow applications to take exclusive control \
     of this device'";
// Windows also says this when another program has the mic in shared mode and
// exclusive programs don't get priority.
const IN_USE: &str = "Another program is using this mic, so Windows won't give it to us alone: \
     close that program, or set this mic to Shared";

// A mic opened in exclusive mode; dropping it stops the stream and releases
// the mic.
pub(crate) struct ExclusiveInput {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    // Counted as open (see OPEN_STREAMS) until the thread has let it go.
    _open: crate::StreamInUse,
}

// What the stream runs at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExclusiveFormat {
    pub channels: u16,
    pub rate: u32,
    // Frames per period (each on_data call gets this many, or fewer at most).
    pub frames: u32,
}

impl ExclusiveInput {
    // Opens the capture endpoint `endpoint_id` (an IMMDevice id) in exclusive
    // mode, at `preferred_rate` if the mic takes it, with a period of
    // `buffer_frames` (None: the mic's shortest). Returns once the stream
    // runs. `on_data` gets interleaved samples, every channel, on the capture
    // thread; `on_error` is called once if the stream stops by itself. The
    // thread puts in `realtime` why MMCSS refused it, if it did, and counts
    // in `lost` the packets Windows lost.
    pub(crate) fn open(
        endpoint_id: &str,
        preferred_rate: u32,
        buffer_frames: Option<u32>,
        realtime: Arc<Mutex<Option<String>>>,
        lost: Arc<AtomicU32>,
        on_data: impl FnMut(&[f32]) + Send + 'static,
        on_error: impl FnOnce(String) + Send + 'static,
    ) -> crate::Result<(ExclusiveInput, ExclusiveFormat)> {
        let stop = Arc::new(AtomicBool::new(false));
        let (opened_tx, opened) = mpsc::channel();
        let endpoint_id = endpoint_id.to_string();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("exclusive mic".to_string())
            .spawn(move || {
                capture_thread(
                    &endpoint_id,
                    (preferred_rate, buffer_frames),
                    opened_tx,
                    &thread_stop,
                    (&realtime, &lost),
                    on_data,
                    on_error,
                )
            })?;
        let input = ExclusiveInput {
            stop,
            thread: Some(thread),
            _open: crate::StreamInUse::new(),
        };
        // On an error the thread has ended; dropping `input` joins it.
        match opened.recv() {
            Ok(Ok(format)) => Ok((input, format)),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err("The exclusive mic thread ended before the mic opened".into()),
        }
    }
}

impl Drop for ExclusiveInput {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn capture_thread(
    endpoint_id: &str,
    (preferred_rate, buffer_frames): (u32, Option<u32>),
    opened: mpsc::Sender<Outcome<ExclusiveFormat>>,
    stop: &AtomicBool,
    (realtime, lost): (&Mutex<Option<String>>, &AtomicU32),
    mut on_data: impl FnMut(&[f32]),
    on_error: impl FnOnce(String),
) {
    // First, so COM ends after every COM object here is released.
    let _com = match Com::start() {
        Ok(com) => com,
        Err(e) => {
            let _ = opened.send(Err(e));
            return;
        }
    };
    let capture = match Capture::open(endpoint_id, preferred_rate, buffer_frames) {
        Ok(capture) => capture,
        Err(e) => {
            let _ = opened.send(Err(e));
            return;
        }
    };
    let _ = opened.send(Ok(capture.format));
    let ended = capture.run(stop, realtime, lost, &mut on_data);
    // Release the mic before saying it stopped.
    drop(capture);
    if let Some(e) = ended
        && !stop.load(Relaxed)
    {
        on_error(e);
    }
}

// COM for this thread, until dropped.
struct Com;

impl Com {
    fn start() -> Outcome<Com> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| failed("CoInitializeEx", &e))?;
        Ok(Com)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

// An auto-reset event WASAPI sets each period.
struct Event(HANDLE);

impl Event {
    fn new() -> Outcome<Event> {
        unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .map(Event)
            .map_err(|e| failed("CreateEventW", &e))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

// The thread's place in MMCSS's "Pro Audio" class, so a busy PC doesn't
// starve it, until dropped.
struct Mmcss(HANDLE);

impl Mmcss {
    // On a refusal the thread still runs, just at normal priority.
    fn join() -> Outcome<Mmcss> {
        let mut task_index = 0;
        unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }
            .map(Mmcss)
            .map_err(|e| format!("MMCSS refused it: {e}"))
    }
}

impl Drop for Mmcss {
    fn drop(&mut self) {
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

// The running stream. Fields drop in order: the clients before the event
// they set.
struct Capture {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    event: Event,
    sample: SampleFormat,
    // Bytes per frame.
    block: usize,
    format: ExclusiveFormat,
}

impl Capture {
    fn open(
        endpoint_id: &str,
        preferred_rate: u32,
        buffer_frames: Option<u32>,
    ) -> Outcome<Capture> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| failed("CoCreateInstance", &e))?;
        let device = unsafe { enumerator.GetDevice(&HSTRING::from(endpoint_id)) }
            .map_err(|e| failed("IMMDeviceEnumerator::GetDevice", &e))?;
        // An output opened exclusively would cut off whatever plays there.
        let flow = device
            .cast::<IMMEndpoint>()
            .and_then(|endpoint| unsafe { endpoint.GetDataFlow() })
            .map_err(|e| failed("IMMEndpoint::GetDataFlow", &e))?;
        if flow != eCapture {
            return Err("This device isn't a mic".to_string());
        }
        let mut client = activate(&device)?;
        let mut minimum = 0;
        unsafe { client.GetDevicePeriod(None, Some(&mut minimum)) }
            .map_err(|e| failed("IAudioClient::GetDevicePeriod", &e))?;
        let (candidate, format) = pick_format(&client, preferred_rate)?;
        let period = buffer_frames.map_or(minimum, |frames| {
            frames_to_hns(frames, candidate.rate).max(minimum)
        });
        if let Err(e) = initialize(&client, &format, period) {
            if e.code() != AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                return Err(failed("IAudioClient::Initialize", &e));
            }
            // Microsoft's documented fix: the aligned size it suggests, on a
            // new client.
            let frames = unsafe { client.GetBufferSize() }
                .map_err(|e| failed("IAudioClient::GetBufferSize", &e))?;
            drop(client);
            client = activate(&device)?;
            initialize(&client, &format, frames_to_hns(frames, candidate.rate))
                .map_err(|e| failed("IAudioClient::Initialize", &e))?;
        }
        let frames = unsafe { client.GetBufferSize() }
            .map_err(|e| failed("IAudioClient::GetBufferSize", &e))?;
        let event = Event::new()?;
        unsafe { client.SetEventHandle(event.0) }
            .map_err(|e| failed("IAudioClient::SetEventHandle", &e))?;
        let capture = unsafe { client.GetService::<IAudioCaptureClient>() }
            .map_err(|e| failed("IAudioClient::GetService", &e))?;
        let capture = Capture {
            capture,
            client,
            event,
            sample: candidate.sample,
            block: candidate.channels as usize * candidate.sample.bytes(),
            format: ExclusiveFormat {
                channels: candidate.channels,
                rate: candidate.rate,
                frames,
            },
        };
        unsafe { capture.client.Start() }.map_err(|e| failed("IAudioClient::Start", &e))?;
        Ok(capture)
    }

    // Reads until `stop` is set; if the stream stops first, why.
    fn run(
        &self,
        stop: &AtomicBool,
        realtime: &Mutex<Option<String>>,
        lost: &AtomicU32,
        on_data: &mut impl FnMut(&[f32]),
    ) -> Option<String> {
        let _mmcss = match Mmcss::join() {
            Ok(mmcss) => Some(mmcss),
            Err(e) => {
                eprintln!("The exclusive mic thread isn't real-time: {e}");
                *crate::lock(realtime) = Some(e);
                None
            }
        };
        let period = self.format.frames as usize * self.format.channels as usize;
        let mut samples = Vec::with_capacity(period);
        while !stop.load(Relaxed) {
            let waited = unsafe { WaitForSingleObject(self.event.0, WAIT_MS) };
            if waited == WAIT_OBJECT_0 {
                if let Err(e) = self.drain(&mut samples, period, lost, on_data) {
                    return Some(e);
                }
            } else if waited != WAIT_TIMEOUT {
                return Some(failed("WaitForSingleObject", &Error::from_thread()));
            }
        }
        None
    }

    // Hands on every packet waiting, at most a period per call.
    // (GetNextPacketSize is for shared mode only, so this reads until
    // GetBuffer has nothing.)
    fn drain(
        &self,
        samples: &mut Vec<f32>,
        period: usize,
        lost: &AtomicU32,
        on_data: &mut impl FnMut(&[f32]),
    ) -> Outcome<()> {
        loop {
            let (mut data, mut frames, mut flags, mut position) = (std::ptr::null_mut(), 0, 0, 0);
            let got = unsafe {
                self.capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut position),
                    None,
                )
            };
            match got {
                // In exclusive mode: no packet yet, so wait for the next event.
                Err(e) if e.code() == AUDCLNT_E_BUFFER_ERROR => return Ok(()),
                Err(e) => return Err(failed("IAudioCaptureClient::GetBuffer", &e)),
                // AUDCLNT_S_BUFFER_EMPTY: all read.
                Ok(()) if frames == 0 => return Ok(()),
                Ok(()) => {}
            }
            // Windows lost a period, as it does when this thread is late: a
            // larger buffer helps. (The flag means nothing on the first
            // packet, at position 0.)
            if position != 0 && flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                lost.fetch_add(1, Relaxed);
            }
            let bytes = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                None
            } else {
                // WASAPI lends us `frames` frames at `data` until ReleaseBuffer.
                Some(unsafe { std::slice::from_raw_parts(data, frames as usize * self.block) })
            };
            let count = frames as usize * self.format.channels as usize;
            convert(self.sample, bytes, count, samples);
            unsafe { self.capture.ReleaseBuffer(frames) }
                .map_err(|e| failed("IAudioCaptureClient::ReleaseBuffer", &e))?;
            for chunk in samples.chunks(period.max(1)) {
                on_data(chunk);
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

fn activate(device: &IMMDevice) -> Outcome<IAudioClient> {
    unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| failed("IMMDevice::Activate", &e))
}

fn initialize(
    client: &IAudioClient,
    format: &WAVEFORMATEXTENSIBLE,
    period: i64,
) -> windows::core::Result<()> {
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            period,
            period,
            &format.Format,
            None,
        )
    }
}

// The first format the mic takes in exclusive mode, of `candidates`.
fn pick_format(
    client: &IAudioClient,
    preferred_rate: u32,
) -> Outcome<(Candidate, WAVEFORMATEXTENSIBLE)> {
    let (channels, mask) = mix_channels(client)?;
    for candidate in candidates(preferred_rate, channels) {
        let format = wave_format(candidate, channel_mask(candidate.channels, channels, mask));
        let hr =
            unsafe { client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, None) };
        if hr.is_ok() {
            return Ok((candidate, format));
        }
        // Not about the format: no other would do better. (Windows says
        // NOT_ALLOWED here already, before Initialize.)
        if [
            AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED,
            AUDCLNT_E_DEVICE_IN_USE,
            AUDCLNT_E_DEVICE_INVALIDATED,
        ]
        .contains(&hr)
        {
            return Err(failed("IAudioClient::IsFormatSupported", &hr.into()));
        }
    }
    Err(no_format(&rates(preferred_rate)))
}

// The mic's channel count and speaker mask (0 if it has none), from its
// shared-mode format.
fn mix_channels(client: &IAudioClient) -> Outcome<(u16, u32)> {
    let format =
        unsafe { client.GetMixFormat() }.map_err(|e| failed("IAudioClient::GetMixFormat", &e))?;
    // The format is ours to read, then free; it may be unaligned.
    unsafe {
        let ex = format.read_unaligned();
        let extensible = ex.wFormatTag == WAVE_FORMAT_EXTENSIBLE as u16 && ex.cbSize >= 22;
        let mask = if extensible {
            (format as *const WAVEFORMATEXTENSIBLE)
                .read_unaligned()
                .dwChannelMask
        } else {
            0
        };
        CoTaskMemFree(Some(format as *const _));
        Ok((ex.nChannels, mask))
    }
}

// The sample formats tried, best first: 24 bits is the most a mic really
// has, and few drivers take 32-bit or float in exclusive mode.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SampleFormat {
    // 24 bits at the top of a 32-bit container.
    I24In32,
    // 24 bits packed in 3 bytes.
    I24,
    I16,
    I32,
    F32,
}

const SAMPLE_FORMATS: [SampleFormat; 5] = [
    SampleFormat::I24In32,
    SampleFormat::I24,
    SampleFormat::I16,
    SampleFormat::I32,
    SampleFormat::F32,
];

impl SampleFormat {
    // Container bits and valid bits.
    fn bits(self) -> (u16, u16) {
        match self {
            SampleFormat::I24In32 => (32, 24),
            SampleFormat::I24 => (24, 24),
            SampleFormat::I16 => (16, 16),
            SampleFormat::I32 | SampleFormat::F32 => (32, 32),
        }
    }

    fn bytes(self) -> usize {
        self.bits().0 as usize / 8
    }

    fn subtype(self) -> GUID {
        match self {
            SampleFormat::F32 => KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            _ => KSDATAFORMAT_SUBTYPE_PCM,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Candidate {
    rate: u32,
    channels: u16,
    sample: SampleFormat,
}

// The values that aren't 0, each once, in order.
fn distinct<T: Copy + Default + PartialEq>(values: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut seen = Vec::new();
    for value in values {
        if value != T::default() && !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

// The one asked for, then the common ones.
fn rates(preferred_rate: u32) -> Vec<u32> {
    distinct(std::iter::once(preferred_rate).chain(FALLBACK_RATES))
}

// Every format to ask the mic about, best first: the rate matters most (the
// mic's samples go to an output at `preferred_rate`), then keeping the mic's
// own channel count, then the sample format.
fn candidates(preferred_rate: u32, mix_channels: u16) -> Vec<Candidate> {
    let channel_counts = distinct([mix_channels, 2, 1]);
    let mut candidates = Vec::new();
    for rate in rates(preferred_rate) {
        for &channels in &channel_counts {
            for sample in SAMPLE_FORMATS {
                candidates.push(Candidate {
                    rate,
                    channels,
                    sample,
                });
            }
        }
    }
    candidates
}

fn no_format(rates: &[u32]) -> String {
    let (last, rest) = rates.split_last().expect("there are always fallback rates");
    let rest: Vec<String> = rest.iter().map(u32::to_string).collect();
    format!(
        "The mic has no exclusive format at {} or {last} Hz",
        rest.join(", ")
    )
}

// The mic's own speaker mask when the count is its own, else the usual one.
fn channel_mask(channels: u16, mix_channels: u16, mix_mask: u32) -> u32 {
    match channels {
        _ if channels == mix_channels && mix_mask != 0 => mix_mask,
        1 => SPEAKER_FRONT_CENTER,
        2 => SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT,
        _ => 0,
    }
}

fn wave_format(candidate: Candidate, mask: u32) -> WAVEFORMATEXTENSIBLE {
    let (bits, valid) = candidate.sample.bits();
    let block = candidate.channels * bits / 8;
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: candidate.channels,
            nSamplesPerSec: candidate.rate,
            nAvgBytesPerSec: candidate.rate * block as u32,
            nBlockAlign: block,
            wBitsPerSample: bits,
            // The bytes after WAVEFORMATEX.
            cbSize: (std::mem::size_of::<WAVEFORMATEXTENSIBLE>()
                - std::mem::size_of::<WAVEFORMATEX>()) as u16,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: valid,
        },
        dwChannelMask: mask,
        SubFormat: candidate.sample.subtype(),
    }
}

// Frames as a WASAPI duration (100 ns units), rounded as Microsoft's
// example rounds it.
fn frames_to_hns(frames: u32, rate: u32) -> i64 {
    (frames as i64 * 10_000_000 + rate as i64 / 2) / rate as i64
}

// A packet's samples into `out` as f32, reusing its space. `bytes` is None
// when WASAPI marks the packet silent: then it's `count` zeros.
fn convert(sample: SampleFormat, bytes: Option<&[u8]>, count: usize, out: &mut Vec<f32>) {
    out.clear();
    let bytes = match bytes {
        Some(bytes) => bytes,
        None => {
            out.resize(count, 0.0);
            return;
        }
    };
    // Integers scale by their full range; 24 bits are shifted to the top of
    // an i32 first.
    const I32_SCALE: f32 = 1.0 / 2_147_483_648.0;
    match sample {
        SampleFormat::I16 => out.extend(
            bytes
                .as_chunks()
                .0
                .iter()
                .map(|&b| i16::from_le_bytes(b) as f32 / 32768.0),
        ),
        SampleFormat::I24 => out.extend(
            bytes
                .as_chunks()
                .0
                .iter()
                .map(|&[a, b, c]| i32::from_le_bytes([0, a, b, c]) as f32 * I32_SCALE),
        ),
        SampleFormat::I24In32 | SampleFormat::I32 => out.extend(
            bytes
                .as_chunks()
                .0
                .iter()
                .map(|&b| i32::from_le_bytes(b) as f32 * I32_SCALE),
        ),
        SampleFormat::F32 => out.extend(bytes.as_chunks().0.iter().map(|&b| f32::from_le_bytes(b))),
    }
}

// What a failed Windows call means, in words someone can act on.
fn failed(step: &str, e: &Error) -> String {
    let code = e.code();
    if code == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
        return NOT_ALLOWED.to_string();
    }
    if code == AUDCLNT_E_DEVICE_IN_USE {
        return IN_USE.to_string();
    }
    if code == AUDCLNT_E_DEVICE_INVALIDATED {
        return "The mic was unplugged or turned off".to_string();
    }
    if code == HRESULT::from_win32(ERROR_NOT_FOUND.0) {
        return "The mic isn't connected".to_string();
    }
    let message = e.message();
    let message = message.trim().trim_end_matches('.');
    if message.is_empty() {
        format!("Exclusive mode failed at {step}: {code}")
    } else {
        format!("Exclusive mode failed at {step}: {code}, {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};
    use windows::Win32::Media::Audio::{DEVICE_STATE_ACTIVE, EDataFlow, eRender};

    fn converted(sample: SampleFormat, bytes: &[u8]) -> Vec<f32> {
        let mut out = vec![9.0; 3];
        convert(sample, Some(bytes), 0, &mut out);
        out
    }

    #[test]
    fn test_convert_16_bit() {
        let bytes = [0x00, 0x80, 0xff, 0x7f, 0x00, 0x40, 0x00, 0x00];
        assert_eq!(
            converted(SampleFormat::I16, &bytes),
            [-1.0, 32767.0 / 32768.0, 0.5, 0.0]
        );
    }

    #[test]
    fn test_convert_24_bit_packed() {
        let bytes = [0x00, 0x00, 0x80, 0x00, 0x00, 0x40, 0xff, 0xff, 0xff];
        assert_eq!(
            converted(SampleFormat::I24, &bytes),
            [-1.0, 0.5, -1.0 / 8_388_608.0]
        );
    }

    #[test]
    fn test_convert_24_in_32() {
        // The valid bits are the top three bytes; the low one is padding.
        let bytes = [
            0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x40, 0x00, 0x01, 0x00, 0x00,
        ];
        assert_eq!(
            converted(SampleFormat::I24In32, &bytes),
            [-1.0, 0.5, 1.0 / 8_388_608.0]
        );
    }

    #[test]
    fn test_convert_32_bit() {
        let bytes = [0x00, 0x00, 0x00, 0xc0, 0xff, 0xff, 0xff, 0x7f];
        assert_eq!(converted(SampleFormat::I32, &bytes), [-0.5, 1.0]);
    }

    #[test]
    fn test_convert_float() {
        let mut bytes = Vec::new();
        for sample in [0.25f32, -0.75] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        assert_eq!(converted(SampleFormat::F32, &bytes), [0.25, -0.75]);
    }

    #[test]
    fn test_convert_silent_packet_is_zeros() {
        let mut out = vec![9.0; 3];
        convert(SampleFormat::I16, None, 4, &mut out);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn test_convert_reuses_the_vec() {
        let mut out = Vec::with_capacity(8);
        let capacity = out.capacity();
        for _ in 0..3 {
            convert(SampleFormat::I16, Some(&[0; 16]), 0, &mut out);
            assert_eq!(out.len(), 8);
        }
        assert_eq!(out.capacity(), capacity);
    }

    #[test]
    fn test_frames_to_hns() {
        assert_eq!(frames_to_hns(144, 48000), 30000);
        assert_eq!(frames_to_hns(480, 48000), 100_000);
        // 29931.97 and 226.76 round up, 104.17 down.
        assert_eq!(frames_to_hns(132, 44100), 29932);
        assert_eq!(frames_to_hns(1, 44100), 227);
        assert_eq!(frames_to_hns(1, 96000), 104);
        // Back at the rate, a rounded period still holds its frames.
        for (frames, rate) in [(132, 44100), (441, 44100), (1, 96000)] {
            let hns = frames_to_hns(frames, rate);
            let back = (hns as f64 * rate as f64 / 1e7).round() as u32;
            assert_eq!(back, frames);
        }
    }

    #[test]
    fn test_candidates_put_the_preferred_rate_first() {
        let all = candidates(44100, 1);
        // 3 rates, 2 channel counts, 5 sample formats.
        assert_eq!(all.len(), 30);
        assert_eq!(
            all[0],
            Candidate {
                rate: 44100,
                channels: 1,
                sample: SampleFormat::I24In32
            }
        );
        let samples: Vec<_> = all[..5].iter().map(|c| c.sample).collect();
        assert_eq!(samples, SAMPLE_FORMATS);
        assert_eq!(all[5].channels, 2);
        let rates: Vec<_> = all.iter().step_by(10).map(|c| c.rate).collect();
        assert_eq!(rates, [44100, 48000, 96000]);
    }

    #[test]
    fn test_candidates_have_no_repeats() {
        assert_eq!(rates(48000), [48000, 44100, 96000]);
        assert_eq!(rates(22050), [22050, 48000, 44100, 96000]);
        assert_eq!(rates(0), [48000, 44100, 96000]);
        let all = candidates(48000, 2);
        assert_eq!(all.len(), 3 * 2 * 5);
        for (i, a) in all.iter().enumerate() {
            assert!(!all[i + 1..].contains(a), "{:?} twice", a);
        }
        // A 4-channel mic tries 4, then 2, then 1.
        let channels: Vec<_> = candidates(48000, 4)[..15]
            .iter()
            .step_by(5)
            .map(|c| c.channels)
            .collect();
        assert_eq!(channels, [4, 2, 1]);
    }

    #[test]
    fn test_no_format_names_the_rates() {
        assert_eq!(
            no_format(&rates(22050)),
            "The mic has no exclusive format at 22050, 48000, 44100 or 96000 Hz"
        );
    }

    #[test]
    fn test_wave_format() {
        let candidate = Candidate {
            rate: 48000,
            channels: 2,
            sample: SampleFormat::I24In32,
        };
        let format = wave_format(candidate, 3);
        assert_eq!({ format.Format.nBlockAlign }, 8);
        assert_eq!({ format.Format.nAvgBytesPerSec }, 384_000);
        assert_eq!({ format.Format.wBitsPerSample }, 32);
        assert_eq!(unsafe { format.Samples.wValidBitsPerSample }, 24);
        assert_eq!({ format.Format.cbSize }, 22);
        assert_eq!({ format.SubFormat }, KSDATAFORMAT_SUBTYPE_PCM);
        let packed = wave_format(
            Candidate {
                rate: 44100,
                channels: 1,
                sample: SampleFormat::I24,
            },
            4,
        );
        assert_eq!({ packed.Format.nBlockAlign }, 3);
    }

    #[test]
    fn test_channel_mask() {
        assert_eq!(channel_mask(2, 2, 0x3f), 0x3f);
        assert_eq!(channel_mask(2, 4, 0x33), 3);
        assert_eq!(channel_mask(1, 2, 3), 4);
        assert_eq!(channel_mask(4, 2, 3), 0);
    }

    #[test]
    fn test_unknown_endpoint_isnt_connected() {
        let opened = ExclusiveInput::open(
            "{0.0.1.00000000}.{nothing}",
            48000,
            None,
            Arc::default(),
            Arc::default(),
            |_| {},
            |_| {},
        );
        assert_eq!(opened.err().unwrap().to_string(), "The mic isn't connected");
    }

    fn first_endpoint(flow: EDataFlow) -> String {
        let _com = Com::start().unwrap();
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
            let devices = enumerator
                .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                .unwrap();
            let id = devices.Item(0).unwrap().GetId().unwrap();
            let text = id.to_string().unwrap();
            CoTaskMemFree(Some(id.0 as *const _));
            text
        }
    }

    // Run with --ignored: takes this PC's first mic for about two seconds.
    #[test]
    #[ignore]
    fn test_exclusive_capture_on_hardware() {
        let id = first_endpoint(eCapture);
        println!("mic {id}");
        // The minimum period, then 10 ms (which also shows the first released
        // the mic).
        for buffer_frames in [None, Some(480)] {
            let samples = Arc::new(AtomicUsize::new(0));
            let largest = Arc::new(AtomicUsize::new(0));
            let error = Arc::new(Mutex::new(None));
            let (counted, seen, stopped) = (samples.clone(), largest.clone(), error.clone());
            let opening = Instant::now();
            let opened = ExclusiveInput::open(
                &id,
                48000,
                buffer_frames,
                Arc::default(),
                Arc::default(),
                move |data| {
                    counted.fetch_add(data.len(), Relaxed);
                    seen.fetch_max(data.len(), Relaxed);
                },
                move |e| *stopped.lock().unwrap() = Some(e),
            );
            let (input, format) = match opened {
                Ok(opened) => opened,
                Err(e) => {
                    println!("refused: {e}");
                    assert_eq!(e.to_string(), NOT_ALLOWED);
                    return;
                }
            };
            println!(
                "buffer {:?}: opened in {:?} at {:?}",
                buffer_frames,
                opening.elapsed(),
                format
            );
            let start = Instant::now();
            std::thread::sleep(Duration::from_secs(1));
            let elapsed = start.elapsed();
            let channels = format.channels as usize;
            let frames = samples.load(Relaxed) / channels;
            drop(input);
            let expected = format.rate as f64 * elapsed.as_secs_f64();
            let largest = largest.load(Relaxed) / channels;
            println!(
                "{frames} frames in {elapsed:?} (about {expected:.0} expected), at most {largest} \
                 per call"
            );
            assert_eq!(*error.lock().unwrap(), None);
            assert!((frames as f64 - expected).abs() < expected * 0.1);
            assert!(largest > 0 && largest <= format.frames as usize);
        }
    }

    // Run with --ignored: looks at the first output without opening it.
    #[test]
    #[ignore]
    fn test_an_output_isnt_opened() {
        let id = first_endpoint(eRender);
        let opened = ExclusiveInput::open(
            &id,
            48000,
            None,
            Arc::default(),
            Arc::default(),
            |_| {},
            |_| {},
        );
        assert_eq!(opened.err().unwrap().to_string(), "This device isn't a mic");
    }
}
