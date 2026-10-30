// karafriends' link to the host's Joysound account. The TV API
// (joysoundApi.ts) takes a link code where the website took a login: Joysound
// issues the code, the account authorizes it, and from then on the code
// stands for the account, as a JOYSOUND TV app would.
//
// The TV app shows a QR code for a signed-in phone to open. karafriends
// authorizes the code itself with the saved email and password: signed in
// to the website, it opens /mypage/tvlink/<code>, which links it. That page
// is the authorization itself (checked 2026-10-29), not one to look at. The
// code is kept between launches in a LinkStore, with the account it was
// made for, and checked with linkInfo once a run.
//
// An account links one TV app at a time. When another holds the link, the
// page asks whether to switch it (/mypage/tvlink/linkedConfirm), which would
// unlink the other one: karafriends doesn't, and says so (TvLinkTakenError)
// until the host presses Switch in Settings (switchLink, the page's
// "?force=1").
//
// The code is a secret: it never goes into a log line or an error's
// message, and never into config.yaml (so Export config leaves it out).
//
// No Electron imports, so unit tests can load this file under plain Node.
import {
  type LoginNote,
  LoginRejectedError,
  LoginWarning,
} from "./credentials";
import {
  formBody,
  getSetCookies,
  httpFetch,
  type HttpResponse,
  HttpStatusError,
  readBody,
  withUrlHidden,
} from "./http";
import { JOYSOUND_BASE_URL, type JoysoundLink, tvPost } from "./joysoundApi";

// What the link store keeps.
export interface StoredLink {
  // The joysoundEmail the code was made for, as it was typed.
  account: string;
  linkCode: string;
}

// Where the link is kept: in services.ts, a file in userData encrypted by
// the OS. load() and save() never reject.
export interface LinkStore {
  load(): Promise<StoredLink | null>;
  save(link: StoredLink | null): Promise<void>;
}

export interface LinkInfo {
  // false once the code has run out or been unlinked.
  isValid: boolean;
  isLinked: boolean;
  // "PAID" for a paid member; "FREE", "NONE" or null otherwise.
  membershipType: string | null;
}

// How the kept link stands, for the settings' Test login.
export type LinkStatus =
  // No code for this account yet.
  | { state: "none" }
  // Issued, but not authorized yet: a link that stopped halfway.
  | { state: "pending" }
  // Not authorized: the last try found another TV app holding the link.
  | { state: "taken" }
  // linkInfo says the code is no longer valid.
  | { state: "ended" }
  | { state: "linked"; membershipType: string | null };

// Another TV app holds the account's link, and karafriends won't unlink it
// by itself. 409, so a phone shows why.
export class TvLinkTakenError extends Error {
  readonly status = 409;
  constructor() {
    super(
      "Another TV app is linked to the host's Joysound account, which links " +
        "one at a time. The host can switch the link to karafriends: " +
        "Settings › Accounts › Joysound, Test login.",
    );
    this.name = "TvLinkTakenError";
  }
}

// How long after finding the link taken karafriends tries the link page
// again, rather than signing in to the website for every request meanwhile.
export const TAKEN_RETRY_MS = 5 * 60_000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0";

// Keyed by cookie name. sound-cafe changes which cookies it sets (JSESSIONID
// is only issued after login, and the CSRF token lives in XSRF-TOKEN), so
// keep whatever it sends instead of a fixed list.
type Cookies = Record<string, string>;

function cookieHeader(cookies: Cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function keepCookies(resp: HttpResponse, target: Cookies) {
  for (const setCookie of getSetCookies(resp)) {
    const matchData = setCookie.match(/^([^=;\s]+)=([^;]*)/);
    if (matchData) target[matchData[1]] = matchData[2];
  }
}

function csrfOf(page: string): string {
  const token = page.match(/<meta name="_csrf" content="([^"]+)"/)?.[1];
  if (!token) {
    throw new Error(
      "Joysound's login page has no CSRF token: it may have changed",
    );
  }
  return token;
}

const sameAccount = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const isStoredLink = (value: unknown): value is StoredLink =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredLink).account === "string" &&
  typeof (value as StoredLink).linkCode === "string" &&
  (value as StoredLink).linkCode !== "";

// Signs in to sound-cafe.jp's website as its login form does, and resolves
// to the signed-in session's cookies. Only for authorizing a link code.
export async function websiteLogin(
  email: string,
  password: string,
  baseURL = JOYSOUND_BASE_URL,
): Promise<Cookies> {
  const cookies: Cookies = {};

  const loginPage = await httpFetch(`${baseURL}/login`, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
  });
  // An error status, 403 usually, means no Japanese IP address.
  if (!loginPage.ok) {
    await loginPage.text().catch(() => "");
    throw new HttpStatusError(loginPage.status, `${baseURL}/login`);
  }
  keepCookies(loginPage, cookies);
  const csrfToken = csrfOf(await loginPage.text());

  const check = await httpFetch(`${baseURL}/login/check`, {
    method: "POST",
    body: formBody({ mailAddress: email, password }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookieHeader(cookies),
      Origin: baseURL,
      Referer: `${baseURL}/login`,
      "User-Agent": BROWSER_USER_AGENT,
      "X-XSRF-TOKEN": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  keepCookies(check, cookies);
  const checked = await readBody<{ result?: unknown } | string>(
    check,
    `${baseURL}/login/check`,
  );
  // 0 means the credentials were accepted; 1 means a wrong email/password.
  const result = typeof checked === "object" ? checked.result : undefined;
  if (result !== 0) {
    throw new LoginRejectedError(
      `Joysound login rejected (result ${String(result)}); check joysoundEmail and joysoundPassword in config.yaml`,
    );
  }

  const submit = await httpFetch(`${baseURL}/login`, {
    method: "POST",
    body: formBody({ _csrf: csrfToken, mailAddress: email, password }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(cookies),
      Origin: baseURL,
      Referer: `${baseURL}/login`,
      "User-Agent": BROWSER_USER_AGENT,
    },
    redirect: "manual",
  });
  keepCookies(submit, cookies);
  await submit.text().catch(() => "");

  // As the browser goes on to the home page: its cookies too.
  const home = await httpFetch(`${baseURL}/`, {
    headers: {
      Cookie: cookieHeader(cookies),
      "User-Agent": BROWSER_USER_AGENT,
    },
  });
  keepCookies(home, cookies);
  await home.text().catch(() => "");
  return cookies;
}

// A new link code. Not authorized yet: it stands for no account.
export async function issueLinkCode(
  baseURL = JOYSOUND_BASE_URL,
): Promise<string> {
  const answer = await tvPost<{ linkCode?: unknown }>(
    baseURL,
    "/api/v1/linkCode",
    "",
  );
  // It goes into a header and a URL.
  if (
    typeof answer.linkCode !== "string" ||
    !/^[\x21-\x7e]+$/.test(answer.linkCode)
  ) {
    throw new Error("Joysound issued no link code karafriends can use");
  }
  return answer.linkCode;
}

// What Joysound says of linkCode. Changes nothing (the TV app asks every 10
// seconds while it waits for the QR code to be opened).
export async function getLinkInfo(
  linkCode: string,
  baseURL = JOYSOUND_BASE_URL,
): Promise<LinkInfo> {
  const answer = await tvPost<Partial<Record<keyof LinkInfo, unknown>>>(
    baseURL,
    "/api/v1/linkInfo",
    linkCode,
    { linkCode },
  );
  if (
    typeof answer.isValid !== "boolean" ||
    typeof answer.isLinked !== "boolean"
  ) {
    throw new Error("Joysound's linkInfo answer makes no sense");
  }
  return {
    isValid: answer.isValid,
    isLinked: answer.isLinked,
    membershipType:
      typeof answer.membershipType === "string" ? answer.membershipType : null,
  };
}

const MAX_REDIRECTS = 5;

// Where the link page sends karafriends when another TV app holds the link.
const LINKED_CONFIRM = "/mypage/tvlink/linkedConfirm";

// Where a redirect from `from` to location goes, on sound-cafe's own host.
// It redirects to http:// URLs (it sits behind a TLS proxy, which takes
// them back to https): those go to https at once, so the session's cookies
// never go out unencrypted. Another host is refused.
export function redirectTarget(location: string, from: URL, base: URL): URL {
  const next = new URL(location, from);
  if (next.hostname !== base.hostname) {
    throw new Error(
      `Joysound's website sent karafriends' link to another site (${next.hostname})`,
    );
  }
  if (next.protocol === "http:" && base.protocol === "https:") {
    next.protocol = "https:";
    next.port = base.port;
  }
  return next;
}

// Links linkCode to the account signed in with cookies, and resolves to the
// path the link page ended on, with the code left out (for an error, if
// linkInfo then says it didn't link). force switches the link from another
// TV app, unlinking it; without it, the page stops at LINKED_CONFIRM and
// this throws a TvLinkTakenError.
//
// The page redirects (from /mypage/tvlink/<code> to another /mypage/tvlink
// page, which links), and node-fetch drops the Cookie header when a
// redirect changes protocol, so the redirects are followed here, with the
// session's cookies, kept up to date at each step. Its HTML isn't read:
// linkInfo says whether it worked.
async function authorizeLinkCode(
  cookies: Cookies,
  linkCode: string,
  baseURL: string,
  force: boolean,
): Promise<string> {
  const base = new URL(baseURL);
  const hide = <T>(run: () => Promise<T>) =>
    withUrlHidden(encodeURIComponent(linkCode), "<link code>", () =>
      withUrlHidden(linkCode, "<link code>", run),
    );
  return hide(async () => {
    let url = new URL(
      `${baseURL}/mypage/tvlink/${encodeURIComponent(linkCode)}${
        force ? "?force=1" : ""
      }`,
    );
    for (let hop = 0; ; hop++) {
      const resp = await httpFetch(url.toString(), {
        headers: {
          Cookie: cookieHeader(cookies),
          Referer: `${baseURL}/`,
          "User-Agent": BROWSER_USER_AGENT,
        },
        redirect: "manual",
      });
      keepCookies(resp, cookies);
      await resp.text().catch(() => "");
      const location = resp.headers.get("Location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        if (hop === MAX_REDIRECTS) {
          throw new Error(
            "Joysound's website redirected karafriends' link too many times",
          );
        }
        url = redirectTarget(location, url, base);
        continue;
      }
      if (!resp.ok) {
        throw new HttpStatusError(resp.status, `${baseURL}${url.pathname}`);
      }
      if (url.pathname.startsWith("/login")) {
        throw new Error(
          "Joysound's website sent karafriends' link to its login page: the sign-in didn't take",
        );
      }
      if (url.pathname === LINKED_CONFIRM) throw new TvLinkTakenError();
      return url.pathname;
    }
  });
}

function statusOf(info: LinkInfo): LinkStatus {
  if (!info.isValid) return { state: "ended" };
  if (!info.isLinked) return { state: "pending" };
  return { state: "linked", membershipType: info.membershipType };
}

// What Test login adds after "Signed in", or, for a link the host should
// do something about, a LoginWarning. Until karafriends is linked, it
// offers the switch: the link may be another TV app's.
export function linkStatusNote(status: LinkStatus): LoginNote {
  const later = "the next time it gets a song or a search from Joysound";
  const orSwitch =
    "If another TV app holds the link (Joysound links one at a time), " +
    "Switch takes it, unlinking the other one.";
  switch (status.state) {
    case "none":
      return {
        note: `karafriends links itself to this account, as its JOYSOUND TV app, ${later}. ${orSwitch}`,
        canSwitchLink: true,
      };
    case "pending":
      return {
        note: `karafriends' link to this account isn't finished; it finishes ${later}. ${orSwitch}`,
        canSwitchLink: true,
      };
    case "taken":
      throw new LoginWarning(
        "Signed in, but another TV app is linked to this Joysound account, " +
          "which links one at a time. Switching the link to karafriends " +
          "unlinks the other one.",
        { canSwitchLink: true },
      );
    case "ended":
      return {
        note: `karafriends' link to this account has ended; it links again ${later}. ${orSwitch}`,
        canSwitchLink: true,
      };
    case "linked":
      if (status.membershipType === "PAID") {
        return {
          note: "karafriends is linked to this account, a paid member.",
        };
      }
      throw new LoginWarning(
        "Signed in, but the Joysound account isn't a paid member " +
          `(membership: ${status.membershipType ?? "none"}), so karafriends ` +
          "can't download its songs and leaves Joysound off.",
      );
  }
}

export interface JoysoundLinker {
  // The link for email's account: the kept one if linkInfo says it is
  // linked; else the kept code, authorized, if it never was; else a new
  // code, authorized. Signs in to the website only to authorize. Fails
  // with a TvLinkTakenError, without unlinking anything, if another TV app
  // holds the link (at once, for TAKEN_RETRY_MS after finding that). For
  // credentials.ts, whose memoizeSuccess has concurrent requests share one.
  link(email: string, password: string): Promise<JoysoundLink>;
  // Settings' Switch: links karafriends even if another TV app holds the
  // link, unlinking that one, as the website does: the link page, and its
  // switch only if it asks. Resolves to a sentence for the host.
  switchLink(email: string, password: string): Promise<string>;
  // How the kept link for email's account stands, from linkInfo. Issues,
  // authorizes and unlinks nothing.
  status(email: string): Promise<LinkStatus>;
  // Test login: signs in to the website with email and password, and
  // resolves to a sentence on the kept link (see linkStatusNote). Issues,
  // authorizes and unlinks nothing.
  test(email: string, password: string): Promise<LoginNote>;
  // Drops the kept link if it was made for another account than email's,
  // as when the setting changes. Joysound keeps it linked to that account
  // (karafriends unlinks nothing): the host can unlink it on the website.
  forgetOtherAccounts(email: string): Promise<void>;
}

export function createJoysoundLinker({
  store,
  baseURL = JOYSOUND_BASE_URL,
  now = Date.now,
}: {
  store: LinkStore;
  baseURL?: string;
  now?: () => number;
}): JoysoundLinker {
  // The account whose link the last try found taken, and when.
  let taken: { account: string; at: number } | null = null;
  const takenFor = (email: string) =>
    taken !== null && sameAccount(taken.account, email);

  const storedFor = async (email: string): Promise<StoredLink | null> => {
    const stored = await store.load();
    return isStoredLink(stored) && sameAccount(stored.account, email)
      ? stored
      : null;
  };

  const status = async (email: string): Promise<LinkStatus> => {
    const stored = await storedFor(email);
    if (!stored) return { state: "none" };
    const kept = statusOf(await getLinkInfo(stored.linkCode, baseURL));
    return kept.state === "pending" && takenFor(email)
      ? { state: "taken" }
      : kept;
  };

  // The kept code for email's account, if linked, or one to authorize: the
  // kept one if it never was, or a new one (kept before it's authorized, so
  // a link that fails halfway is finished with it, not a new one).
  const codeFor = async (
    email: string,
  ): Promise<
    { linked: true; link: JoysoundLink } | { linked: false; stored: StoredLink }
  > => {
    let stored = await storedFor(email);
    if (stored) {
      const kept = statusOf(await getLinkInfo(stored.linkCode, baseURL));
      if (kept.state === "linked") {
        taken = null;
        return {
          linked: true,
          link: {
            linkCode: stored.linkCode,
            membershipType: kept.membershipType,
          },
        };
      }
      if (kept.state === "ended") {
        console.info(
          "[joysound] karafriends' link to the account has ended; linking again",
        );
        await store.save(null);
        stored = null;
      }
    }
    if (!stored) {
      stored = { account: email, linkCode: await issueLinkCode(baseURL) };
      await store.save(stored);
    }
    return { linked: false, stored };
  };

  // Signs in and authorizes stored's code, then checks it with linkInfo.
  // If another TV app holds the link: switching, the page's switch, in the
  // same session (as the host would press it), which unlinks that one;
  // otherwise a TvLinkTakenError.
  const authorize = async (
    email: string,
    password: string,
    stored: StoredLink,
    switching: boolean,
  ): Promise<JoysoundLink> => {
    const cookies = await websiteLogin(email, password, baseURL);
    const open = (force: boolean) =>
      authorizeLinkCode(cookies, stored.linkCode, baseURL, force);
    let endedOn: string;
    let switched = false;
    try {
      endedOn = await open(false);
    } catch (err) {
      if (!(err instanceof TvLinkTakenError)) throw err;
      if (!switching) {
        console.info(
          "[joysound] another TV app holds the account's link; karafriends waits for the host to switch it",
        );
        taken = { account: email, at: now() };
        throw err;
      }
      endedOn = await open(true);
      switched = true;
    }
    const linked = statusOf(await getLinkInfo(stored.linkCode, baseURL));
    if (linked.state !== "linked") {
      throw new Error(
        "Joysound didn't link karafriends to the account: its link code is " +
          `${linked.state === "ended" ? "no longer valid" : "still not linked"} ` +
          `after authorizing it (the link page ended on ${endedOn})`,
      );
    }
    taken = null;
    console.info(
      `[joysound] karafriends is ${
        switched
          ? "now the account's TV app, in place of another"
          : "linked to the account"
      } (membership: ${linked.membershipType ?? "none"})`,
    );
    return { linkCode: stored.linkCode, membershipType: linked.membershipType };
  };

  return {
    async link(email, password) {
      const code = await codeFor(email);
      if (code.linked) return code.link;
      if (takenFor(email) && now() - taken!.at < TAKEN_RETRY_MS) {
        throw new TvLinkTakenError();
      }
      return authorize(email, password, code.stored, false);
    },

    async switchLink(email, password) {
      const code = await codeFor(email);
      const link = code.linked
        ? code.link
        : await authorize(email, password, code.stored, true);
      return linkStatusNote({
        state: "linked",
        membershipType: link.membershipType,
      }).note;
    },

    status,

    async test(email, password) {
      await websiteLogin(email, password, baseURL);
      let linkStatus: LinkStatus;
      try {
        linkStatus = await status(email);
      } catch (err) {
        return {
          note: `Couldn't check karafriends' link to the account: ${
            (err as Error)?.message ?? String(err)
          }`,
        };
      }
      return linkStatusNote(linkStatus);
    },

    async forgetOtherAccounts(email) {
      const stored = await store.load();
      if (taken && !sameAccount(taken.account, email)) taken = null;
      if (
        stored &&
        !(isStoredLink(stored) && sameAccount(stored.account, email))
      ) {
        await store.save(null);
      }
    },
  };
}
