// A sound system that's there but not answering, as PipeWire was for a
// minute and a half once a USB mic was unplugged mid-stream: its socket
// takes connections and never says anything. Its own test binary, so the
// environment it sets is its alone, and set before cpal looks.
#![cfg(target_os = "linux")]

use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// Takes connections on `path` and holds them, answering nothing.
fn stuck_server(path: PathBuf) {
    let listener = UnixListener::bind(path).unwrap();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for connection in listener.incoming() {
            held.push(connection);
        }
    });
}

#[test]
fn test_a_sound_system_not_answering_isnt_swapped_for_alsa() {
    // Short, for a socket's path.
    let dir = std::env::temp_dir().join(format!("kf-stuck-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    stuck_server(dir.join("pipewire-0"));
    stuck_server(dir.join("pulse-native"));
    // Safety: before any thread of this test binary reads the environment.
    unsafe {
        std::env::set_var("PIPEWIRE_RUNTIME_DIR", &dir);
        std::env::set_var(
            "PULSE_SERVER",
            format!("unix:{}", dir.join("pulse-native").display()),
        );
        std::env::remove_var("KARAFRIENDS_AUDIO_HOST");
    }

    // Asked once, for cpal's 2 seconds: not then PulseAudio's 2 more, and
    // not ALSA, whose names a mic saved meanwhile would keep.
    let began = Instant::now();
    let audio = karafriends_lib::linux_audio().unwrap();
    let took = began.elapsed();
    assert!(audio.status.contains("isn't answering"), "{}", audio.status);
    assert!(!audio.status.contains("ALSA"), "{}", audio.status);
    assert!(took < Duration::from_millis(3500), "took {took:?}");

    // Left alone for a while: the display's next calls don't wait.
    let again = Instant::now();
    let error = karafriends_lib::InputDevice::collect_devices()
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("isn't answering"), "{error}");
    assert!(
        karafriends_lib::linux_audio()
            .unwrap()
            .status
            .contains("isn't answering")
    );
    assert!(
        again.elapsed() < Duration::from_millis(100),
        "{:?}",
        again.elapsed()
    );

    let _ = std::fs::remove_dir_all(&dir);
}
