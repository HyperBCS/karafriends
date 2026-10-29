// Runs on Node's test runner through tsx (yarn test:unit). The DAM and
// Joysound clients talk to a local server that records what they send.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { ApiError } from "./api";
import { MinseiAPI } from "./damApi";
import { formBody } from "./http";
import { backgroundVideoUrl, JoysoundAPI, songDetailOf } from "./joysoundApi";

// What a phone might type, and what a config.yaml password might hold.
const AWKWARD = "C&K 1+1=2 100% 米津玄師 a%2Fb";

// contentsDetail's answer as sound-cafe sent it on 2026-10-29, its shop
// links left out and its first line made up.
const DETAIL = {
  spcContentsDetailResponse: {
    selSongNo: "428493",
    songName: "SHYでもいいよ",
    lyricist: "AISHA",
    composer: "MANABOON(Tiny Voice Production)，AISHA",
    artistInfo: { artistName: "AISHA", artistId_digi: "208528" },
    aplList: [
      {
        aplId: "0002004",
        selectionList: [
          {
            selSongNo: "428493",
            lyricIntro: "テストの一行目",
            originalKey: "0",
            serviceTypeList: [{ serviceType: "003000761" }],
          },
        ],
      },
    ],
    tieupList: [],
    outsideUrlInfo: {},
  },
  mySong: false,
  myArtist: false,
};

// contentsList's rows: a song, and (format artist_digi) an artist.
const SONG_ROW = {
  selSongNo: "425691",
  songName: "Lemon",
  artistName: "米津玄師",
  serviceTypeList: [{ serviceType: "003000761" }],
  outsideUrlInfo: {},
  artistId_digi: "232873",
};
const ARTIST_ROW = {
  selSongNo: null,
  songName: null,
  artistName: "米津玄師",
  serviceTypeList: null,
  outsideUrlInfo: {},
  artistId_digi: "232873",
};

let server: http.Server;
let base: string;
const received: {
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}[] = [];
// What contentsList answers.
let contentsList: (request: { format: string }) => unknown;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body, headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/v1/spc/contentsDetail") {
        res.end(JSON.stringify(DETAIL));
      } else if (req.url === "/api/v1/spc/contentsList") {
        res.end(JSON.stringify(contentsList(JSON.parse(body))));
      } else {
        res.end(
          req.url?.startsWith("/cwa/")
            ? JSON.stringify({ statusCode: "0000", status: "OK", message: "" })
            : "[]",
        );
      }
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
  contentsList = ({ format }) =>
    format === "artist_digi"
      ? {
          hitCount: "1",
          facetList: [],
          contentsList: null,
          artistList: [ARTIST_ROW],
        }
      : {
          hitCount: "1",
          facetList: [],
          contentsList: [SONG_ROW],
          artistList: null,
        };
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
    linkCode: "code-1",
    membershipType: "PAID",
  }));

  before(() => {
    joysound.baseURL = base;
  });

  // The orders are the ones that give the website's, page for page
  // (checked on 2026-10-29): by popularity, the TV API's "asc" is least
  // popular first.
  test("sends each list as the TV app's JSON, the search term whole", async () => {
    await joysound.getSongListByKeyword(AWKWARD, 21, 20);
    await joysound.getArtistListByKeyword(AWKWARD, 1, 20);
    await joysound.getSongListByArtist("232873", 1, 20);
    const list = (
      param: object,
      sort: string,
      order: string,
      format: string,
      start: string,
    ) => [
      "/api/v1/spc/contentsList",
      {
        params: [param],
        sort,
        order,
        format,
        start,
        count: "20",
        facet: "false",
      },
    ];
    assert.deepEqual(
      received.map(({ url, body }) => [url, JSON.parse(body)]),
      [
        list(
          { kind: "song", word: AWKWARD, match: "partial" },
          "popular",
          "desc",
          "all",
          "21",
        ),
        list(
          { kind: "artist", word: AWKWARD, match: "partial" },
          "name",
          "asc",
          "artist_digi",
          "1",
        ),
        list(
          { kind: "selArtist_digi", word: "232873", match: "exact" },
          "popular",
          "desc",
          "all",
          "1",
        ),
      ],
    );
  });

  test("sends the link code, and nothing of the website's", async () => {
    await joysound.getSongDetail("428493");
    const { headers, body } = received[0];
    assert.equal(headers["x-linkcode"], "code-1");
    assert.equal(headers["x-osname"], "Android");
    assert.match(headers["content-type"] ?? "", /^application\/json/);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers["x-xsrf-token"], undefined);
    assert.deepEqual(JSON.parse(body), { songNumber: "428493" });
  });

  test("takes the songs or the artists out of the answer", async () => {
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), [
      SONG_ROW,
    ]);
    assert.deepEqual(await joysound.getArtistListByKeyword("米津", 1, 20), [
      ARTIST_ROW,
    ]);
    assert.deepEqual(await joysound.getSongListByArtist("232873", 1, 20), [
      SONG_ROW,
    ]);
    // Past the last page.
    contentsList = () => ({
      hitCount: "1",
      contentsList: null,
      artistList: null,
    });
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 21, 20), []);
    assert.deepEqual(await joysound.getArtistListByKeyword("米津", 21, 20), []);
  });

  test("reads a song's details from contentsDetail", async () => {
    assert.deepEqual(await joysound.getSongDetail("428493"), {
      name: "SHYでもいいよ",
      artistName: "AISHA",
      lyricsPreview: "テストの一行目",
      tieUp: "",
    });
  });

  for (const id of ["../mypage/whatever", "425691?x=1", "1&count=999", ""]) {
    test(`refuses ${JSON.stringify(id)} as an ID, sending nothing`, async () => {
      const isBadInput = (err: unknown) =>
        err instanceof ApiError && err.status === 400;
      await assert.rejects(joysound.getSongDetail(id), isBadInput);
      await assert.rejects(joysound.getSongListByArtist(id, 0, 20), isBadInput);
      await assert.rejects(joysound.getSongData(id), isBadInput);
      await assert.rejects(joysound.getMovieUrls(id), isBadInput);
      assert.deepEqual(received, []);
    });
  }
});

describe("songDetailOf", () => {
  const detail = (changes: object) => ({
    ...DETAIL,
    spcContentsDetailResponse: {
      ...DETAIL.spcContentsDetailResponse,
      ...changes,
    },
  });

  test("joins the tie-ups, skipping empty ones", () => {
    const tieupList = [
      { tieupName: "北海道・東北地方" },
      { tieupName: "" },
      { tieupName: null },
      { tieupName: "ドラマ「アンナチュラル」主題歌" },
    ];
    assert.equal(
      songDetailOf("428493", detail({ tieupList })).tieUp,
      "北海道・東北地方 / ドラマ「アンナチュラル」主題歌",
    );
  });

  test("takes the first line of the selection with the song's own number", () => {
    const aplList = [
      {
        aplId: "1",
        selectionList: [{ selSongNo: "999999", lyricIntro: "別の曲" }],
      },
      { aplId: "2", selectionList: null },
      {
        aplId: "3",
        selectionList: [
          { selSongNo: "111111", lyricIntro: "もう一つ" },
          { selSongNo: "428493", lyricIntro: "この曲" },
        ],
      },
    ];
    assert.equal(
      songDetailOf("428493", detail({ aplList })).lyricsPreview,
      "この曲",
    );
    // None of its own: no preview, rather than another song's.
    assert.equal(songDetailOf("123", detail({ aplList })).lyricsPreview, "");
  });

  test("leaves out what isn't there", () => {
    assert.deepEqual(
      songDetailOf(
        "428493",
        detail({ artistInfo: null, aplList: null, tieupList: null }),
      ),
      { name: "SHYでもいいよ", artistName: "", lyricsPreview: "", tieUp: "" },
    );
  });

  test("refuses an answer without the song", () => {
    assert.throws(
      () => songDetailOf("428493", { spcContentsDetailResponse: null }),
      /no details for song 428493/,
    );
  });
});

describe("backgroundVideoUrl", () => {
  test("takes mov1, or else the first other one there is", () => {
    assert.equal(
      backgroundVideoUrl({
        slc: "1",
        movie: { mov1: "https://a/1.mp4", mov2: "https://a/2.mp4" },
      }),
      "https://a/1.mp4",
    );
    assert.equal(
      backgroundVideoUrl({
        slc: "1",
        movie: { mov3: "https://a/3.mp4", mov1: "", mov2: "https://a/2.mp4" },
      }),
      "https://a/2.mp4",
    );
    assert.equal(backgroundVideoUrl({ slc: "1", movie: { mov1: "" } }), null);
    assert.equal(backgroundVideoUrl({ slc: "1", movie: null }), null);
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
