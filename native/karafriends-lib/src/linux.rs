// Linux: which sound system the mics use, which of its devices are mics and
// outputs, what Settings calls them, and how they open.
//
// The sound system is PipeWire when it runs (most systems since 2022), else
// PulseAudio, else ALSA itself. PipeWire is the one with the least delay:
// karafriends asks it for small buffers (the "quantum"), and every mic and
// the mic output run in the same graph cycle. PulseAudio comes next (through
// pipewire-pulse too, but that one won't go below 256 samples). ALSA alone
// lists every card many times over (front, surround51, dmix, hw, plughw...),
// each with up to 64 channels, so only the system default and each card's
// own devices are kept.

use std::collections::HashMap;

use cpal::traits::{DeviceTrait, HostTrait};

use crate::Result;

// The buffer size, in frames, the mics and their output ask for until
// Settings picks one: 128 is 2.7 ms at 48 kHz. With PipeWire's real-time
// threads that runs without a glitch on an ordinary laptop; the sound
// waits a few buffers between the mic and the speaker.
pub(crate) const DEFAULT_BUFFER: u32 = 128;

// The sizes Settings offers, where the sound system takes them.
const BUFFERS: [u32; 5] = [64, 128, 256, 512, 1024];

// Names KARAFRIENDS_AUDIO_HOST takes: pipewire, pulseaudio or alsa.
const HOST_VARIABLE: &str = "KARAFRIENDS_AUDIO_HOST";

// cpal's PipeWire streams call pw_stream_get_time_n, from PipeWire 0.3.50.
// The module binds it lazily (see build.rs), so with an older library it
// loads, and PipeWire is skipped.
#[cfg(feature = "pipewire")]
const PIPEWIRE_MIN: (u32, u32, u32) = (0, 3, 50);

// The sound system the mics use, and why it isn't the usual one if it
// isn't: KARAFRIENDS_AUDIO_HOST's when it is set and starts; else PipeWire,
// when it runs and its library is new enough; else PulseAudio
// (pipewire-pulse counts); else ALSA.
pub(crate) fn system_host() -> Result<(cpal::Host, Option<String>)> {
    let mut why = None;
    if let Ok(name) = std::env::var(HOST_VARIABLE) {
        match chosen_host(&name) {
            Ok(host) => return Ok((host, Some(format!("as {HOST_VARIABLE} says")))),
            Err(e) => why = Some(format!("{HOST_VARIABLE}={name} didn't start: {e}")),
        }
    }
    let available = cpal::available_hosts();
    #[cfg(feature = "pipewire")]
    if available.contains(&cpal::HostId::PipeWire) {
        if !pipewire_is_new_enough() {
            let (major, minor, micro) = PIPEWIRE_MIN;
            why.get_or_insert(format!(
                "PipeWire {} is older than {major}.{minor}.{micro}",
                pipewire_version()
            ));
        } else {
            match cpal::host_from_id(cpal::HostId::PipeWire) {
                Ok(host) => return Ok((host, why)),
                Err(e) => {
                    why.get_or_insert(format!("PipeWire didn't start: {e}"));
                }
            }
        }
    }
    #[cfg(not(feature = "pipewire"))]
    why.get_or_insert("this build has no PipeWire".to_string());
    if available.contains(&cpal::HostId::PulseAudio) {
        if let Ok(host) = cpal::host_from_id(cpal::HostId::PulseAudio) {
            return Ok((host, why));
        }
    }
    Ok((cpal::host_from_id(cpal::HostId::Alsa)?, why))
}

// The host KARAFRIENDS_AUDIO_HOST names, if it starts.
fn chosen_host(name: &str) -> Result<cpal::Host> {
    let id: cpal::HostId = name
        .parse()
        .map_err(|_| "not one of pipewire, pulseaudio, alsa".to_string())?;
    #[cfg(feature = "pipewire")]
    if id == cpal::HostId::PipeWire && !pipewire_is_new_enough() {
        return Err(format!("PipeWire {} is too old", pipewire_version()).into());
    }
    if !cpal::available_hosts().contains(&id) {
        return Err(format!("{} isn't running", id.name()).into());
    }
    Ok(cpal::host_from_id(id)?)
}

// For Settings: the sound system the mics use ("Sound system: PipeWire
// 1.6.2"), and why, from system_host, if it isn't the usual one.
pub(crate) fn status(host: &cpal::Host, why: Option<String>) -> String {
    #[cfg(feature = "pipewire")]
    let name = if host.id() == cpal::HostId::PipeWire {
        format!("PipeWire {}", pipewire_version())
    } else {
        host.id().name().to_string()
    };
    #[cfg(not(feature = "pipewire"))]
    let name = host.id().name().to_string();
    match why {
        Some(why) => format!("Sound system: {name} ({why})"),
        None => format!("Sound system: {name}"),
    }
}

// The PipeWire library's version: "1.6.2".
#[cfg(feature = "pipewire")]
fn pipewire_version() -> String {
    // A static string, there before pw_init.
    unsafe { std::ffi::CStr::from_ptr(pipewire::sys::pw_get_library_version()) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(feature = "pipewire")]
fn pipewire_is_new_enough() -> bool {
    version_at_least(&pipewire_version(), PIPEWIRE_MIN)
}

// Whether "1.6.2" is at least (0, 3, 50). Missing parts count as 0.
#[cfg_attr(not(feature = "pipewire"), allow(dead_code))]
fn version_at_least(version: &str, min: (u32, u32, u32)) -> bool {
    let mut parts = version
        .split('.')
        .map(|part| part.trim().parse::<u32>().unwrap_or(0));
    let mut next = || parts.next().unwrap_or(0);
    (next(), next(), next()) >= min
}

// The part of a device's id after the host: a PipeWire node's name, a
// PulseAudio source's or sink's, an ALSA PCM's.
fn node(device: &cpal::Device) -> String {
    device
        .id()
        .map(|id| id.id().to_string())
        .unwrap_or_default()
}

// PipeWire's stand-ins for the default devices, which follow the system's
// choice.
const PIPEWIRE_DEFAULT_INPUT: &str = "input_default";
const PIPEWIRE_DEFAULT_OUTPUTS: [&str; 2] = ["output_default", "sink_default"];

// The mics: on PipeWire the system default and its sources (not the
// outputs, which cpal lists as inputs too, to record what they play, nor
// other programs' recordings); on PulseAudio its sources but not the
// outputs' monitors; on ALSA the default and each card's devices.
pub(crate) fn input_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>> {
    let devices: Vec<_> = host.input_devices()?.collect();
    Ok(match host.id().name() {
        "PipeWire" => {
            let classes = pipewire_classes();
            devices
                .into_iter()
                .filter(|device| {
                    let node = node(device);
                    node == PIPEWIRE_DEFAULT_INPUT
                        || is_pipewire_device(device, &node, classes.as_ref(), "Audio/Source")
                })
                .collect()
        }
        "PulseAudio" => devices
            .into_iter()
            .filter(|device| !node(device).ends_with(".monitor"))
            .collect(),
        "ALSA" => alsa_devices(devices, &["plughw:"]),
        _ => devices,
    })
}

// The outputs the mics can play through ("System default", the one that
// follows the system, is Settings' own): on PipeWire its sinks, on ALSA the
// default and each card's devices, direct or shared.
pub(crate) fn output_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>> {
    let devices: Vec<_> = host.output_devices()?.collect();
    Ok(match host.id().name() {
        "PipeWire" => {
            let classes = pipewire_classes();
            devices
                .into_iter()
                .filter(|device| {
                    let node = node(device);
                    !PIPEWIRE_DEFAULT_OUTPUTS.contains(&node.as_str())
                        && is_pipewire_device(device, &node, classes.as_ref(), "Audio/Sink")
                })
                .collect()
        }
        "ALSA" => alsa_devices(devices, &["plughw:", "dmix:"]),
        _ => devices,
    })
}

// A device of `class` ("Audio/Source", "Audio/Sink"), or one that is both
// ("Audio/Duplex"), as PipeWire's registry says; or, if it didn't answer,
// one with a driver (other programs' streams have none).
fn is_pipewire_device(
    device: &cpal::Device,
    node: &str,
    classes: Option<&HashMap<String, String>>,
    class: &str,
) -> bool {
    match classes {
        Some(classes) => classes
            .get(node)
            .is_some_and(|c| c == class || c == "Audio/Duplex"),
        None => device
            .description()
            .is_ok_and(|description| description.driver().is_some()),
    }
}

// Each node's media class, by node name: mics are "Audio/Source", outputs
// "Audio/Sink", and programs' streams (karafriends' own too) "Stream/...".
// None if PipeWire doesn't answer within two seconds. Asked while a cpal
// PipeWire host lives, which keeps the library initialised (cpal
// deinitialises it once its last host or stream is gone).
#[cfg(feature = "pipewire")]
fn pipewire_classes() -> Option<HashMap<String, String>> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    use pipewire as pw;

    let mainloop = pw::main_loop::MainLoopRc::new(None).ok()?;
    let context = pw::context::ContextRc::new(&mainloop, None).ok()?;
    let core = context.connect_rc(None).ok()?;
    let registry = core.get_registry_rc().ok()?;

    let classes: Rc<RefCell<HashMap<String, String>>> = Rc::default();
    let _registry_listener = registry
        .add_listener_local()
        .global({
            let classes = classes.clone();
            move |global| {
                if global.type_ != pw::types::ObjectType::Node {
                    return;
                }
                let Some(props) = global.props else {
                    return;
                };
                if let (Some(name), Some(class)) =
                    (props.get("node.name"), props.get("media.class"))
                {
                    classes
                        .borrow_mut()
                        .insert(name.to_string(), class.to_string());
                }
            }
        })
        .register();

    // The registry has sent every node once the server answers this.
    let pending = core.sync(0).ok()?;
    let _core_listener = core
        .add_listener_local()
        .done({
            let mainloop = mainloop.clone();
            move |id, seq| {
                if id == pw::core::PW_ID_CORE && seq == pending {
                    mainloop.quit();
                }
            }
        })
        .register();

    // A server that never answers can't hang the display.
    let (cancel_tx, cancel_rx) = mpsc::channel::<()>();
    let (timeout_tx, timeout_rx) = pw::channel::channel::<()>();
    let timed_out = Rc::new(RefCell::new(false));
    let _timeout = timeout_rx.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        let timed_out = timed_out.clone();
        move |_| {
            *timed_out.borrow_mut() = true;
            mainloop.quit();
        }
    });
    std::thread::spawn(move || {
        if cancel_rx.recv_timeout(Duration::from_secs(2)).is_err() {
            let _ = timeout_tx.send(());
        }
    });
    mainloop.run();
    let _ = cancel_tx.send(());
    if *timed_out.borrow() {
        eprintln!("PipeWire didn't list its nodes in time");
        return None;
    }
    let classes = classes.take();
    Some(classes)
}

#[cfg(not(feature = "pipewire"))]
fn pipewire_classes() -> Option<HashMap<String, String>> {
    None
}

// ALSA's "default", and each card's devices with one of `prefixes` (plughw:
// converts any format; dmix: shares the device with other programs). Cards
// by name (plughw:CARD=Microphones,DEV=0) where ALSA lists them so; by
// number (CARD=1) only where it doesn't, since numbers change as USB devices
// come and go.
fn alsa_devices(devices: Vec<cpal::Device>, prefixes: &[&str]) -> Vec<cpal::Device> {
    let by_name = |node: &str| {
        prefixes.iter().any(|prefix| {
            node.strip_prefix(prefix)
                .and_then(|rest| rest.strip_prefix("CARD="))
                .is_some_and(|card| !card.starts_with(|c: char| c.is_ascii_digit()))
        })
    };
    let named = devices.iter().any(|device| by_name(&node(device)));
    devices
        .into_iter()
        .filter(|device| {
            let node = node(device);
            node == "default"
                || if named {
                    by_name(&node)
                } else {
                    prefixes.iter().any(|prefix| node.starts_with(prefix))
                }
        })
        .collect()
}

// What Settings calls a device: "System default" for the ones that follow
// the system's choice; ALSA's card and device ("USB Audio, device 1",
// "HDA Intel PCH, HDMI 0, shared"); else what the sound system calls it.
pub(crate) fn label(device: &cpal::Device) -> Option<String> {
    let id = device.id().ok()?;
    let node = id.id();
    let host = id.host().name();
    if (host == "PipeWire"
        && (node == PIPEWIRE_DEFAULT_INPUT || PIPEWIRE_DEFAULT_OUTPUTS.contains(&node)))
        || (host == "ALSA" && node == "default")
    {
        return Some("System default".to_string());
    }
    let description = device.description().ok()?;
    if host != "ALSA" {
        return Some(description.name().to_string());
    }
    Some(alsa_label(description.name(), node))
}

// An ALSA device's name from its description's first line: "HDA Intel PCH,
// ALC892 Analog", or "sof-hda-dsp, " with no device name, which then gets
// its device number when not the first; and how it shares.
fn alsa_label(name: &str, node: &str) -> String {
    let (card, device_name) = name.split_once(',').unwrap_or((name, ""));
    let (card, device_name) = (card.trim(), device_name.trim());
    let device_number = node
        .split([',', ':'])
        .find_map(|part| part.strip_prefix("DEV="))
        .filter(|number| *number != "0");
    let mut label = match (card, device_name, device_number) {
        ("", _, _) => node.to_string(),
        (card, "", Some(number)) => format!("{card}, device {number}"),
        (card, "", None) => card.to_string(),
        (card, device_name, _) => format!("{card}, {device_name}"),
    };
    if node.starts_with("dmix:") {
        label.push_str(", shared");
    }
    label
}

// How a mic or an output opens: in its own channels and sample format, at
// `rate` when it takes that (else at its own), in buffers of `frames`.
pub(crate) fn stream_config(
    default: &cpal::SupportedStreamConfig,
    mut ranges: impl Iterator<Item = cpal::SupportedStreamConfigRange>,
    rate: Option<cpal::SampleRate>,
    frames: u32,
) -> cpal::StreamConfig {
    let mut config = default.config();
    if let Some(rate) = rate {
        if ranges.any(|range| {
            range.channels() == config.channels
                && range.sample_format() == default.sample_format()
                && range.contains_rate(rate)
        }) {
            config.sample_rate = rate;
        }
    }
    config.buffer_size = buffer_size(default.buffer_size(), frames);
    config
}

// `frames`, within the device's range. PipeWire's range is 0 to 0 until its
// clock settings arrive; it takes any size then.
pub(crate) fn buffer_size(range: &cpal::SupportedBufferSize, frames: u32) -> cpal::BufferSize {
    match *range {
        cpal::SupportedBufferSize::Range { min, max } if min <= max && max > 0 => {
            cpal::BufferSize::Fixed(frames.clamp(min, max))
        }
        cpal::SupportedBufferSize::Range { .. } => cpal::BufferSize::Fixed(frames),
        cpal::SupportedBufferSize::Unknown => cpal::BufferSize::Default,
    }
}

// The buffer sizes Settings offers: those the system's default output
// takes (PipeWire's quantum range, 32 to 2048 samples unless set
// otherwise).
pub(crate) fn buffer_sizes(host: &cpal::Host) -> Vec<u32> {
    let range = host
        .default_output_device()
        .and_then(|device| device.default_output_config().ok())
        .map(|config| *config.buffer_size());
    match range {
        Some(cpal::SupportedBufferSize::Range { min, max }) if max > 0 => BUFFERS
            .iter()
            .copied()
            .filter(|frames| (min..=max).contains(frames))
            .collect(),
        Some(cpal::SupportedBufferSize::Range { .. }) => BUFFERS.to_vec(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_at_least() {
        assert!(version_at_least("1.6.2", (0, 3, 50)));
        assert!(version_at_least("0.3.50", (0, 3, 50)));
        assert!(version_at_least("0.3.65", (0, 3, 50)));
        assert!(!version_at_least("0.3.48", (0, 3, 50)));
        assert!(!version_at_least("0.2", (0, 3, 50)));
        assert!(!version_at_least("", (0, 3, 50)));
    }

    #[test]
    fn test_alsa_labels() {
        assert_eq!(
            alsa_label("HDA Intel PCH, ALC892 Analog", "plughw:CARD=PCH,DEV=0"),
            "HDA Intel PCH, ALC892 Analog"
        );
        assert_eq!(
            alsa_label("sof-hda-dsp, ", "plughw:CARD=sofhdadsp,DEV=6"),
            "sof-hda-dsp, device 6"
        );
        assert_eq!(
            alsa_label("sof-hda-dsp, HDMI 1", "dmix:CARD=sofhdadsp,DEV=3"),
            "sof-hda-dsp, HDMI 1, shared"
        );
        assert_eq!(
            alsa_label("sof-hda-dsp, ", "plughw:CARD=sofhdadsp,DEV=0"),
            "sof-hda-dsp"
        );
        assert_eq!(alsa_label("", "plughw:CARD=0,DEV=0"), "plughw:CARD=0,DEV=0");
    }

    #[test]
    fn test_buffer_size() {
        let range = |min, max| cpal::SupportedBufferSize::Range { min, max };
        assert_eq!(
            buffer_size(&range(32, 2048), 256),
            cpal::BufferSize::Fixed(256)
        );
        assert_eq!(
            buffer_size(&range(512, 2048), 256),
            cpal::BufferSize::Fixed(512)
        );
        assert_eq!(buffer_size(&range(0, 0), 128), cpal::BufferSize::Fixed(128));
        assert_eq!(
            buffer_size(&cpal::SupportedBufferSize::Unknown, 128),
            cpal::BufferSize::Default
        );
    }

    #[test]
    fn test_stream_config_keeps_channels_and_takes_the_rate() {
        let range = |rate| {
            cpal::SupportedStreamConfigRange::new(
                2,
                rate,
                rate,
                cpal::SupportedBufferSize::Range { min: 32, max: 2048 },
                cpal::SampleFormat::F32,
            )
        };
        let default = range(48000).with_sample_rate(48000);
        let ranges = [range(44100), range(48000)];
        let config = stream_config(&default, ranges.iter().cloned(), Some(44100), 128);
        assert_eq!(config.channels, 2);
        assert_eq!(config.sample_rate, 44100);
        assert_eq!(config.buffer_size, cpal::BufferSize::Fixed(128));
        // A rate it doesn't take: its own.
        let config = stream_config(&default, ranges.iter().cloned(), Some(96000), 128);
        assert_eq!(config.sample_rate, 48000);
    }
}
