// The display window's side of the API, over Electron IPC (channels in
// src/common/ipc.ts): the same validators and handlers as POST /api/<method>,
// with the display as the caller (an admin), and the live events pushed to
// it. Only the display window's own page may use it.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { LiveEvent } from "../common/api";
import { IPC_CHANNELS, type ApiResponse } from "../common/ipc";
import type { ApiHandlers, Caller } from "./api";
import { errorAnswer, isMethod, runMethod } from "./dispatch";
import type { LiveHub } from "./live";

// The parts of Electron's WebContents used here.
export interface DisplayContents {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

// Who sent an IPC message: the parts of Electron's IpcMainEvent and
// IpcMainInvokeEvent used here.
export interface IpcSource {
  sender: unknown;
  senderFrame: { parent: unknown; url: string } | null;
}

export interface DisplayIpcOptions {
  handlers: ApiHandlers;
  hub: LiveHub;
  // The display window's web contents, while it is open.
  display: () => DisplayContents | null;
  // The address the display window loads.
  displayUrl: string;
}

// The display has no device or nickname, and is always an admin.
export const DISPLAY_CALLER: Caller = {
  deviceId: null,
  nickname: null,
  adminToken: null,
  isDisplay: true,
};

// Whether url is on the same site as the display's page: same scheme, host
// and port (any file, for a file: URL), so not a page the window was
// navigated to.
export function sameSite(url: string, displayUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(displayUrl);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

export function createDisplayIpc({
  handlers,
  hub,
  display,
  displayUrl,
}: DisplayIpcOptions) {
  // The display window's main frame, showing the display's page.
  const isFromDisplay = (source: IpcSource): boolean => {
    const contents = display();
    const frame = source.senderFrame;
    return (
      contents !== null &&
      source.sender === contents &&
      frame !== null &&
      frame.parent === null &&
      sameSite(frame.url, displayUrl)
    );
  };

  const refuse = (what: string, source: IpcSource) =>
    console.warn(
      `Refused ${what} over IPC from ${source.senderFrame?.url ?? "a gone frame"}: not the display`,
    );

  let remoconProblem: string | null = null;
  let stopLive: (() => void) | null = null;
  const endLive = () => {
    stopLive?.();
    stopLive = null;
  };

  return {
    isFromDisplay,

    // ipcMain.handle(IPC_CHANNELS.call): never throws, so the renderer gets
    // the status and message as data (see ApiResponse).
    async call(
      source: IpcSource,
      method: unknown,
      input: unknown,
    ): Promise<ApiResponse> {
      if (!isFromDisplay(source)) {
        refuse(`an API call (${String(method)})`, source);
        return {
          ok: false,
          status: 403,
          error: "Only the display window may call the API over IPC",
        };
      }
      if (!isMethod(method)) {
        return {
          ok: false,
          status: 404,
          error: `No API method ${String(method)}`,
        };
      }
      try {
        const output = await runMethod(handlers, method, input, DISPLAY_CALLER);
        return { ok: true, output } as ApiResponse;
      } catch (err) {
        return { ok: false, ...errorAnswer(err, `IPC ${method}`) };
      }
    },

    // ipcMain.on(IPC_CHANNELS.liveSubscribe): the display's page asks once
    // each time it loads. It gets the live state at once, then every event.
    // A new page's subscription replaces the last page's.
    subscribeLive(source: IpcSource & { sender: DisplayContents }) {
      if (!isFromDisplay(source)) {
        refuse("live events", source);
        return;
      }
      endLive();
      const contents = source.sender;
      stopLive = hub.subscribe(
        (event: LiveEvent) => {
          if (!contents.isDestroyed()) contents.send(IPC_CHANNELS.live, event);
        },
        { deviceId: null, isDisplay: true },
      );
    },

    // The display window closed.
    endLive,

    // The remote's server can't take connections (its port is taken, say),
    // so phones can't connect. The display works without it, so tell it.
    reportRemoconProblem(message: string) {
      remoconProblem = message;
      const contents = display();
      if (contents && !contents.isDestroyed()) {
        contents.send(IPC_CHANNELS.remoconProblem, message);
      }
    },

    // ipcMain.handle(IPC_CHANNELS.remoconProblem): the display's page asks as
    // it loads, since the problem usually comes first.
    remoconProblem(source: IpcSource): string | null {
      return isFromDisplay(source) ? remoconProblem : null;
    },
  };
}

export type DisplayIpc = ReturnType<typeof createDisplayIpc>;
