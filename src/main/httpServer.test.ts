// Runs on Node's test runner through tsx (yarn test:unit). A real server on a
// free port, with a stub app.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import express from "express";

import { startHttpServer } from "./httpServer";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.get("/", (_req, res) => {
    res.send("ok");
  });
  server = startHttpServer(app, { port: 0, host: "127.0.0.1" }, () => {});
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// Asks to upgrade to WebSocket, reads the answer, then resets the connection
// (a TCP RST) instead of closing it.
async function upgradeThenReset(): Promise<string> {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  let answer = "";
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (data) => {
      answer += data;
      if (answer.includes("\r\n\r\n")) resolve();
    });
    socket.write(
      "GET / HTTP/1.1\r\nHost: karafriends\r\n" +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
  socket.resetAndDestroy();
  return answer;
}

test("a WebSocket upgrade is refused, and a reset after it crashes nothing", async () => {
  // An unhandled socket error would end the app (see index.ts).
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    for (let i = 0; i < 5; i++) {
      assert.match(await upgradeThenReset(), /^HTTP\/1\.1 400 Bad Request\r\n/);
    }
    // Give the resets time to arrive.
    await sleep(200);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught, []);
  // And the server still answers.
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await res.text(), "ok");
});
