// Whether DAM's and Joysound's songs are on for this party: each catalog is
// on once its login has signed in, checked at launch and whenever the login
// changes. Guests' phones only show the catalogs that are on (the live
// state's catalogs), and the API refuses the others.
//
// A service that can't be reached (no connection, or no Japanese IP address:
// the VPN is off) is tried again by itself, sooner at first, then every
// minute, so turning the VPN on is enough. A refused login (a wrong
// password, an account that isn't a paid member, another TV app holding
// Joysound's link) waits for the host: Settings says why.
//
// No Electron imports, so unit tests can load this file under plain Node.
import type { CatalogStatus, LoginService } from "../common/api";
import { LoginRejectedError, LoginWarning, NoLoginError } from "./credentials";
import { MinseiStatusError } from "./damApi";
import { HttpStatusError, isTransient } from "./http";
import { TvLinkTakenError } from "./joysoundLink";
import { TimeoutError, withTimeout } from "./timeout";

export const CATALOGS: readonly LoginService[] = ["dam", "joysound"];

const NAMES: Record<LoginService, string> = {
  dam: "DAM",
  joysound: "Joysound",
};

// The waits before each try again while a service can't be reached; the
// last one repeats.
export const RETRY_MS: readonly number[] = [10_000, 30_000, 60_000];

// Signing in to Joysound can take several requests (its link: sign in to
// the website, authorize a code, check it).
const CHECK_TIMEOUT_MS = 45_000;

const OFF: CatalogStatus = { state: "off" };
const CHECKING: CatalogStatus = { state: "checking" };
const ON: CatalogStatus = { state: "on" };

export type CatalogStatuses = Record<LoginService, CatalogStatus>;

// What a failed sign-in means for the catalog, in a sentence for the host
// (and the TV's notice). Never the error's own message, which can hold a
// URL with Joysound's link code: Test login, on the display only, gives
// the details.
export function catalogProblem(
  service: LoginService,
  err: unknown,
):
  | { state: "off" }
  | { state: "unreachable"; reason: string }
  | { state: "failed"; reason: string; canSwitchLink?: boolean } {
  const name = NAMES[service];
  if (err instanceof NoLoginError) return { state: "off" };
  if (err instanceof TvLinkTakenError) {
    return {
      state: "failed",
      reason:
        "Another TV app is linked to the Joysound account, which links one " +
        "at a time. Switch the link to karafriends in Settings › Accounts.",
      canSwitchLink: true,
    };
  }
  if (err instanceof LoginWarning) {
    return err.canSwitchLink
      ? { state: "failed", reason: err.message, canSwitchLink: true }
      : { state: "failed", reason: err.message };
  }
  if (err instanceof LoginRejectedError || err instanceof MinseiStatusError) {
    const user = service === "dam" ? "username" : "email";
    return {
      state: "failed",
      reason: `${name} refused the login: check the ${user} and password in Settings › Accounts.`,
    };
  }
  if (err instanceof HttpStatusError && err.status === 403) {
    return {
      state: "unreachable",
      reason: `${name} refused this connection: it only answers addresses in Japan. Turn on the VPN to Japan.`,
    };
  }
  if (err instanceof TimeoutError || isTransient(err)) {
    return {
      state: "unreachable",
      reason: `Can't reach ${name}. Check the internet connection and the VPN to Japan.`,
    };
  }
  return {
    state: "failed",
    reason: `Couldn't sign in to ${name}. Test login in Settings › Accounts says why.`,
  };
}

// KARAFRIENDS_FAKE_CATALOGS, for the e2e tests: the catalogs it names
// ("dam,joysound", or "" for none) are on, and no login is checked. Null
// when it isn't set: the logins are checked.
export function fakeCatalogs(
  value: string | undefined,
): ReadonlySet<LoginService> | null {
  if (value === undefined) return null;
  return new Set(
    CATALOGS.filter((service) =>
      value.split(",").some((name) => name.trim() === service),
    ),
  );
}

export interface CatalogsDeps {
  // Whether the login is filled in.
  hasLogin(service: LoginService): boolean;
  // Signs in with the clients' shared login (credentials.ts), or uses the
  // session it keeps. Rejects with why it can't.
  signIn: Record<LoginService, () => Promise<void>>;
  // Drops the shared login's session, so signIn signs in again.
  forget: Record<LoginService, () => void>;
  // Every status, whenever one changes.
  onChange(statuses: CatalogStatuses): void;
  now?: () => number;
  retryMs?: readonly number[];
  checkTimeoutMs?: number;
  // See fakeCatalogs.
  fake?: ReadonlySet<LoginService> | null;
}

export interface Catalogs {
  statuses(): CatalogStatuses;
  isOn(service: LoginService): boolean;
  // Checks the login now, from a new sign-in if fresh, and resolves to
  // the catalog's status. A check started since wins: an older one's
  // outcome is dropped.
  check(
    service: LoginService,
    options?: { fresh?: boolean },
  ): Promise<CatalogStatus>;
  // Stops the tries again (tests).
  stop(): void;
}

export function createCatalogs(deps: CatalogsDeps): Catalogs {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const timeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const statuses: CatalogStatuses = { dam: OFF, joysound: OFF };
  // Each check's number, so an older one's outcome is dropped.
  const runs: Record<LoginService, number> = { dam: 0, joysound: 0 };
  // Tries in a row that couldn't reach the service.
  const misses: Record<LoginService, number> = { dam: 0, joysound: 0 };
  const timers: Partial<Record<LoginService, ReturnType<typeof setTimeout>>> =
    {};

  const set = (service: LoginService, status: CatalogStatus) => {
    if (JSON.stringify(statuses[service]) === JSON.stringify(status)) return;
    statuses[service] = status;
    const shown =
      "reason" in status ? `${status.state}: ${status.reason}` : status.state;
    console.info(`[catalogs] ${NAMES[service]} ${shown}`);
    deps.onChange({ ...statuses });
  };

  const check = async (
    service: LoginService,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<CatalogStatus> => {
    clearTimeout(timers[service]);
    delete timers[service];
    const run = ++runs[service];
    if (deps.fake) {
      set(service, deps.fake.has(service) ? ON : OFF);
      return statuses[service];
    }
    if (!deps.hasLogin(service)) {
      misses[service] = 0;
      set(service, OFF);
      return statuses[service];
    }
    if (fresh) deps.forget[service]();
    // A service that can't be reached is tried again quietly: its notice
    // stays up meanwhile.
    if (statuses[service].state !== "unreachable") set(service, CHECKING);
    try {
      await withTimeout(
        deps.signIn[service](),
        timeoutMs,
        `${NAMES[service]}'s sign-in`,
      );
      if (run !== runs[service]) return statuses[service];
      misses[service] = 0;
      set(service, ON);
    } catch (err) {
      if (run !== runs[service]) return statuses[service];
      const problem = catalogProblem(service, err);
      if (problem.state === "unreachable") {
        const wait = retryMs[Math.min(misses[service], retryMs.length - 1)];
        misses[service]++;
        set(service, { ...problem, retryAt: now() + wait });
        timers[service] = setTimeout(() => void check(service), wait);
      } else {
        misses[service] = 0;
        set(service, problem);
      }
    }
    return statuses[service];
  };

  return {
    statuses: () => ({ ...statuses }),
    isOn: (service) => statuses[service].state === "on",
    check,
    stop() {
      for (const service of CATALOGS) {
        runs[service]++;
        clearTimeout(timers[service]);
        delete timers[service];
      }
    },
  };
}
