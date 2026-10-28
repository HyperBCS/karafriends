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

// An image's URL.
declare module "*.png" {
  const url: string;
  export default url;
}

// A native module: copied next to the main or preload bundle and loaded with
// require().
declare module "*.node" {
  const native: any;
  export default native;
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
