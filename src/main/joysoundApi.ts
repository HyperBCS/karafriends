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

// A song's versions (the TV app's ServiceType): with a synthesised guide
// melody on the audio's third channel, as karafriends has always downloaded
// it; or, for some songs, another recording with a sung guide vocal there.
const GUIDE_MELODY = "003000761";
const GUIDE_VOCAL = "003000762";
const serviceType = (guideVocal: boolean) =>
  guideVocal ? GUIDE_VOCAL : GUIDE_MELODY;

const CONTENTS_LIST = "/api/v1/spc/contentsList";

// Joysound's featured lists: the TV app's home screen's, a static file.
const FEATURES_PATH = "/static/json/feature_tv.json";

// How long Browse's genres and featured lists are kept: they change
// rarely, and every phone opening Browse asks for them.
const BROWSE_KEPT_MS = 60 * 60_000;

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
            | {
                selSongNo?: string;
                lyricIntro?: string | null;
                serviceTypeList?: { serviceType?: string }[] | null;
              }[]
            | null;
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

// One of Joysound's genres (J-POP, 演歌, アニメ...).
export interface JoysoundGenre {
  id: string;
  name: string;
}

// One of Joysound's featured lists ("バラードソング特集"): its songs' numbers,
// in its order, and its picture (690×340), if any.
export interface JoysoundFeature {
  id: string;
  title: string;
  description: string;
  songNumbers: string[];
  pictureUrl: string | null;
}

interface GenreListAnswer {
  genreList?: { genreId?: string; genreName?: string }[] | null;
}

// New songs, by the date they came: the newest group first.
interface UpListAnswer {
  hitCount?: string;
  upList?: { contentsList?: JoysoundSongListItem[] | null }[] | null;
}

export interface FeatureFile {
  feature?: {
    id?: unknown;
    title?: unknown;
    description?: unknown;
    song_number?: unknown;
    thumbnail_img?: unknown;
  }[];
}

// The featured lists from feature_tv.json: well-formed ones only, and the
// first of two with one id (the file has had two "12"s).
// A sentence, up to and with its end (。！？♪ and the like, and the
// brackets that close after it), or what's left at the end.
const SENTENCE = /[^。！!？?♪💖]*[。！!？?♪💖]+[）」』)]*|[^。！!？?♪💖]+$/gu;

// The TV app's own pitch: its うたう button, its sign-up, its name, a QR
// code on its screen. None of that is karafriends'.
const TV_APP_PITCH = /「うたう」|会員登録|ジョイサウンドカフェ|QRコード/;

// A featured list's description without the sentences written for the TV
// app (see TV_APP_PITCH): "会員登録がまだの人も、「うたう」を押して無料カラオケ
// 体験を♪" and the like.
export function withoutTvAppPitch(text: string): string {
  return (text.match(SENTENCE) ?? [])
    .filter((sentence) => !TV_APP_PITCH.test(sentence))
    .join("")
    .trim();
}

export function featuresOf(file: FeatureFile): JoysoundFeature[] {
  const seen = new Set<string>();
  const features: JoysoundFeature[] = [];
  for (const entry of file.feature ?? []) {
    const id = String(entry.id ?? "");
    if (!/^\d+$/.test(id) || seen.has(id) || typeof entry.title !== "string") {
      continue;
    }
    const songNumbers = (
      Array.isArray(entry.song_number) ? entry.song_number : []
    )
      .map(String)
      .filter((number) => /^\d+$/.test(number));
    if (songNumbers.length === 0) continue;
    seen.add(id);
    features.push({
      id,
      title: entry.title,
      // Lines cut for the TV's width, of one paragraph.
      description: withoutTvAppPitch(
        Array.isArray(entry.description)
          ? entry.description
              .filter((line) => typeof line === "string")
              .join("")
          : typeof entry.description === "string"
            ? entry.description
            : "",
      ),
      songNumbers,
      pictureUrl:
        typeof entry.thumbnail_img === "string" && entry.thumbnail_img !== ""
          ? entry.thumbnail_img
          : null,
    });
  }
  return features;
}

// A value kept for keptMs once loaded: one load at a time, and a failure
// isn't kept.
export function keptFor<T>(keptMs: number, load: () => Promise<T>) {
  let kept: { value: Promise<T>; at: number } | null = null;
  return (now = Date.now()): Promise<T> => {
    if (!kept || now - kept.at >= keptMs) {
      const value = load();
      const entry = { value, at: now };
      kept = entry;
      value.catch(() => {
        if (kept === entry) kept = null;
      });
    }
    return kept.value;
  };
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
  // Whether it has a guide-vocal version (getSongData's guideVocal).
  guideVocal: boolean;
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
function checkId(id: string, what: "song number" | "artist ID" | "genre ID") {
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
    kind: "song" | "artist" | "selArtist_digi" | "selGenre" | "selSongNo";
    word: string;
    match: "partial" | "exact";
  },
  sort: "popular" | "name" | "songName",
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

// A page of one of the lists, and how many the whole list has (its
// hitCount), or null if Joysound didn't say.
export interface JoysoundListPage<T> {
  items: T[];
  total: number | null;
}

function pageOf<T>(
  answer: ContentsListAnswer,
  rows: T[] | null | undefined,
): JoysoundListPage<T> {
  const hitCount = answer.hitCount;
  return {
    items: rows ?? [],
    total:
      typeof hitCount === "string" && /^\d+$/.test(hitCount)
        ? Number(hitCount)
        : null,
  };
}

// A search's answer when no Joysound login is set: no results, without a
// request, so a DAM-only host's phones search DAM without an error.
// Any other failure rejects, and the phone shows it with a Retry button.
function noResultsWithoutLogin<T>(err: unknown): JoysoundListPage<T> {
  if (err instanceof NoLoginError) return { items: [], total: null };
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
    guideVocal: (selection?.serviceTypeList ?? []).some(
      (type) => type.serviceType === GUIDE_VOCAL,
    ),
    name: detail.songName,
    artistName: detail.artistInfo?.artistName ?? "",
    lyricsPreview: selection?.lyricIntro ?? "",
    tieUp: (detail.tieupList ?? [])
      .map((tieUp) => tieUp.tieupName)
      .filter((name): name is string => typeof name === "string" && name !== "")
      .join(" / "),
  };
}

// The background video to use: one of the song's (mov1 to mov5, stock
// footage all of one quality), picked at random, so a song downloaded again
// may look different. null if there's none.
export function backgroundVideoUrl(
  list: JoysoundMovieList,
  random: () => number = Math.random,
): string | null {
  const movies = list.movie ?? {};
  const urls = Object.keys(movies)
    .sort()
    .map((key) => movies[key])
    .filter((url): url is string => typeof url === "string" && url !== "");
  if (urls.length === 0) return null;
  return urls[Math.min(Math.floor(random() * urls.length), urls.length - 1)];
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
    `The linked Joysound account has no paid membership ` +
      `(${membershipType ?? "none"}), so Joysound sends only previews`,
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

  // Browse's genres, kept for BROWSE_KEPT_MS.
  private keptGenres = keptFor(BROWSE_KEPT_MS, async () =>
    (
      (await this.post<GenreListAnswer>("/api/v1/spc/genreList", undefined))
        .genreList ?? []
    ).flatMap((genre): JoysoundGenre[] =>
      typeof genre.genreId === "string" &&
      /^\d+$/.test(genre.genreId) &&
      typeof genre.genreName === "string"
        ? [{ id: genre.genreId, name: genre.genreName }]
        : [],
    ),
  );

  // Browse's featured lists, kept for BROWSE_KEPT_MS. A static file, not
  // the TV API, but asked for only with a link, as the rest of Joysound:
  // without a login, a NoLoginError.
  private keptFeatures = keptFor(BROWSE_KEPT_MS, () =>
    withSession(
      this.link,
      async () => {
        const url = `${this.baseURL}${FEATURES_PATH}`;
        const file = await readBody<FeatureFile | string>(
          await httpFetch(url, { headers: { "User-Agent": TV_USER_AGENT } }),
          url,
        );
        if (typeof file !== "object") {
          throw new Error("Joysound's featured lists aren't data");
        }
        return featuresOf(file);
      },
      { label: "Joysound featured lists" },
    ),
  );

  // path with the shared link, and with policy's retries.
  private post<T extends object>(
    path: string,
    body: object | undefined,
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
      .then((answer) => pageOf(answer, answer.contentsList))
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
      .then((answer) => pageOf(answer, answer.artistList))
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
      .then((answer) => pageOf(answer, answer.contentsList))
      .catch(noResultsWithoutLogin<JoysoundSongListItem>);
  }

  // Joysound's genres, for Browse.
  getGenres(): Promise<JoysoundGenre[]> {
    return this.keptGenres();
  }

  // A genre's songs, most popular first.
  async getSongListByGenre(genreId: string, start: number, count: number) {
    checkId(genreId, "genre ID");
    return this.post<ContentsListAnswer>(
      CONTENTS_LIST,
      contentsListRequest(
        { kind: "selGenre", word: genreId, match: "exact" },
        "popular",
        "desc",
        "all",
        start,
        count,
      ),
    ).then((answer) => pageOf(answer, answer.contentsList));
  }

  // Joysound's newest songs, newest first: one list (about 100).
  async getNewSongs(): Promise<JoysoundSongListItem[]> {
    const answer = await this.post<UpListAnswer>(
      "/api/v1/spc/upList",
      undefined,
    );
    return (answer.upList ?? []).flatMap((group) => group.contentsList ?? []);
  }

  // Joysound's featured lists, for Browse.
  getFeatures(): Promise<JoysoundFeature[]> {
    return this.keptFeatures();
  }

  // Songs by their numbers, in that order (a featured list's), in one
  // request, as the TV app asks. Numbers Joysound doesn't know are left out.
  async getSongsByNumber(numbers: string[]): Promise<JoysoundSongListItem[]> {
    for (const number of numbers) checkId(number, "song number");
    if (numbers.length === 0) return [];
    const answer = await this.post<ContentsListAnswer>(
      CONTENTS_LIST,
      contentsListRequest(
        { kind: "selSongNo", word: numbers.join(","), match: "exact" },
        "songName",
        "asc",
        "all",
        1,
        numbers.length,
      ),
    );
    const rows = new Map(
      (answer.contentsList ?? []).map((row) => [row.selSongNo, row]),
    );
    return numbers.flatMap((number) => rows.get(number) ?? []);
  }

  async getSongDetail(id: string): Promise<JoysoundSongDetail> {
    checkId(id, "song number");
    const answer = await this.post<ContentsDetailAnswer>(
      "/api/v1/spc/contentsDetail",
      { songNumber: id },
    );
    return songDetailOf(id, answer);
  }

  async getMovieUrls(id: string, guideVocal = false) {
    checkId(id, "song number");
    return this.post<JoysoundMovieList>(
      "/api/v1/spc/contentsInfo",
      { songNumber: id, serviceType: serviceType(guideVocal) },
      this.retryPolicy,
    );
  }

  // getFME for the whole song, at the original key. A preview (any
  // membership but PAID) is a SessionLostError: the link may have ended.
  private async getFme(
    link: JoysoundLink,
    id: string,
    guideVocal: boolean,
  ): Promise<GetFmeAnswer> {
    const answer = await tvPost<GetFmeAnswer>(
      this.baseURL,
      "/api/v1/spc/getFME",
      link.linkCode,
      { songNumber: id, serviceType: serviceType(guideVocal), key: 0 },
    );
    if (answer.membershipType !== "PAID") throw notPaid(answer.membershipType);
    return answer;
  }

  // The song's lyrics data and its audio, for a paid member's link. Every
  // try asks getFME again, so each has a fresh audio URL; an audio URL
  // refused as if it had run out gets one more fresh one.
  async getSongData(id: string, guideVocal = false): Promise<JoysoundSongData> {
    checkId(id, "song number");
    return withSession(
      this.link,
      async (link) => {
        if (link.membershipType !== "PAID") throw notPaid(link.membershipType);
        const fme = await this.getFme(link, id, guideVocal);
        const telop = decodeTelop(fme.telop, id);
        const ogg = await fetchAudio(fme.streaming_wifi_url, id).catch(
          async (err) => {
            if (!mayHaveExpired(err)) throw err;
            console.warn(
              `Joysound getFME ${id}: asking for a new audio URL after:`,
              (err as Error).message,
            );
            const again = await this.getFme(link, id, guideVocal);
            return fetchAudio(again.streaming_wifi_url, id);
          },
        );
        return { telop, ogg };
      },
      {
        policy: this.retryPolicy,
        label: `Joysound getFME ${id}${guideVocal ? " (guide vocal)" : ""}`,
      },
    );
  }
}
