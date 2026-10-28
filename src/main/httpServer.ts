// The HTTP server on the remocon port: the phone remote's pages and the API
// (server.ts), for the phones. The display uses IPC instead (ipc.ts).
//
// No Electron imports, so unit tests can load this file under plain Node.
import { createServer, type Server } from "http";

import type { Application } from "express";

export interface ListenOptions {
  port: number;
  // Where to listen: undefined for every interface.
  host?: string;
}

// onProblem gets a sentence for the display when phones can't connect.
export function startHttpServer(
  app: Application,
  { port, host }: ListenOptions,
  onProblem: (message: string) => void,
): Server {
  const httpServer = createServer(app);

  // The server is an EventEmitter: an unhandled "error" event (most commonly
  // the port already being in use, by another karafriends, say) would crash
  // the whole app. Only phones need the server, so keep the display going,
  // and say why phones can't connect.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    const message =
      err.code === "EADDRINUSE"
        ? `Phones can't connect: port ${port} is in use. ` +
          "Close whatever is using it (another karafriends?) and restart karafriends."
        : `Phones can't connect: the server on port ${port} failed (${err.code ?? err.message}).`;
    console.warn(message, err);
    onProblem(message);
  });

  // No "upgrade" listener: Node then hands a WebSocket upgrade (nothing
  // here speaks it) to the app like any request, which answers it as one.
  httpServer.listen(port, host, () => {
    console.log(`Server is now running on http://localhost:${port}`);
  });

  return httpServer;
}
