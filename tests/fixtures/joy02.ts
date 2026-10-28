// Builds a small JOY-02 telop (Joysound's lyrics file), in the layout
// src/common/joysoundParser.ts reads, for the parser's unit tests and the
// display's e2e. Every number is little-endian; the text is Shift JIS.
//
//   0..5     unused
//   6        u32 metadata offset, u32 lyrics offset, u32 timing offset
//   metadata u16 music type, 7 × u16 string offsets (from the metadata's
//            start), u16, u16 playtime (s), then the NUL-ended strings
//   lyrics   15 × u16 RGB555 colours, then the blocks: u16 block size,
//            u16 flags, u16 x, u16 y, 4 × u8 colour (pre fill, post fill,
//            pre border, post border), u16 char count, per char u8 font,
//            u16 code, u16 width; u16 ruby count, per ruby u16 length,
//            u16 x, length × u16 code
//   timing   to the end: per event u32 time (ms), u8 payload size, payload

// Shift JIS has no encoder in Node: decode every two-byte code once.
let sjisCodes: Map<string, number> | null = null;

function sjisCode(char: string): number {
  if (char.length === 1 && char.charCodeAt(0) < 0x80) {
    return char.charCodeAt(0);
  }
  if (!sjisCodes) {
    sjisCodes = new Map();
    const decoder = new TextDecoder("shift_jis", { fatal: true });
    for (let high = 0x81; high <= 0xfc; high++) {
      if (high >= 0xa0 && high <= 0xdf) continue;
      for (let low = 0x40; low <= 0xfc; low++) {
        try {
          const text = decoder.decode(new Uint8Array([high, low]));
          if (!sjisCodes.has(text)) sjisCodes.set(text, high * 256 + low);
        } catch {
          // Not a character.
        }
      }
    }
  }
  const code = sjisCodes.get(char);
  if (code === undefined) throw new Error(`${char} isn't in Shift JIS`);
  return code;
}

function sjisBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = sjisCode(char);
    if (code < 0x100) bytes.push(code);
    else bytes.push(code >> 8, code & 0xff);
  }
  return bytes;
}

export interface Joy02Block {
  // In the telop's 720×480 space: the left of the line, and the top of its
  // main text.
  x: number;
  y: number;
  // The main line, one glyph per character, each `width` wide.
  text: string;
  width?: number;
  // Ruby over the main line, from x (relative to the block).
  ruby?: { x: number; text: string }[];
  flags?: number;
  // Palette indices: before and after the wipe.
  colours?: [
    preFill: number,
    postFill: number,
    preBorder: number,
    postBorder: number,
  ];
}

export interface Joy02Event {
  time: number;
  payload: number[];
}

// Timeline events, by what they do.
export const joy02Events = {
  // Starts the next block's wipe at `speed` × 10 units a second.
  scroll: (time: number, speed: number): Joy02Event => ({
    time,
    payload: [0, speed],
  }),
  // Changes the current block's wipe speed (× 10 units a second).
  scrollMore: (time: number, speed: number): Joy02Event => ({
    time,
    payload: [1, speed],
  }),
  // The title card ends.
  titleOut: (time: number): Joy02Event => ({ time, payload: [4] }),
  // The `count` oldest blocks on screen fade out.
  fadeOut: (time: number, count: number): Joy02Event => ({
    time,
    payload: [5, count],
  }),
  // The next `count` blocks fade in.
  fadeIn: (time: number, count: number): Joy02Event => ({
    time,
    payload: [6, count],
  }),
};

// The default palette: 0 white, 1 black, 2 blue, 3 pink.
const PALETTE = [0x7fff, 0x0000, 0x001f, 0x7d5f];

export function buildJoy02(telop: {
  title: string;
  artist: string;
  lyricist?: string;
  composer?: string;
  seconds: number;
  blocks: Joy02Block[];
  events: Joy02Event[];
}): Buffer {
  const bytes: number[] = [];
  const u8 = (n: number) => bytes.push(n & 0xff);
  const u16 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) => {
    u16(n & 0xffff);
    u16(n >>> 16);
  };
  const setU32 = (at: number, n: number) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = (n >>> (i * 8)) & 0xff;
  };

  for (let i = 0; i < 18; i++) u8(0);

  // Metadata: the names, then the readings (empty) and JASRAC code (empty).
  const metadataStart = bytes.length;
  setU32(6, metadataStart);
  const names = [
    telop.title,
    telop.artist,
    telop.lyricist ?? "",
    telop.composer ?? "",
    "",
    "",
    "",
  ].map((name) => [...sjisBytes(name), 0]);
  u16(0); // music type
  let stringOffset = 20;
  for (const name of names) {
    u16(stringOffset);
    stringOffset += name.length;
  }
  u16(0);
  u16(telop.seconds);
  for (const name of names) bytes.push(...name);

  setU32(10, bytes.length);
  for (let i = 0; i < 15; i++) u16(PALETTE[i] ?? 0);
  for (const block of telop.blocks) {
    const start = bytes.length;
    u16(0); // the size, below
    u16(block.flags ?? 0);
    u16(block.x);
    u16(block.y);
    for (const colour of block.colours ?? [0, 2, 1, 0]) u8(colour);
    const chars = [...block.text];
    u16(chars.length);
    for (const char of chars) {
      u8(0);
      u16(sjisCode(char));
      u16(block.width ?? 44);
    }
    const ruby = block.ruby ?? [];
    u16(ruby.length);
    for (const { x, text } of ruby) {
      const rubyChars = [...text];
      u16(rubyChars.length);
      u16(x);
      for (const char of rubyChars) u16(sjisCode(char));
    }
    const size = bytes.length - start;
    bytes[start] = size & 0xff;
    bytes[start + 1] = size >> 8;
  }

  setU32(14, bytes.length);
  for (const { time, payload } of telop.events) {
    u32(time);
    u8(payload.length);
    for (const byte of payload) u8(byte);
  }

  return Buffer.from(bytes);
}
