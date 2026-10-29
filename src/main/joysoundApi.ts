// Joysound through the JOYSOUND TV app's API (jp.co.xing.joysoundcafetv
// 1.1.0; checked live on 2026-10-29): JSON POSTs to sound-cafe.jp's
// /api/v1, each sent with the link code of karafriends' link to the host's
// account (joysoundLink.ts). No web pages, cookies or CSRF tokens.
//
// The link code stands for the account, and getFME's audio URL is signed:
// neither goes into a log line or an error's message.
//
// No Electron imports, so unit tests can load this file under plain Node.
import { ApiError } from "./api";
import { NoLoginError } from "./credentials";
import {
  httpFetch,
  HttpStatusError,
  NO_RETRIES,
  QUICK_RETRIES,
  readBody,
  type RetryPolicy,
  type Session,
  SessionLostError,
  withSession,
  withUrlHidden,
} from "./http";

export const JOYSOUND_BASE_URL = "https://www.sound-cafe.jp";

// The song with its guide melody (the TV app's GUIDE_MELODY), as karafriends
// has always downloaded it. (GUIDE_VOCAL, 003000762, is untested.)
const SERVICE_TYPE = "003000761";

const CONTENTS_LIST = "/api/v1/spc/contentsList";

// What the TV app's OkHttp client sends with each request, with karafriends
// as the device. These values were accepted in the live tests.
const TV_USER_AGENT = "okhttp/4.12.0";
function tvHeaders(linkCode: string): Record<string, string> {
  return {
    "X-LinkCode": linkCode,
    "X-OSName": "Android",
    "X-OSVer": "32",
    "X-Brand": "karafriends",
    "X-Device": "karafriends",
    "User-Agent": TV_USER_AGENT,
  };
}

// karafriends' link to the account (joysoundLink.ts).
export interface JoysoundLink {
  // Sent as X-LinkCode. A secret.
  linkCode: string;
  // linkInfo's when the link was checked: "PAID" for a paid member, else
  // "FREE", "NONE" or null.
  membershipType: string | null;
}

// The shared link (credentials.joysound): forget drops one that has stopped
// working, so the next request checks it again (and links again if need be).
export type JoysoundLinkProvider = Session<JoysoundLink>;

interface ServiceTypeData {
  serviceType: string;
}

// A row of contentsList's songs. IDs are text.
interface JoysoundSongListItem {
  selSongNo: string;
  songName: string;
  artistName: string;
  artistId_digi: string;
  serviceTypeList: ServiceTypeData[] | null;
}

// A row of contentsList's artists (format artist_digi).
interface JoysoundArtistListItem {
  artistName: string;
  artistId_digi: string;
}

// contentsList's answer: songs in contentsList, or artists in artistList,
// the other null. hitCount is text.
interface ContentsListAnswer {
  hitCount?: string;
  contentsList?: JoysoundSongListItem[] | null;
  artistList?: JoysoundArtistListItem[] | null;
}

interface ContentsDetailAnswer {
  spcContentsDetailResponse?: {
    selSongNo?: string;
    songName?: string;
    artistInfo?: { artistName?: string; artistId_digi?: string } | null;
    // A selection per "apl", each with its own song number and first line.
    aplList?:
      | {
          aplId?: string;
          selectionList?:
            { selSongNo?: string; lyricIntro?: string | null }[] | null;
        }[]
      | null;
    tieupList?: { tieupName?: string | null }[] | null;
    // Album art, from Amazon (three sizes) and Apple: "" for none.
    outsideUrlInfo?: {
      amazonInfo?: {
        songImageUrl?: string | null;
        songImageUrlLarge?: string | null;
      } | null;
      itunesInfo?: { songImageUrl?: string | null } | null;
    } | null;
  } | null;
}

interface GetFmeAnswer {
  slc?: string;
  // The lyrics and their timing: JOY-02 data, in plain base64.
  telop?: string;
  // "PAID" when the whole song came. A free or unlinked code still gets an
  // answer (with 200), but a preview's.
  membershipType?: string | null;
  // Seems to say whether the song is free to play, not whether the account
  // is paid: it was false for a paid member's whole song.
  isFree?: boolean;
  // The song's audio (Ogg), at a signed URL.
  streaming_wifi_url?: string | null;
}

export interface JoysoundMovieList {
  slc: string;
  // Background videos, mov1 to mov5. Any may be missing.
  movie: Record<string, string | undefined> | null;
}

export interface JoysoundSongDetail {
  name: string;
  artistName: string;
  // The song's first line, or "".
  lyricsPreview: string;
  // Its tie-ups (a drama, a region...), " / " between them, or "".
  tieUp: string;
  // Its album art: Amazon's largest (500 px), else Amazon's (160 px), else
  // Apple's (100 px). null if none.
  pictureUrl: string | null;
}

// A song as its download needs it.
export interface JoysoundSongData {
  // The lyrics and their timing (joysoundParser.ts reads them).
  telop: Buffer;
  // The song's audio: Ogg Vorbis, 3 channels, with a playtime=<ms> comment.
  ogg: Buffer;
}

// Joysound's song numbers and artist IDs are digits. Anything else (from a
// phone) is refused before it goes into a request.
function checkId(id: string, what: "song number" | "artist ID") {
  if (!/^\d+$/.test(id)) {
    throw new ApiError(400, `Not a Joysound ${what}: ${JSON.stringify(id)}`);
  }
}

// One TV API request, with body as JSON (no body if none). The answer must
// be JSON data. Errors name the path, never the code.
export async function tvPost<T extends object>(
  baseURL: string,
  path: string,
  linkCode: string,
  body?: object,
): Promise<T> {
  const url = `${baseURL}${path}`;
  const answer = await readBody<unknown>(
    await httpFetch(url, {
      method: "POST",
      headers: tvHeaders(linkCode),
      body,
    }),
    url,
  );
  if (
    typeof answer !== "object" ||
    answer === null ||
    answer instanceof ArrayBuffer
  ) {
    throw new Error(`Joysound answered ${path} with something other than data`);
  }
  return answer as T;
}

// What the song and artist lists send. start counts from 1, as on the
// website (the TV app starts at 1, and 0 gives the same page).
function contentsListRequest(
  param: {
    kind: "song" | "artist" | "selArtist_digi";
    word: string;
    match: "partial" | "exact";
  },
  sort: "popular" | "name",
  order: "asc" | "desc",
  format: "all" | "artist_digi",
  start: number,
  count: number,
) {
  return {
    params: [param],
    sort,
    order,
    format,
    start: String(start),
    count: String(count),
    facet: "false",
  };
}

// A search's answer when no Joysound login is set: no results, without a
// request, so a DAM-only host's phones search DAM without an error.
// Any other failure rejects, and the phone shows it with a Retry button.
function noResultsWithoutLogin<T>(err: unknown): T[] {
  if (err instanceof NoLoginError) return [];
  throw err;
}

// contentsDetail's answer as the song page shows it. The lyrics preview is
// the selection with the song's own number: a song can have several.
export function songDetailOf(
  id: string,
  answer: ContentsDetailAnswer,
): JoysoundSongDetail {
  const detail = answer.spcContentsDetailResponse;
  if (!detail || typeof detail.songName !== "string") {
    throw new Error(`Joysound sent no details for song ${id}`);
  }
  const selection = (detail.aplList ?? [])
    .flatMap((apl) => apl.selectionList ?? [])
    .find((candidate) => candidate.selSongNo === id);
  const art = detail.outsideUrlInfo;
  const pictureUrl =
    [
      art?.amazonInfo?.songImageUrlLarge,
      art?.amazonInfo?.songImageUrl,
      art?.itunesInfo?.songImageUrl,
    ].find((url): url is string => typeof url === "string" && url !== "") ??
    null;
  return {
    pictureUrl,
    name: detail.songName,
    artistName: detail.artistInfo?.artistName ?? "",
    lyricsPreview: selection?.lyricIntro ?? "",
    tieUp: (detail.tieupList ?? [])
      .map((tieUp) => tieUp.tieupName)
      .filter((name): name is string => typeof name === "string" && name !== "")
      .join(" / "),
  };
}

// The background video to use: mov1, as before, or else the first other
// one there is. null if there's none.
export function backgroundVideoUrl(list: JoysoundMovieList): string | null {
  const movies = list.movie ?? {};
  const keys = Object.keys(movies)
    .filter((key) => key !== "mov1")
    .sort();
  const url = ["mov1", ...keys]
    .map((key) => movies[key])
    .find((candidate) => typeof candidate === "string" && candidate !== "");
  return url ?? null;
}

// getFME's lyrics: plain base64 of JOY-02 data. (The website's player moved
// the first 30 characters to the end; the TV API doesn't.)
function decodeTelop(telop: unknown, id: string): Buffer {
  const data = Buffer.from(typeof telop === "string" ? telop : "", "base64");
  if (data.toString("latin1", 0, 6) !== "JOY-02") {
    throw new Error(`Joysound's lyrics data for song ${id} isn't JOY-02`);
  }
  return data;
}

// Whether the audio URL may only have run out: a fresh one may work.
function mayHaveExpired(err: unknown): boolean {
  return (
    err instanceof HttpStatusError && [401, 403, 404, 410].includes(err.status)
  );
}

// The song's audio, from getFME's signed URL, sent with nothing of the
// link's. An answer that isn't Ogg (an error page with 200, say) fails.
async function fetchAudio(url: unknown, id: string): Promise<Buffer> {
  const what = `Joysound's audio for song ${id}`;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error(`Joysound sent no audio URL for song ${id}`);
  }
  return withUrlHidden(url, what, async () => {
    const resp = await httpFetch(url, {
      headers: { "User-Agent": TV_USER_AGENT },
    });
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      throw new HttpStatusError(resp.status, what, resp.statusText);
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    if (audio.toString("latin1", 0, 4) !== "OggS") {
      throw new Error(
        `${what} isn't Ogg audio (${
          resp.headers.get("Content-Type") ?? "no type"
        }, ${audio.length} bytes)`,
      );
    }
    return audio;
  });
}

// Why a song's download can't be the whole song: the link's account isn't a
// paid member. withSession checks the link again once, in case it changed.
function notPaid(membershipType: string | null | undefined): SessionLostError {
  return new SessionLostError(
    `The Joysound account karafriends is linked to isn't a paid member ` +
      `(membership: ${membershipType ?? "none"}), so Joysound sends only previews`,
  );
}

export class JoysoundAPI {
  baseURL = JOYSOUND_BASE_URL;
  link: JoysoundLinkProvider;
  // For the downloads (getFME and its audio, contentsInfo). Lookups aren't
  // tried again: the phone that asked shows the error.
  retryPolicy: RetryPolicy = QUICK_RETRIES;

  constructor(link: JoysoundLinkProvider) {
    this.link = link;
  }

  // path with the shared link, and with policy's retries.
  private post<T extends object>(
    path: string,
    body: object,
    policy: RetryPolicy = NO_RETRIES,
  ): Promise<T> {
    return withSession(
      this.link,
      (link) => tvPost<T>(this.baseURL, path, link.linkCode, body),
      { policy, label: `Joysound ${path}` },
    );
  }

  // Most popular first. ("desc": the TV API's "asc" is least popular
  // first, unlike the website's.)
  getSongListByKeyword(keyword: string, start: number, count: number) {
    return this.post<ContentsListAnswer>(
      CONTENTS_LIST,
      contentsListRequest(
        { kind: "song", word: keyword, match: "partial" },
        "popular",
        "desc",
        "all",
        start,
        count,
      ),
    )
      .then((answer) => answer.contentsList ?? [])
      .catch(noResultsWithoutLogin<JoysoundSongListItem>);
  }

  // By name. ("kind: compound" would match song names too.)
  getArtistListByKeyword(keyword: string, start: number, count: number) {
    return this.post<ContentsListAnswer>(
      CONTENTS_LIST,
      contentsListRequest(
        { kind: "artist", word: keyword, match: "partial" },
        "name",
        "asc",
        "artist_digi",
        start,
        count,
      ),
    )
      .then((answer) => answer.artistList ?? [])
      .catch(noResultsWithoutLogin<JoysoundArtistListItem>);
  }

  // Most popular first, as getSongListByKeyword.
  async getSongListByArtist(artistId: string, start: number, count: number) {
    checkId(artistId, "artist ID");
    return this.post<ContentsListAnswer>(
      CONTENTS_LIST,
      contentsListRequest(
        { kind: "selArtist_digi", word: artistId, match: "exact" },
        "popular",
        "desc",
        "all",
        start,
        count,
      ),
    )
      .then((answer) => answer.contentsList ?? [])
      .catch(noResultsWithoutLogin<JoysoundSongListItem>);
  }

  async getSongDetail(id: string): Promise<JoysoundSongDetail> {
    checkId(id, "song number");
    const answer = await this.post<ContentsDetailAnswer>(
      "/api/v1/spc/contentsDetail",
      { songNumber: id },
    );
    return songDetailOf(id, answer);
  }

  async getMovieUrls(id: string) {
    checkId(id, "song number");
    return this.post<JoysoundMovieList>(
      "/api/v1/spc/contentsInfo",
      { songNumber: id, serviceType: SERVICE_TYPE },
      this.retryPolicy,
    );
  }

  // getFME for the whole song, at the original key. A preview (any
  // membership but PAID) is a SessionLostError: the link may have ended.
  private async getFme(link: JoysoundLink, id: string): Promise<GetFmeAnswer> {
    const answer = await tvPost<GetFmeAnswer>(
      this.baseURL,
      "/api/v1/spc/getFME",
      link.linkCode,
      { songNumber: id, serviceType: SERVICE_TYPE, key: 0 },
    );
    if (answer.membershipType !== "PAID") throw notPaid(answer.membershipType);
    return answer;
  }

  // The song's lyrics data and its audio, for a paid member's link. Every
  // try asks getFME again, so each has a fresh audio URL; an audio URL
  // refused as if it had run out gets one more fresh one.
  async getSongData(id: string): Promise<JoysoundSongData> {
    checkId(id, "song number");
    return withSession(
      this.link,
      async (link) => {
        if (link.membershipType !== "PAID") throw notPaid(link.membershipType);
        const fme = await this.getFme(link, id);
        const telop = decodeTelop(fme.telop, id);
        const ogg = await fetchAudio(fme.streaming_wifi_url, id).catch(
          async (err) => {
            if (!mayHaveExpired(err)) throw err;
            console.warn(
              `Joysound getFME ${id}: asking for a new audio URL after:`,
              (err as Error).message,
            );
            const again = await this.getFme(link, id);
            return fetchAudio(again.streaming_wifi_url, id);
          },
        );
        return { telop, ogg };
      },
      { policy: this.retryPolicy, label: `Joysound getFME ${id}` },
    );
  }
}
