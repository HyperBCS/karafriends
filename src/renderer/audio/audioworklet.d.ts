// Ambient AudioWorklet globals used by phazeAudioWorklet.ts.
//
// TypeScript 6 doesn't include @types packages automatically (`types` defaults
// to []), so @types/audioworklet's globals were never picked up; this shim
// declares the two the worklet needs instead. AudioWorkletProcessor's
// constructor takes no arguments, as in the Web Audio spec.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (...args: any[]) => AudioWorkletProcessor,
): void;
