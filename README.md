# karafriends

<img src="https://raw.githubusercontent.com/emmaworley/karafriends/master/icon.png" width="128" />

## Running a party

This part is for the host: the person whose computer plays the songs on the TV. Guests only need their phones.

### Install

Download the zip for your computer from the [Releases page](https://github.com/HyperBCS/karafriends/releases): `win32-x64` for Windows, `darwin-arm64` for an Apple Silicon Mac, `darwin-x64` for an Intel Mac, `linux-x64` for Linux. Unzip it anywhere and run `karafriends` inside. There's no installer; to update, unzip the new version over the old one or next to it.

### First launch

- The app opens full-screen on the main display. Plug in the TV before starting it, or move the window there.
- The first start downloads ffmpeg and yt-dlp (for YouTube and Niconico songs), so be online and give it a minute.
- Windows asks whether to let karafriends through the firewall. Allow it on private networks, or phones can't connect.
- Press `Q` to show or hide the sidebar: the QR code, the hostname and microphone settings, and the queue.

### Settings: `config.yaml`

The first start writes a `config.yaml` with every setting. Edit it with any text editor while the app is closed, then start the app again. A settings screen on the display is coming in a later update (phase D), with Export and Import buttons that move this whole file, DAM and Joysound logins and the admin password included, to another computer, so keep an exported file as safe as the logins themselves.

| System  | Where it is                                             |
| ------- | ------------------------------------------------------- |
| Windows | `%APPDATA%\karafriends\config.yaml`                     |
| macOS   | `~/Library/Application Support/karafriends/config.yaml` |
| Linux   | `~/.config/karafriends/config.yaml`                     |

- `damUsername` and `damPassword`, `joysoundEmail` and `joysoundPassword`: your DAM and Joysound logins. Without them, only YouTube and Niconico songs work.
- DAM and Joysound only answer from a Japanese IP address. Outside Japan, run a VPN to Japan on this computer, or set `proxyEnable`, `proxyHost` and `proxyPort` (and `proxyUser` and `proxyPass` if it needs them) to a proxy in Japan.
- `remoconPort`: the port phones connect to, 8080 unless you change it. If another program already uses it, the display still works and shows a banner saying phones can't connect; pick another port.
- `supervisedMode: true`: only an admin or the person singing can pause, skip or change the key.
- `paxSongQueueLimit`: how many songs each person may have queued at once (0 for no limit).
- `adminPasswordSalt` and `adminPasswordHash`: the admin password. A guest who types it on the phone's profile page (the person icon, top right) becomes an admin until they sign out; the display is always one. Without it, no phone can be an admin. Once the display has its Settings screen, you'll set the password there. Until then, run this with your password in place of `your password` (it uses scrypt with a random 16-byte salt, a 64-byte key and N=16384, r=8, p=1, as the app does), and, with the app closed, replace the `adminPasswordSalt` and `adminPasswordHash` lines in `config.yaml` with the two it prints:

  ```sh
  node -e "const c=require('crypto'),s=c.randomBytes(16).toString('hex'),h=c.scryptSync(process.argv[1],s,64,{N:16384,r:8,p:1}).toString('hex');console.log('adminPasswordSalt: '+JSON.stringify(s)+'\nadminPasswordHash: '+JSON.stringify(h))" "your password"
  ```

  Phones stay signed in when the app restarts. The older `adminDeviceIds` and `adminNicks` settings no longer do anything, and the app removes them from `config.yaml`.

### Phones

Phones join the same Wi-Fi as the computer and scan the QR code in the sidebar. If a phone can't open `karafriends.local`, pick the computer's IP address under Hostname in the sidebar and scan again. Guests choose a nickname, search DAM, Joysound, YouTube or Niconico, and queue songs; the queue plays in order.

## Building

Dependencies

- Node.js, plus any `yarn` on your PATH (`npm install -g yarn` is enough). The repo pins its Yarn version in `.yarn/releases` via `yarnPath`, so whichever `yarn` you run hands off to it; corepack isn't needed.
- Rust

## Running

```sh
yarn install && yarn dev
```

`yarn install` puts dependencies in `node_modules` and keeps its download cache in `.yarn/cache`. Neither is committed.

`yarn dev` builds the native module, then runs `electron-vite dev -w`: the main process and the preload are rebuilt when they change (and the app restarts or the display reloads), and the display and the phone remote come from the Vite dev server, with hot reload. In dev, phones use the dev server too: the display's QR code points at its port (5173, or `KARAFRIENDS_DEV_PORT`), and it passes `/api` on to the app's own server, which then listens on 8080 (or `KARAFRIENDS_REMOCON_PORT`), whatever `config.yaml` says.

The build is in `electron.vite.config.ts`. `yarn build-prod` bundles everything, `node_modules` included, into `build/prod` (`main`, `preload`, and the two pages in `web`), and `yarn package-prod` packages that folder. `yarn build-dev` makes an unminified copy with source maps in `build/dev`.

## Development

```sh
yarn typecheck && yarn lint && yarn test:unit
```

The main process serves the phone remote and a JSON API on the remote port (8080 by default), for the phones:

- `POST /api/<method>`: JSON in and out. `src/common/api.ts` has the methods and their types, `src/main/api.ts` the handlers, and `src/common/apiQueries.ts` the clients' TanStack Query hooks.
- `GET /api/events`: the live state (queue, now playing, playback, key, downloads) as Server-Sent Events.

The display window uses the same methods and live events over Electron IPC, through its preload (`src/common/ipc.ts`, `src/main/ipc.ts`); `src/common/apiClient.ts` picks the transport. So the display works even when the remote port is taken: then only phones can't connect, and the display shows a banner saying so.

There's no code generation: `yarn typecheck` works on a fresh checkout. A checkout from before GraphQL was removed may still have gitignored `src/**/__generated__` folders, which now fail the type check; delete them.

### Smoke tests

The Playwright smoke tests drive the karaoke display and the phone remote (in an emulated Pixel 7). `yarn test:e2e` and `yarn test:e2e:ci` test the production build in `build/prod` and don't build it, so run `yarn build-prod` first, and again after changing the app. Install Chromium (into `node_modules`) once:

```sh
yarn build-prod
yarn test:e2e:install
yarn test:e2e
```

- Each test launches the app muted, with a throwaway profile and temp folder and a free port, so it never touches your queue or config and can run next to the real app.
- `@net` tests queue a YouTube video. They copy ffmpeg and yt-dlp from the installed app's data folder (`%APPDATA%\karafriends\externalResources` on Windows), so start the app once beforehand.
- `@jp` tests search DAM and Joysound with the logins from the installed app's `config.yaml`, queue a song from each (the Joysound one downloads, with the installed app's ffmpeg) and take it straight off the queue. They need a Japanese IP and only run on request: `KARAFRIENDS_E2E_JP=1 yarn test:e2e --grep @jp`.
- There's no GraphQL any more: a test checks that `/graphql` answers 404, and every test fails if the display or the remote requests it.
- The display uses IPC: every test fails if the display requests `/api`, and one launches with the remote port already taken.
- `yarn test:e2e:ci` leaves out `@net` and `@jp`; CI runs it on Windows and Linux.
