// Runs on Node's test runner through tsx (yarn test:unit), against a local
// HTTP server that answers slowly or not at all.
import assert from "node:assert/strict";
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { getSetCookies, http as httpGet, httpFetch } from "./http";

const TIMEOUT_MS = 300;

// Each route writes its answer to res.
const routes: Record<string, (res: ServerResponse) => Promise<void> | void> = {
  // A body that takes 4 timeouts to arrive, but never pauses for one.
  "/slow-body": async (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const chunks = JSON.stringify({ ogg: "x".repeat(4000) }).match(
      /[^]{1,250}/g,
    )!;
    const pause = (4 * TIMEOUT_MS) / chunks.length;
    for (const chunk of chunks) {
      res.write(chunk);
      await sleep(pause);
    }
    res.end();
  },
  // Headers and the start of a body, then nothing.
  "/stalled-body": (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ogg": "');
  },
  // Never answers.
  "/no-headers": () => {},
  "/cookies": (res) => {
    res.writeHead(302, {
      Location: "/elsewhere",
      "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
    });
    res.end("moved");
  },
};

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    void routes[req.url ?? ""]?.(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("httpFetch's timeout", () => {
  test("lets a slow body finish as long as it keeps arriving", async () => {
    const started = Date.now();
    const body = await httpGet<{ ogg: string }>(`${base}/slow-body`, {
      timeoutMs: TIMEOUT_MS,
    });
    assert.equal(body.ogg.length, 4000);
    assert.ok(Date.now() - started > 2 * TIMEOUT_MS, "the body was slow");
  });

  test("fails a body that stops arriving", async () => {
    const started = Date.now();
    await assert.rejects(
      httpGet(`${base}/stalled-body`, { timeoutMs: TIMEOUT_MS }),
      /sent nothing for 300ms/,
    );
    assert.ok(Date.now() - started < 5 * TIMEOUT_MS);
  });

  test("fails a request that gets no headers", async () => {
    const started = Date.now();
    await assert.rejects(
      httpFetch(`${base}/no-headers`, { timeoutMs: TIMEOUT_MS }),
      /No answer from .* within 300ms/,
    );
    assert.ok(Date.now() - started < 5 * TIMEOUT_MS);
  });

  test("keeps the response's status, headers and cookies", async () => {
    const resp = await httpFetch(`${base}/cookies`, {
      redirect: "manual",
      timeoutMs: TIMEOUT_MS,
    });
    assert.equal(resp.status, 302);
    assert.equal(resp.url, `${base}/cookies`);
    assert.equal(resp.headers.get("Location"), "/elsewhere");
    assert.deepEqual(getSetCookies(resp), ["a=1; Path=/", "b=2; Path=/"]);
    assert.equal(await resp.text(), "moved");
  });

  test("lets a body go unread without an error", async () => {
    const resp = await httpFetch(`${base}/cookies`, {
      redirect: "manual",
      timeoutMs: TIMEOUT_MS,
    });
    // Nothing reads it, and nothing throws.
    await sleep(2 * TIMEOUT_MS);
    assert.equal(resp.status, 302);
  });
});
