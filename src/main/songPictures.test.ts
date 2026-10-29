// Runs on Node's test runner through tsx (yarn test:unit). The song pages'
// pictures: which URLs are fetched, what is kept, and the route phones use,
// against a local server that plays the image hosts.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import express from "express";

import { NoLoginError } from "./credentials";
import {
  createSongPictures,
  fetchPicture,
  isAllowedPictureUrl,
  type SongPicture,
  songPictureRouter,
} from "./songPictures";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let server: http.Server;
let base: string;
const asked: string[] = [];

before(async () => {
  for (const level of ["warn", "error"] as const) {
    mock.method(console, level, () => {});
  }
  server = http.createServer((req, res) => {
    asked.push(req.url ?? "");
    const route = new URL(req.url ?? "/", "http://x").pathname;
    if (route === "/art.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
    } else if (route === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not an image</html>");
    } else if (route === "/huge.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(4 * 1024 * 1024),
      });
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html>missing</html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  mock.restoreAll();
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  asked.length = 0;
});

describe("isAllowedPictureUrl", () => {
  test("allows DAM's thumbnails and Amazon's and Apple's images, over https", () => {
    for (const url of [
      "https://csgw.clubdam.com/minsei/music/info/GetNewThumbnail.api?imageKey=a",
      "https://m.media-amazon.com/images/I/61w3XEkVjBL._SL500_.jpg",
      "https://images-fe.ssl-images-amazon.com/images/I/x.jpg",
      "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg",
      // A Joysound featured list's.
      "https://d24lvzvt5ynxi0.cloudfront.net/static/image/feature/thumbnail/t.png",
    ]) {
      assert.ok(isAllowedPictureUrl(url), url);
    }
  });

  test("refuses anything else", () => {
    for (const url of [
      "http://m.media-amazon.com/images/I/x.jpg",
      "https://example.com/x.png",
      "https://evilmzstatic.com/x.png",
      // Another CloudFront distribution than sound-cafe's.
      "https://d111111abcdef8.cloudfront.net/x.png",
      "https://mzstatic.com.example.com/x.png",
      "https://127.0.0.1/x.png",
      "not a url",
    ]) {
      assert.ok(!isAllowedPictureUrl(url), url);
    }
  });
});

describe("fetchPicture", () => {
  test("fetches an image", async () => {
    assert.deepEqual(await fetchPicture(`${base}/art.png`), {
      contentType: "image/png",
      data: PNG,
    });
  });

  test("refuses a page, a missing image and a huge one, without naming the URL", async () => {
    for (const [path, why] of [
      ["/page?compAuthKey=SECRET", /isn't an image \(text\/html\)/],
      ["/missing.png?compAuthKey=SECRET", /404 from the song's picture/],
      ["/huge.png?compAuthKey=SECRET", /too big/],
    ] as const) {
      const err = await fetchPicture(`${base}${path}`).then(
        () => assert.fail(`${path} was taken`),
        (failure: Error) => failure,
      );
      assert.match(err.message, why);
      assert.ok(!err.message.includes("SECRET"), err.message);
    }
  });
});

describe("createSongPictures", () => {
  const picture = (bytes: number): SongPicture => ({
    contentType: "image/jpeg",
    data: Buffer.alloc(bytes, 1),
  });
  const ART = "https://m.media-amazon.com/images/I/art._SL500_.jpg";

  function setUp(lookUp = async (): Promise<string | null> => ART) {
    const lookUps: string[] = [];
    const fetches: string[] = [];
    const pictures = createSongPictures({
      lookUp: async (kind, id) => {
        lookUps.push(`${kind}:${id}`);
        return lookUp();
      },
      fetch: async (url) => {
        fetches.push(url);
        return picture(100);
      },
      maxBytes: 250,
    });
    return { pictures, lookUps, fetches };
  }

  test("uses the URL the song page's lookup left, without looking up again", async () => {
    const { pictures, lookUps, fetches } = setUp();
    pictures.remember("joysound", "425691", ART);
    assert.equal((await pictures.get("joysound", "425691"))?.data.length, 100);
    assert.deepEqual(lookUps, []);
    assert.deepEqual(fetches, [ART]);
  });

  test("looks the song up when nothing was left, and keeps the picture", async () => {
    const { pictures, lookUps, fetches } = setUp();
    await pictures.get("dam", "3246-51");
    await pictures.get("dam", "3246-51");
    assert.deepEqual(lookUps, ["dam:3246-51"]);
    assert.equal(fetches.length, 1);
  });

  test("two phones on one song fetch it once", async () => {
    const { pictures, fetches } = setUp();
    await Promise.all([
      pictures.get("joysound", "1"),
      pictures.get("joysound", "1"),
    ]);
    assert.equal(fetches.length, 1);
  });

  test("a song without a picture, or with one from elsewhere, has none", async () => {
    const { pictures, fetches } = setUp(async () => null);
    assert.equal(await pictures.get("joysound", "1"), null);
    pictures.remember("joysound", "2", "https://example.com/x.jpg");
    assert.equal(await pictures.get("joysound", "2"), null);
    assert.deepEqual(fetches, []);
  });

  test("keeps the most recently used pictures, up to maxBytes", async () => {
    const { pictures, fetches } = setUp();
    // 100 bytes each, 250 at most: two are kept.
    await pictures.get("joysound", "1");
    await pictures.get("joysound", "2");
    await pictures.get("joysound", "1");
    await pictures.get("joysound", "3");
    fetches.length = 0;
    await pictures.get("joysound", "1");
    await pictures.get("joysound", "3");
    assert.deepEqual(fetches, []);
    await pictures.get("joysound", "2");
    assert.equal(fetches.length, 1);
  });

  test("a failure isn't kept: the next try fetches again", async () => {
    let fail = true;
    const pictures = createSongPictures({
      lookUp: async () => ART,
      fetch: async () => {
        if (fail) throw new Error("no answer");
        return picture(10);
      },
    });
    await assert.rejects(pictures.get("dam", "3246-51"), /no answer/);
    fail = false;
    assert.ok(await pictures.get("dam", "3246-51"));
  });
});

describe("songPictureRouter", () => {
  let app: http.Server;
  let url: string;
  let get: (kind: string, id: string) => Promise<SongPicture | null>;

  before(async () => {
    const router = songPictureRouter({
      remember: () => {},
      get: (kind, id) => get(kind, id),
    });
    app = express().use("/api/songPicture", router).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => app.once("listening", resolve));
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/songPicture`;
  });

  after(() => {
    app.closeAllConnections();
    app.close();
  });

  test("sends the picture, for phones to keep a day", async () => {
    get = async () => ({ contentType: "image/png", data: PNG });
    const res = await fetch(`${url}/dam/3246-51`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  test("refuses what isn't a DAM or Joysound song, asking nothing", async () => {
    let asks = 0;
    get = async () => {
      asks++;
      return null;
    };
    for (const path of ["/youtube/abc", "/dam/425691", "/joysound/3246-51"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 400, path);
    }
    assert.equal(asks, 0);
  });

  test("404 for a song without a picture, or without a login for its catalogue", async () => {
    get = async () => null;
    assert.equal((await fetch(`${url}/joysound/425691`)).status, 404);
    get = async () => {
      throw new NoLoginError("Joysound");
    };
    assert.equal((await fetch(`${url}/joysound/425691`)).status, 404);
  });

  test("502 when the picture couldn't be fetched", async () => {
    get = async () => {
      throw new Error("no answer");
    };
    assert.equal((await fetch(`${url}/dam/3246-51`)).status, 502);
  });
});
