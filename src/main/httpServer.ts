// The HTTP server on the remocon port: the phone remote's pages and the API
// (server.ts), for the phones. The display uses IPC instead (ipc.ts).
//
// No Electron imports, so unit tests can load this file under plain Node.
import { createServer, type Server } from "http";
import type { Duplex } from "stream";

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

  httpServer.on("upgrade", (_req, socket) => refuseUpgrade(socket));

  httpServer.listen(port, host, () => {
    console.log(`Server is now running on http://localhost:${port}`);
  });

  return httpServer;
}

// Nothing here speaks WebSocket, so refuse upgrades, as graphql-ws did for
// any other path, instead of Node handing them to Express. (In dev, the
// remote's hot-reload socket goes to the Vite dev server, not here.)
//
// Node takes its own error handler off the socket before it emits "upgrade",
// so this one needs its own: an unhandled "error" (the phone resetting the
// connection, say) would be an uncaught exception, which ends the app (see
// index.ts). Once the answer is out, close the socket, as ws does.
export function refuseUpgrade(socket: Duplex) {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
}
