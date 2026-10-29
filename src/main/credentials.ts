// The DAM and Joysound logins the clients share: each logs in on first use
// and keeps the session, until the login fails, a client finds the session
// has ended (withSession in http.ts), or the settings change it. Joysound's
// "login" is karafriends' link to the account (joysoundLink.ts), made with
// the saved email and password and kept between launches.
//
// No Electron imports, so unit tests can load this file under plain Node.
import {
  DAM_LOGIN_KEYS,
  hasLogin,
  JOYSOUND_LOGIN_KEYS,
  type KarafriendsConfig,
} from "../common/configSchema";
import type { ConfigStore } from "../common/configStore";

export interface Memoized<T> {
  (): Promise<T>;
  // Drops the kept answer, so the next call runs fn again. Given the answer
  // a caller found stale, drops it only while it is still the kept one: two
  // requests that fail on the same ended session log in again once.
  forget(stale?: T): void;
}

// Like memoize, but forgets a rejected promise so a failed login (wrong
// credentials, no Japanese IP, service down) is retried on the next request
// instead of failing until restart.
export function memoizeSuccess<T>(fn: () => Promise<T>): Memoized<T> {
  let promise: Promise<T> | null = null;
  // promise's answer, once it has one.
  let kept: { value: T } | null = null;
  const memoized = () => {
    if (!promise) {
      const attempt: Promise<T> = fn().then(
        (value) => {
          if (promise === attempt) kept = { value };
          return value;
        },
        (err) => {
          // Unless forget() (and maybe a newer call) came in meanwhile.
          if (promise === attempt) promise = null;
          throw err;
        },
      );
      promise = attempt;
    }
    return promise;
  };
  memoized.forget = (...stale: [T?]) => {
    // A newer login has replaced it, or is under way.
    if (stale.length > 0 && kept?.value !== stale[0]) return;
    promise = null;
    kept = null;
  };
  return memoized;
}

// What a session answers when its login isn't filled in. Nothing is sent.
// 409 for the phone that asked.
export class NoLoginError extends Error {
  readonly status = 409;
  constructor(service: "DAM" | "Joysound") {
    super(`The host hasn't set up a ${service} login`);
    this.name = "NoLoginError";
  }
}

// What a login test that worked says beyond "Signed in": how karafriends'
// link to the Joysound account stands, and whether Settings can switch the
// account's TV link to karafriends.
export interface LoginNote {
  note: string;
  canSwitchLink?: boolean;
}

// A login that worked, but with a problem the host should know about (the
// Joysound account isn't a paid member, say). Test login shows its message
// as it is, in place of "Couldn't sign in" (settings.ts). canSwitchLink:
// another TV app holds the Joysound account's link, which Settings can
// switch to karafriends.
export class LoginWarning extends Error {
  readonly canSwitchLink: boolean;
  constructor(message: string, { canSwitchLink = false } = {}) {
    super(message);
    this.name = "LoginWarning";
    this.canSwitchLink = canSwitchLink;
  }
}

export interface CredentialProviderDeps<Dam, Joysound> {
  store: Pick<ConfigStore, "get" | "onChange">;
  damLogin(username: string, password: string): Promise<Dam>;
  joysoundLogin(email: string, password: string): Promise<Joysound>;
}

// The two logins, each with the store's current credentials, forgotten when
// those credentials change. A login that isn't filled in fails with a
// NoLoginError, without asking the service.
export function createCredentialProviders<Dam, Joysound>({
  store,
  damLogin,
  joysoundLogin,
}: CredentialProviderDeps<Dam, Joysound>) {
  const config = (): Readonly<KarafriendsConfig> => store.get();
  const dam = memoizeSuccess(async () => {
    if (!hasLogin(config(), "dam")) throw new NoLoginError("DAM");
    return damLogin(config().damUsername, config().damPassword);
  });
  const joysound = memoizeSuccess(async () => {
    if (!hasLogin(config(), "joysound")) throw new NoLoginError("Joysound");
    return joysoundLogin(config().joysoundEmail, config().joysoundPassword);
  });
  const changed = (keys: readonly string[], watched: readonly string[]) =>
    keys.some((key) => watched.includes(key));
  store.onChange(({ keys }) => {
    if (changed(keys, DAM_LOGIN_KEYS)) dam.forget();
    if (changed(keys, JOYSOUND_LOGIN_KEYS)) joysound.forget();
  });
  return { dam, joysound };
}
