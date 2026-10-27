// The HTTP server on the remocon port: the phone remote's pages and the API
// (server.ts), for the phones. The display uses IPC instead (ipc.ts).
import { createServer, type Server } from "http";

import type { Application } from "express";

import karafriendsConfig, { LOCAL_ONLY } from "../common/config";

// onProblem gets a sentence for the display when phones can't connect.
export function startHttpServer(
  app: Application,
  onProblem: (message: string) => void,
): Server {
  const httpServer = createServer(app);
  const port = karafriendsConfig.remoconPort;

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

  // Nothing here speaks WebSocket, so refuse upgrades, as graphql-ws did for
  // any other path, instead of Node handing them to Express. (In dev, the
  // remote's hot-reload socket goes to the Vite dev server, not here.)
  httpServer.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  // LOCAL_ONLY (tests and checks): this machine only, so no firewall prompt.
  const host = LOCAL_ONLY ? "127.0.0.1" : undefined;
  httpServer.listen(port, host, () => {
    console.log(`Server is now running on http://localhost:${port}`);
  });

  return httpServer;
}
