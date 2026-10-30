// The native module's functions, as JS calls them (see src/renderer/global.ts
// and the preload). neon converts the arguments and results of the plain
// ones, and throws a returned error; arrays and objects are built by hand.
// A mic is a JsBox the preload keeps.

use std::cell::RefCell;

use karafriends_lib::InputDevice;
use neon::prelude::*;
use neon::types::extract::{Boxed, Error};

type Mic<'cx> = Handle<'cx, JsBox<RefCell<InputDevice>>>;

// Throws a native error as a JS one, with its message.
fn throw<'cx, T>(
    cx: &mut FunctionContext<'cx>,
    result: karafriends_lib::Result<T>,
) -> NeonResult<T> {
    result.or_else(|e| cx.throw_error(e.to_string()))
}

fn numbers<'cx>(cx: &mut FunctionContext<'cx>, values: &[u32]) -> JsResult<'cx, JsArray> {
    let array = cx.empty_array();
    for (i, value) in values.iter().enumerate() {
        let value = cx.number(*value);
        array.set(cx, i as u32, value)?;
    }
    Ok(array)
}

#[neon::export(name = "allocConsole")]
fn alloc_console() -> Result<(), Error> {
    Ok(karafriends_lib::alloc_console()?)
}

// [id, label, channels] for each input.
#[neon::export(name = "inputDevices")]
fn input_devices<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsArray> {
    let devices = throw(cx, InputDevice::collect_devices())?;
    let array = cx.empty_array();
    for (i, (id, label, channels)) in devices.iter().enumerate() {
        let device = cx.empty_array();
        let id = cx.string(id);
        let label = cx.string(label);
        let channels = cx.number(*channels);
        device.set(cx, 0, id)?;
        device.set(cx, 1, label)?;
        device.set(cx, 2, channels)?;
        array.set(cx, i as u32, device)?;
    }
    Ok(array)
}

#[neon::export(name = "asioStatus")]
fn asio_status() -> String {
    karafriends_lib::asio_status()
}

// Settings' Use ASIO: off until it's on (see ASIO_ON in karafriends-lib).
#[neon::export(name = "setAsio")]
fn set_asio(on: bool) {
    karafriends_lib::set_asio(on)
}

// The registered ASIO drivers, none loaded.
#[neon::export(name = "asioDrivers")]
fn asio_drivers<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsArray> {
    let array = cx.empty_array();
    for (i, name) in karafriends_lib::asio_driver_names().iter().enumerate() {
        let name = cx.string(name);
        array.set(cx, i as u32, name)?;
    }
    Ok(array)
}

#[neon::export(name = "outputDevices")]
fn output_devices<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsArray> {
    let names = throw(cx, karafriends_lib::output_devices())?;
    let array = cx.empty_array();
    for (i, name) in names.iter().enumerate() {
        let name = cx.string(name);
        array.set(cx, i as u32, name)?;
    }
    Ok(array)
}

// A name (null for the default output), and its rate and buffer size in
// frames (null for the device's own).
#[neon::export(name = "setOutputDevice")]
fn set_output_device(
    name: Option<String>,
    rate: Option<f64>,
    buffer: Option<f64>,
) -> Result<(), Error> {
    Ok(karafriends_lib::set_output_device(
        name,
        rate.map(|rate| rate as u32),
        buffer.map(|frames| frames as u32),
    )?)
}

// { rates, bufferSizes } for an ASIO output; null for others.
#[neon::export(name = "outputOptions")]
fn output_options<'cx>(cx: &mut FunctionContext<'cx>, name: String) -> JsResult<'cx, JsValue> {
    let Some((rates, buffers)) = throw(cx, karafriends_lib::output_options(&name))? else {
        return Ok(cx.null().upcast());
    };
    let object = cx.empty_object();
    let rates = numbers(cx, &rates)?;
    let buffers = numbers(cx, &buffers)?;
    object.set(cx, "rates", rates)?;
    object.set(cx, "bufferSizes", buffers)?;
    Ok(object.upcast())
}

// "48 kHz, 512 samples (10.7 ms)"; undefined while no mic is open.
#[neon::export(name = "outputFormat")]
fn output_format() -> Option<String> {
    karafriends_lib::output_format()
}

// "ok", "ok: <a note>", or why the mic output stopped; undefined while no
// mic is open.
#[neon::export(name = "outputStatus")]
fn output_status() -> Option<String> {
    karafriends_lib::output_status()
}

// Exclusive or not, and the buffer size in frames (null: the smallest).
#[neon::export(name = "setMicMode")]
fn set_mic_mode(exclusive: bool, buffer: Option<f64>) {
    karafriends_lib::set_mic_mode(exclusive, buffer.map(|frames| frames as u32));
}

// On Linux { status, bufferSizes, defaultBufferSize }: the sound system
// ("Sound system: PipeWire 1.6.2"), the buffer sizes in frames it takes for
// the mics and their output, and the one used until one is picked. Null
// elsewhere.
#[neon::export(name = "linuxAudio")]
fn linux_audio<'cx>(cx: &mut FunctionContext<'cx>) -> JsResult<'cx, JsValue> {
    let Some(linux) = karafriends_lib::linux_audio() else {
        return Ok(cx.null().upcast());
    };
    let object = cx.empty_object();
    let status = cx.string(linux.status);
    let buffers = numbers(cx, &linux.buffer_sizes)?;
    let default_buffer = cx.number(linux.default_buffer);
    object.set(cx, "status", status)?;
    object.set(cx, "bufferSizes", buffers)?;
    object.set(cx, "defaultBufferSize", default_buffer)?;
    Ok(object.upcast())
}

#[neon::export(name = "inputDevice_new")]
fn input_device_new(
    name: String,
    channel_selection: f64,
) -> Result<Boxed<RefCell<InputDevice>>, Error> {
    let device = InputDevice::new(&name, channel_selection as usize)?;
    Ok(Boxed(RefCell::new(device)))
}

// { midiNumber, confidence }
#[neon::export(name = "inputDevice_getPitch")]
fn input_device_get_pitch<'cx>(
    cx: &mut FunctionContext<'cx>,
    mic: Mic<'cx>,
) -> JsResult<'cx, JsObject> {
    let (midi_number, confidence) = mic.borrow_mut().get_pitch();
    let object = cx.empty_object();
    let midi_number = cx.number(midi_number);
    let confidence = cx.number(confidence);
    object.set(cx, "midiNumber", midi_number)?;
    object.set(cx, "confidence", confidence)?;
    Ok(object)
}

#[neon::export(name = "inputDevice_setGain")]
fn input_device_set_gain(mic: Mic, gain: f64) {
    mic.borrow().set_gain(gain as f32);
}

#[neon::export(name = "inputDevice_setEcho")]
fn input_device_set_echo(mic: Mic, echo: f64) {
    mic.borrow().set_echo(echo as f32);
}

#[neon::export(name = "inputDevice_setGate")]
fn input_device_set_gate(mic: Mic, threshold: f64) {
    mic.borrow().set_gate(threshold as f32);
}

#[neon::export(name = "inputDevice_status")]
fn input_device_status(mic: Mic) -> String {
    mic.borrow().status()
}

#[neon::export(name = "inputDevice_level")]
fn input_device_level(mic: Mic) -> f64 {
    mic.borrow().level().into()
}

#[neon::export(name = "inputDevice_format")]
fn input_device_format(mic: Mic) -> String {
    mic.borrow().format()
}

#[neon::export(name = "inputDevice_stop")]
fn input_device_stop(mic: Mic) {
    mic.borrow_mut().stop();
}
