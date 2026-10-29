// Runs on Node's test runner through tsx (yarn test:unit). How the DAM and
// Joysound clients retry, link or log in again, and fail, against a local
// server that plays sound-cafe's TV API, its audio CDN, or DAM. The links
// and logins are fakes, kept by the app's own memoizeSuccess.
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { memoizeSuccess, NoLoginError } from "./credentials";
import { MinseiAPI, type MinseiCredentialsProvider } from "./damApi";
import { HttpStatusError } from "./http";
import { JoysoundAPI, type JoysoundLink } from "./joysoundApi";

type DamLogin = Awaited<ReturnType<MinseiCredentialsProvider>>;

// Retries without the waits.
const FAST = { retries: 3, minTimeoutMs: 1, maxTimeoutMs: 1 };

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: http.Server;
let base: string;
let handle: Handler;
const received: {
  url: string;
  linkCode: string | undefined;
  cookie: string;
  body: string;
}[] = [];
// What the clients logged.
const logged: string[] = [];

const json = (res: ServerResponse, value: unknown, headers = {}) => {
  res.writeHead(200, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};
const status = (res: ServerResponse, code: number) => {
  res.writeHead(code, { "Content-Type": "text/html" });
  res.end("<html>error</html>");
};

before(async () => {
  // The clients log each failure; kept, to check what they say.
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const linkCode = req.headers["x-linkcode"];
      received.push({
        url: req.url ?? "",
        linkCode: typeof linkCode === "string" ? linkCode : undefined,
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
  logged.length = 0;
  handle = (_req, res) => json(res, {});
});

// Links c1, c2, ...: each link makes the next, with membership()'s
// membership.
function joysoundLinks(membership: () => string | null = () => "PAID") {
  const links: string[] = [];
  const session = memoizeSuccess<JoysoundLink>(async () => {
    links.push(`c${links.length + 1}`);
    return { linkCode: links.at(-1)!, membershipType: membership() };
  });
  return { links, session };
}

function joysoundWith(session: ConstructorParameters<typeof JoysoundAPI>[0]) {
  const joysound = new JoysoundAPI(session);
  joysound.baseURL = base;
  joysound.retryPolicy = FAST;
  return joysound;
}

// A song's lyrics data, as getSongDuration and the JOY-02 check read it,
// and its audio.
const TELOP = Buffer.concat([Buffer.from("JOY-02"), Buffer.alloc(26, 1)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 2)]);
// The secret part of the signed audio URL.
const SIGNATURE = "Signature=SECRETSIGNATURE";

// getFME's answer for a paid member, as sound-cafe sends it.
const fme = (changes: object = {}) => ({
  slc: "425691",
  telop: TELOP.toString("base64"),
  th2: null,
  membershipType: "PAID",
  isFree: false,
  streaming_wifi_url: `${base}/media/425691.ogg?Expires=1&${SIGNATURE}`,
  ...changes,
});
const ogg = (res: ServerResponse) => {
  res.writeHead(200, { "Content-Type": "audio/ogg" });
  res.end(OGG);
};
const MOVIES = { slc: "425691", movie: { mov1: "https://cdn/mov1.mp4" } };

// The paths asked for, in order.
const paths = () => received.map(({ url }) => url.split("?")[0]);

// The usual sound-cafe: getFME, the audio and the videos.
function soundCafe(overrides: {
  getFme?: Handler;
  audio?: Handler;
  contentsInfo?: Handler;
}): Handler {
  return (req, res) => {
    const route = req.url?.split("?")[0];
    if (route === "/api/v1/spc/getFME") {
      return (overrides.getFme ?? ((_q, r) => json(r, fme())))(req, res);
    }
    if (route === "/media/425691.ogg") {
      return (overrides.audio ?? ((_q, r) => ogg(r)))(req, res);
    }
    if (route === "/api/v1/spc/contentsInfo") {
      return (overrides.contentsInfo ?? ((_q, r) => json(r, MOVIES)))(req, res);
    }
    status(res, 404);
  };
}

describe("JoysoundAPI's downloads", () => {
  test("decode the lyrics as they come, and fetch the audio from its URL", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({});
    const song = await joysound.getSongData("425691");
    assert.deepEqual(song, { telop: TELOP, ogg: OGG });
    assert.deepEqual(paths(), ["/api/v1/spc/getFME", "/media/425691.ogg"]);
    const [getFme, audio] = received;
    assert.deepEqual(JSON.parse(getFme.body), {
      songNumber: "425691",
      serviceType: "003000761",
      key: 0,
    });
    assert.equal(getFme.linkCode, "c1");
    // The audio's URL is signed: it gets nothing of the link's.
    assert.equal(audio.linkCode, undefined);
    assert.equal(audio.cookie, "");
  });

  test("ask for the guide-vocal version when told to", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({});
    await joysound.getSongData("425691", true);
    await joysound.getMovieUrls("425691", true);
    await joysound.getSongData("425691");
    const serviceTypes = received
      .filter(({ url }) => url.startsWith("/api/v1/spc/"))
      .map(({ url, body }) => [url, JSON.parse(body).serviceType]);
    assert.deepEqual(serviceTypes, [
      ["/api/v1/spc/getFME", "003000762"],
      ["/api/v1/spc/contentsInfo", "003000762"],
      ["/api/v1/spc/getFME", "003000761"],
    ]);
  });

  test("refuse lyrics in the website's old order", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    const base64 = TELOP.toString("base64");
    handle = soundCafe({
      getFme: (_req, res) =>
        json(res, fme({ telop: base64.slice(-30) + base64.slice(0, -30) })),
    });
    await assert.rejects(joysound.getSongData("425691"), /isn't JOY-02/);
    assert.deepEqual(paths(), ["/api/v1/spc/getFME"]);
  });

  test("refuse audio that isn't Ogg, such as an error page with 200", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({
      audio: (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Access denied</html>");
      },
    });
    await assert.rejects(
      joysound.getSongData("425691"),
      /audio for song 425691 isn't Ogg audio \(text\/html, 26 bytes\)/,
    );
    assert.deepEqual(paths(), ["/api/v1/spc/getFME", "/media/425691.ogg"]);
  });

  test("try a 5xx again, a few times at most", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    let calls = 0;
    handle = soundCafe({
      getFme: (_req, res) =>
        ++calls < 3 ? status(res, 503) : json(res, fme()),
    });
    assert.deepEqual(await joysound.getSongData("425691"), {
      telop: TELOP,
      ogg: OGG,
    });
    assert.equal(calls, 3);

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
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = (req) => req.socket.destroy();
    await assert.rejects(joysound.getSongData("425691"));
    assert.equal(received.length, 4);
  });

  test("ask getFME again when the audio fails for a while", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    let audioCalls = 0;
    handle = soundCafe({
      audio: (req, res) =>
        ++audioCalls === 1 ? req.socket.destroy() : ogg(res),
    });
    assert.deepEqual(await joysound.getSongData("425691"), {
      telop: TELOP,
      ogg: OGG,
    });
    assert.deepEqual(paths(), [
      "/api/v1/spc/getFME",
      "/media/425691.ogg",
      "/api/v1/spc/getFME",
      "/media/425691.ogg",
    ]);
  });

  test("ask once for a new audio URL when one is refused as if it had run out", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    let audioCalls = 0;
    handle = soundCafe({
      audio: (_req, res) => (++audioCalls === 1 ? status(res, 403) : ogg(res)),
    });
    assert.deepEqual(await joysound.getSongData("425691"), {
      telop: TELOP,
      ogg: OGG,
    });
    assert.equal(paths().length, 4);

    // Refused every time: one new URL, then the 403.
    received.length = 0;
    handle = soundCafe({ audio: (_req, res) => status(res, 403) });
    await assert.rejects(
      joysound.getSongData("425691"),
      (err) => err instanceof HttpStatusError && err.status === 403,
    );
    assert.deepEqual(paths(), [
      "/api/v1/spc/getFME",
      "/media/425691.ogg",
      "/api/v1/spc/getFME",
      "/media/425691.ogg",
    ]);
  });

  test("never put the audio's signed URL in an error or the log", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    for (const audio of [
      (_req: IncomingMessage, res: ServerResponse) => status(res, 403),
      (req: IncomingMessage) => req.socket.destroy(),
    ]) {
      handle = soundCafe({ audio });
      const err = await joysound.getSongData("425691").then(
        () => assert.fail("it worked"),
        (failure: Error) => failure,
      );
      assert.match(err.message, /Joysound's audio for song 425691/);
      for (const text of [err.message, String(err.stack), ...logged]) {
        assert.ok(!text.includes(SIGNATURE), text);
        assert.ok(!text.includes("/media/"), text);
      }
    }
  });

  test("fail a 4xx at once", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 404);
    await assert.rejects(
      joysound.getSongData("425691"),
      (err) => err instanceof HttpStatusError && err.status === 404,
    );
    assert.equal(received.length, 1);
  });

  // A free or unlinked code still gets an answer, with 200, but a preview's.
  test("check the link again once when Joysound sends a preview", async () => {
    const { links, session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({
      getFme: (req, res) =>
        json(
          res,
          fme(
            req.headers["x-linkcode"] === "c1"
              ? { membershipType: "FREE", telop: "c2hvcnQ=" }
              : {},
          ),
        ),
    });
    assert.deepEqual(await joysound.getSongData("425691"), {
      telop: TELOP,
      ogg: OGG,
    });
    assert.deepEqual(links, ["c1", "c2"]);
    // And c2 is kept.
    await joysound.getSongData("425691");
    assert.deepEqual(links, ["c1", "c2"]);
  });

  test("give up after one new link that still gets previews", async () => {
    const { links, session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({
      getFme: (_req, res) => json(res, fme({ membershipType: "FREE" })),
    });
    await assert.rejects(
      joysound.getSongData("425691"),
      /isn't a paid member \(membership: FREE\)/,
    );
    assert.deepEqual(links, ["c1", "c2"]);
    // No audio: a preview's isn't the song.
    assert.deepEqual(paths(), ["/api/v1/spc/getFME", "/api/v1/spc/getFME"]);
  });

  test("don't ask for a song with a free member's link", async () => {
    const { links, session } = joysoundLinks(() => "FREE");
    const joysound = joysoundWith(session);
    handle = soundCafe({});
    await assert.rejects(
      joysound.getSongData("425691"),
      /isn't a paid member \(membership: FREE\)/,
    );
    // Checked again once, in case the membership changed.
    assert.deepEqual(links, ["c1", "c2"]);
    assert.equal(received.length, 0);
  });

  test("two downloads on an ended link link again once", async () => {
    const { links, session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = soundCafe({
      getFme: (req, res) =>
        json(
          res,
          fme(
            req.headers["x-linkcode"] === "c1"
              ? { membershipType: "NONE" }
              : {},
          ),
        ),
    });
    await Promise.all([
      joysound.getSongData("425691"),
      joysound.getSongData("425691"),
    ]);
    assert.deepEqual(links, ["c1", "c2"]);
  });

  test("fail a refused link at once, linking once", async () => {
    let links = 0;
    const joysound = joysoundWith(
      memoizeSuccess<JoysoundLink>(async () => {
        links++;
        throw new Error("Joysound login rejected (result 1)");
      }),
    );
    await assert.rejects(joysound.getSongData("425691"), /rejected/);
    assert.equal(links, 1);
    assert.equal(received.length, 0);
  });

  test("fail a link from outside Japan at once", async () => {
    let links = 0;
    const joysound = joysoundWith(
      memoizeSuccess<JoysoundLink>(async () => {
        links++;
        throw new HttpStatusError(403, "https://www.sound-cafe.jp/login");
      }),
    );
    await assert.rejects(
      joysound.getMovieUrls("425691"),
      (err) => err instanceof HttpStatusError && err.status === 403,
    );
    assert.equal(links, 1);
  });

  test("a 403 from the TV API doesn't count as an ended link", async () => {
    const { links, session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 403);
    await assert.rejects(
      joysound.getSongData("425691"),
      (err) => err instanceof HttpStatusError && err.status === 403,
    );
    assert.deepEqual(links, ["c1"]);
    assert.equal(received.length, 1);
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
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = (_req, res) => status(res, 500);
    const results = await Promise.allSettled(lookups(joysound));
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected", "rejected", "rejected"],
    );
    assert.equal(received.length, 4);
  });

  test("reject an answer that isn't data", async () => {
    const { session } = joysoundLinks();
    const joysound = joysoundWith(session);
    handle = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>maintenance</html>");
    };
    await assert.rejects(
      joysound.getSongListByKeyword("lemon", 1, 20),
      /something other than data/,
    );
  });

  test("reject when the link fails, instead of a song called 'Error'", async () => {
    const joysound = joysoundWith(async () => {
      throw new Error("Joysound login rejected (result 1)");
    });
    for (const result of await Promise.allSettled(lookups(joysound))) {
      assert.equal(result.status, "rejected");
      assert.match(String(result.reason), /rejected/);
    }
  });

  test("work with a free member's link", async () => {
    const { session } = joysoundLinks(() => "FREE");
    const joysound = joysoundWith(session);
    handle = (_req, res) =>
      json(res, { hitCount: "1", contentsList: [{ selSongNo: "1" }] });
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), {
      items: [{ selSongNo: "1" }],
      total: 1,
    });
  });

  test("answer no results without a request when no login is set", async () => {
    const joysound = joysoundWith(async () => {
      throw new NoLoginError("Joysound");
    });
    const none = { items: [], total: null };
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), none);
    assert.deepEqual(
      await joysound.getArtistListByKeyword("lemon", 1, 20),
      none,
    );
    assert.deepEqual(await joysound.getSongListByArtist("232873", 1, 20), none);
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
      memoizeSuccess<DamLogin>(async () => {
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
