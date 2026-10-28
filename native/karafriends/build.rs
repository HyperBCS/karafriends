// On Linux the module binds libpipewire's functions when first called, not
// as it loads: cpal's PipeWire streams call one from PipeWire 0.3.50, and
// with an older library (Ubuntu 22.04 has 0.3.48) the module still loads and
// the mics use PulseAudio instead (see linux.rs).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-z,lazy");
    }
}
