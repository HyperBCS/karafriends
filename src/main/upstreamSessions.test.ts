// Runs on Node's test runner through tsx (yarn test:unit). How the DAM and
// Joysound clients retry, log in again and fail, against a local server that
// plays sound-cafe or DAM. The logins are fakes, kept by the app's own
// memoizeSuccess.
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { memoizeSuccess, NoLoginError } from "./credentials";
import { MinseiAPI } from "./damApi";
import { HttpStatusError } from "./http";
import { JoysoundAPI } from "./joysoundApi";

// Retries without the waits.
const FAST = { retries: 3, minTimeoutMs: 1, maxTimeoutMs: 1 };

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: http.Server;
let base: string;
let handle: Handler;
const received: { url: string; cookie: string; body: string }[] = [];

const json = (res: ServerResponse, value: unknown, headers = {}) => {
  res.writeHead(200, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};
const status = (res: ServerResponse, code: number) => {
  res.writeHead(code, { "Content-Type": "text/html" });
  res.end("<html>error</html>");
};
const loginPage = (res: ServerResponse) => {
  res.writeHead(302, { Location: "/login" });
  res.end();
};

before(async () => {
  // The clients log each request, and each failure, for debugging.
  for (const level of ["debug", "log", "warn", "error"] as const) {
    mock.method(console, level, () => {});
  }
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/login") {
        // Where a lost session ends up: sound-cafe's login form.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end('<html><meta name="_csrf" content="anon" /></html>');
        return;
      }
      received.push({
        url: req.url ?? "",
        cookie: req.headers.cookie ?? "",
        body,
      });
      handle(req, res);
    });
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
  received.length = 0;
  handle = (_req, res) => json(res, {});
});

// Sessions s1, s2, ...: each login makes the next.
function joysoundLogins() {
  const logins: string[] = [];
  const session = memoizeSuccess(async () => {
    logins.push(`s${logins.length + 1}`);
    return { cookies: { JSESSIONID: logins.at(-1)! }, csrfToken: "token" };
  });
  return { logins, session };
}

function joysoundWith(session: ConstructorParameters<typeof JoysoundAPI>[0]) {
  const joysound = new JoysoundAPI(session);
  joysound.baseURL = base;
  joysound.retryPolicy = FAST;
  return joysound;
}

const SONG = {
  slc: "",
  telop: "dGVsb3A=",
  ogg: "b2dn",
  streaming_wifi_url: "",
};

describe("JoysoundAPI's downloads", () => {
  test("try a 5xx again, a few times at most", async () => {
    const { session } = joysoundLogins();
    const joysound = joysoundWith(session);
    let calls = 0;
    handle = (_req, res) => (++calls < 3 ? status(res, 503) : json(res, SONG));
    assert.deepEqual(await joysound.getSongRawData("425691"), SONG);
    assert.equal(received.length, 3);

    received.length = 0;
    handle = (_req, res) => status(res, 500);
    await assert.rejects(
      joysound.getMovieUrls("425691"),
      (err) => err instanceof HttpStatusError && err.status === 500,
    );
    // The first try and 3 more.
    assert.equal(received.length, 4);
  });

  test("try a dropped connection again, a few times at most", async () => {
    const { session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (req) => req.socket.destroy();
    await assert.rejects(joysound.getSongRawData("425691"));
    assert.equal(received.length, 4);
  });

  test("fail a 4xx at once", async () => {
    const { session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 404);
    await assert.rejects(
      joysound.getSongRawData("425691"),
      (err) => err instanceof HttpStatusError && err.status === 404,
    );
    assert.equal(received.length, 1);
  });

  test("fail a refused login at once, logging in once", async () => {
    let logins = 0;
    const joysound = joysoundWith(
      memoizeSuccess(async () => {
        logins++;
        throw new Error("Joysound login rejected (result 1)");
      }),
    );
    await assert.rejects(joysound.getSongRawData("425691"), /rejected/);
    assert.equal(logins, 1);
    assert.equal(received.length, 0);
  });

  test("fail a login from outside Japan at once", async () => {
    let logins = 0;
    const joysound = joysoundWith(
      memoizeSuccess(async () => {
        logins++;
        throw new HttpStatusError(403, "https://www.sound-cafe.jp/login");
      }),
    );
    await assert.rejects(
      joysound.getMovieUrls("425691"),
      (err) => err instanceof HttpStatusError && err.status === 403,
    );
    assert.equal(logins, 1);
  });

  test("log in again once when the session has ended", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    // s1 ends after its first song: sound-cafe sends it to the login page.
    handle = (req, res) =>
      req.headers.cookie === "JSESSIONID=s1" && received.length > 1
        ? loginPage(res)
        : json(res, SONG);
    assert.deepEqual(await joysound.getSongRawData("425691"), SONG);
    assert.deepEqual(await joysound.getSongRawData("425691"), SONG);
    assert.deepEqual(logins, ["s1", "s2"]);
    assert.deepEqual(
      received.map(({ cookie }) => cookie),
      ["JSESSIONID=s1", "JSESSIONID=s1", "JSESSIONID=s2"],
    );
    // And s2 is kept.
    await joysound.getSongRawData("425691");
    assert.deepEqual(logins, ["s1", "s2"]);
  });

  test("give up after one new login that doesn't help", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 403);
    await assert.rejects(joysound.getSongRawData("425691"), /session/);
    assert.deepEqual(logins, ["s1", "s2"]);
    assert.equal(received.length, 2);
  });

  test("a page where data was expected counts as a lost session", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (req, res) => {
      if (req.headers.cookie === "JSESSIONID=s1") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Please log in</html>");
      } else {
        json(res, SONG);
      }
    };
    assert.deepEqual(await joysound.getSongRawData("425691"), SONG);
    assert.deepEqual(logins, ["s1", "s2"]);
  });

  test("two requests on the same dead session log in again once", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (req, res) =>
      req.headers.cookie === "JSESSIONID=s1" ? loginPage(res) : json(res, SONG);
    await Promise.all([
      joysound.getSongRawData("425691"),
      joysound.getMovieUrls("425691"),
    ]);
    assert.deepEqual(logins, ["s1", "s2"]);
  });

  test("keep the cookies sound-cafe sets on the session", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (_req, res) =>
      json(res, SONG, { "Set-Cookie": "XSRF-TOKEN=renewed; Path=/" });
    await joysound.getSongRawData("425691");
    await joysound.getSongRawData("425691");
    assert.equal(received[1].cookie, "JSESSIONID=s1; XSRF-TOKEN=renewed");
    assert.deepEqual(logins, ["s1"]);
  });
});

describe("JoysoundAPI's lookups", () => {
  const lookups = (joysound: JoysoundAPI) => [
    joysound.getSongListByKeyword("lemon", 1, 20),
    joysound.getArtistListByKeyword("lemon", 1, 20),
    joysound.getSongListByArtist("232873", 1, 20),
    joysound.getSongDetail("425691"),
  ];

  test("reject when sound-cafe fails, without trying again", async () => {
    const { session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 500);
    const results = await Promise.allSettled(lookups(joysound));
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected", "rejected", "rejected"],
    );
    assert.equal(received.length, 4);
  });

  test("reject when the login fails, instead of a song called 'Error'", async () => {
    const joysound = joysoundWith(async () => {
      throw new Error("Joysound login rejected (result 1)");
    });
    for (const result of await Promise.allSettled(lookups(joysound))) {
      assert.equal(result.status, "rejected");
      assert.match(String(result.reason), /rejected/);
    }
  });

  test("log in again once when the session has ended", async () => {
    const { logins, session } = joysoundLogins();
    const joysound = joysoundWith(session);
    handle = (req, res) =>
      req.headers.cookie === "JSESSIONID=s1" ? loginPage(res) : json(res, []);
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), []);
    assert.deepEqual(logins, ["s1", "s2"]);
  });

  test("answer no results without a request when no login is set", async () => {
    const joysound = joysoundWith(async () => {
      throw new NoLoginError("Joysound");
    });
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), []);
    assert.deepEqual(await joysound.getArtistListByKeyword("lemon", 1, 20), []);
    assert.deepEqual(await joysound.getSongListByArtist("232873", 1, 20), []);
    await assert.rejects(
      joysound.getSongDetail("425691"),
      (err) => err instanceof NoLoginError && err.status === 409,
    );
    assert.equal(received.length, 0);
  });
});

// DAM's sessions are tokens t1, t2, ...
function damLogins() {
  const logins: string[] = [];
  const session = memoizeSuccess(async () => {
    logins.push(`t${logins.length + 1}`);
    return { userCode: "user", authToken: logins.at(-1)! };
  });
  return { logins, session };
}

function minseiWith(session: ConstructorParameters<typeof MinseiAPI>[0]) {
  const minsei = new MinseiAPI(session);
  minsei.baseURL = base;
  minsei.retryPolicy = FAST;
  return minsei;
}

const tokenOf = (body: string) => new URLSearchParams(body).get("authToken");
const OK = { statusCode: "0000", status: "OK", message: "" };
const STREAMING = { ...OK, data: { karaokeContentsId: "1" }, list: [] };
const BAD_TOKEN = { statusCode: "9999", status: "NG", message: "bad token" };

describe("MinseiAPI", () => {
  test("logs in again once when DAM refuses the token", async () => {
    const { logins, session } = damLogins();
    const minsei = minseiWith(session);
    handle = (req, res) =>
      json(
        res,
        tokenOf(received.at(-1)!.body) === "t1" ? BAD_TOKEN : STREAMING,
      );
    assert.deepEqual(await minsei.getMusicStreamingUrls("3246-51"), STREAMING);
    assert.deepEqual(logins, ["t1", "t2"]);
  });

  test("gives up after one new login that doesn't help", async () => {
    const { logins, session } = damLogins();
    const minsei = minseiWith(session);
    handle = (_req, res) => json(res, BAD_TOKEN);
    await assert.rejects(minsei.getMusicStreamingUrls("3246-51"), /9999/);
    assert.deepEqual(logins, ["t1", "t2"]);
    assert.equal(received.length, 2);
  });

  test("tries a 5xx again, a few times at most", async () => {
    const { logins, session } = damLogins();
    const minsei = minseiWith(session);
    handle = (_req, res) => status(res, 502);
    await assert.rejects(minsei.getScoringData("3246-51"), /502/);
    assert.equal(received.length, 4);
    assert.deepEqual(logins, ["t1"]);
  });

  test("fails a refused login at once", async () => {
    let logins = 0;
    const minsei = minseiWith(
      memoizeSuccess(async () => {
        logins++;
        throw new Error("NG 1001: wrong password");
      }),
    );
    await assert.rejects(minsei.getMusicStreamingUrls("3246-51"), /1001/);
    await assert.rejects(minsei.getScoringData("3246-51"), /1001/);
    assert.equal(logins, 2);
    assert.equal(received.length, 0);
  });

  test("a song without scoring data fails at once", async () => {
    const { logins, session } = damLogins();
    const minsei = minseiWith(session);
    handle = (_req, res) => json(res, OK);
    await assert.rejects(minsei.getScoringData("3246-51"), /scoring data/);
    assert.equal(received.length, 1);
    assert.deepEqual(logins, ["t1"]);
  });

  test("scoring data comes back as bytes", async () => {
    const { session } = damLogins();
    const minsei = minseiWith(session);
    handle = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3]));
    };
    const data = await minsei.getScoringData("3246-51");
    assert.deepEqual([...new Uint8Array(data)], [1, 2, 3]);
  });

  test("sends nothing when no login is set", async () => {
    const minsei = minseiWith(async () => {
      throw new NoLoginError("DAM");
    });
    await assert.rejects(
      minsei.getMusicStreamingUrls("3246-51"),
      (err) => err instanceof NoLoginError && err.status === 409,
    );
    assert.equal(received.length, 0);
  });
});
