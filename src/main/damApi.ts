import {
  formBody,
  http,
  httpFetch,
  HttpStatusError,
  QUICK_RETRIES,
  type RetryPolicy,
  type Session,
  withSession,
} from "./http";
import { DAM_PAGE_SIZE, damPageWindow } from "./paging";

const BASE_MINSEI_REQUEST = {
  charset: "UTF-8",
  compAuthKey: "2/Qb9R@8s*",
  compId: "1",
  deviceId: "22",
  format: "json",
  serviceId: "1",
  contractId: "1",
};

// The fixed fields, joined unencoded as they always have been: DAM also
// accepts compAuthKey percent-encoded, but the app has only ever sent it as
// is.
const BASE_MINSEI_BODY = Object.entries(BASE_MINSEI_REQUEST)
  .map(([k, v]) => `${k}=${v}`)
  .join("&");

// A request's own fields as the log shows them: without the login's user
// code and token, which would sign anyone in as the host until DAM drops
// them. (The log is in a console window, and gets pasted into bug reports.)
const SECRET_FIELDS = new Set(["userCode", "authToken"]);
function loggable(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      SECRET_FIELDS.has(key) ? "(hidden)" : value,
    ]),
  );
}

const MINSEI_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "WindowsApplication",
  "win10-access-key": "mbAmgk3GuCOKAgL8dCQR",
};

// The shared login (credentials.dam): forget drops a token DAM has stopped
// taking.
export type MinseiCredentialsProvider = Session<{
  userCode: string;
  authToken: string;
}>;

// DAM's own status code, from an answer that isn't "0000".
export class MinseiStatusError extends Error {
  constructor(
    readonly statusCode: string,
    message: string,
  ) {
    super(message);
    this.name = "MinseiStatusError";
  }
}

// Whether a failure of a call made with the token may mean DAM no longer
// takes it. Which status codes mean that isn't known, so any of DAM's own
// codes, or a 401 or 403, counts: one more login and one more try cost
// little. (A 403 from outside Japan then fails that login at once.)
function tokenRefused(err: unknown): boolean {
  return (
    err instanceof MinseiStatusError ||
    (err instanceof HttpStatusError &&
      (err.status === 401 || err.status === 403))
  );
}

interface MinseiResponse {
  message: string;
  status: string;
  statusCode: string;
}

interface MinseiLogin extends MinseiResponse {
  data: {
    authToken: string;
    damtomoId: string;
  };
}

interface MinseiStreamingUrls extends MinseiResponse {
  data: {
    karaokeContentsId: string;
  };
  list: {
    contentsId: string;
    duet: string;
    highBitrateUrl: string;
    lowBitrateUrl: string;
  }[];
}

export class MinseiAPI {
  baseURL = "https://win10.clubdam.com";
  credsProvider: MinseiCredentialsProvider;
  retryPolicy: RetryPolicy = QUICK_RETRIES;

  constructor(credsProvider: MinseiCredentialsProvider) {
    this.credsProvider = credsProvider;
  }

  // The fixed fields, then data's (the song, the login) percent-encoded.
  post<T>(url: string, data: Record<string, string>): Promise<T> {
    const body = `${BASE_MINSEI_BODY}&${formBody(data)}`;
    console.debug(
      `[minsei] POST ${this.baseURL}${url} ${formBody(loggable(data))}`,
    );
    return http<T>(`${this.baseURL}${url}`, {
      method: "POST",
      body,
      headers: MINSEI_HEADERS,
    });
  }

  static checkError<T extends MinseiResponse>(data: T) {
    // statusCode 1005 seems to mean pagination continues
    if (data.statusCode !== "0000" && data.statusCode !== "1005") {
      throw new MinseiStatusError(
        data.statusCode,
        `${data.status} ${data.statusCode}: ${data.message}`,
      );
    }
    return data;
  }

  // The body is read whatever the HTTP status, so a rejected login reports
  // DAM's own status code and message through checkError. An error status
  // without DAM's JSON (a 403 from outside Japan, say) is an
  // HttpStatusError.
  static async login(loginId: string, password: string) {
    const url = `https://win10.clubdam.com/cwa/win/minsei/auth/LoginByDamtomoMemberId.api`;
    const resp = await httpFetch(url, {
      method: "POST",
      body: formBody({ loginId, password, format: "json" }),
      headers: MINSEI_HEADERS,
    });
    const text = await resp.text();
    let data: MinseiLogin;
    try {
      data = JSON.parse(text) as MinseiLogin;
    } catch (err) {
      if (!resp.ok) throw new HttpStatusError(resp.status, url);
      throw err;
    }
    return MinseiAPI.checkError(data);
  }

  // These endpoints have been flaky, so a transient failure is tried again
  // (retryPolicy), and a refused token gets one new login.
  getMusicStreamingUrls(requestNo: string) {
    return withSession(
      this.credsProvider,
      async (creds) =>
        MinseiAPI.checkError(
          await this.post<MinseiStreamingUrls>(
            "/cwa/win/minsei/music/playLog/GetMusicStreamingURL.api",
            { requestNo, ...creds },
          ),
        ),
      {
        policy: this.retryPolicy,
        sessionLost: tokenRefused,
        label: `DAM streaming URLs ${requestNo}`,
      },
    );
  }

  getScoringData(requestNo: string) {
    return withSession(
      this.credsProvider,
      async (creds) => {
        const body = await this.post<Partial<MinseiResponse> | ArrayBuffer>(
          "/cwa/win/minsei/scoring/GetScoringReferenceData.api",
          { requestNo, ...creds },
        );
        if (body instanceof ArrayBuffer) return body;
        // DAM's answer instead of the data: an error code, or none for a
        // song without scoring data, which no retry changes.
        if (typeof body.statusCode === "string") {
          MinseiAPI.checkError(body as MinseiResponse);
        }
        throw new Error(`DAM has no scoring data for ${requestNo}`);
      },
      {
        policy: this.retryPolicy,
        sessionLost: tokenRefused,
        label: `DAM scoring data ${requestNo}`,
      },
    );
  }
}

const BASE_DKWEBSYS_REQUEST = {
  modelTypeCode: "2",
  minseiModelNum: "M1",
  compId: "1",
  authKey: "2/Qb9R@8s*",
};

interface DkwebsysReponse {
  result: {
    statusCode: string;
    message: string;
    detailMessage?: string;
  };
}

interface GetMusicDetailInfoResponse extends DkwebsysReponse {
  data: {
    artistCode: number;
    artist: string;
    requestNo: string;
    title: string;
    titleYomi_Kana: string;
    firstLine: string;
  };

  list: {
    mModelMusicInfoList: {
      highlightTieUp: string;
      shift: string;
      thumbnailType: string;
      thumbnailPath: string;
      guideVocal: string;
      playtime: string;
      contentTypeId: string;
      contentTypeName: string;
      scoreLevel: number;
      technicalLevel: number;
      scoreFlag: string;
      lyricsImageFlag: string;
      myListFlag: string;
      damTomoPublicVocalFlag: string;
      damTomoPublicMovieFlag: string;
      damTomoPublicRecordingFlag: string;
    }[];
  }[];
}

interface SearchMusicByKeywordResponse extends DkwebsysReponse {
  data: {
    totalCount: number;
  };
  list: {
    requestNo: string;
    title: string;
    titleYomi: string;
    artist: string;
    artistYomi: string;
  }[];
}

interface SearchArtistByKeywordResponse extends DkwebsysReponse {
  data: {
    totalCount: number;
  };
  list: {
    artist: string;
    artistCode: number;
    artistYomi: string;
    holdMusicCount: number;
  }[];
}

interface GetMusicListByArtistResponse extends DkwebsysReponse {
  data: {
    artistCode: number;
    artist: string;
    artistYomi_Kana: string;
    totalCount: number;
  };
  list: {
    requestNo: string;
    title: string;
    titleYomi: string;
    artist: string;
    artistYomi: string;
  }[];
}

// The URL of a song's karaoke video title card (a 640×360 PNG), from
// GetMusicDetailInfo's thumbnailPath, which leaves DAM's app key out: it is
// filled in. null if the song has none, or the path isn't DAM's thumbnail
// API.
export function damPictureUrl(
  thumbnailPath: string | null | undefined,
): string | null {
  if (!thumbnailPath) return null;
  let url: URL;
  try {
    url = new URL(thumbnailPath);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "csgw.clubdam.com" ||
    url.pathname !== "/minsei/music/info/GetNewThumbnail.api" ||
    !url.searchParams.get("imageKey")
  ) {
    return null;
  }
  url.searchParams.set("compId", BASE_DKWEBSYS_REQUEST.compId);
  url.searchParams.set("compAuthKey", BASE_DKWEBSYS_REQUEST.authKey);
  return url.toString();
}

// DAM's text fields say "undefined" (the text) for nothing, as a song with
// no tie-up does: null then.
export function damText(value: string | null | undefined): string | null {
  return value && value !== "undefined" ? value : null;
}

export class DkwebsysAPI {
  baseURL = "https://csgw.clubdam.com";

  post<T>(url: string, data: object): Promise<T> {
    const body = {
      ...BASE_DKWEBSYS_REQUEST,
      ...data,
    };
    console.debug(
      `[dkwebsys] curl ${this.baseURL}${url} --json '${JSON.stringify(body)}'`,
    );
    return http<T>(`${this.baseURL}${url}`, {
      method: "POST",
      body,
      headers: {
        "User-Agent": "WindowsApplication",
      },
    });
  }

  checkError<T extends DkwebsysReponse>(data: T) {
    if (data.result.statusCode !== "0000") {
      throw new Error(`${data.result.message}: ${data.result.detailMessage}`);
    }
    return data;
  }

  getMusicDetailsInfo(requestNo: string) {
    return this.post<GetMusicDetailInfoResponse>(
      "/dkwebsys/search-api/GetMusicDetailInfoApi",
      { requestNo },
    ).then(this.checkError);
  }

  getMusicByKeyword(keyword: string, first: number, after: number) {
    return this.getPages<SearchMusicByKeywordResponse>(
      "/dkwebsys/search-api/SearchMusicByKeywordApi",
      { keyword },
      first,
      after,
    );
  }

  getArtistByKeyword(keyword: string, first: number, after: number) {
    return this.getPages<SearchArtistByKeywordResponse>(
      "/dkwebsys/search-api/SearchArtistByKeywordApi",
      { keyword },
      first,
      after,
    );
  }

  getMusicListByArtist(artistCode: string, first: number, after: number) {
    return this.getPages<GetMusicListByArtistResponse>(
      "/dkwebsys/search-api/GetMusicListByArtistApi",
      { artistCode },
      first,
      after,
    );
  }

  // The search APIs return 30 results a page: fetch the pages that cover
  // results [after, after + first) and join their lists.
  private getPages<
    T extends DkwebsysReponse & { data: unknown; list: unknown[] },
  >(
    url: string,
    params: object,
    first: number,
    after: number,
  ): Promise<Pick<T, "data" | "list">> {
    const { firstPage, pageCount, start, end } = damPageWindow(after, first);

    return Promise.all(
      [...Array(pageCount).keys()].map((pageOffset) =>
        this.post<T>(url, {
          ...params,
          sort: "2",
          pageNo: (firstPage + pageOffset).toString(),
          dispCount: DAM_PAGE_SIZE.toString(),
        }).then(this.checkError),
      ),
    ).then((results) => ({
      data: results[0].data,
      list: results
        .reduce<unknown[]>((acc, cur) => acc.concat(cur.list), [])
        .slice(start, end) as T["list"],
    }));
  }
}
