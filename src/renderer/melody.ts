// What the pitch bars (PianoRoll) draw for a song: its melody's notes, the
// parts with lyrics (the rest is shaded as free time) and DAM's kiai parts
// (the roll glows). From DAM's scoring data, or from a Joysound song's
// guide melody (guideMelody.ts). Pure, so the unit tests reach it.

// A note, in seconds of the song.
export interface MelodyNote {
  startTime: number;
  endTime: number;
  midiNumber: number;
}

export interface Melody {
  notes: MelodyNote[];
  // In seconds.
  lyricsIntervals: [number, number][];
  pogIntervals: [number, number][];
}

// DAM's scoring data: bytes of little-endian 32-bit words. Words 1 to 4
// count the notes, the lyrics intervals, DAM's time windows and the kiai
// (POG) intervals. The notes start at word 6, four words each (start and
// end in ms, the MIDI number, one more); then the intervals, two words
// each (start and end in ms), in that order.
export function damMelody(scoringData: readonly number[]): Melody {
  const bytes = Uint8Array.from(scoringData);
  const view = new Uint32Array(bytes.buffer, 0, bytes.length >> 2);
  const noteCount = view[1] ?? 0;
  const lyricsIntervalCount = view[2] ?? 0;
  const damTimeWindowIntervalCount = view[3] ?? 0;
  const pogIntervalCount = view[4] ?? 0;

  const notesOffset = 6;
  const notes: MelodyNote[] = [];
  for (let i = notesOffset; i < notesOffset + noteCount * 4; i += 4) {
    notes.push({
      startTime: view[i] / 1000,
      endTime: view[i + 1] / 1000,
      midiNumber: view[i + 2],
    });
  }

  const intervals = (offset: number, count: number) => {
    const result: [number, number][] = [];
    for (let i = offset; i < offset + count * 2; i += 2) {
      result.push([view[i] / 1000, view[i + 1] / 1000]);
    }
    return result;
  };
  const lyricsIntervalsOffset = notesOffset + noteCount * 4;
  const pogIntervalsOffset =
    lyricsIntervalsOffset +
    lyricsIntervalCount * 2 +
    damTimeWindowIntervalCount * 2;

  return {
    notes,
    lyricsIntervals: intervals(lyricsIntervalsOffset, lyricsIntervalCount),
    pogIntervals: intervals(pogIntervalsOffset, pogIntervalCount),
  };
}

// A Joysound song's: its guide melody's notes, sung where they are. Null
// with no notes (no guide channel, or a silent one): no bars.
export function joysoundMelody(notes: MelodyNote[]): Melody | null {
  if (notes.length === 0) return null;
  return {
    notes,
    lyricsIntervals: notes.map((note) => [note.startTime, note.endTime]),
    pogIntervals: [],
  };
}
