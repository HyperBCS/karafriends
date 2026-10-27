// Runs on Node's test runner through tsx (yarn test:unit). The DAM and
// Joysound clients talk to a local server that records what they send.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { ApiError } from "./api";
import { MinseiAPI } from "./damApi";
import { formBody } from "./http";
import { JoysoundAPI } from "./joysoundApi";

// What a phone might type, and what a config.yaml password might hold.
const AWKWARD = "C&K 1+1=2 100% 米津玄師 a%2Fb";

// The parts of a sound-cafe.jp song page that getSongDetail reads.
const SONG_PAGE = `
  <div class="flex items-center w-full border-b border-gray">Lemon</div>
  <div class="flex items-center w-full border-b border-gray">米津玄師</div>
  <div class="flex items-center w-full border-b border-gray">ドラマ「アンナチュラル」主題歌</div>
  <div class="flex items-center w-full border-b select-none border-gray">夢ならばどれほどよかったでしょう</div>
`;

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
      if (req.url?.startsWith("/songdetail/")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SONG_PAGE);
        return;
      }
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

  test("fetches a song's page by its number", async () => {
    const detail = await joysound.getSongDetail("425691");
    assert.equal(detail.name, "Lemon");
    assert.equal(detail.artistName, "米津玄師");
    assert.deepEqual(
      received.map(({ url }) => url),
      ["/songdetail/425691"],
    );
  });

  test("lists an artist's songs by its ID", async () => {
    await joysound.getSongListByArtist("232873", 0, 20);
    assert.equal(
      new URLSearchParams(received[0].body).get("artistId"),
      "232873",
    );
  });

  for (const id of ["../mypage/whatever", "425691?x=1", "1&count=999", ""]) {
    test(`refuses ${JSON.stringify(id)} as an ID, sending nothing`, async () => {
      const isBadInput = (err: unknown) =>
        err instanceof ApiError && err.status === 400;
      await assert.rejects(joysound.getSongDetail(id), isBadInput);
      await assert.rejects(joysound.getSongListByArtist(id, 0, 20), isBadInput);
      await assert.rejects(joysound.getSongRawData(id), isBadInput);
      await assert.rejects(joysound.getMovieUrls(id), isBadInput);
      assert.deepEqual(received, []);
    });
  }
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
