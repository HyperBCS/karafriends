// The HTTP server on the remocon port: the phone remote's pages and the API
// (server.ts), for the phones and, until Phase 5f, the display.
import { createServer, type Server } from "http";

import { app as electronApp, dialog } from "electron";
import type { Application } from "express";

import karafriendsConfig, { LOCAL_ONLY } from "../common/config";

export function startHttpServer(app: Application): Server {
  const httpServer = createServer(app);

  // The server is an EventEmitter: an unhandled "error" event (most commonly
  // the remocon port already being in use) would otherwise crash the whole app
  // with a bare stack trace. Fail loudly with a clear message and quit cleanly.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      dialog.showErrorBox(
        "karafriends: port already in use",
        `Port ${karafriendsConfig.remoconPort} is already in use. ` +
          "Is karafriends already running? Close the other instance " +
          "(or free the port) and relaunch.",
      );
    } else {
      console.error("HTTP server error:", err);
    }
    electronApp.quit();
  });

  // Nothing here speaks WebSocket, so refuse upgrades, as graphql-ws did for
  // any other path. Otherwise Node hands them to Express, and in dev the
  // remote's proxy to Parcel fails on the HMR socket Parcel's client opens.
  httpServer.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  // LOCAL_ONLY (tests and checks): this machine only, so no firewall prompt.
  const host = LOCAL_ONLY ? "127.0.0.1" : undefined;
  httpServer.listen(karafriendsConfig.remoconPort, host, () => {
    console.log(
      `Server is now running on http://localhost:${karafriendsConfig.remoconPort}`,
    );
  });

  return httpServer;
}
