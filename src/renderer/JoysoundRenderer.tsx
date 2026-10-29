import React, { useEffect, useRef } from "react";
import invariant from "ts-invariant";

import "./JoysoundRenderer.css";

import type { LyricsMode } from "../common/api";
import parseJoysoundData, {
  decodeJoysoundText,
  JoysoundLyricsBlock,
  JoysoundMetadata,
  KuroshiroSingleton,
} from "../common/joysoundParser";

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../common/constants";
import {
  blockOnScreen,
  blockTexturesWanted,
  titleCardTop,
  titleOnScreen,
  wipeEdgePx,
} from "./joysoundSchedule";
import loadKuroshiro from "./kuroshiro";
import { drawTime } from "./playback";

// XXX: These should be in their own file

const vsSource = `#version 300 es
  in vec2 a_position;
  in vec2 a_texCoord;
  in float a_scroll;
  in float a_scrollType;

  uniform vec2 u_resolution;

  out vec2 v_texCoord;
  out vec2 v_position;
  out float v_scroll;
  out float v_scrollType;

  void main() {
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);

    v_texCoord = a_texCoord;
    v_position = a_position;
    v_scroll = a_scroll;
    v_scrollType = a_scrollType;
  }
`;

const fsSource = `#version 300 es
  precision highp float;

  uniform sampler2D u_image;

  in vec2 v_texCoord;
  in vec2 v_position;
  in float v_scroll;
  in float v_scrollType;

  out vec4 outColor;

  void main() {
    vec4 textureColor = texture(u_image, v_texCoord);

    if (
      (v_scrollType == 0.0 && v_position.x <= v_scroll) ||
      (v_scrollType == 1.0 && v_position.x > v_scroll)
    ) {
      outColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
      outColor = vec4(textureColor.r, textureColor.g, textureColor.b, textureColor.a);
    }
  }
`;

// XXX: Move these to some setting somewhere?
// XXX: RUBY_FONT_SIZE and RUBY_FONT_STROKE live in src/common/constants.ts for *reasons*

const TITLE_FONT_SIZE = 48;
const TITLE_FONT_STROKE = 4;

const ARTIST_FONT_SIZE = 32;
const ARTIST_FONT_STROKE = 4;

const METADATA_FONT_SIZE = 24;
const METADATA_FONT_STROKE = 3;

const MAIN_FONT_SIZE = 44;
const MAIN_FONT_STROKE = 4;

const ROMAJI_FONT_SIZE = 20;
const ROMAJI_FONT_STROKE = 2;

// A line of a lyrics block: its font size and stroke.
interface LineSize {
  size: number;
  stroke: number;
}

const lineHeight = (line: LineSize) => line.size + line.stroke * 2;

// "kana" draws the ruby above the main line, "romaji" the romaji there
// instead. "both" adds the romaji under the main line, in the same height
// (so it can't run into the next line): its three lines are smaller.
const RUBY_LINE = { size: RUBY_FONT_SIZE, stroke: RUBY_FONT_STROKE };
const MAIN_LINE = { size: MAIN_FONT_SIZE, stroke: MAIN_FONT_STROKE };
const ROMAJI_LINE = { size: ROMAJI_FONT_SIZE, stroke: ROMAJI_FONT_STROKE };
// "both": the ruby and the romaji line.
const BOTH_SMALL_LINE = { size: 14, stroke: 2 };
const BOTH_MAIN_LINE = { size: 36, stroke: 3 };

const SCREEN_WIDTH = 720;
const SCREEN_HEIGHT = 480;
const TEXT_PADDING = 16;

let EXPAND_RATE = 1.0;
let EXPAND_RATE_X = 1.0;
let EXPAND_RATE_Y = 1.0;

const TIMING_OFFSET = -200;

const JP_FONT_FACE = "notoSerifJP";
const KR_FONT_FACE = "notoSerifKR";

interface LyricsBlockTextures {
  preTexture: WebGLTexture;
  postTexture: WebGLTexture;
}

interface JoysoundTitleRow {
  text: string;
  width: number;
}

interface JoysoundDisplayBuffers {
  position: WebGLBuffer;
  texCoord: WebGLBuffer;
  scroll: WebGLBuffer;
  scrollType: WebGLBuffer;
}

function getFontFace(fontCode: number): string {
  switch (fontCode) {
    case 0:
      return JP_FONT_FACE;
    case 1:
      return KR_FONT_FACE;
    default:
      return JP_FONT_FACE;
  }
}

function createShader(
  gl: WebGL2RenderingContext,
  type:
    | WebGLRenderingContextBase["VERTEX_SHADER"]
    | WebGLRenderingContextBase["FRAGMENT_SHADER"],
  source: string,
) {
  const shader = gl.createShader(type);
  invariant(shader);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  return shader;
}

// The program; its shaders go with it when it is deleted.
function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  invariant(program);

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

function quadToTriangles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  return [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1];
}

function createTextureFromImage(
  gl: WebGL2RenderingContext,
  bitmap: HTMLCanvasElement,
): WebGLTexture {
  const texture = gl.createTexture();
  invariant(texture);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  return texture;
}

function getLyricsBlockWidth(lyricsBlock: JoysoundLyricsBlock): number {
  const mainBlockWidth = lyricsBlock.chars.reduce(
    (acc, curr) => acc + curr.width,
    0,
  );

  const rightmostFuriganaBlock =
    lyricsBlock.furigana[lyricsBlock.furigana.length - 1];
  const furiganaBlockWidth = rightmostFuriganaBlock
    ? rightmostFuriganaBlock.xPos +
      (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2) *
        rightmostFuriganaBlock.chars.length
    : 0;

  return (
    MAIN_FONT_STROKE * 2 +
    Math.max(mainBlockWidth, furiganaBlockWidth) +
    TEXT_PADDING * 2
  );
}

function getLyricsBlockHeight(_lyricsBlock: JoysoundLyricsBlock): number {
  return (
    MAIN_FONT_SIZE +
    MAIN_FONT_STROKE * 2 +
    RUBY_FONT_SIZE +
    RUBY_FONT_STROKE * 2 +
    TEXT_PADDING * 2
  );
}

function setupTextCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  fillColor: number[],
  strokeColor: number[],
): void {
  textCtx.canvas.width = getLyricsBlockWidth(lyricsBlock) * EXPAND_RATE_X;
  textCtx.canvas.height = getLyricsBlockHeight(lyricsBlock) * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;
  textCtx.strokeStyle = `rgb(${strokeColor.join(", ")})`;
}

function setupTitleCanvas(textCtx: CanvasRenderingContext2D): void {
  textCtx.canvas.width = SCREEN_WIDTH * EXPAND_RATE_X;
  textCtx.canvas.height = SCREEN_HEIGHT * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(255, 255, 255)`;
  textCtx.strokeStyle = `rgb(8, 8, 8)`;
}

function createTitleRows(
  textCtx: CanvasRenderingContext2D,
  fontStroke: number,
  title: string,
): JoysoundTitleRow[] {
  const titleRows = [];

  let currTitleText = "";
  let currTitleWidth = 0;

  for (const nextChar of title) {
    const nextTitleWidth = textCtx.measureText(currTitleText + nextChar).width;

    if (
      nextTitleWidth >=
      (SCREEN_WIDTH - (TEXT_PADDING + fontStroke + 16) * 2) * EXPAND_RATE_X
    ) {
      titleRows.push({ text: currTitleText, width: currTitleWidth });

      currTitleText = nextChar;
      currTitleWidth = textCtx.measureText(nextChar).width;
    } else {
      currTitleText += nextChar;
      currTitleWidth = nextTitleWidth;
    }
  }

  titleRows.push({ text: currTitleText, width: currTitleWidth });

  return titleRows;
}

function drawTitleRowsToCanvas(
  textCtx: CanvasRenderingContext2D,
  titleRows: JoysoundTitleRow[],
  fontSize: number,
  fontStroke: number,
  yPos: number,
) {
  for (const titleRow of titleRows) {
    const titleRowPaddedWidth =
      titleRow.width + (TEXT_PADDING + fontStroke) * EXPAND_RATE_X * 2;

    const xPos = Math.max(
      0,
      (SCREEN_WIDTH * EXPAND_RATE_X - titleRowPaddedWidth) / 2 / EXPAND_RATE_X,
    );

    drawTextToCanvas(textCtx, fontSize, fontStroke, xPos, yPos, titleRow.text);

    yPos += fontSize + fontStroke * 2;
  }
}

// clearPitchBand: lay the card out below the pitch bars.
function createTitleTexture(
  gl: WebGL2RenderingContext,
  textCtx: CanvasRenderingContext2D,
  metadata: JoysoundMetadata,
  lyricsMode: LyricsMode,
  clearPitchBand: boolean,
): WebGLTexture {
  const isRomaji = lyricsMode === "romaji";

  setupTitleCanvas(textCtx);

  const titleFontSize =
    metadata.musicName.length < 48 ? TITLE_FONT_SIZE : ARTIST_FONT_SIZE;
  const titleFontStroke =
    metadata.musicName.length < 48 ? TITLE_FONT_STROKE : ARTIST_FONT_STROKE;
  textCtx.font = `${titleFontSize * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const titleRows = createTitleRows(
    textCtx,
    titleFontStroke,
    metadata.musicName,
  );
  const titleHeight =
    (titleFontSize + TITLE_FONT_STROKE * 2) * titleRows.length * EXPAND_RATE_Y;

  const artistFontSize =
    metadata.artistName.length < 64 ? ARTIST_FONT_SIZE : METADATA_FONT_SIZE;
  const artistFontStroke =
    metadata.artistName.length < 64 ? ARTIST_FONT_STROKE : METADATA_FONT_STROKE;

  textCtx.font = `${artistFontSize * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const artistRows = createTitleRows(
    textCtx,
    artistFontStroke,
    "♪ " + metadata.artistName,
  );
  const artistHeight =
    (artistFontSize + ARTIST_FONT_STROKE * 2) *
    artistRows.length *
    EXPAND_RATE_Y;

  textCtx.font = `${METADATA_FONT_SIZE * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const lyricistText =
    (isRomaji ? "Lyrics: " : "作詞 ") + metadata.lyricistName;
  const lyricistMeasure = textCtx.measureText(lyricistText);
  const lyricistHeight =
    lyricistMeasure.actualBoundingBoxAscent +
    lyricistMeasure.actualBoundingBoxDescent;

  const composerText =
    (isRomaji ? "Composer: " : "作曲 ") + metadata.composerName;
  const composerMeasure = textCtx.measureText(composerText);
  const composerHeight =
    composerMeasure.actualBoundingBoxAscent +
    composerMeasure.actualBoundingBoxDescent;

  const totalHeight =
    titleHeight +
    artistHeight +
    lyricistHeight +
    composerHeight +
    144 * EXPAND_RATE_Y;

  const titleYPos = titleCardTop(
    SCREEN_HEIGHT,
    totalHeight / EXPAND_RATE_Y,
    TEXT_PADDING,
    clearPitchBand,
  );
  const artistYPos = titleYPos + titleHeight / EXPAND_RATE_Y + 64;
  const lyricistYPos = artistYPos + artistHeight / EXPAND_RATE_Y + 64;
  const composerYPos = lyricistYPos + lyricistHeight / EXPAND_RATE_Y + 16;

  drawTitleRowsToCanvas(
    textCtx,
    titleRows,
    titleFontSize,
    TITLE_FONT_STROKE,
    titleYPos,
  );
  drawTitleRowsToCanvas(
    textCtx,
    artistRows,
    artistFontSize,
    ARTIST_FONT_STROKE,
    artistYPos,
  );

  drawTextToCanvas(
    textCtx,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    lyricistYPos,
    lyricistText,
  );

  drawTextToCanvas(
    textCtx,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    composerYPos,
    composerText,
  );

  return createTextureFromImage(gl, textCtx.canvas);
}

function createLyricsBlockTexture(
  gl: WebGL2RenderingContext,
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  fillColor: number[],
  strokeColor: number[],
  lyricsMode: LyricsMode,
): WebGLTexture {
  setupTextCanvas(textCtx, lyricsBlock, fillColor, strokeColor);

  if (lyricsMode === "both") {
    const mainY = lineHeight(BOTH_SMALL_LINE);
    drawFuriganaTextToCanvas(textCtx, lyricsBlock, BOTH_SMALL_LINE);
    drawMainTextToCanvas(textCtx, lyricsBlock, BOTH_MAIN_LINE, mainY);
    drawRomajiTextToCanvas(
      textCtx,
      lyricsBlock,
      BOTH_SMALL_LINE,
      mainY + lineHeight(BOTH_MAIN_LINE),
    );
  } else {
    drawMainTextToCanvas(
      textCtx,
      lyricsBlock,
      MAIN_LINE,
      lineHeight(RUBY_LINE),
    );
    if (lyricsMode === "romaji") {
      drawRomajiTextToCanvas(textCtx, lyricsBlock, ROMAJI_LINE, 0);
    } else {
      drawFuriganaTextToCanvas(textCtx, lyricsBlock, RUBY_LINE);
    }
  }

  return createTextureFromImage(gl, textCtx.canvas);
}

// Where text drawnWidth device pixels wide starts (x as drawTextToCanvas
// takes it, which adds the stroke) to be centred on centre, in telop units.
// Places stretch with the screen's width (EXPAND_RATE_X), but text keeps its
// shape (EXPAND_RATE): on a screen wider than the telop's 3:2, text is
// narrower than the space it was laid out for, so a centre is worked out in
// device pixels. The stroke's outline is even on both sides.
function centredX(centre: number, drawnWidth: number, stroke: number): number {
  return centre - drawnWidth / (2 * EXPAND_RATE_X) - stroke;
}

// A main-line glyph's x in its slot of charWidth, measured at the line's
// size (textCtx's font, unscaled). One that fits is centred in its slot, as
// the ruby over it and the romaji under it are; one that doesn't hangs out
// as its ink allows.
function getTextOffset(
  textCtx: CanvasRenderingContext2D,
  text: string,
  charWidth: number,
  stroke: number,
): number {
  const measure = textCtx.measureText(text);

  if (charWidth >= measure.width) {
    return centredX(charWidth / 2, measure.width * EXPAND_RATE, stroke);
  }

  if (
    measure.actualBoundingBoxLeft === 0 ||
    measure.actualBoundingBoxRight === 0
  ) {
    return (charWidth - measure.width) / 2;
  }

  const boundingBoxWidth =
    measure.actualBoundingBoxLeft + measure.actualBoundingBoxRight;
  const widthDiff = measure.width - charWidth;
  const halfDiff = widthDiff / 2;

  let leftOverflow = -1 * measure.actualBoundingBoxLeft;
  let rightOverflow = measure.width - measure.actualBoundingBoxRight;

  let isLeftOverflow = false;

  if (leftOverflow >= halfDiff) {
    leftOverflow -= halfDiff;
    isLeftOverflow = true;
  }

  let isRightOverflow = false;

  if (rightOverflow >= halfDiff) {
    rightOverflow -= halfDiff;
    isRightOverflow = true;
  }

  if (isLeftOverflow) {
    if (isRightOverflow) {
      return leftOverflow + measure.actualBoundingBoxLeft;
    } else if (leftOverflow >= halfDiff - rightOverflow) {
      return (
        leftOverflow -
        (halfDiff - rightOverflow) +
        measure.actualBoundingBoxLeft
      );
    }
  } else if (isRightOverflow && rightOverflow >= widthDiff - leftOverflow) {
    return measure.actualBoundingBoxLeft;
  }

  return (charWidth - boundingBoxWidth) / 2 + measure.actualBoundingBoxLeft;
}

function drawTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  fontSize: number,
  fontStroke: number,
  xPos: number,
  yPos: number,
  text: string,
  fontCode: number = 0,
): void {
  textCtx.font = `${fontSize * EXPAND_RATE}px ${getFontFace(fontCode)}`;
  textCtx.lineWidth = fontStroke * 2 * EXPAND_RATE;

  textCtx.strokeText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_Y,
  );

  textCtx.fillText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_Y,
  );
}

function drawMainTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  line: LineSize,
  yPos: number,
): void {
  let currX = 0;

  for (const glyphChar of lyricsBlock.chars) {
    const text = decodeJoysoundText(
      glyphChar.charCode,
      glyphChar.font,
      lyricsBlock.flags,
    );

    textCtx.font = `${line.size}px ${getFontFace(glyphChar.font)}`;
    textCtx.lineWidth = line.stroke * 2;

    const xPos =
      currX + getTextOffset(textCtx, text, glyphChar.width, line.stroke);

    drawTextToCanvas(
      textCtx,
      line.size,
      line.stroke,
      xPos,
      yPos,
      text,
      glyphChar.font,
    );

    currX += glyphChar.width;
  }
}

// The ruby, at the top of the block. Smaller ruby stays centred where the
// full-size ruby would be.
function drawFuriganaTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  line: LineSize,
): void {
  const advance = line.size + line.stroke;
  const fullAdvance = RUBY_FONT_SIZE + RUBY_FONT_STROKE;

  for (const furiganaBlock of lyricsBlock.furigana) {
    const count = furiganaBlock.chars.length;
    let currX = furiganaBlock.xPos + ((fullAdvance - advance) * count) / 2;

    for (const charCode of furiganaBlock.chars) {
      const unicodeChar = decodeJoysoundText(charCode);

      drawTextToCanvas(textCtx, line.size, line.stroke, currX, 0, unicodeChar);

      currX += advance;
    }
  }
}

function drawRomajiTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  line: LineSize,
  yPos: number,
): void {
  const sortedRomaji = lyricsBlock.romaji.sort((a, b) => a.xPos - b.xPos);

  for (const romajiBlock of sortedRomaji) {
    // Measured as drawTextToCanvas draws it, and centred on what it reads
    // (its kana, or the ruby over its kanji).
    textCtx.font = `${line.size * EXPAND_RATE}px ${getFontFace(0)}`;
    const drawnWidth = textCtx.measureText(romajiBlock.phrase).width;

    drawTextToCanvas(
      textCtx,
      line.size,
      line.stroke,
      centredX(
        romajiBlock.xPos + romajiBlock.sourceWidth / 2,
        drawnWidth,
        line.stroke,
      ),
      yPos,
      romajiBlock.phrase,
    );
  }
}

// A block's textures, before and after the wipe, drawn on the scratch
// canvas textCtx.
function createLyricsBlockTextures(
  gl: WebGL2RenderingContext,
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  lyricsMode: LyricsMode,
): LyricsBlockTextures {
  return {
    preTexture: createLyricsBlockTexture(
      gl,
      textCtx,
      lyricsBlock,
      lyricsBlock.preFill.rgb,
      lyricsBlock.preBorder.rgb,
      lyricsMode,
    ),
    postTexture: createLyricsBlockTexture(
      gl,
      textCtx,
      lyricsBlock,
      lyricsBlock.postFill.rgb,
      lyricsBlock.postBorder.rgb,
      lyricsMode,
    ),
  };
}

function drawTitle(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  titleTexture: WebGLTexture,
): void {
  const scrollArray = new Float32Array(Array(6).fill(0));

  const positions = quadToTriangles(
    0,
    0,
    SCREEN_WIDTH * EXPAND_RATE_X,
    SCREEN_HEIGHT * EXPAND_RATE_Y,
  );

  drawLyricsTexture(gl, glBuffers, titleTexture, positions, scrollArray, false);
}

function drawLyricsTexture(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  texture: WebGLTexture,
  positions: number[],
  scrollArray: Float32Array,
  isPostTexture: boolean,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scroll);
  gl.bufferData(gl.ARRAY_BUFFER, scrollArray, gl.STATIC_DRAW);

  const scrollTypeArray = new Float32Array(
    Array(6).fill(isPostTexture ? 1.0 : 0.0),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scrollType);
  gl.bufferData(gl.ARRAY_BUFFER, scrollTypeArray, gl.STATIC_DRAW);

  const texCoordArray = new Float32Array(quadToTriangles(0.0, 0.0, 1.0, 1.0));

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.texCoord);
  gl.bufferData(gl.ARRAY_BUFFER, texCoordArray, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
}

function drawLyricsBlock(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  lyricsBlock: JoysoundLyricsBlock,
  textures: LyricsBlockTextures,
  refreshTime: number,
) {
  // In device pixels, as the fragment shader compares it.
  const wipeX = wipeEdgePx(lyricsBlock, refreshTime, EXPAND_RATE_X);

  const scrollArray = new Float32Array(Array(6).fill(wipeX));

  const currX = lyricsBlock.xPos;
  const currY = lyricsBlock.yPos - (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2) - 8;

  const rectWidth = getLyricsBlockWidth(lyricsBlock);
  const rectHeight = getLyricsBlockHeight(lyricsBlock);

  const positions = quadToTriangles(
    (currX - TEXT_PADDING) * EXPAND_RATE_X,
    (currY - TEXT_PADDING) * EXPAND_RATE_Y,
    (currX + rectWidth - TEXT_PADDING) * EXPAND_RATE_X,
    (currY + rectHeight - TEXT_PADDING) * EXPAND_RATE_Y,
  );

  if (wipeX <= (currX + rectWidth) * EXPAND_RATE_X) {
    drawLyricsTexture(
      gl,
      glBuffers,
      textures.preTexture,
      positions,
      scrollArray,
      false,
    );
  }

  if (wipeX >= currX * EXPAND_RATE_X) {
    drawLyricsTexture(
      gl,
      glBuffers,
      textures.postTexture,
      positions,
      scrollArray,
      true,
    );
  }
}

// The GL objects one song draws with, and its textures: only those of the
// title card and the blocks around now (joysoundSchedule.ts), made as they
// come up and deleted as they go.
class SongTextures {
  private blocks = new Map<number, LyricsBlockTextures>();
  private title: WebGLTexture | null = null;
  // The layout the title texture was drawn for.
  private titleClearsPitchBand = false;

  constructor(
    private gl: WebGL2RenderingContext,
    private textCtx: CanvasRenderingContext2D,
    private metadata: JoysoundMetadata,
    private lyricsData: JoysoundLyricsBlock[],
    private lyricsMode: LyricsMode,
  ) {}

  get count(): number {
    return this.blocks.size * 2 + (this.title ? 1 : 0);
  }

  // Makes and deletes textures for the frame at refreshTime. One block's
  // early textures a frame, so blocks that come up together don't stall a
  // single frame; a block already on screen (after a seek) is made at once.
  update(refreshTime: number, clearPitchBand: boolean) {
    const { gl } = this;
    if (titleOnScreen(this.metadata, refreshTime)) {
      if (this.title && this.titleClearsPitchBand !== clearPitchBand) {
        gl.deleteTexture(this.title);
        this.title = null;
      }
      if (!this.title) {
        this.title = createTitleTexture(
          gl,
          this.textCtx,
          this.metadata,
          this.lyricsMode,
          clearPitchBand,
        );
        this.titleClearsPitchBand = clearPitchBand;
      }
    } else if (this.title) {
      gl.deleteTexture(this.title);
      this.title = null;
    }

    let madeEarly = false;
    this.lyricsData.forEach((block, i) => {
      const textures = this.blocks.get(i);
      if (!blockTexturesWanted(block, refreshTime)) {
        if (textures) this.deleteBlock(i, textures);
      } else if (
        !textures &&
        (blockOnScreen(block, refreshTime) || !madeEarly)
      ) {
        madeEarly ||= !blockOnScreen(block, refreshTime);
        this.blocks.set(
          i,
          createLyricsBlockTextures(gl, this.textCtx, block, this.lyricsMode),
        );
      }
    });
  }

  titleTexture(): WebGLTexture | null {
    return this.title;
  }

  blockTextures(index: number): LyricsBlockTextures | undefined {
    return this.blocks.get(index);
  }

  private deleteBlock(index: number, textures: LyricsBlockTextures) {
    this.gl.deleteTexture(textures.preTexture);
    this.gl.deleteTexture(textures.postTexture);
    this.blocks.delete(index);
  }

  // All of them, for a resize (the next frame makes them at the new size)
  // or the end of the song.
  clear() {
    for (const [i, textures] of this.blocks) this.deleteBlock(i, textures);
    if (this.title) this.gl.deleteTexture(this.title);
    this.title = null;
  }
}

export default function JoysoundRenderer(props: {
  telop: ArrayBuffer;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  lyricsMode: LyricsMode;
  // The display's audio/video offset (see drawTime).
  avOffsetMs: number;
  // Whether the pitch bars may show over the video: the title card then
  // stays clear of their band.
  pitchBars: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read by draw(), so a change doesn't re-parse the telop.
  const avOffsetMsRef = useRef(props.avOffsetMs);
  avOffsetMsRef.current = props.avOffsetMs;
  const pitchBarsRef = useRef(props.pitchBars);
  pitchBarsRef.current = props.pitchBars;

  useEffect(() => {
    const canvas = canvasRef.current;
    invariant(canvas);
    const context = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
    });
    invariant(context);
    // Typed non-null, for draw() and frame() below.
    const canvasElement: HTMLCanvasElement = canvas;
    const gl: WebGL2RenderingContext = context;

    let cancelled = false;
    let animationFrame = 0;
    // Set once the song's lyrics are read.
    let textures: SongTextures | null = null;
    let releaseGl = () => {};

    const updateSize = () => {
      canvasElement.width = canvasElement.clientWidth * window.devicePixelRatio;
      canvasElement.height =
        canvasElement.clientHeight * window.devicePixelRatio;

      // XXX: Global variables but it works
      EXPAND_RATE = Math.min(
        canvasElement.width / SCREEN_WIDTH,
        canvasElement.height / SCREEN_HEIGHT,
      );

      EXPAND_RATE_X = canvasElement.width / SCREEN_WIDTH;
      EXPAND_RATE_Y = canvasElement.height / SCREEN_HEIGHT;

      gl.viewport(0, 0, canvasElement.width, canvasElement.height);
      // Remade at the new size as they're drawn.
      textures?.clear();
    };

    const refresh = async () => {
      updateSize();
      window.addEventListener("resize", updateSize);

      // Romaji needs kuromoji's dictionary; kana doesn't. If it won't load,
      // the song still shows its lyrics, without romaji.
      let kuroshiro: KuroshiroSingleton | null = null;
      if (props.lyricsMode !== "kana") {
        kuroshiro = await loadKuroshiro().catch((error) => {
          console.error("Couldn't load kuromoji for the romaji:", error);
          return null;
        });
      }
      const joysoundData = await parseJoysoundData(props.telop, kuroshiro);
      // Cleaned up while parsing: a newer effect draws instead.
      if (cancelled) return;

      const metadata = joysoundData.metadata;
      const lyricsData = joysoundData.lyrics;

      // The scratch canvas each texture is drawn on, in turn.
      const textCtx = document.createElement("canvas").getContext("2d");
      invariant(textCtx);
      const songTextures = new SongTextures(
        gl,
        textCtx,
        metadata,
        lyricsData,
        props.lyricsMode,
      );
      textures = songTextures;

      const program = createProgram(gl);

      const positionAttributeLocation = gl.getAttribLocation(
        program,
        "a_position",
      );
      const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
      const scrollLocation = gl.getAttribLocation(program, "a_scroll");
      const scrollTypeLocation = gl.getAttribLocation(program, "a_scrollType");
      const resolutionUniformLocation = gl.getUniformLocation(
        program,
        "u_resolution",
      );

      const positionBuffer = gl.createBuffer();
      const texCoordBuffer = gl.createBuffer();
      const scrollBuffer = gl.createBuffer();
      const scrollTypeBuffer = gl.createBuffer();

      invariant(positionBuffer);
      invariant(texCoordBuffer);
      invariant(scrollBuffer);
      invariant(scrollTypeBuffer);

      const glBuffers: JoysoundDisplayBuffers = {
        position: positionBuffer,
        texCoord: texCoordBuffer,
        scroll: scrollBuffer,
        scrollType: scrollTypeBuffer,
      };

      releaseGl = () => {
        songTextures.clear();
        for (const buffer of Object.values(glBuffers)) gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        // Never attached: this frees its pixels now, not at GC.
        textCtx.canvas.width = 0;
        textCtx.canvas.height = 0;
      };

      function draw() {
        const video = props.videoRef.current;
        if (!video) return;

        const refreshTime =
          drawTime(video.currentTime, avOffsetMsRef.current) * 1000 +
          TIMING_OFFSET;

        songTextures.update(refreshTime, pitchBarsRef.current);
        // For the e2e: how many textures the song holds.
        const count = String(songTextures.count);
        if (canvasElement.dataset.textures !== count) {
          canvasElement.dataset.textures = count;
        }

        gl.clearColor(0.0, 0.0, 0.0, 0.2);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );

        gl.useProgram(program);

        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.vertexAttribPointer(
          positionAttributeLocation,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );

        gl.enableVertexAttribArray(texCoordLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollBuffer);
        gl.vertexAttribPointer(scrollLocation, 1, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollTypeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollTypeBuffer);
        gl.vertexAttribPointer(scrollTypeLocation, 1, gl.FLOAT, false, 0, 0);

        gl.uniform2f(
          resolutionUniformLocation,
          gl.canvas.width,
          gl.canvas.height,
        );

        const titleTexture = songTextures.titleTexture();
        if (titleTexture) {
          drawTitle(gl, glBuffers, titleTexture);
        }

        lyricsData.forEach((lyricsBlock, i) => {
          const blockTextures = songTextures.blockTextures(i);
          if (blockTextures && blockOnScreen(lyricsBlock, refreshTime)) {
            drawLyricsBlock(
              gl,
              glBuffers,
              lyricsBlock,
              blockTextures,
              refreshTime,
            );
          }
        });
      }

      // A frame that throws is skipped, and the lyrics go on with the next:
      // one bad frame mustn't end them for the rest of the song. Logged
      // once a song.
      let frameFailed = false;
      function frame() {
        animationFrame = window.requestAnimationFrame(frame);
        try {
          draw();
        } catch (error) {
          if (!frameFailed) console.error("A lyrics frame failed:", error);
          frameFailed = true;
        }
      }

      animationFrame = window.requestAnimationFrame(frame);
    };

    refresh().catch(console.error);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", updateSize);
      window.cancelAnimationFrame(animationFrame);
      releaseGl();
      // The drawing buffer too: React may keep this canvas (a new lyrics
      // mode), and if it doesn't, the context waits for GC.
      canvasElement.width = 0;
      canvasElement.height = 0;
    };
  }, [props.telop, props.lyricsMode]);

  return <canvas ref={canvasRef} className="joysoundDisplay"></canvas>;
}
