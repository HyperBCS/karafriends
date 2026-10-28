import React, { useEffect, useMemo, useRef, useState } from "react";

import type { Melody } from "./melody";
import type { InputDevice } from "./nativeAudio";
import {
  currentNote,
  micColor,
  PitchTrace,
  quadToTriangles,
  rollLayout,
  type RollLayout,
  SEGMENT_FLOATS,
  TIME_WIDTH_SECS,
} from "./pianoRoll";
import "./PianoRoll.css";
import { drawTime, pitchTime } from "./playback";
import midiVertShaderRaw from "./shaders/PianoRollMidi.vert.glsl?raw";
import noteFragShaderRaw from "./shaders/PianoRollNote.frag.glsl?raw";
import seekVertShaderRaw from "./shaders/PianoRollSeek.vert.glsl?raw";
import singleColorFragShaderRaw from "./shaders/PianoRollSingleColor.frag.glsl?raw";

// How often each mic's pitch is read.
const PITCH_POLL_MS = 25;
const FREE_TIME_COLOR = [0, 0, 0, 0.5];
const SEEK_COLOR = [0.9, 0.9, 0.9, 1.0];
// The seek line, in clip space; its shader moves it along with the time.
const SEEK_LINE = Float32Array.from(quadToTriangles(-1.005, 1.0, -0.995, -1.0));

// A linked program and where its inputs are. Every program here draws
// triangles from one attribute, "position"; a uniform it doesn't have is
// null, which GL ignores.
interface Program {
  program: WebGLProgram;
  position: number;
  time: WebGLUniformLocation | null;
  timeWidth: WebGLUniformLocation | null;
  canvasWidth: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // A lost context fails everything, and is set up again once restored.
    if (!gl.isContextLost()) {
      console.error(
        `Can't compile a pitch bars shader: ${gl.getShaderInfoLog(shader)}`,
      );
    }
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// Null if GL can't make it (the context was lost meanwhile).
function makeProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
): Program | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const program = gl.createProgram();
  if (vert && frag) {
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
  }
  // Freed with the program, once linked.
  if (vert) gl.deleteShader(vert);
  if (frag) gl.deleteShader(frag);
  if (!vert || !frag || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  return {
    program,
    position: gl.getAttribLocation(program, "position"),
    time: uniform("time"),
    timeWidth: uniform("timeWidth"),
    canvasWidth: uniform("canvasWidth"),
    color: uniform("color"),
  };
}

function drawTriangles(
  gl: WebGL2RenderingContext,
  program: Program,
  buffer: WebGLBuffer,
  vertices: number,
  uniforms: { time: number; canvasWidth: number; color?: readonly number[] },
) {
  if (vertices === 0) return;
  gl.useProgram(program.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(program.position);
  gl.uniform1f(program.timeWidth, TIME_WIDTH_SECS);
  gl.uniform1f(program.time, uniforms.time);
  gl.uniform1f(program.canvasWidth, uniforms.canvasWidth);
  if (uniforms.color) gl.uniform4fv(program.color, uniforms.color);
  gl.drawArrays(gl.TRIANGLES, 0, vertices);
}

// The pitch bars: the song's melody as bars along the top, the mics' pitch
// over them. GL is set up once per canvas (and again when a lost context is
// restored); a new melody, a key change or a mic change only changes what
// it draws. Without WebGL2 there are no bars, and the song plays on.
export default function PianoRoll(props: {
  melody: Melody;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mics: InputDevice[];
  pitchShiftSemis: number;
  // The display's audio/video offset (see drawTime).
  avOffsetMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bumped when a lost context is restored: GL is set up again.
  const [contextGeneration, setContextGeneration] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const [noWebGl, setNoWebGl] = useState(false);

  const layout = useMemo(() => rollLayout(props.melody), [props.melody]);
  // Read by the draw loop and the pitch pollers, so a change to these
  // doesn't set anything up again (nor an offset change lose the trace).
  const layoutRef = useRef<RollLayout>(layout);
  layoutRef.current = layout;
  const pitchShiftRef = useRef(props.pitchShiftSemis);
  pitchShiftRef.current = props.pitchShiftSemis;
  const avOffsetMsRef = useRef(props.avOffsetMs);
  avOffsetMsRef.current = props.avOffsetMs;
  // Each mic's trace and its colour, drawn by the draw loop.
  const tracesRef = useRef<{ trace: PitchTrace; color: number[] }[]>([]);
  // The note being sung, as an index into layout.notes.
  const noteIndexRef = useRef(0);

  // The drawing buffer follows the canvas's size on screen, whatever
  // changes it (the window, the Up next strip, the UI scale).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const device = entry.devicePixelContentBoxSize?.[0];
      const box = entry.contentBoxSize[0];
      canvas.width = device
        ? device.inlineSize
        : Math.round(box.inlineSize * window.devicePixelRatio);
      canvas.height = device
        ? device.blockSize
        : Math.round(box.blockSize * window.devicePixelRatio);
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }
    return () => observer.disconnect();
  }, [noWebGl]);

  // A lost context (the GPU process crashed or reset) is hidden until
  // Chromium restores it, which it does only if the loss is
  // preventDefault-ed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLost = (event: Event) => {
      event.preventDefault();
      setContextLost(true);
    };
    const onRestored = () => {
      setContextLost(false);
      setContextGeneration((generation) => generation + 1);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [noWebGl]);

  // GL, and the draw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = props.videoRef.current;
    if (!canvas || !video) return;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      console.warn("No WebGL2, so no pitch bars");
      setNoWebGl(true);
      return;
    }
    // Set up again once restored.
    if (gl.isContextLost()) return;

    const programs = [
      makeProgram(gl, midiVertShaderRaw, noteFragShaderRaw),
      makeProgram(gl, midiVertShaderRaw, singleColorFragShaderRaw),
      makeProgram(gl, seekVertShaderRaw, singleColorFragShaderRaw),
    ];
    const notesBuffer = gl.createBuffer();
    const freeTimeBuffer = gl.createBuffer();
    const seekBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seekBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, SEEK_LINE, gl.STATIC_DRAW);
    // Each trace's buffer, made the first time it's drawn.
    const traceBuffers = new Map<PitchTrace, WebGLBuffer>();
    let drawnLayout: RollLayout | null = null;
    let frame = 0;

    const cleanup = () => {
      cancelAnimationFrame(frame);
      for (const program of programs) {
        if (program) gl.deleteProgram(program.program);
      }
      for (const buffer of [notesBuffer, freeTimeBuffer, seekBuffer]) {
        gl.deleteBuffer(buffer);
      }
      traceBuffers.forEach((buffer) => gl.deleteBuffer(buffer));
    };
    const [noteProgram, colorProgram, seekProgram] = programs;
    if (!noteProgram || !colorProgram || !seekProgram) return cleanup;

    // The trace's buffer, with what changed since the last frame.
    const traceBuffer = (trace: PitchTrace) => {
      let buffer = traceBuffers.get(trace);
      if (!buffer) {
        buffer = gl.createBuffer();
        traceBuffers.set(trace, buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, trace.segments, gl.DYNAMIC_DRAW);
        trace.takeChanged();
        return buffer;
      }
      const changed = trace.takeChanged();
      if (changed.length === 0) return buffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      if (changed === "all") {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, trace.segments);
      } else {
        for (const slot of changed) {
          gl.bufferSubData(
            gl.ARRAY_BUFFER,
            slot * SEGMENT_FLOATS * Float32Array.BYTES_PER_ELEMENT,
            trace.segments,
            slot * SEGMENT_FLOATS,
            SEGMENT_FLOATS,
          );
        }
      }
      return buffer;
    };

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (gl.isContextLost()) return;
      // No stream yet (the low-bitrate switch, before its seek): the time
      // reads 0, so keep the last frame rather than flash the song's start.
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;

      const layout = layoutRef.current;
      if (layout !== drawnLayout) {
        gl.bindBuffer(gl.ARRAY_BUFFER, notesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, layout.notePositions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, freeTimeBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          layout.freeTimePositions,
          gl.STATIC_DRAW,
        );
        drawnLayout = layout;
      }
      const traces = tracesRef.current;
      traceBuffers.forEach((buffer, trace) => {
        if (!traces.some((drawn) => drawn.trace === trace)) {
          gl.deleteBuffer(buffer);
          traceBuffers.delete(trace);
        }
      });

      const time = drawTime(video.currentTime, avOffsetMsRef.current);
      const canvasWidth = canvas.width;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Free time, the notes, the traces, then the seek line over them.
      drawTriangles(
        gl,
        colorProgram,
        freeTimeBuffer,
        layout.freeTimePositions.length / 2,
        { time, canvasWidth, color: FREE_TIME_COLOR },
      );
      drawTriangles(
        gl,
        noteProgram,
        notesBuffer,
        layout.notePositions.length / 2,
        { time, canvasWidth },
      );
      for (const { trace, color } of traces) {
        drawTriangles(
          gl,
          colorProgram,
          traceBuffer(trace),
          (trace.filled * SEGMENT_FLOATS) / 2,
          { time, canvasWidth, color },
        );
      }
      drawTriangles(gl, seekProgram, seekBuffer, SEEK_LINE.length / 2, {
        time,
        canvasWidth,
        color: SEEK_COLOR,
      });

      canvas.classList.toggle(
        "pianoRollPog",
        layout.pogIntervals.some(
          ([start, end]) => time >= start - 1 && time <= end,
        ),
      );
    };
    frame = requestAnimationFrame(draw);
    return cleanup;
  }, [contextGeneration, noWebGl, props.videoRef]);

  // Each mic's pitch, read into its trace while the song plays.
  useEffect(() => {
    const video = props.videoRef.current;
    if (!video) return;
    const traces = props.mics.map((_, i) => ({
      trace: new PitchTrace(),
      color: [...micColor(i, props.mics.length), 1.0],
    }));
    tracesRef.current = traces;

    const poll = (mic: InputDevice, trace: PitchTrace) => {
      const { notes, median } = layoutRef.current;
      if (notes.length === 0 || video.paused) return;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
      const { midiNumber, confidence } = mic.getPitch();
      if (confidence < 0.8 || midiNumber === 0) return;
      const time = pitchTime(video.currentTime, avOffsetMsRef.current);
      noteIndexRef.current = currentNote(
        notes,
        Math.min(noteIndexRef.current, notes.length - 1),
        time,
      );
      // In the melody's own key, as the roll draws it.
      trace.push(
        midiNumber - pitchShiftRef.current,
        notes[noteIndexRef.current].midiNumber,
        median,
        time,
      );
    };
    const pollers = traces.map(({ trace }, i) =>
      setInterval(() => poll(props.mics[i], trace), PITCH_POLL_MS),
    );
    const clear = () => {
      noteIndexRef.current = 0;
      traces.forEach(({ trace }) => trace.clear());
    };
    video.addEventListener("seeked", clear);
    return () => {
      pollers.forEach(clearInterval);
      video.removeEventListener("seeked", clear);
      tracesRef.current = [];
    };
  }, [props.mics, props.videoRef]);

  // A new song (DAM to DAM keeps the roll): no trace from the last one.
  useEffect(() => {
    noteIndexRef.current = 0;
    tracesRef.current.forEach(({ trace }) => trace.clear());
  }, [layout]);

  if (noWebGl) return null;
  return (
    <canvas
      className="pianoRollRoll"
      ref={canvasRef}
      hidden={contextLost}
    ></canvas>
  );
}
