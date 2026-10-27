// The DAM and Joysound logins the clients share: each logs in on first use
// and keeps the session, until the login fails or the settings change it.
//
// No Electron imports, so unit tests can load this file under plain Node.
import {
  DAM_LOGIN_KEYS,
  JOYSOUND_LOGIN_KEYS,
  type KarafriendsConfig,
} from "../common/configSchema";
import type { ConfigStore } from "../common/configStore";

export interface Memoized<T> {
  (): Promise<T>;
  // Drops the kept answer, so the next call runs fn again.
  forget(): void;
}

// Like memoize, but forgets a rejected promise so a failed login (wrong
// credentials, no Japanese IP, service down) is retried on the next request
// instead of failing until restart.
export function memoizeSuccess<T>(fn: () => Promise<T>): Memoized<T> {
  let promise: Promise<T> | null = null;
  const memoized = () => {
    if (!promise) {
      const attempt: Promise<T> = fn().catch((err) => {
        // Unless forget() (and maybe a newer call) came in meanwhile.
        if (promise === attempt) promise = null;
        throw err;
      });
      promise = attempt;
    }
    return promise;
  };
  memoized.forget = () => {
    promise = null;
  };
  return memoized;
}

export interface CredentialProviderDeps<Dam, Joysound> {
  store: Pick<ConfigStore, "get" | "onChange">;
  damLogin(username: string, password: string): Promise<Dam>;
  joysoundLogin(email: string, password: string): Promise<Joysound>;
}

// The two logins, each with the store's current credentials, forgotten when
// those credentials change.
export function createCredentialProviders<Dam, Joysound>({
  store,
  damLogin,
  joysoundLogin,
}: CredentialProviderDeps<Dam, Joysound>) {
  const config = (): Readonly<KarafriendsConfig> => store.get();
  const dam = memoizeSuccess(() =>
    damLogin(config().damUsername, config().damPassword),
  );
  const joysound = memoizeSuccess(() =>
    joysoundLogin(config().joysoundEmail, config().joysoundPassword),
  );
  const changed = (keys: readonly string[], watched: readonly string[]) =>
    keys.some((key) => watched.includes(key));
  store.onChange(({ keys }) => {
    if (changed(keys, DAM_LOGIN_KEYS)) dam.forget();
    if (changed(keys, JOYSOUND_LOGIN_KEYS)) joysound.forget();
  });
  return { dam, joysound };
}
