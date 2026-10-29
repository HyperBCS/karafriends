// karafriends' link to the host's Joysound account. The TV API
// (joysoundApi.ts) takes a link code where the website took a login: Joysound
// issues the code, the account authorizes it, and from then on the code
// stands for the account, as a JOYSOUND TV device would.
//
// The TV app shows a QR code for a signed-in phone to open. karafriends
// authorizes the code itself with the saved email and password: signed in
// to the website, GET /mypage/tvlink/<code> links it. That GET is the
// authorization itself (checked 2026-10-29), not a page to look at. The
// code is kept between launches in a LinkStore, with the account it was
// made for, and checked with linkInfo once a run.
//
// The code is a secret: it never goes into a log line or an error's
// message, and never into config.yaml (so Export config leaves it out).
//
// No Electron imports, so unit tests can load this file under plain Node.
import { LoginWarning } from "./credentials";
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
// the OS. load() and save() never throw.
export interface LinkStore {
  load(): StoredLink | null;
  save(link: StoredLink | null): void;
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
  // linkInfo says the code is no longer valid.
  | { state: "ended" }
  | { state: "linked"; membershipType: string | null };

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
    throw new Error(
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

// Links linkCode to the account signed in with cookies. Its HTML isn't
// read: linkInfo says whether it worked.
async function authorizeLinkCode(
  cookies: Cookies,
  linkCode: string,
  baseURL: string,
): Promise<void> {
  const url = `${baseURL}/mypage/tvlink/${encodeURIComponent(linkCode)}`;
  const shownAs = `${baseURL}/mypage/tvlink/<link code>`;
  await withUrlHidden(url, shownAs, async () => {
    const resp = await httpFetch(url, {
      headers: {
        Cookie: cookieHeader(cookies),
        Referer: `${baseURL}/`,
        "User-Agent": BROWSER_USER_AGENT,
      },
    });
    await resp.text().catch(() => "");
    if (!resp.ok) throw new HttpStatusError(resp.status, shownAs);
    if (new URL(resp.url || url).pathname.startsWith("/login")) {
      throw new Error(
        "Joysound's website sent karafriends' link to its login page: the sign-in didn't take",
      );
    }
  });
}

function statusOf(info: LinkInfo): LinkStatus {
  if (!info.isValid) return { state: "ended" };
  if (!info.isLinked) return { state: "pending" };
  return { state: "linked", membershipType: info.membershipType };
}

// What Test login adds after "Signed in", or, for a link whose account
// isn't a paid member, a LoginWarning.
export function linkStatusNote(status: LinkStatus): string {
  const later = "the next time it gets a song or a search from Joysound";
  switch (status.state) {
    case "none":
      return `karafriends links itself to this account, as a JOYSOUND TV device, ${later}.`;
    case "pending":
      return `karafriends' link to this account isn't finished; it finishes ${later}.`;
    case "ended":
      return `karafriends' link to this account has ended; it links again ${later}.`;
    case "linked":
      if (status.membershipType === "PAID") {
        return "karafriends is linked to this account, a paid member.";
      }
      throw new LoginWarning(
        "Signed in, but the Joysound account isn't a paid member " +
          `(membership: ${status.membershipType ?? "none"}), so karafriends ` +
          "can't download its songs, only search them.",
      );
  }
}

export interface JoysoundLinker {
  // The link for email's account: the kept one if linkInfo says it is
  // linked; else the kept code, authorized, if it never was; else a new
  // code, authorized. Signs in to the website only to authorize. For
  // credentials.ts, whose memoizeSuccess has concurrent requests share one.
  link(email: string, password: string): Promise<JoysoundLink>;
  // How the kept link for email's account stands, from linkInfo. Issues,
  // authorizes and unlinks nothing.
  status(email: string): Promise<LinkStatus>;
  // Test login: signs in to the website with email and password, and
  // resolves to a sentence on the kept link (see linkStatusNote). Issues,
  // authorizes and unlinks nothing.
  test(email: string, password: string): Promise<string>;
  // Drops the kept link if it was made for another account than email's,
  // as when the setting changes. Joysound keeps it linked to that account
  // (karafriends unlinks nothing): the host can unlink it on the website.
  forgetOtherAccounts(email: string): void;
}

export function createJoysoundLinker({
  store,
  baseURL = JOYSOUND_BASE_URL,
}: {
  store: LinkStore;
  baseURL?: string;
}): JoysoundLinker {
  const storedFor = (email: string): StoredLink | null => {
    const stored = store.load();
    return isStoredLink(stored) && sameAccount(stored.account, email)
      ? stored
      : null;
  };

  const status = async (email: string): Promise<LinkStatus> => {
    const stored = storedFor(email);
    if (!stored) return { state: "none" };
    return statusOf(await getLinkInfo(stored.linkCode, baseURL));
  };

  return {
    async link(email, password) {
      let stored = storedFor(email);
      if (stored) {
        const kept = statusOf(await getLinkInfo(stored.linkCode, baseURL));
        if (kept.state === "linked") {
          return {
            linkCode: stored.linkCode,
            membershipType: kept.membershipType,
          };
        }
        if (kept.state === "ended") {
          console.info(
            "[joysound] karafriends' link to the account has ended; linking again",
          );
          store.save(null);
          stored = null;
        } else {
          console.info(
            "[joysound] karafriends' link code was never authorized; authorizing it",
          );
        }
      }
      if (!stored) {
        stored = { account: email, linkCode: await issueLinkCode(baseURL) };
        // Kept before it's authorized: a link that fails halfway is finished
        // with this code next time, not a new one.
        store.save(stored);
      }

      const cookies = await websiteLogin(email, password, baseURL);
      await authorizeLinkCode(cookies, stored.linkCode, baseURL);
      const linked = statusOf(await getLinkInfo(stored.linkCode, baseURL));
      if (linked.state !== "linked") {
        throw new Error(
          "Joysound didn't link karafriends to the account: its link code is " +
            `${linked.state === "ended" ? "no longer valid" : "still not linked"} ` +
            "after authorizing it",
        );
      }
      console.info(
        `[joysound] karafriends is linked to the Joysound account (membership: ${
          linked.membershipType ?? "none"
        })`,
      );
      return {
        linkCode: stored.linkCode,
        membershipType: linked.membershipType,
      };
    },

    status,

    async test(email, password) {
      await websiteLogin(email, password, baseURL);
      let linkStatus: LinkStatus;
      try {
        linkStatus = await status(email);
      } catch (err) {
        return `Couldn't check karafriends' link to the account: ${
          (err as Error)?.message ?? String(err)
        }`;
      }
      return linkStatusNote(linkStatus);
    },

    forgetOtherAccounts(email) {
      const stored = store.load();
      if (
        stored &&
        !(isStoredLink(stored) && sameAccount(stored.account, email))
      ) {
        store.save(null);
      }
    },
  };
}
