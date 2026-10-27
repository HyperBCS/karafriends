import promiseRetry from "promise-retry";

import { formBody, http, httpFetch } from "./http";
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

const MINSEI_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "WindowsApplication",
  "win10-access-key": "mbAmgk3GuCOKAgL8dCQR",
};

export type MinseiCredentialsProvider = () => Promise<{
  userCode: string;
  authToken: string;
}>;

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

  constructor(credsProvider: MinseiCredentialsProvider) {
    this.credsProvider = credsProvider;
  }

  // The fixed fields, then data's (the song, the login) percent-encoded.
  post<T>(url: string, data: Record<string, string>): Promise<T> {
    const body = `${BASE_MINSEI_BODY}&${formBody(data)}`;
    console.debug(
      `[minsei] curl ${this.baseURL}${url} -d '${JSON.stringify(body)}'`,
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
      throw new Error(`${data.status} ${data.statusCode}: ${data.message}`);
    }
    return data;
  }

  // The body is read whatever the HTTP status, so a rejected login reports
  // DAM's own status code and message through checkError.
  static login(loginId: string, password: string) {
    return httpFetch(
      `https://win10.clubdam.com/cwa/win/minsei/auth/LoginByDamtomoMemberId.api`,
      {
        method: "POST",
        body: formBody({ loginId, password, format: "json" }),
        headers: MINSEI_HEADERS,
      },
    )
      .then((data) => data.json() as Promise<MinseiLogin>)
      .then((data) => MinseiAPI.checkError(data));
  }

  getMusicStreamingUrls(requestNo: string) {
    // This endpoint seems to be flaky
    return promiseRetry((retry) =>
      this.credsProvider()
        .then((creds) =>
          this.post<MinseiStreamingUrls>(
            "/cwa/win/minsei/music/playLog/GetMusicStreamingURL.api",
            { requestNo, ...creds },
          ),
        )
        .then(MinseiAPI.checkError)
        .catch((err) => {
          console.error(err);
          return retry(err);
        }),
    );
  }

  getScoringData(requestNo: string) {
    // This endpoint seems to be flaky
    return promiseRetry((retry) =>
      this.credsProvider()
        .then((creds) =>
          this.post<object | ArrayBuffer>(
            "/cwa/win/minsei/scoring/GetScoringReferenceData.api",
            { requestNo, ...creds },
          ),
        )
        .then((body) => {
          if (!(body instanceof ArrayBuffer)) {
            return Promise.reject(
              "Scoring data was not returned in binary format",
            );
          }
          return body;
        })
        .catch((err) => {
          console.error(err);
          return retry(err);
        }),
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
