import promiseRetry from "promise-retry";
import invariant from "ts-invariant";

import { getSetCookies, http, httpFetch, HttpResponse } from "./http";

export type JoysoundCredentialsProvider = () => Promise<{
  cookies: JoysoundCookies;
  csrfToken: string;
}>;

// Keyed by cookie name. sound-cafe changes which cookies it sets (JSESSIONID
// is now only issued after login, and the CSRF token lives in XSRF-TOKEN), so
// keep whatever it sends instead of a fixed list.
type JoysoundCookies = Record<string, string>;

interface JoysoundArtistListItem {
  selSongNo: null;
  songName: null;
  artistName: string;
  serviceTypeList: null;
  artistId_digi: string;
}

interface JoysoundMovieList {
  slc: string;
  movie: JoysoundMovieUrlList;
}

interface JoysoundMovieUrlList {
  [index: string]: string;
}

interface JoysoundSongDetail {
  name: string;
  artistName: string;
  lyricsPreview: string;
  tieUp: string;
}

interface JoysoundSongListItem {
  selSongNo: string;
  songName: string;
  artistName: string;
  serviceTypeList: ServiceTypeData[];
  artistId_digi: string;
}

export interface JoysoundSongRawData {
  slc: string;
  telop: string;
  ogg: string;
  streaming_wifi_url: string;
}

interface ServiceTypeData {
  serviceType: string;
}

function generateCookieString(cookies: JoysoundCookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function parseCookies(resp: HttpResponse, target: JoysoundCookies) {
  for (const setCookie of getSetCookies(resp)) {
    const matchData = setCookie.match(/^([^=;\s]+)=([^;]*)/);
    if (matchData) target[matchData[1]] = matchData[2];
  }
}

function unescapeJoysoundString(str: string) {
  const htmlEntities = {
    nbsp: " ",
    cent: "¢",
    pound: "£",
    yen: "¥",
    euro: "€",
    copy: "©",
    reg: "®",
    lt: "<",
    gt: ">",
    quot: '"',
    amp: "&",
    apos: "'",
  };

  return str.replace(/&([^;]+);/g, (entity: string, entityCode: string) => {
    let match;

    if (htmlEntities[entityCode as keyof typeof htmlEntities] !== undefined) {
      return htmlEntities[entityCode as keyof typeof htmlEntities];
    }

    match = entityCode.match(/^#x([\da-fA-F]+)$/);

    if (match) {
      return String.fromCharCode(parseInt(match[1], 16));
    }

    match = entityCode.match(/^#(\d+)$/);

    if (match) {
      return String.fromCharCode(parseInt(match[1], 10));
    }

    return entity;
  });
}

export class JoysoundAPI {
  baseURL = "https://www.sound-cafe.jp";
  credsProvider: JoysoundCredentialsProvider;

  constructor(credsProvider: JoysoundCredentialsProvider) {
    this.credsProvider = credsProvider;
  }

  async post<T>(url: string, data: object): Promise<T> {
    const body = Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const creds = await this.credsProvider();

    console.debug(
      `[joysound] curl ${
        this.baseURL
      }${url} -d "${body}" -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" -H "Cookie: ${generateCookieString(
        creds.cookies,
      )}" -H "X-XSRF-TOKEN: ${creds.csrfToken}"`,
    );

    return http<T>(`${this.baseURL}${url}`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: generateCookieString(creds.cookies),
        Referer: "https://www.sound-cafe.jp/player",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
        "X-XSRF-TOKEN": creds.csrfToken,
      },
    });
  }

  getArtistListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundArtistListItem[]>("/search/artist/list", {
      keyword,
      match: "partial",
      sort: "name",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch((err) => {
      console.log(err);
      return [] as JoysoundArtistListItem[];
    });
  }

  async getMovieUrls(id: string) {
    return promiseRetry((retryFn, retryCount: number) => {
      console.log(`contentsInfo for songId: ${id}, retry no. ${retryCount}`);

      return this.post<JoysoundMovieList>("/player/contentsInfo", {
        songNumber: id,
        serviceType: "003000761",
      }).catch(retryFn);
    });
  }

  async getSongDetail(id: string) {
    const creds = await this.credsProvider().catch(() => {
      console.log("Login Failed");
      return null;
    });
    if (creds === undefined || creds === null) {
      return {
        name: "Error",
        artistName: "Error",
        lyricsPreview: "Error",
        tieUp: "Error",
      };
    }

    const data = await http<string>(`${this.baseURL}/songdetail/${id}`, {
      headers: { Cookie: generateCookieString(creds.cookies) },
    });

    const re = new RegExp(
      /<div class="flex items-center w-full border-b border-gray">([^<>]*)/,
      "g",
    );

    const results: string[] = [];

    for (const matchData of data.matchAll(re)) {
      results.push(matchData[1]);
    }

    const name = results[0];
    invariant(name);

    const artistName = results[1];
    invariant(artistName);

    const tieUp = results[2];
    invariant(tieUp !== undefined);

    const lyricsPreview = data.match(
      /<div class="flex items-center w-full border-b select-none border-gray">([^<>]*)/,
    )?.[1];
    invariant(lyricsPreview !== undefined);

    const payload: JoysoundSongDetail = {
      name: unescapeJoysoundString(name),
      artistName: unescapeJoysoundString(artistName),
      lyricsPreview: unescapeJoysoundString(lyricsPreview),
      tieUp: unescapeJoysoundString(tieUp),
    };

    return payload;
  }

  getSongListByArtist(artistId: string, start: number, count: number) {
    return this.post<JoysoundSongListItem[]>("/search/artist/song/list", {
      artistId,
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch((err) => {
      console.log(err);
      return [] as JoysoundSongListItem[];
    });
  }

  getSongListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundSongListItem[]>("/search/song/list", {
      keyword,
      match: "partial",
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch((err) => {
      console.log(err);
      return [] as JoysoundSongListItem[];
    });
  }

  async getSongRawData(id: string) {
    return promiseRetry((retryFn, retryCount: number) => {
      console.log(`getFME for songId: ${id}, retry no. ${retryCount}`);

      return this.post<JoysoundSongRawData>("/player/getFME", {
        songNumber: id,
        serviceType: "003000761",
      }).catch(retryFn);
    });
  }

  static async login(email: string, password: string) {
    const loginCookies: JoysoundCookies = {};

    const csrfToken = await httpFetch("https://www.sound-cafe.jp/login", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
      },
    })
      .then((resp) => {
        parseCookies(resp, loginCookies);

        return resp.text();
      })
      .then((respBody) => {
        const matchData = respBody.match(
          /<meta name="_csrf" content="([^"]+)" \/>/,
        );
        invariant(matchData);

        return matchData[1];
      });

    return httpFetch("https://www.sound-cafe.jp/login/check", {
      method: "POST",
      body: `mailAddress=${email}&password=${password}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: generateCookieString(loginCookies),
        Origin: "https://www.sound-cafe.jp",
        Referer: "https://www.sound-cafe.jp/login",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
        "X-XSRF-TOKEN": csrfToken,
        "X-Requested-With": "XMLHttpRequest",
      },
    })
      .then((resp) => {
        parseCookies(resp, loginCookies);

        return resp.json() as Promise<{ result: number }>;
      })
      .then((check) => {
        // 0 means the credentials were accepted; 1 means a wrong email/password
        if (check.result !== 0) {
          throw new Error(
            `Joysound login rejected (result ${check.result}); check joysoundEmail and joysoundPassword in config.yaml`,
          );
        }

        return httpFetch("https://www.sound-cafe.jp/login", {
          method: "POST",
          body: `_csrf=${csrfToken}&mailAddress=${email}&password=${password}`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: generateCookieString(loginCookies),
            Origin: "https://www.sound-cafe.jp",
            Referer: "https://www.sound-cafe.jp/login",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
          },
          redirect: "manual",
        });
      })
      .then((resp) => {
        parseCookies(resp, loginCookies);

        return httpFetch("https://www.sound-cafe.jp", {
          headers: {
            Cookie: generateCookieString(loginCookies),
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
          },
        });
      })
      .then((resp) => {
        parseCookies(resp, loginCookies);

        return resp.text();
      })
      .then((respBody) => {
        const matchData = respBody.match(
          /<meta name="_csrf" content="([^"]+)" \/>/,
        );
        invariant(matchData);

        return {
          cookies: loginCookies,
          csrfToken: matchData[1],
        };
      });
  }
}
