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
