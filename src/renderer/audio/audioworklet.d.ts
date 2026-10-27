// Ambient AudioWorklet globals used by phazeAudioWorklet.ts.
//
// TypeScript 6 doesn't include @types packages automatically (`types` defaults
// to []), so @types/audioworklet's globals were never picked up; this shim
// declares the two the worklet needs instead. It mirrors that package's
// parameterless AudioWorkletProcessor constructor, so the `@ts-expect-error` on
// the `super(options)` call there stays valid.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (...args: any[]) => AudioWorkletProcessor,
): void;
