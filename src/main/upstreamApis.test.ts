// Runs on Node's test runner through tsx (yarn test:unit). The DAM and
// Joysound clients talk to a local server that records what they send.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import { ApiError } from "./api";
import { damPictureUrl, damText, MinseiAPI } from "./damApi";
import { formBody } from "./http";
import {
  backgroundVideoUrl,
  featuresOf,
  JoysoundAPI,
  keptFor,
  songDetailOf,
} from "./joysoundApi";

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

// genreList's answer (2026-10-29, trimmed): a genre, and its one
// sub-genre, "すべて" (all).
const GENRES = {
  genreList: [
    {
      genreId: "10000001",
      genreName: "J-POP",
      genreList: [{ genreId: "10000001", genreName: "すべて", genreList: [] }],
    },
    { genreId: "10000011", genreName: "演歌", genreList: [] },
    // Not a genre karafriends can use.
    { genreId: "../x", genreName: "?" },
  ],
};

// upList's: new songs, by the date they came.
const UP_LIST = {
  hitCount: "3",
  upList: [
    { svcStartDate: "20261029", contentsList: [SONG_ROW, SONG_ROW] },
    { svcStartDate: "20261022", contentsList: [SONG_ROW] },
  ],
};

// feature_tv.json's, trimmed.
const FEATURE_FILE = {
  feature: [
    {
      id: "63",
      title: "バラードソング特集",
      thumbnail_img:
        "https://d24lvzvt5ynxi0.cloudfront.net/static/image/feature/thumbnail/t.png",
      header_img: "https://d24lvzvt5ynxi0.cloudfront.net/b.png",
      description: ["しっとり", "抒情的な曲を。"],
      song_number: [638255, 425691],
    },
  ],
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
      } else if (req.url === "/api/v1/spc/genreList") {
        res.end(JSON.stringify(GENRES));
      } else if (req.url === "/api/v1/spc/upList") {
        res.end(JSON.stringify(UP_LIST));
      } else if (req.url === "/static/json/feature_tv.json") {
        res.end(JSON.stringify(FEATURE_FILE));
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
    // With the whole list's count (hitCount, as text).
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 1, 20), {
      items: [SONG_ROW],
      total: 1,
    });
    assert.deepEqual(await joysound.getArtistListByKeyword("米津", 1, 20), {
      items: [ARTIST_ROW],
      total: 1,
    });
    assert.deepEqual(await joysound.getSongListByArtist("232873", 1, 20), {
      items: [SONG_ROW],
      total: 1,
    });
    // Past the last page.
    contentsList = () => ({
      hitCount: "1",
      contentsList: null,
      artistList: null,
    });
    assert.deepEqual(await joysound.getSongListByKeyword("lemon", 21, 20), {
      items: [],
      total: 1,
    });
    // A hitCount that isn't a count: none.
    contentsList = () => ({ hitCount: "many", contentsList: null });
    assert.deepEqual(await joysound.getArtistListByKeyword("米津", 21, 20), {
      items: [],
      total: null,
    });
  });

  test("reads a song's details from contentsDetail", async () => {
    assert.deepEqual(await joysound.getSongDetail("428493"), {
      name: "SHYでもいいよ",
      artistName: "AISHA",
      lyricsPreview: "テストの一行目",
      tieUp: "",
      // The fixture leaves out its shop links.
      pictureUrl: null,
      // Its selection has the guide-melody version only.
      guideVocal: false,
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
      {
        name: "SHYでもいいよ",
        artistName: "",
        lyricsPreview: "",
        tieUp: "",
        pictureUrl: null,
        guideVocal: false,
      },
    );
  });

  test("takes Amazon's largest album art, else Amazon's, else Apple's", () => {
    const art = (amazonInfo: object, itunesInfo: object) =>
      songDetailOf(
        "428493",
        detail({ outsideUrlInfo: { amazonInfo, itunesInfo } }),
      ).pictureUrl;
    assert.equal(
      art(
        {
          songImageUrl: "https://a/160.jpg",
          songImageUrlLarge: "https://a/500.jpg",
        },
        { songImageUrl: "https://apple/100.jpg" },
      ),
      "https://a/500.jpg",
    );
    assert.equal(
      art(
        { songImageUrl: "", songImageUrlLarge: "" },
        { songImageUrl: "https://apple/100.jpg" },
      ),
      "https://apple/100.jpg",
    );
    // TAMAGO's LEMON had none.
    assert.equal(
      art({ songImageUrl: "", songImageUrlLarge: "" }, { songImageUrl: "" }),
      null,
    );
    assert.equal(
      songDetailOf("428493", detail({ outsideUrlInfo: null })).pictureUrl,
      null,
    );
  });

  test("says whether the song has a guide-vocal version, from its own selection", () => {
    const aplList = (services: string[], selSongNo = "428493") => [
      {
        aplId: "0002004",
        selectionList: [
          {
            selSongNo,
            serviceTypeList: services.map((serviceType) => ({ serviceType })),
          },
        ],
      },
    ];
    const guideVocal = (list: object) =>
      songDetailOf("428493", detail({ aplList: list })).guideVocal;
    assert.equal(guideVocal(aplList(["003000761", "003000762"])), true);
    assert.equal(guideVocal(aplList(["003000761"])), false);
    // Another song's selection doesn't count.
    assert.equal(guideVocal(aplList(["003000762"], "999999")), false);
  });

  test("refuses an answer without the song", () => {
    assert.throws(
      () => songDetailOf("428493", { spcContentsDetailResponse: null }),
      /no details for song 428493/,
    );
  });
});

describe("backgroundVideoUrl", () => {
  const movie = {
    mov3: "https://a/3.mp4",
    mov1: "https://a/1.mp4",
    mov2: "",
    mov4: "https://a/4.mp4",
  };

  test("picks one of the song's videos at random", () => {
    // The ones there are, in order: mov1, mov3, mov4.
    assert.equal(
      backgroundVideoUrl({ slc: "1", movie }, () => 0),
      movie.mov1,
    );
    assert.equal(
      backgroundVideoUrl({ slc: "1", movie }, () => 0.5),
      movie.mov3,
    );
    assert.equal(
      backgroundVideoUrl({ slc: "1", movie }, () => 0.9999),
      movie.mov4,
    );
    const picked = new Set(
      Array.from({ length: 200 }, () =>
        backgroundVideoUrl({ slc: "1", movie }),
      ),
    );
    assert.deepEqual([...picked].sort(), [movie.mov1, movie.mov3, movie.mov4]);
  });

  test("has none when the song has none", () => {
    assert.equal(backgroundVideoUrl({ slc: "1", movie: { mov1: "" } }), null);
    assert.equal(backgroundVideoUrl({ slc: "1", movie: null }), null);
  });
});

describe("JoysoundAPI's Browse", () => {
  const joysound = new JoysoundAPI(async () => ({
    linkCode: "code-1",
    membershipType: "PAID",
  }));

  before(() => {
    joysound.baseURL = base;
  });

  test("a genre's songs: most popular first, by its ID", async () => {
    await joysound.getSongListByGenre("10000001", 1, 20);
    assert.deepEqual(JSON.parse(received[0].body), {
      params: [{ kind: "selGenre", word: "10000001", match: "exact" }],
      sort: "popular",
      order: "desc",
      format: "all",
      start: "1",
      count: "20",
      facet: "false",
    });
    await assert.rejects(
      joysound.getSongListByGenre("../x", 1, 20),
      (err) => err instanceof ApiError && err.status === 400,
    );
  });

  test("the genres, asked for once an hour at most", async () => {
    const fresh = new JoysoundAPI(async () => ({
      linkCode: "code-1",
      membershipType: "PAID",
    }));
    fresh.baseURL = base;
    const genres = await fresh.getGenres();
    assert.deepEqual(genres, [
      { id: "10000001", name: "J-POP" },
      { id: "10000011", name: "演歌" },
    ]);
    await fresh.getGenres();
    assert.deepEqual(
      received.map(({ url }) => url),
      ["/api/v1/spc/genreList"],
    );
  });

  test("the newest songs, every date's", async () => {
    assert.equal((await joysound.getNewSongs()).length, 3);
    assert.equal(received[0].url, "/api/v1/spc/upList");
  });

  test("the featured lists, from the TV app's file, with the link", async () => {
    const fresh = new JoysoundAPI(async () => ({
      linkCode: "code-1",
      membershipType: "PAID",
    }));
    fresh.baseURL = base;
    assert.deepEqual(await fresh.getFeatures(), [
      {
        id: "63",
        title: "バラードソング特集",
        description: "しっとり抒情的な曲を。",
        songNumbers: ["638255", "425691"],
        pictureUrl: FEATURE_FILE.feature[0].thumbnail_img,
      },
    ]);
    assert.equal(received[0].url, "/static/json/feature_tv.json");
  });

  test("a featured list's songs: in one request, in the list's order", async () => {
    contentsList = () => ({
      hitCount: "2",
      contentsList: [
        { ...SONG_ROW, selSongNo: "425691", songName: "Lemon" },
        { ...SONG_ROW, selSongNo: "638255", songName: "Ballad" },
      ],
    });
    const songs = await joysound.getSongsByNumber(["638255", "999", "425691"]);
    // Joysound's song-name order put back in the list's; 999 isn't one.
    assert.deepEqual(
      songs.map((song) => song.selSongNo),
      ["638255", "425691"],
    );
    assert.equal(received.length, 1);
    assert.deepEqual(JSON.parse(received[0].body).params, [
      { kind: "selSongNo", word: "638255,999,425691", match: "exact" },
    ]);
    assert.equal(JSON.parse(received[0].body).count, "3");
    await assert.rejects(
      joysound.getSongsByNumber(["1", "2,3"]),
      (err) => err instanceof ApiError && err.status === 400,
    );
  });
});

describe("featuresOf", () => {
  test("keeps well-formed lists, the first of two with one ID", () => {
    const features = featuresOf({
      feature: [
        { id: "12", title: "A", song_number: [1, 2] },
        { id: "12", title: "A again", song_number: [3] },
        { id: "x", title: "Bad ID", song_number: [1] },
        { id: "13", title: "No songs", song_number: [] },
        { id: 14, title: "Number ID", song_number: ["5", "../6"] },
      ],
    });
    assert.deepEqual(
      features.map((f) => [f.id, f.title, f.songNumbers, f.pictureUrl]),
      [
        ["12", "A", ["1", "2"], null],
        ["14", "Number ID", ["5"], null],
      ],
    );
  });
});

describe("keptFor", () => {
  test("keeps a value for its time, and not a failure", async () => {
    let loads = 0;
    let fail = true;
    const kept = keptFor(1000, async () => {
      loads++;
      if (fail) throw new Error("no");
      return loads;
    });
    await assert.rejects(kept(0), /no/);
    fail = false;
    assert.equal(await kept(1), 2);
    assert.equal(await kept(999), 2);
    assert.equal(await kept(1001), 3);
  });
});

describe("damPictureUrl", () => {
  test("fills in the app key DAM's thumbnail URL leaves out", () => {
    assert.equal(
      damPictureUrl(
        "https://csgw.clubdam.com/minsei/music/info/GetNewThumbnail.api?compId=&compAuthKey=&imageKey=c8bf732035ef02d0416b663a834c48ba",
      ),
      "https://csgw.clubdam.com/minsei/music/info/GetNewThumbnail.api?compId=1&compAuthKey=2%2FQb9R%408s*&imageKey=c8bf732035ef02d0416b663a834c48ba",
    );
  });

  test("has none for no thumbnail, or one that isn't DAM's", () => {
    for (const path of [
      "",
      undefined,
      "not a url",
      "http://csgw.clubdam.com/minsei/music/info/GetNewThumbnail.api?imageKey=a",
      "https://example.com/minsei/music/info/GetNewThumbnail.api?imageKey=a",
      "https://csgw.clubdam.com/minsei/other.api?imageKey=a",
      "https://csgw.clubdam.com/minsei/music/info/GetNewThumbnail.api?imageKey=",
    ]) {
      assert.equal(damPictureUrl(path), null, String(path));
    }
  });
});

describe("damText", () => {
  test("reads DAM's 'undefined' as nothing", () => {
    assert.equal(damText("undefined"), null);
    assert.equal(damText(""), null);
    assert.equal(damText(undefined), null);
    assert.equal(damText("主題歌"), "主題歌");
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
