import invariant from "ts-invariant";

import { ApiError } from "./api";
import { NoLoginError } from "./credentials";
import {
  formBody,
  getSetCookies,
  httpFetch,
  type HttpRequest,
  HttpResponse,
  HttpStatusError,
  NO_RETRIES,
  QUICK_RETRIES,
  readBody,
  type RetryPolicy,
  type Session,
  SessionLostError,
  withSession,
} from "./http";

interface JoysoundSession {
  cookies: JoysoundCookies;
  csrfToken: string;
}

// The shared login (credentials.joysound): forget drops a session that has
// ended.
export type JoysoundCredentialsProvider = Session<JoysoundSession>;

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

// Joysound's song numbers and artist IDs are digits. Anything else (from a
// phone) is refused before it goes into a URL or form sent with the host's
// session: "../mypage" as a song would otherwise fetch another page.
function checkId(id: string, what: "song number" | "artist ID") {
  if (!/^\d+$/.test(id)) {
    throw new ApiError(400, `Not a Joysound ${what}: ${JSON.stringify(id)}`);
  }
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

// A search's answer when no Joysound login is set: no results, without a
// request, so a DAM-only host's phones search DAM without an error.
// Any other failure rejects, and the phone shows it with a Retry button.
function noResultsWithoutLogin<T>(err: unknown): T[] {
  if (err instanceof NoLoginError) return [];
  throw err;
}

export class JoysoundAPI {
  baseURL = "https://www.sound-cafe.jp";
  credsProvider: JoysoundCredentialsProvider;
  // For the downloads (getFME, contentsInfo). Lookups aren't tried again:
  // the phone that asked shows the error.
  retryPolicy: RetryPolicy = QUICK_RETRIES;

  constructor(credsProvider: JoysoundCredentialsProvider) {
    this.credsProvider = credsProvider;
  }

  // path, sent with the session's cookies. Cookies the answer sets go into
  // the session's jar, for its later requests. An answer that sends the
  // request to the login page, or 401 or 403, is a SessionLostError.
  private async request<T>(
    creds: JoysoundSession,
    path: string,
    req: HttpRequest,
  ): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const resp = await httpFetch(url, {
      ...req,
      headers: { ...req.headers, Cookie: generateCookieString(creds.cookies) },
    });
    parseCookies(resp, creds.cookies);
    if (
      resp.status === 401 ||
      resp.status === 403 ||
      new URL(resp.url || url).pathname.startsWith("/login")
    ) {
      await resp.text().catch(() => "");
      throw new SessionLostError(
        `Joysound answered ${path} with ${
          resp.ok ? "its login page" : resp.status
        }: the session may have ended`,
      );
    }
    return readBody<T>(resp, url);
  }

  // One of sound-cafe's JSON APIs. An HTML page where JSON was expected is
  // the login page, or one like it: a SessionLostError.
  private async postJson<T>(
    creds: JoysoundSession,
    path: string,
    data: Record<string, string>,
  ): Promise<T> {
    const body = formBody(data);
    console.debug(
      `[joysound] curl ${
        this.baseURL
      }${path} -d "${body}" -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" -H "Cookie: ${generateCookieString(
        creds.cookies,
      )}" -H "X-XSRF-TOKEN: ${creds.csrfToken}"`,
    );
    const answer = await this.request<T | string>(creds, path, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: "https://www.sound-cafe.jp/player",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
        "X-XSRF-TOKEN": creds.csrfToken,
      },
    });
    if (typeof answer === "string") {
      throw new SessionLostError(
        `Joysound answered ${path} with a page, not data: the session may have ended`,
      );
    }
    return answer;
  }

  // postJson in the shared session: logged in again once if the session has
  // ended, and with policy's retries.
  post<T>(
    url: string,
    data: Record<string, string>,
    policy: RetryPolicy = NO_RETRIES,
  ): Promise<T> {
    return withSession(
      this.credsProvider,
      (creds) => this.postJson<T>(creds, url, data),
      { policy, label: `Joysound ${url}` },
    );
  }

  getArtistListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundArtistListItem[]>("/search/artist/list", {
      keyword,
      match: "partial",
      sort: "name",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch(noResultsWithoutLogin<JoysoundArtistListItem>);
  }

  async getMovieUrls(id: string) {
    checkId(id, "song number");
    return this.post<JoysoundMovieList>(
      "/player/contentsInfo",
      { songNumber: id, serviceType: "003000761" },
      this.retryPolicy,
    );
  }

  async getSongDetail(id: string) {
    checkId(id, "song number");
    const path = `/songdetail/${encodeURIComponent(id)}`;
    const data = await withSession(
      this.credsProvider,
      (creds) => this.request<string>(creds, path, {}),
      { label: `Joysound ${path}` },
    );

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

  async getSongListByArtist(artistId: string, start: number, count: number) {
    checkId(artistId, "artist ID");
    return this.post<JoysoundSongListItem[]>("/search/artist/song/list", {
      artistId,
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch(noResultsWithoutLogin<JoysoundSongListItem>);
  }

  getSongListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundSongListItem[]>("/search/song/list", {
      keyword,
      match: "partial",
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    }).catch(noResultsWithoutLogin<JoysoundSongListItem>);
  }

  async getSongRawData(id: string) {
    checkId(id, "song number");
    return this.post<JoysoundSongRawData>(
      "/player/getFME",
      { songNumber: id, serviceType: "003000761" },
      this.retryPolicy,
    );
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
        // An error status, 403 usually, means no Japanese IP address.
        if (!resp.ok) {
          throw new HttpStatusError(
            resp.status,
            "https://www.sound-cafe.jp/login",
          );
        }
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
      body: formBody({ mailAddress: email, password }),
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
          body: formBody({ _csrf: csrfToken, mailAddress: email, password }),
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
