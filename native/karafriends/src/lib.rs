#![allow(non_snake_case)]

use std::cell::RefCell;
use std::iter::Iterator;

use neon::prelude::*;

#[cfg(windows)]
use win32console::console::WinConsole;

fn alloc_console(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(windows)]
    if let Err(e) = WinConsole::alloc_console() {
        return cx.throw_error(e.to_string());
    } else if let Err(e) = WinConsole::set_title("karafriends native console") {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

fn input_devices(mut cx: FunctionContext) -> JsResult<JsArray> {
    let input_devices: Vec<_> = match karafriends_lib::InputDevice::collect_devices() {
        Ok(devices) => devices,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    let js_array = JsArray::new(&mut cx, input_devices.len());
    for (i, (id, label, channels)) in input_devices.iter().enumerate() {
        let js_id = cx.string(id);
        let js_label = cx.string(label);
        let js_channel_count = cx.number(*channels);
        let inner_array = JsArray::new(&mut cx, 3);
        inner_array.set(&mut cx, 0, js_id)?;
        inner_array.set(&mut cx, 1, js_label)?;
        inner_array.set(&mut cx, 2, js_channel_count)?;
        js_array.set(&mut cx, i as u32, inner_array)?;
    }
    Ok(js_array)
}

fn asio_status(mut cx: FunctionContext) -> JsResult<JsString> {
    Ok(cx.string(karafriends_lib::asio_status()))
}

fn output_devices(mut cx: FunctionContext) -> JsResult<JsArray> {
    let names = match karafriends_lib::output_devices() {
        Ok(names) => names,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    let js_array = JsArray::new(&mut cx, names.len());
    for (i, name) in names.iter().enumerate() {
        let js_name = cx.string(name);
        js_array.set(&mut cx, i as u32, js_name)?;
    }
    Ok(js_array)
}

// Argument i as a string, or None when it is missing or null.
fn optional_string(cx: &mut FunctionContext, i: usize) -> NeonResult<Option<String>> {
    match cx.argument_opt(i) {
        Some(value) if !value.is_a::<JsNull, _>(cx) && !value.is_a::<JsUndefined, _>(cx) => {
            Ok(Some(value.downcast_or_throw::<JsString, _>(cx)?.value(cx)))
        }
        _ => Ok(None),
    }
}

// Argument i as a whole number, or None when it is missing or null.
fn optional_u32(cx: &mut FunctionContext, i: usize) -> NeonResult<Option<u32>> {
    match cx.argument_opt(i) {
        Some(value) if !value.is_a::<JsNull, _>(cx) && !value.is_a::<JsUndefined, _>(cx) => Ok(
            Some(value.downcast_or_throw::<JsNumber, _>(cx)?.value(cx) as u32),
        ),
        _ => Ok(None),
    }
}

// A name (null for the default output), and its rate and buffer size in
// frames (null for the device's own).
fn set_output_device(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let name = optional_string(&mut cx, 0)?;
    let rate = optional_u32(&mut cx, 1)?;
    let buffer = optional_u32(&mut cx, 2)?;
    if let Err(e) = karafriends_lib::set_output_device(name, rate, buffer) {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

// { rates, bufferSizes } for an ASIO output; null for others.
fn output_options(mut cx: FunctionContext) -> JsResult<JsValue> {
    let name = cx.argument::<JsString>(0)?.value(&mut cx);
    let options = match karafriends_lib::output_options(&name) {
        Ok(options) => options,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    let Some((rates, buffers)) = options else {
        return Ok(cx.null().upcast());
    };
    let js_object = JsObject::new(&mut cx);
    let js_rates = JsArray::new(&mut cx, rates.len());
    for (i, rate) in rates.iter().enumerate() {
        let value = cx.number(*rate);
        js_rates.set(&mut cx, i as u32, value)?;
    }
    let js_buffers = JsArray::new(&mut cx, buffers.len());
    for (i, frames) in buffers.iter().enumerate() {
        let value = cx.number(*frames);
        js_buffers.set(&mut cx, i as u32, value)?;
    }
    js_object.set(&mut cx, "rates", js_rates)?;
    js_object.set(&mut cx, "bufferSizes", js_buffers)?;
    Ok(js_object.upcast())
}

// Exclusive or not, and the buffer size in frames (null: the smallest).
fn set_mic_mode(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let exclusive = cx.argument::<JsBoolean>(0)?.value(&mut cx);
    let buffer = optional_u32(&mut cx, 1)?;
    karafriends_lib::set_mic_mode(exclusive, buffer);
    Ok(cx.undefined())
}

fn exclusive_available(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    Ok(cx.boolean(karafriends_lib::exclusive_available()))
}

// On Linux { status, bufferSizes, defaultBufferSize }: the sound system
// ("Sound system: PipeWire 1.6.2"), the buffer sizes in frames it takes for
// the mics and their output, and the one used until one is picked. Null
// elsewhere.
fn linux_audio(mut cx: FunctionContext) -> JsResult<JsValue> {
    let Some(linux) = karafriends_lib::linux_audio() else {
        return Ok(cx.null().upcast());
    };
    let js_object = JsObject::new(&mut cx);
    let status = cx.string(linux.status);
    let js_buffers = JsArray::new(&mut cx, linux.buffer_sizes.len());
    for (i, frames) in linux.buffer_sizes.iter().enumerate() {
        let value = cx.number(*frames);
        js_buffers.set(&mut cx, i as u32, value)?;
    }
    let default_buffer = cx.number(linux.default_buffer);
    js_object.set(&mut cx, "status", status)?;
    js_object.set(&mut cx, "bufferSizes", js_buffers)?;
    js_object.set(&mut cx, "defaultBufferSize", default_buffer)?;
    Ok(js_object.upcast())
}

// "48 kHz, 512 samples (10.7 ms)", or null while no mic is open.
fn output_format(mut cx: FunctionContext) -> JsResult<JsValue> {
    Ok(match karafriends_lib::output_format() {
        Some(format) => cx.string(format).upcast(),
        None => cx.null().upcast(),
    })
}

fn input_device__new(
    mut cx: FunctionContext,
) -> JsResult<JsBox<RefCell<karafriends_lib::InputDevice>>> {
    let name = cx.argument::<JsString>(0)?.value(&mut cx);
    let channel_selection = cx.argument::<JsNumber>(1)?.value(&mut cx) as usize;
    let device = match karafriends_lib::InputDevice::new(&name, channel_selection) {
        Ok(device) => device,
        Err(e) => return cx.throw_error(e.to_string()),
    };
    Ok(cx.boxed(RefCell::new(device)))
}

fn input_device__get_pitch(mut cx: FunctionContext) -> JsResult<JsObject> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let mut device = device.borrow_mut();
    let (midi_number, confidence) = device.get_pitch();
    let js_object = JsObject::new(&mut cx);
    let midi_number = cx.number(midi_number);
    let confidence = cx.number(confidence);
    js_object.set(&mut cx, "midiNumber", midi_number)?;
    js_object.set(&mut cx, "confidence", confidence)?;
    Ok(js_object)
}

fn input_device__set_gain(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let gain = cx.argument::<JsNumber>(1)?.value(&mut cx) as f32;
    device.borrow().set_gain(gain);
    Ok(cx.undefined())
}

fn input_device__set_echo(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let echo = cx.argument::<JsNumber>(1)?.value(&mut cx) as f32;
    device.borrow().set_echo(echo);
    Ok(cx.undefined())
}

fn input_device__status(mut cx: FunctionContext) -> JsResult<JsString> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let status = device.borrow().status();
    Ok(cx.string(status))
}

fn input_device__level(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let level = device.borrow().level();
    Ok(cx.number(level))
}

fn input_device__format(mut cx: FunctionContext) -> JsResult<JsString> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    let format = device.borrow().format();
    Ok(cx.string(format))
}

fn input_device__stop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    device.borrow_mut().stop();
    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("allocConsole", alloc_console)?;
    cx.export_function("inputDevices", input_devices)?;
    cx.export_function("outputDevices", output_devices)?;
    cx.export_function("asioStatus", asio_status)?;
    cx.export_function("setOutputDevice", set_output_device)?;
    cx.export_function("outputOptions", output_options)?;
    cx.export_function("outputFormat", output_format)?;
    cx.export_function("setMicMode", set_mic_mode)?;
    cx.export_function("exclusiveAvailable", exclusive_available)?;
    cx.export_function("linuxAudio", linux_audio)?;
    cx.export_function("inputDevice_new", input_device__new)?;
    cx.export_function("inputDevice_setGain", input_device__set_gain)?;
    cx.export_function("inputDevice_setEcho", input_device__set_echo)?;
    cx.export_function("inputDevice_status", input_device__status)?;
    cx.export_function("inputDevice_format", input_device__format)?;
    cx.export_function("inputDevice_level", input_device__level)?;
    cx.export_function("inputDevice_getPitch", input_device__get_pitch)?;
    cx.export_function("inputDevice_stop", input_device__stop)?;

    Ok(())
}
