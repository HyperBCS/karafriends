// Runs on Node's test runner through tsx (yarn test:unit). The DAM and
// Joysound clients talk to a local server that records what they send.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { MinseiAPI } from "./damApi";
import { formBody } from "./http";
import { JoysoundAPI } from "./joysoundApi";

// What a phone might type, and what a config.yaml password might hold.
const AWKWARD = "C&K 1+1=2 100% 米津玄師 a%2Fb";

let server: http.Server;
let base: string;
const received: { url: string; body: string }[] = [];

before(async () => {
  // The clients log each request (with credentials) for debugging.
  mock.method(console, "debug", () => {});
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        req.url?.startsWith("/cwa/")
          ? JSON.stringify({ statusCode: "0000", status: "OK", message: "" })
          : "[]",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  mock.restoreAll();
  server.close();
});

beforeEach(() => {
  received.length = 0;
});

describe("formBody", () => {
  test("keeps each value whole, whatever it holds", () => {
    const fields = { keyword: AWKWARD, "a&b": "=", empty: "" };
    const body = formBody(fields);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), fields);
    assert.equal(body.split("&").length, 3);
  });

  test("leaves plain values as they are", () => {
    assert.equal(
      formBody({ songNumber: "425691", serviceType: "003000761" }),
      "songNumber=425691&serviceType=003000761",
    );
  });
});

describe("JoysoundAPI", () => {
  const joysound = new JoysoundAPI(async () => ({
    cookies: {},
    csrfToken: "token",
  }));

  before(() => {
    joysound.baseURL = base;
  });

  test("sends a search term as one form value", async () => {
    await joysound.getSongListByKeyword(AWKWARD, 0, 20);
    await joysound.getArtistListByKeyword(AWKWARD, 0, 20);
    assert.equal(received.length, 2);
    for (const { body } of received) {
      const form = new URLSearchParams(body);
      assert.equal(form.get("keyword"), AWKWARD);
      assert.equal(form.get("count"), "20");
      assert.deepEqual(
        [...form.keys()],
        ["keyword", "match", "sort", "order", "start", "count"],
      );
    }
  });
});

describe("MinseiAPI", () => {
  const minsei = new MinseiAPI(async () => ({
    userCode: "user",
    authToken: AWKWARD,
  }));

  before(() => {
    minsei.baseURL = base;
  });

  test("sends the fixed fields as before and encodes the rest", async () => {
    await minsei.getMusicStreamingUrls("3246-51");
    assert.equal(received.length, 1);
    const { body } = received[0];
    // Byte for byte what the app has always sent, compAuthKey unencoded.
    assert.ok(
      body.startsWith(
        "charset=UTF-8&compAuthKey=2/Qb9R@8s*&compId=1&deviceId=22&format=json&serviceId=1&contractId=1&",
      ),
      body,
    );
    const form = new URLSearchParams(body);
    assert.equal(form.get("requestNo"), "3246-51");
    assert.equal(form.get("userCode"), "user");
    assert.equal(form.get("authToken"), AWKWARD);
  });
});
