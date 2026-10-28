import { useEffect, useState } from "react";

import GuideMelodyWorker from "./guideMelody.worker.ts?worker";
import { joysoundMelody, type Melody, type MelodyNote } from "./melody";

// The rate the song's sound is decoded at: plenty for a melody, and a
// quarter of the memory of 44.1 kHz.
const SAMPLE_RATE = 11025;
// The last few songs' melodies are kept, for a song sung again.
const KEPT_SONGS = 8;

// By song ID; null for a song without a guide melody.
const melodies = new Map<string, Promise<Melody | null>>();

// The guide melody's notes, read in a worker so the lyrics don't stutter.
function readNotes(
  samples: Float32Array,
  sampleRate: number,
): Promise<MelodyNote[]> {
  return new Promise((resolve, reject) => {
    const worker = new GuideMelodyWorker();
    worker.onmessage = (event: MessageEvent<MelodyNote[]>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ samples, sampleRate }, [samples.buffer]);
  });
}

// A Joysound song's melody, from its video's sound: Joysound's ogg is
// 3-channel, and the third is the guide melody (webAudio.ts). Null with no
// third channel, or a silent one.
async function readMelody(file: string): Promise<Melody | null> {
  const data = await (await fetch(file)).arrayBuffer();
  // Decoded at the context's rate, with all its channels.
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const sound = await context.decodeAudioData(data);
  if (sound.numberOfChannels < 3) return null;
  const samples = new Float32Array(sound.length);
  sound.copyFromChannel(samples, 2);
  return joysoundMelody(await readNotes(samples, sound.sampleRate));
}

function guideMelody(songId: string, file: string): Promise<Melody | null> {
  let melody = melodies.get(songId);
  if (!melody) {
    melody = readMelody(file).catch((err) => {
      console.warn(`No pitch bars for ${songId}: can't read ${file}:`, err);
      melodies.delete(songId);
      return null;
    });
    melodies.set(songId, melody);
    if (melodies.size > KEPT_SONGS) {
      melodies.delete(melodies.keys().next().value!);
    }
  }
  return melody;
}

// The pitch bars' melody for a Joysound song, from its guide melody (file:
// its video), once read; null until then, for no song, or for a song
// without one.
export default function useGuideMelody(
  song: { songId: string; file: string } | null,
): Melody | null {
  const [read, setRead] = useState<{
    songId: string;
    melody: Melody | null;
  } | null>(null);
  const songId = song?.songId ?? null;
  const file = song?.file ?? null;

  useEffect(() => {
    if (songId === null || file === null) return;
    let current = true;
    void guideMelody(songId, file).then((melody) => {
      if (current) setRead({ songId, melody });
    });
    return () => {
      current = false;
    };
  }, [songId, file]);

  return read?.songId === songId ? read.melody : null;
}
