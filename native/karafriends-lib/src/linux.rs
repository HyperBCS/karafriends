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

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};

use crate::Result;

// The buffer size, in frames, the mics and their output ask for until
// Settings picks one: 128 is 2.7 ms at 48 kHz. With PipeWire's real-time
// threads that runs without a glitch on an ordinary laptop; the sound
// waits a few buffers between the mic and the speaker. cpal runs ALSA's
// threads at real-time priority too, but not PulseAudio's, which share the
// display's process at normal priority: those get 512 (10.7 ms).
const DEFAULT_BUFFER: u32 = 128;
const PULSEAUDIO_BUFFER: u32 = 512;

// The sizes Settings offers, where the sound system takes them.
const BUFFERS: [u32; 5] = [64, 128, 256, 512, 1024];

// Names KARAFRIENDS_AUDIO_HOST takes: pipewire, pulseaudio or alsa.
const HOST_VARIABLE: &str = "KARAFRIENDS_AUDIO_HOST";

// cpal's PipeWire streams call pw_stream_get_time_n, from PipeWire 0.3.50.
// The module binds it when first called (see build.rs and
// .cargo/config.toml), so with an older library it loads, and PipeWire is
// skipped before anything calls it. scripts/checkLazyPipewire.sh checks
// both.
#[cfg(feature = "pipewire")]
const PIPEWIRE_MIN: (u32, u32, u32) = (0, 3, 50);

// How long a sound system, once picked, is used again, along with its
// devices (cpal lists them as the host starts) and PipeWire's node classes.
// Long enough that a Settings open (the outputs, the sound system, the
// mics) or mics opening one after another ask the sound system once, not
// five times, on the display's thread. Short enough that the next listing,
// and every 2-second retry of a mic that is down, sees a device plugged in
// since.
const FRESH: Duration = Duration::from_secs(1);

// cpal gives PipeWire and PulseAudio 2 seconds to list their devices. One
// that fails after most of that is there but isn't answering (PipeWire
// once spent a minute and a half retrying a USB mic unplugged mid-stream),
// not one without sound devices (PipeWire that only does video), which
// fails at once.
const TIMED_OUT: Duration = Duration::from_millis(1500);

// How long a sound system that didn't answer is left alone: the display's
// listings and a down mic's retries, all on its thread, don't each wait
// another 2 seconds. They fail at once meanwhile, rather than use the
// devices it listed before: a USB mic among them may be gone (PipeWire
// lists one for a while after it's unplugged), and a mic reopened on it
// records nothing real and keeps it from coming back when it's plugged in.
const NOT_ANSWERING_PAUSE: Duration = Duration::from_secs(10);

// What Settings says of a sound system that isn't answering.
const NOT_ANSWERING: &str = "isn't answering";

struct Picked {
    host: Rc<cpal::Host>,
    why: Option<String>,
    // PipeWire's registry: None until a listing or a mic asks for it;
    // Some(None) if PipeWire didn't answer.
    registry: Option<Option<Rc<Registry>>>,
    at: Instant,
}

// The sound system of this run, once picked: the devices are listed afresh
// from it, never from another. One that is slow for a moment isn't swapped
// for the next (ALSA, whose device names a mic saved meanwhile keeps, and
// PipeWire doesn't have).
struct System {
    id: cpal::HostId,
    // Why it isn't the usual one, if it isn't.
    why: Option<String>,
    // While it isn't answering: since when it was last asked, and why.
    stuck: Option<(Instant, String)>,
}

thread_local! {
    // Native calls come from the display's JS thread.
    static PICKED: RefCell<Option<Picked>> = const { RefCell::new(None) };
    static SYSTEM: RefCell<Option<System>> = const { RefCell::new(None) };
}

// The sound system the mics use, and why it isn't the usual one if it
// isn't (see pick_host). The one started within the last second, if any.
// An error while it isn't answering.
pub(crate) fn system_host() -> Result<(Rc<cpal::Host>, Option<String>)> {
    PICKED.with_borrow_mut(|picked| {
        if let Some(picked) = picked.as_ref().filter(|p| p.at.elapsed() < FRESH) {
            return Ok((picked.host.clone(), picked.why.clone()));
        }
        match start_system() {
            Ok((host, why)) => {
                let host = Rc::new(host);
                *picked = Some(Picked {
                    host: host.clone(),
                    why: why.clone(),
                    registry: None,
                    at: Instant::now(),
                });
                Ok((host, why))
            }
            Err(why) => Err(why.into()),
        }
    })
}

// The run's sound system started afresh, for its devices now: picked the
// first time (pick_host), the same one after. Why not, while it isn't
// answering: it is asked again once NOT_ANSWERING_PAUSE has passed.
fn start_system() -> std::result::Result<(cpal::Host, Option<String>), String> {
    SYSTEM.with_borrow_mut(|system| {
        let Some(system) = system.as_mut() else {
            return match pick_host() {
                Ok(Picking::Started(host, why)) => {
                    *system = Some(System {
                        id: host.id(),
                        why: why.clone(),
                        stuck: None,
                    });
                    Ok((host, why))
                }
                Ok(Picking::NotAnswering(id, why, stuck)) => {
                    *system = Some(System {
                        id,
                        why,
                        stuck: Some((Instant::now(), stuck.clone())),
                    });
                    Err(stuck)
                }
                Err(e) => Err(e.to_string()),
            };
        };
        if let Some((since, why)) = &system.stuck
            && since.elapsed() < NOT_ANSWERING_PAUSE
        {
            return Err(why.clone());
        }
        match cpal::host_from_id(system.id) {
            Ok(host) => {
                system.stuck = None;
                Ok((host, system.why.clone()))
            }
            Err(e) => {
                let why = format!("{} didn't list its devices: {e}", system.id.name());
                system.stuck = Some((Instant::now(), why.clone()));
                Err(why)
            }
        }
    })
}

// The buffer size the mics and their output ask for until Settings picks
// one, on the sound system picked last (every listing and open picks one
// first).
pub(crate) fn default_buffer() -> u32 {
    default_buffer_on(PICKED.with_borrow(|picked| picked.as_ref().map(|p| p.host.id())))
}

fn default_buffer_on(id: Option<cpal::HostId>) -> u32 {
    match id {
        Some(cpal::HostId::PulseAudio) => PULSEAUDIO_BUFFER,
        _ => DEFAULT_BUFFER,
    }
}

// What the first pick came to: a sound system that started, and why it
// isn't the usual one if it isn't; or one that is there but didn't answer,
// that same why, and its own.
enum Picking {
    Started(cpal::Host, Option<String>),
    NotAnswering(cpal::HostId, Option<String>, String),
}

// Why a sound system didn't start.
#[derive(Debug, PartialEq)]
enum Failed {
    // It's there but didn't answer in time: it's still the one to use.
    NotAnswering(String),
    // It isn't there, or has no sound devices: the next one is.
    Absent(String),
}

// KARAFRIENDS_AUDIO_HOST's when it is set and starts; else PipeWire, when
// it runs and its library is new enough; else PulseAudio (pipewire-pulse
// counts); else ALSA. PipeWire or PulseAudio running but not answering is
// still the one: the next would be the same server (pipewire-pulse, or
// ALSA's pipewire plugin), or none.
fn pick_host() -> Result<Picking> {
    let mut why = None;
    if let Ok(name) = std::env::var(HOST_VARIABLE) {
        match chosen_host(&name) {
            Ok(host) => {
                return Ok(Picking::Started(
                    host,
                    Some(format!("as {HOST_VARIABLE} says")),
                ));
            }
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
            match start(cpal::HostId::PipeWire) {
                Ok(host) => return Ok(Picking::Started(host, why)),
                Err(Failed::NotAnswering(stuck)) => {
                    return Ok(Picking::NotAnswering(cpal::HostId::PipeWire, why, stuck));
                }
                Err(Failed::Absent(e)) => {
                    why.get_or_insert(format!("PipeWire didn't start: {e}"));
                }
            }
        }
    }
    #[cfg(not(feature = "pipewire"))]
    why.get_or_insert("this build has no PipeWire".to_string());
    if available.contains(&cpal::HostId::PulseAudio) {
        match start(cpal::HostId::PulseAudio) {
            Ok(host) => return Ok(Picking::Started(host, why)),
            Err(Failed::NotAnswering(stuck)) => {
                return Ok(Picking::NotAnswering(cpal::HostId::PulseAudio, why, stuck));
            }
            Err(Failed::Absent(_)) => {}
        }
    }
    Ok(Picking::Started(
        cpal::host_from_id(cpal::HostId::Alsa)?,
        why,
    ))
}

// Starts the sound system `id`, timed to tell why it didn't (see
// TIMED_OUT).
fn start(id: cpal::HostId) -> std::result::Result<cpal::Host, Failed> {
    let began = Instant::now();
    cpal::host_from_id(id).map_err(|e| failed(id, &e.to_string(), began.elapsed()))
}

fn failed(id: cpal::HostId, error: &str, took: Duration) -> Failed {
    if took >= TIMED_OUT {
        Failed::NotAnswering(format!("{} {NOT_ANSWERING}", id.name()))
    } else {
        Failed::Absent(error.to_string())
    }
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
    let id = host.id();
    status_line(&system_name(id), id == cpal::HostId::PulseAudio, why)
}

// For Settings when system_host has none (it failed with `error`): the
// run's sound system, if it is there but isn't answering, else none.
pub(crate) fn status_without_host(error: &str) -> String {
    SYSTEM.with_borrow(|system| match system {
        Some(System {
            id, stuck: Some(_), ..
        }) => status_line(
            &system_name(*id),
            *id == cpal::HostId::PulseAudio,
            Some(NOT_ANSWERING.to_string()),
        ),
        _ => format!("No sound system: {error}"),
    })
}

// "PipeWire 1.6.2", "PulseAudio", "ALSA".
fn system_name(id: cpal::HostId) -> String {
    #[cfg(feature = "pipewire")]
    if id == cpal::HostId::PipeWire {
        return format!("PipeWire {}", pipewire_version());
    }
    id.name().to_string()
}

// "Sound system: PulseAudio (why). Not real-time: ...": cpal never says so
// of PulseAudio's streams, whose threads it doesn't try to promote.
fn status_line(name: &str, pulseaudio: bool, why: Option<String>) -> String {
    let mut line = match why {
        Some(why) => format!("Sound system: {name} ({why})"),
        None => format!("Sound system: {name}"),
    };
    if pulseaudio {
        line.push_str(
            ". Not real-time: PulseAudio runs the mics at normal priority, \
             so a bigger Mic buffer helps if they crackle",
        );
    }
    line
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
        "PipeWire" => pipewire_devices(host, devices, Wanted::Mic),
        "PulseAudio" => devices
            .into_iter()
            .filter(|device| keep_pulse_input(&node(device)))
            .collect(),
        "ALSA" => alsa_devices(devices, ALSA_INPUTS),
        _ => devices,
    })
}

// The outputs the mics can play through ("System default", the one that
// follows the system, is Settings' own): on PipeWire its sinks, on ALSA the
// default and each card's devices, direct or shared.
pub(crate) fn output_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>> {
    let devices: Vec<_> = host.output_devices()?.collect();
    Ok(match host.id().name() {
        "PipeWire" => pipewire_devices(host, devices, Wanted::Output),
        "ALSA" => alsa_devices(devices, ALSA_OUTPUTS),
        _ => devices,
    })
}

// What a listing is for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Wanted {
    Mic,
    Output,
}

// The PipeWire devices of `host` keep_pipewire keeps.
fn pipewire_devices(
    host: &cpal::Host,
    devices: Vec<cpal::Device>,
    wanted: Wanted,
) -> Vec<cpal::Device> {
    let registry = registry_for(host);
    devices
        .into_iter()
        .filter(|device| {
            let description = device.description().ok();
            keep_pipewire(
                wanted,
                &node(device),
                registry.as_deref().map(|r| &r.classes),
                description.as_ref().map(|d| d.direction()),
                description.is_some_and(|d| d.driver().is_some()),
            )
        })
        .collect()
}

// Whether Settings lists PipeWire's `node` as a mic or an output. A mic is
// the system default or an "Audio/Source", an output an "Audio/Sink" (not
// the defaults: Settings has its own entry for those), and either can be an
// "Audio/Duplex", as the registry's `classes` say. If the registry didn't
// answer (None): a node with a driver (other programs' streams have none),
// and for a mic one cpal lists as input only. cpal lists the outputs as
// inputs too (to record what they play), and one picked as a mic would
// play the speakers back through themselves. `direction` and `has_driver`
// are from cpal's description of the node.
fn keep_pipewire(
    wanted: Wanted,
    node: &str,
    classes: Option<&HashMap<String, String>>,
    direction: Option<cpal::DeviceDirection>,
    has_driver: bool,
) -> bool {
    let class = match wanted {
        Wanted::Mic if node == PIPEWIRE_DEFAULT_INPUT => return true,
        Wanted::Output if PIPEWIRE_DEFAULT_OUTPUTS.contains(&node) => return false,
        Wanted::Mic => "Audio/Source",
        Wanted::Output => "Audio/Sink",
    };
    match classes {
        Some(classes) => classes
            .get(node)
            .is_some_and(|c| c == class || c == "Audio/Duplex"),
        None => {
            has_driver
                && (wanted == Wanted::Output || direction == Some(cpal::DeviceDirection::Input))
        }
    }
}

// PulseAudio's sources, but not the outputs' monitors (which record what
// they play).
fn keep_pulse_input(node: &str) -> bool {
    !node.ends_with(".monitor")
}

// PipeWire's registry, asked once per host system_host picked (and fresh
// for any other host).
fn registry_for(host: &cpal::Host) -> Option<Rc<Registry>> {
    let is_picked = |picked: &Picked| std::ptr::eq(&*picked.host, host);
    let asked = PICKED.with_borrow(|picked| {
        picked
            .as_ref()
            .filter(|p| is_picked(p))
            .and_then(|p| p.registry.clone())
    });
    if let Some(registry) = asked {
        return registry;
    }
    let registry = pipewire_registry().map(Rc::new);
    PICKED.with_borrow_mut(|picked| {
        if let Some(picked) = picked.as_mut().filter(|p| is_picked(p)) {
            picked.registry = Some(registry.clone());
        }
    });
    registry
}

// What PipeWire's registry says of its nodes, by node name: each one's
// media class (mics are "Audio/Source", outputs "Audio/Sink", programs'
// streams, karafriends' own too, "Stream/..."), and the serials of the
// nodes of that name. A mic plugged in again is a new node: the name it
// had, a new serial.
#[derive(Default)]
struct Registry {
    classes: HashMap<String, String>,
    serials: HashMap<String, Vec<String>>,
}

// The PipeWire node a mic opened on, as it was then: its name and the
// serials PipeWire had for it.
pub(crate) struct OpenedNode {
    name: String,
    serials: Vec<String>,
}

// For a mic just opened on `device`: its PipeWire node, for node_is_there.
// None where that can't be told: on another sound system, for the system
// default (which follows the system's choice, not a node), or if PipeWire
// didn't answer.
pub(crate) fn opened_node(device: &cpal::Device) -> Option<OpenedNode> {
    let (host, _) = system_host().ok()?;
    if host.id().name() != "PipeWire" {
        return None;
    }
    let name = node(device);
    let serials = registry_for(&host)?.serials.get(&name)?.clone();
    Some(OpenedNode { name, serials })
}

// Whether the node a mic opened on is still there. A mic unplugged goes
// from PipeWire's registry, but its stream doesn't stop: cpal schedules it
// with the mic output's, so it calls back with silence, its status stays
// "ok", and the display never reopens it, not even once the mic is plugged
// in again (as a new node). True when PipeWire can't say.
pub(crate) fn node_is_there(opened: &OpenedNode) -> bool {
    let Ok((host, _)) = system_host() else {
        return true;
    };
    if host.id().name() != "PipeWire" {
        return true;
    }
    match registry_for(&host) {
        Some(registry) => still_listed(&opened.serials, registry.serials.get(&opened.name)),
        None => true,
    }
}

// Whether any node a mic opened on (`opened`, its serials then) is among
// those of its name now.
fn still_listed(opened: &[String], now: Option<&Vec<String>>) -> bool {
    now.is_some_and(|now| now.iter().any(|serial| opened.contains(serial)))
}

// The registry, from PipeWire. None if it doesn't answer within two
// seconds. Asked while a cpal PipeWire host lives, which keeps the library
// initialised (cpal deinitialises it once its last host or stream is
// gone).
#[cfg(feature = "pipewire")]
fn pipewire_registry() -> Option<Registry> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    use pipewire as pw;

    let mainloop = pw::main_loop::MainLoopRc::new(None).ok()?;
    let context = pw::context::ContextRc::new(&mainloop, None).ok()?;
    let core = context.connect_rc(None).ok()?;
    let registry = core.get_registry_rc().ok()?;

    let nodes: Rc<RefCell<Registry>> = Rc::default();
    let _registry_listener = registry
        .add_listener_local()
        .global({
            let nodes = nodes.clone();
            move |global| {
                if global.type_ != pw::types::ObjectType::Node {
                    return;
                }
                let Some(props) = global.props else {
                    return;
                };
                let Some(name) = props.get("node.name") else {
                    return;
                };
                let mut nodes = nodes.borrow_mut();
                if let Some(class) = props.get("media.class") {
                    nodes.classes.insert(name.to_string(), class.to_string());
                }
                if let Some(serial) = props.get("object.serial") {
                    nodes
                        .serials
                        .entry(name.to_string())
                        .or_default()
                        .push(serial.to_string());
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
    Some(nodes.take())
}

#[cfg(not(feature = "pipewire"))]
fn pipewire_registry() -> Option<Registry> {
    None
}

// The ALSA devices listed as mics (plughw: converts any format) and as
// outputs (dmix: also shares the device with other programs).
const ALSA_INPUTS: &[&str] = &["plughw:"];
const ALSA_OUTPUTS: &[&str] = &["plughw:", "dmix:"];

// The ALSA devices alsa_kept keeps.
fn alsa_devices(devices: Vec<cpal::Device>, prefixes: &[&str]) -> Vec<cpal::Device> {
    let nodes: Vec<String> = devices.iter().map(node).collect();
    let kept = alsa_kept(&nodes, prefixes);
    devices
        .into_iter()
        .zip(kept)
        .filter_map(|(device, kept)| kept.then_some(device))
        .collect()
}

// Which of ALSA's `nodes` Settings lists: "default", and each card's
// devices with one of `prefixes`. Cards by name (plughw:CARD=Microphones,
// DEV=0) where ALSA lists them so; by number (CARD=1) only where it
// doesn't, since numbers change as USB devices come and go.
fn alsa_kept(nodes: &[impl AsRef<str>], prefixes: &[&str]) -> Vec<bool> {
    let by_name = |node: &str| {
        prefixes.iter().any(|prefix| {
            node.strip_prefix(prefix)
                .and_then(|rest| rest.strip_prefix("CARD="))
                .is_some_and(|card| !card.starts_with(|c: char| c.is_ascii_digit()))
        })
    };
    let named = nodes.iter().any(|node| by_name(node.as_ref()));
    nodes
        .iter()
        .map(|node| {
            let node = node.as_ref();
            node == "default"
                || if named {
                    by_name(node)
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
    ranges: impl Iterator<Item = cpal::SupportedStreamConfigRange>,
    rate: cpal::SampleRate,
    frames: u32,
) -> cpal::StreamConfig {
    let mut config = default.config();
    if crate::takes_rate(default, ranges, rate) {
        config.sample_rate = rate;
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

    // Node names as PipeWire calls them on a laptop, and a USB mic.
    const LAPTOP_MIC: &str =
        "alsa_input.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Mic1__source";
    const USB_MIC: &str = "alsa_input.usb-Shure_Inc_Shure_MV7-00.mono-fallback";
    const SPEAKER: &str =
        "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink";
    const HEADSET: &str = "bluez_card.00_1B_66_A1_B2_C3.headset";
    // Other programs' streams, karafriends' own among them.
    const RECORDING: &str = "karafriends";
    const PLAYBACK: &str = "Chromium";
    const CAMERA: &str = "v4l2_input.pci-0000_00_05.0";

    fn registry() -> HashMap<String, String> {
        [
            (LAPTOP_MIC, "Audio/Source"),
            (USB_MIC, "Audio/Source"),
            (SPEAKER, "Audio/Sink"),
            (HEADSET, "Audio/Duplex"),
            (RECORDING, "Stream/Input/Audio"),
            (PLAYBACK, "Stream/Output/Audio"),
            (CAMERA, "Video/Source"),
        ]
        .iter()
        .map(|(node, class)| (node.to_string(), class.to_string()))
        .collect()
    }

    #[test]
    fn test_pulseaudio_gets_a_bigger_buffer_and_says_why() {
        assert_eq!(default_buffer_on(Some(cpal::HostId::PulseAudio)), 512);
        assert_eq!(default_buffer_on(Some(cpal::HostId::Alsa)), 128);
        #[cfg(feature = "pipewire")]
        assert_eq!(default_buffer_on(Some(cpal::HostId::PipeWire)), 128);
        assert_eq!(default_buffer_on(None), 128);
        assert_eq!(
            status_line("PipeWire 1.6.2", false, None),
            "Sound system: PipeWire 1.6.2"
        );
        assert_eq!(
            status_line(
                "PulseAudio",
                true,
                Some("PipeWire 0.3.48 is older than 0.3.50".to_string())
            ),
            "Sound system: PulseAudio (PipeWire 0.3.48 is older than 0.3.50). \
             Not real-time: PulseAudio runs the mics at normal priority, \
             so a bigger Mic buffer helps if they crackle"
        );
    }

    // Lists only; no device opens.
    #[test]
    fn test_system_host_is_shared_for_a_second() {
        let (first, _) = system_host().unwrap();
        let (again, _) = system_host().unwrap();
        assert!(Rc::ptr_eq(&first, &again));
        let _ = input_devices(&again);
        let _ = output_devices(&again);
        if first.id().name() == "PipeWire" {
            // Asked once for both listings.
            assert!(PICKED.with_borrow(|p| p.as_ref().unwrap().registry.is_some()));
        }
        PICKED.with_borrow_mut(|p| {
            let p = p.as_mut().unwrap();
            p.at = p.at.checked_sub(FRESH).unwrap_or(p.at);
        });
        let (later, _) = system_host().unwrap();
        assert!(!Rc::ptr_eq(&first, &later));
        // Started again, the same sound system.
        assert_eq!(later.id(), first.id());
    }

    #[test]
    fn test_a_slow_failure_is_a_sound_system_not_answering() {
        // cpal's 2 seconds, run out.
        assert_eq!(
            failed(
                cpal::HostId::PulseAudio,
                "timed out",
                Duration::from_secs(2)
            ),
            Failed::NotAnswering("PulseAudio isn't answering".to_string())
        );
        // At once: not there, or without sound devices; the next one's
        // turn.
        assert_eq!(
            failed(
                cpal::HostId::PulseAudio,
                "refused",
                Duration::from_millis(20)
            ),
            Failed::Absent("refused".to_string())
        );
    }

    #[test]
    fn test_a_mic_is_there_while_a_node_it_opened_on_is() {
        let serials = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let opened = serials(&["40117"]);
        assert!(still_listed(&opened, Some(&serials(&["40117"]))));
        // Unplugged: no node of its name.
        assert!(!still_listed(&opened, None));
        // Plugged in again: its name, a new node. The stream is still on
        // the old one, so it's gone.
        assert!(!still_listed(&opened, Some(&serials(&["40524"]))));
        // Opened while an unplugged one lingered beside the new one: either
        // will do.
        assert!(still_listed(
            &serials(&["40117", "40524"]),
            Some(&serials(&["40524"]))
        ));
    }

    // No sound system is asked: ALSA's host starts without a device.
    #[test]
    fn test_a_sound_system_not_answering_is_left_alone_and_lists_nothing() {
        // This run's sound system (PulseAudio here; PipeWire alike), which
        // didn't answer a moment ago, and the devices it listed before
        // that.
        let before = Rc::new(cpal::host_from_id(cpal::HostId::Alsa).unwrap());
        PICKED.with_borrow_mut(|p| {
            let at = Instant::now();
            *p = Some(Picked {
                host: before.clone(),
                why: None,
                registry: None,
                at: at.checked_sub(FRESH).unwrap_or(at),
            });
        });
        SYSTEM.with_borrow_mut(|s| {
            *s = Some(System {
                id: cpal::HostId::PulseAudio,
                why: None,
                stuck: Some((Instant::now(), "PulseAudio isn't answering".to_string())),
            });
        });

        // Why not, at once: not another 2 seconds, not another sound
        // system, and not the devices from before (a mic unplugged since
        // would reopen on one that's gone).
        let began = Instant::now();
        let Err(error) = system_host() else {
            panic!("a host while the sound system isn't answering");
        };
        let error = error.to_string();
        assert_eq!(error, "PulseAudio isn't answering");
        assert!(began.elapsed() < Duration::from_millis(100));

        // Settings says which sound system, and why.
        let status = status_without_host(&error);
        assert!(
            status.starts_with("Sound system: PulseAudio (isn't answering)"),
            "{status}"
        );
    }

    #[test]
    fn test_pipewire_mics_and_outputs_by_class() {
        use Wanted::{Mic, Output};
        let classes = registry();
        // (wanted, node, kept): cpal's direction and driver don't count
        // while the registry answers.
        let table = [
            (Mic, "input_default", true),
            (Mic, LAPTOP_MIC, true),
            (Mic, USB_MIC, true),
            (Mic, HEADSET, true),
            (Mic, SPEAKER, false),
            (Mic, RECORDING, false),
            (Mic, PLAYBACK, false),
            (Mic, CAMERA, false),
            (Mic, "alsa_input.usb-plugged-in-since", false),
            (Output, SPEAKER, true),
            (Output, HEADSET, true),
            (Output, "output_default", false),
            (Output, "sink_default", false),
            (Output, LAPTOP_MIC, false),
            (Output, PLAYBACK, false),
            (Output, RECORDING, false),
        ];
        for (wanted, node, kept) in table {
            for direction in [
                None,
                Some(cpal::DeviceDirection::Input),
                Some(cpal::DeviceDirection::Duplex),
            ] {
                for has_driver in [false, true] {
                    assert_eq!(
                        keep_pipewire(wanted, node, Some(&classes), direction, has_driver),
                        kept,
                        "{wanted:?} {node} {direction:?} {has_driver}"
                    );
                }
            }
        }
    }

    #[test]
    fn test_pipewire_mics_and_outputs_without_the_registry() {
        use Wanted::{Mic, Output};
        use cpal::DeviceDirection::{Duplex, Input, Output as Out};
        // (wanted, node, cpal's direction, has a driver, kept). cpal lists
        // sources as Input and sinks as Duplex (to record what they play).
        let table = [
            (Mic, "input_default", Some(Input), false, true),
            (Mic, LAPTOP_MIC, Some(Input), true, true),
            (Mic, USB_MIC, Some(Input), true, true),
            // An output never passes for a mic: it would record the
            // speakers and play them back through them.
            (Mic, SPEAKER, Some(Duplex), true, false),
            (Mic, HEADSET, Some(Duplex), true, false),
            (Mic, RECORDING, Some(Input), false, false),
            (Mic, LAPTOP_MIC, None, false, false),
            (Output, SPEAKER, Some(Duplex), true, true),
            (Output, "output_default", Some(Out), false, false),
            (Output, "sink_default", Some(Duplex), false, false),
            (Output, PLAYBACK, Some(Out), false, false),
        ];
        for (wanted, node, direction, has_driver, kept) in table {
            assert_eq!(
                keep_pipewire(wanted, node, None, direction, has_driver),
                kept,
                "{wanted:?} {node} {direction:?} {has_driver}"
            );
        }
    }

    #[test]
    fn test_pulse_inputs() {
        assert!(keep_pulse_input(LAPTOP_MIC));
        assert!(keep_pulse_input(USB_MIC));
        assert!(!keep_pulse_input(&format!("{SPEAKER}.monitor")));
    }

    #[test]
    fn test_alsa_cards_by_name() {
        // As `aplay -L` lists them on a laptop.
        let nodes = [
            "default",
            "sysdefault:CARD=sofhdadsp",
            "hw:CARD=sofhdadsp,DEV=0",
            "plughw:CARD=sofhdadsp,DEV=0",
            "plughw:CARD=sofhdadsp,DEV=3",
            "dmix:CARD=sofhdadsp,DEV=0",
            "front:CARD=sofhdadsp,DEV=0",
            "surround51:CARD=sofhdadsp,DEV=0",
            "plughw:CARD=Microphones,DEV=0",
        ];
        assert_eq!(
            alsa_kept(&nodes, ALSA_INPUTS),
            [true, false, false, true, true, false, false, false, true]
        );
        assert_eq!(
            alsa_kept(&nodes, ALSA_OUTPUTS),
            [true, false, false, true, true, true, false, false, true]
        );
    }

    #[test]
    fn test_alsa_cards_by_number() {
        // Only by number: those are kept.
        let nodes = [
            "default",
            "hw:CARD=0,DEV=0",
            "plughw:CARD=0,DEV=0",
            "dmix:CARD=0,DEV=0",
        ];
        assert_eq!(alsa_kept(&nodes, ALSA_INPUTS), [true, false, true, false]);
        assert_eq!(alsa_kept(&nodes, ALSA_OUTPUTS), [true, false, true, true]);
        // By name and by number: only by name, since numbers move.
        let nodes = ["plughw:CARD=PCH,DEV=0", "plughw:CARD=0,DEV=0"];
        assert_eq!(alsa_kept(&nodes, ALSA_INPUTS), [true, false]);
        assert_eq!(alsa_kept(&[] as &[&str], ALSA_INPUTS), [] as [bool; 0]);
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
        let config = stream_config(&default, ranges.iter().cloned(), 44100, 128);
        assert_eq!(config.channels, 2);
        assert_eq!(config.sample_rate, 44100);
        assert_eq!(config.buffer_size, cpal::BufferSize::Fixed(128));
        // A rate it doesn't take: its own.
        let config = stream_config(&default, ranges.iter().cloned(), 96000, 128);
        assert_eq!(config.sample_rate, 48000);
    }
}
