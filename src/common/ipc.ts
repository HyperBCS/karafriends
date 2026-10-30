// The display window's API transport: Electron IPC through its preload
// (src/preload/index.ts), instead of HTTP. Same methods, handlers and live
// events as POST /api/<method> and GET /api/events (see api.ts); only phones
// use HTTP.
//
// Types and constants only, so the main process, the preload and the renderer
// can all import it.
import type { AboutText } from "./about";
import type { ApiInput, ApiMethod, ApiOutput, LiveEvent } from "./api";

export const IPC_CHANNELS = {
  // invoke(method, input) -> ApiResponse
  call: "api",
  // send(): the display's preload asks for the live events once per page
  // load. The main process then sends the live state at once, as a new
  // /api/events stream does, and every event after it.
  liveSubscribe: "live:subscribe",
  // main -> display: one LiveEvent
  live: "live",
  // invoke(suggestedName, text) -> boolean: a save dialog, then the file
  // written (Export config).
  saveTextFile: "file:saveText",
  // invoke() -> string | null: an open dialog, then the file read (Import
  // config).
  openTextFile: "file:openText",
  // invoke(AboutText) -> string | null: karafriends' license or the
  // third-party notices, as the build put them beside the bundles; null
  // if this build has none (yarn dev).
  readAboutText: "about:readText",
  // invoke(): karafriends' source (SOURCE_URL) in the system's browser.
  openSource: "about:openSource",
  // invoke() -> boolean: whether the display's window is in full screen.
  isFullScreen: "window:isFullScreen",
  // main -> display: boolean, whenever the window goes in or out of full
  // screen (F11, say).
  fullScreen: "window:fullScreen",
  // invoke(): asks the host in a dialog, then quits karafriends if they
  // say so (Settings' Quit button).
  quit: "app:quit",
} as const;

// window.karafriends's file dialogs, in the display window.
export interface DisplayFiles {
  // Asks where to save, suggesting suggestedName in the Documents folder,
  // and writes text there as UTF-8. False if the host canceled; rejects if
  // the file can't be written.
  saveTextFile(suggestedName: string, text: string): Promise<boolean>;
  // Asks for a .yaml file and reads it as UTF-8. Null if the host canceled.
  openTextFile(): Promise<string | null>;
}

// window.karafriends.about: About in the display's Settings (see
// src/common/about.ts).
export interface DisplayAbout {
  // karafriends' version, from the main process.
  version(): string;
  readText(which: AboutText): Promise<string | null>;
  openSource(): Promise<void>;
}

// window.karafriends.fullScreen: whether the display's window is in full
// screen, which the page can't tell by itself (the window's, not the
// page's, so document.fullscreenElement stays null).
export interface DisplayFullScreen {
  // Calls listener with whether it is, once known, and at every change.
  // Returns a function that stops it.
  onChange(listener: (fullScreen: boolean) => void): () => void;
}

// The display window's command-line switch (webPreferences
// .additionalArguments) with the phones' server port, which the preload
// reads: --karafriends-remocon-port=8080.
export const REMOCON_PORT_ARG = "--karafriends-remocon-port=";

// The same, with karafriends' version (app.getVersion()), for About:
// --karafriends-version=0.2.0.
export const VERSION_ARG = "--karafriends-version=";

// What the preload's call() resolves with. The status and error are what the
// HTTP API answers with (403 and its message, say). Failures come back as
// data because an Error's own properties don't survive the context bridge.
export type ApiResponse<M extends ApiMethod = ApiMethod> =
  | { ok: true; output: ApiOutput<M> }
  | { ok: false; status: number; error: string };

// window.karafriends.api in the display window.
export interface DisplayApi {
  call<M extends ApiMethod>(
    method: M,
    input: ApiInput<M>,
  ): Promise<ApiResponse<M>>;
  // Calls listener with the live state at once, then with every event.
  // Returns a function that stops it.
  onLive(listener: (event: LiveEvent) => void): () => void;
}
