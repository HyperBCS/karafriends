// Types for the bundler's special imports (see electron.vite.config.ts).

// A file's contents as a string (the piano roll's shaders).
declare module "*?raw" {
  const content: string;
  export default content;
}

// The URL of a script bundled on its own (the display's audio worklet).
declare module "*?worker&url" {
  const url: string;
  export default url;
}

// A web worker bundled on its own (the display's guide melody reader).
declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

// A file copied beside the main bundle: its path (electron-vite's ?asset).
declare module "*?asset" {
  const path: string;
  export default path;
}

// An image's URL.
declare module "*.png" {
  const url: string;
  export default url;
}

// The native module (native/karafriends/src/lib.rs): copied next to the main
// or preload bundle and loaded with require(). Its functions are those the
// display gets through the preload (NativeAudio), with each mic an opaque
// handle the preload keeps (it can't cross to the page), and a console
// window for the main process. src/preload/native.test.ts checks the names
// against the built module.
declare module "*/native/index.node" {
  type NativeAudio = import("./renderer/global").NativeAudio;
  // A mic: a box only the native module opens.
  const mic: unique symbol;
  type Mic = { readonly [mic]: true };
  // A mic function, taking the mic itself rather than its number.
  type OnMic<F> = F extends (deviceId: number, ...args: infer A) => infer R
    ? (mic: Mic, ...args: A) => R
    : never;
  const native: Pick<
    NativeAudio,
    | "inputDevices"
    | "outputDevices"
    | "asioStatus"
    | "setOutputDevice"
    | "outputOptions"
    | "outputFormat"
    | "outputStatus"
    | "setMicMode"
    | "linuxAudio"
  > & {
    // Throws "Access is denied (os error 5)" when the process has one.
    allocConsole: () => void;
    inputDevice_new: (name: string, channelSelection: number) => Mic;
    inputDevice_setGain: OnMic<NativeAudio["inputDevice_setGain"]>;
    inputDevice_setEcho: OnMic<NativeAudio["inputDevice_setEcho"]>;
    inputDevice_setGate: OnMic<NativeAudio["inputDevice_setGate"]>;
    inputDevice_status: OnMic<NativeAudio["inputDevice_status"]>;
    inputDevice_format: OnMic<NativeAudio["inputDevice_format"]>;
    inputDevice_level: OnMic<NativeAudio["inputDevice_level"]>;
    inputDevice_getPitch: OnMic<NativeAudio["inputDevice_getPitch"]>;
    inputDevice_stop: OnMic<NativeAudio["inputDevice_stop"]>;
  };
  export default native;
  export type { Mic };
}

// The values Vite puts in import.meta.env (only the ones used).
interface ImportMetaEnv {
  // True on the dev server (yarn dev), false in a build.
  readonly DEV: boolean;
  // "1" builds the remote's /dev/ui review page into a production build, for
  // screenshots (see tests/e2e/screenshots.spec.ts).
  readonly VITE_KARAFRIENDS_DEV_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
