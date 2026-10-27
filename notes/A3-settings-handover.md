# Phase A3 (settings API, config export/import) hand-over

Branch `claude/priceless-lichterman-8878cb`, on master 7e94975, not pushed. For phase D, which builds the settings screen on this.

## Calling the methods

Every settings method is display-only. The display calls them like any other method, through `window.karafriends.api.call(method, input)` (the generic IPC transport covers every method, so the preload needed nothing new for them), and gets `{ ok: true, output }` or `{ ok: false, status, error }`. A phone that POSTs one to `/api/<method>` gets 403 before its body is read (`DISPLAY_ONLY_METHODS` in `src/main/server.ts`), and each handler also refuses any caller that isn't the display (`src/main/settings.ts`). Types are in `src/common/api.ts` (`Settings`, `SettingsChanges`, `TestLoginResult`, `MASKED_PASSWORD`).

| Method             | Input                                                                    | Output                                                                           |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `getSettings`      | `{}`                                                                     | `{ settings: Settings, isFirstRun, needsRestart }`                               |
| `setSettings`      | `{ settings: SettingsChanges }` (any subset)                             | `{ ok: true, needsRestart }` or `{ ok: false, problems: string[] }`              |
| `setAdminPassword` | `{ password }` (`""` removes it)                                         | `{}`                                                                             |
| `testLogin`        | `{ service: "dam" \| "joysound", credentials?: { username, password } }` | `{ ok: true }` or `{ ok: false, reason }`                                        |
| `exportConfig`     | `{}`                                                                     | `{ yaml }`                                                                       |
| `importConfig`     | `{ yaml }` (1 MB at most)                                                | `{ ok: true, problems: string[] }` or `{ ok: false, problems: string[] }`        |
| `restartApp`       | `{}`                                                                     | `{}`, then the app relaunches about 200 ms later (`app.relaunch(); app.exit(0)`) |

### `Settings` and the masking rule

`Settings` is `config.yaml`'s keys as saved (not `KARAFRIENDS_REMOCON_PORT`'s override), except:

- `damPassword`, `joysoundPassword` and `proxyPass` are `"••••••"` (`MASKED_PASSWORD`) when not empty, and `""` when empty. The placeholders a fresh `config.yaml` has (`YOUR_PASSWORD_HERE`, `PROXY_PASS_HERE`) aren't empty, so they come masked too; use `isFirstRun` to tell that no login is set.
- `adminPasswordHash` and `adminPasswordSalt` never leave the main process; `adminPasswordSet: boolean` says whether there is an admin password.
- Everything else comes as it is, placeholders included (`YOUR_USERNAME_HERE`, `YOUR_EMAIL_HERE`, `PROXY_HOST_HERE`, `PROXY_USER_HERE`).

Send the form back to `setSettings` as it is: a password of `MASKED_PASSWORD` means "unchanged"; any other value, `""` included, replaces it. `adminPasswordSet`, `adminPasswordHash`, `adminPasswordSalt` and any key that isn't a setting are refused with 400 (the admin password goes through `setAdminPassword`).

### Validation (`setSettings`, `importConfig`)

All or none: `ok: false` changes nothing and lists every problem, one sentence per setting, e.g. `"remoconPort must be a whole number from 1 to 65535"`. The rules (`CONFIG_RULES` in `src/common/configSchema.ts`): `useLowBitrateUrl`, `supervisedMode`, `proxyEnable` are true or false; `remoconPort` and `proxyPort` whole numbers from 1 to 65535; `paxSongQueueLimit` from 0 (no limit) to 1000; every text at most 1000 characters. A failed write of `config.yaml` also comes back as a problem (`"Couldn't save config.yaml: ..."`).

### `isFirstRun`

True when neither a DAM nor a Joysound login is filled in; a login counts once both its fields are non-empty and neither is the placeholder. Open Settings with the first-launch banner when it's true.

### `needsRestart` and the Restart button

True while `remoconPort` or a proxy setting (`proxyEnable`, `proxyHost`, `proxyPort`, `proxyUser`, `proxyPass`) is saved with a value other than the one the app started with (changing it back clears it). `setSettings` returns it too, so show the restart note and the Restart button (`restartApp`) right after a save. Without a restart:

- A DAM or Joysound login change: the shared session is forgotten at once; the next search or song signs in with the new login.
- Proxy: the main process's DAM and Joysound requests use the new proxy at once. The display window's own proxy (DAM's streams) and the phones' server port change only on restart.
- `supervisedMode`: phones and the display get a new live state at once. `paxSongQueueLimit` and `useLowBitrateUrl`: from the next queued song.
- A new admin password (from `setAdminPassword` or an import) signs every phone out.

### `testLogin`

Signs in with `credentials` if given (for Joysound, `username` is the email), else the saved login, and never keeps the session: the shared one is untouched. To test what's saved, leave `credentials` out; to test what the host typed, send it (a masked password can't be tested that way, as the form doesn't know it). Gives up after 15 s. Reasons, each naming the service:

- No login: `"No DAM login is set: enter the username and password first."` (no request is made)
- 403: `"Joysound answered 403: this usually means no Japanese IP address. Connect through a VPN or proxy in Japan."`
- Timeout: `"DAM didn't answer within 15 seconds. Check this computer's internet connection, VPN or proxy."`
- Anything else, a wrong password included: `"Couldn't sign in to DAM: <the service's message>"`.

The app doesn't look up its IP's country (that would send it to a third party); the 403 is the tell.

### Export and import

`exportConfig` gives `config.yaml` as saved with `karafriendsConfigVersion: 1` as the first line: logins, proxy password and the admin password's hash and salt included, as decided. `importConfig`:

- takes that file or any `config.yaml`, with or without the version line;
- changes only the settings the file has (an old file without `adminPasswordHash` keeps the current admin password);
- drops `adminDeviceIds`, `adminNicks` and unknown keys, naming each in `problems` (`"Dropped futureSetting: karafriends has no such setting."`);
- answers `ok: false`, changing nothing, if the file isn't YAML (it gives the line number, never the line, which may hold a password), holds no settings, or any value fails validation;
- then tests both logins and adds one line each (`"DAM login works."` or the `testLogin` reason). A failed login doesn't undo the import.

Show `problems` as a list after an import, success or not.

## File dialogs (preload)

Two functions on `window.karafriends` (type `DisplayFiles` in `src/common/ipc.ts`, IPC channels `file:saveText` and `file:openText`, handled in `src/main/index.ts` for the display window only):

- `saveTextFile(suggestedName, text) → Promise<boolean>`: a save dialog in Documents suggesting `suggestedName` (a file name; any folder part is dropped), then `text` written as UTF-8. False if the host canceled; rejects if the file can't be written.
- `openTextFile() → Promise<string | null>`: an open dialog for `.yaml`/`.yml`, then the file's text. Null if the host canceled; rejects if it can't be read.

Export config is `exportConfig` then `saveTextFile("karafriends-config.yaml", yaml)`; Import config is `openTextFile()` then `importConfig({ yaml: text })`.

## Inside the main process

- `src/common/configStore.ts` is the store: `get()` (the running config, one object changed in place, environment overrides on top), `saved()`, `atLaunch`, `update(partial)` (validates, writes through a temp file, applies, then tells the listeners which keys changed) and `onChange(listener)`. `src/common/config.ts` makes the app's one store, `configStore`. Its default export is still `configStore.get()`, so `index.ts`, which only reads it, didn't change. `updateConfig()` is gone; A2's `setAdminPassword` saves through `configStore.update`.
- A `config.yaml` that doesn't parse at launch is copied to `config.yaml.broken` (the app runs on the defaults, as before), since a save from the settings screen now writes the file.
- `src/main/credentials.ts`: the shared DAM/Joysound logins (`memoizeSuccess` now has `forget()`), forgotten when their keys change. `src/main/services.ts` subscribes for the rest: `hub.refresh()` on `supervisedMode`, `setProxy` on the proxy keys, `adminSessions.clear()` on the admin hash or salt.
- `HttpStatusError` in `src/main/http.ts`: thrown by `MinseiAPI.login` when DAM answers an error status without its JSON, and by `JoysoundAPI.login` when its login page answers an error status.

## Tests

- Unit: `src/common/configStore.test.ts`, `src/common/configSchema.test.ts` (the rules, `hasLogin`), `src/main/settings.test.ts`, `src/main/credentials.test.ts`, `src/main/live.test.ts` (`refresh`), `src/main/server.test.ts` (every display-only method is 403 over HTTP).
- e2e: `tests/e2e/settings.spec.ts` over the display's IPC: masking, `setSettings` reaching the phones' and the display's live state, export from one launch and import into a second, a phone's 403, and a `@jp` `testLogin` with the installed app's logins.
