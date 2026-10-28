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
    for (i, (name, config)) in input_devices.iter().enumerate() {
        let js_name = cx.string(name);
        let js_channel_count = cx.number(config.channels);
        let inner_array = JsArray::new(&mut cx, 2);
        inner_array.set(&mut cx, 0, js_name)?;
        inner_array.set(&mut cx, 1, js_channel_count)?;
        js_array.set(&mut cx, i as u32, inner_array)?;
    }
    Ok(js_array)
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

// A name, or null for the default output.
fn set_output_device(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let name = match cx.argument_opt(0) {
        Some(value) if !value.is_a::<JsNull, _>(&mut cx) => Some(
            value
                .downcast_or_throw::<JsString, _>(&mut cx)?
                .value(&mut cx),
        ),
        _ => None,
    };
    if let Err(e) = karafriends_lib::set_output_device(name) {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
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
    let (midi_number, confidence) = match device.get_pitch() {
        Ok((midi_number, confidence)) => (midi_number, confidence),
        Err(e) => return cx.throw_error(e.to_string()),
    };
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

fn input_device__stop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let device = cx.argument::<JsBox<RefCell<karafriends_lib::InputDevice>>>(0)?;
    if let Err(e) = device.borrow().stop() {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("allocConsole", alloc_console)?;
    cx.export_function("inputDevices", input_devices)?;
    cx.export_function("outputDevices", output_devices)?;
    cx.export_function("setOutputDevice", set_output_device)?;
    cx.export_function("inputDevice_new", input_device__new)?;
    cx.export_function("inputDevice_setGain", input_device__set_gain)?;
    cx.export_function("inputDevice_setEcho", input_device__set_echo)?;
    cx.export_function("inputDevice_status", input_device__status)?;
    cx.export_function("inputDevice_getPitch", input_device__get_pitch)?;
    cx.export_function("inputDevice_stop", input_device__stop)?;

    Ok(())
}
