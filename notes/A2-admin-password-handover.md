# Phase A2 (admin password) hand-over

Branch `claude/recursing-ramanujan-c5f879`, on master 53fcef8, not pushed.

## How admin access works now

- **Config.** `config.yaml` has `adminPasswordHash` and `adminPasswordSalt`, both empty by default. An empty hash means no phone can be an admin; the display always is one. The hash is scrypt (`crypto.scryptSync`, 64-byte key, N=16384, r=8, p=1) of the password with the salt as text, hex-encoded: `hashAdminPassword(password, salt)` and `newAdminSalt()` in `src/common/adminPassword.ts` (no Electron imports; the app, the unit tests and the e2e fixture use it). `isAdminPassword(password, config)` compares in constant time.
- **Old keys.** `adminDeviceIds` and `adminNicks` are ignored, logged once at startup and dropped on the write-back (`OBSOLETE_KEYS` and `configFromFile` in `src/common/configSchema.ts`).
- **Methods.** `adminLogin { password } → { token }`: 403 for a wrong password or when none is set, 400 from the display (it never signs in). `adminLogout {} → {}` ends the caller's session. `whoami` is unchanged.
- **Token.** A phone sends it in the `X-Karafriends-Admin-Token` header (`ADMIN_TOKEN_HEADER` in `src/common/api.ts`), and on `GET /api/events` as the `adminToken` query parameter (`EVENTS_ADMIN_TOKEN_PARAM`). `Caller.adminToken` (from `callerFromHeaders` in `src/main/caller.ts`) carries the header; the events parameter goes into the hub's `Viewer.adminToken`, which nothing uses yet.
- **Sessions.** `isAdmin(caller)` is `caller.isDisplay || adminSessions.has(caller.adminToken)` in `src/main/api.ts`. Tokens are 32 random bytes as hex. `createAdminSessions(filePath)` in `src/main/adminAuth.ts` keeps their SHA-256 hashes, newest 500, in `userData/adminSessions.json` (written through a temp file), so a restart keeps admins signed in. A missing or broken file means no sessions.
- **Rate limit.** `adminLogin` gets 5 tries a minute per remote address, right or wrong (`ADMIN_LOGIN_LIMIT` and `rateLimiter` in `src/main/server.ts`); the sixth answers 429 with `Retry-After: 60` and "Too many sign-in tries. Wait a minute, then try again." Through the dev server or a tunnel every phone shares one address, so they share one limit.
- **Device IDs** still decide whose song is whose (`isMine`, and the supervised-mode checks in `removeSong` and `setPlaybackState`); they never make anyone an admin.

## For A3 (settings API)

- Call `setAdminPassword(password)` from `src/main/services.ts` for the display-only `setAdminPassword` method. It is built by `createSetAdminPassword` in `src/main/adminAuth.ts`: it keeps the salt (making one if it's empty), writes both keys through `updateConfig()`, and clears every session. `""` removes the password. Nothing calls it yet.
- `updateConfig(partial)` in `src/common/config.ts` re-reads `config.yaml`, merges, writes it through a temp file and updates the live config object. A3's config store can replace it; keep the sessions cleared on a password change.
- `configFromFile(parsed) → { config, problems }` already drops the obsolete keys, so `importConfig` can reuse it.
- `getSettings` must leave out or mask `adminPasswordHash` and `adminPasswordSalt`.

## For C (phone remote refresh)

- Keep the client side as it is: `adminSignIn`, `adminSignOut`, `onAdminTokenChange` and `storedAdminToken` in `src/common/apiClient.ts`. `LiveStateProvider` asks `whoami` again after a sign-in or sign-out (so `useIsAdmin()` updates without a reload) and forgets a token the server no longer accepts. `useUserIdentity()` returns `adminToken`, `signIn` and `signOut`; the token is in `localStorage` under `adminToken`.
- `/profile` (`src/remocon/pages/ProfilePage.tsx`) is a minimal page to rebuild: nickname (read-only), the admin password field and sign-in, "You're an admin" with sign-out, and the error text (403: "Wrong password. Ask the host for it."; 429: "Too many tries. Wait a minute, then try again."; offline: `common.offline`). Strings are `profile.*` in `en.ts` and `ja.ts`.
- Keep the accessible names the e2e test (`tests/e2e/api.spec.ts`, "signs in from the profile page") uses: the "Profile" link in the header, the "Admin password" field, the "Sign in" and "Sign out" buttons, and the visible text "You're an admin" and the wrong-password message.
- The queue sheet stays expanded across a reload; the e2e test relies on that today.

## Testing an admin

- e2e: `adminPasswordConfig(password)` in `tests/e2e/fixtures.ts` returns a salt and hash for `appConfig`; then sign in through the API or the profile page.
- By hand: README's "Running a party" has a `node -e` one-liner that prints the two `config.yaml` lines.
