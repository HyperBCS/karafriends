import { useEffect, useState } from "react";

import GuideMelodyWorker from "./guideMelody.worker.ts?worker";
import { SharedReads } from "./guideMelodyReads";
import { joysoundMelody, type Melody, type MelodyNote } from "./melody";

// The rate the song's sound is decoded at: plenty for a melody, and a
// quarter of the memory of 44.1 kHz.
const SAMPLE_RATE = 11025;

// By song ID, null for a song without a guide melody. The last few songs'
// are kept, for a song sung again.
const melodies = new SharedReads<Melody | null>(8);

// The guide melody's notes, read in a worker so the lyrics don't stutter.
function readNotes(
  samples: Float32Array,
  sampleRate: number,
  signal: AbortSignal,
): Promise<MelodyNote[]> {
  return new Promise((resolve, reject) => {
    const worker = new GuideMelodyWorker();
    const stop = () => {
      worker.terminate();
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    const done = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<MelodyNote[]>) => {
      done();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message));
    };
    worker.postMessage({ samples, sampleRate }, [samples.buffer]);
  });
}

// The guide channel of a Joysound song's video: Joysound's ogg is
// 3-channel, and the third is the guide melody (webAudio.ts). Null with no
// third channel. WebAudio decodes every channel, so only the third is kept:
// the file's bytes go to the decoder, and the decoded sound is dropped when
// this returns, before the notes are read.
async function guideChannel(
  file: string,
  signal: AbortSignal,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const response = await fetch(file, { signal });
  if (!response.ok) throw new Error(`${response.status} for ${file}`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  // Decoded at the context's rate.
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const sound = await context.decodeAudioData(data);
  signal.throwIfAborted();
  if (sound.numberOfChannels < 3) return null;
  return {
    samples: sound.getChannelData(2).slice(),
    sampleRate: sound.sampleRate,
  };
}

// A Joysound song's melody, from its guide channel. Null without one, or
// with a silent one.
async function readMelody(
  file: string,
  signal: AbortSignal,
): Promise<Melody | null> {
  const guide = await guideChannel(file, signal);
  if (!guide) return null;
  return joysoundMelody(
    await readNotes(guide.samples, guide.sampleRate, signal),
  );
}

// The pitch bars' melody for a Joysound song, from its guide melody (file:
// its video), once read; null until then, for no song, or for a song
// without one. Read once a song, and stopped if the song goes (or the bars
// do) first.
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
    const { result, release } = melodies.use(songId, (signal) =>
      readMelody(file, signal),
    );
    result.then(
      (melody) => {
        if (current) setRead({ songId, melody });
      },
      (err: unknown) => {
        // Skipped: nobody's waiting for it.
        if (!current) return;
        console.warn(`No pitch bars for ${songId}: can't read ${file}:`, err);
        setRead({ songId, melody: null });
      },
    );
    return () => {
      current = false;
      release();
    };
  }, [songId, file]);

  return read?.songId === songId ? read.melody : null;
}
