import { guideMelodyNotes } from "./guideMelody";

// Reads a Joysound song's guide melody off the display's main thread (see
// useGuideMelody.ts): gets the guide channel's samples, answers with its
// notes.
self.onmessage = (
  event: MessageEvent<{ samples: Float32Array; sampleRate: number }>,
) => {
  const { samples, sampleRate } = event.data;
  self.postMessage(guideMelodyNotes(samples, sampleRate));
};
