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
- Until a DAM or Joysound login is set, the app opens on its Settings screen, with a line at the top saying so. Add a login there, or close Settings and use YouTube and Niconico songs only.

### Settings

Open Settings with the gear on the idle screen, or press `S`. Escape or Close puts it away. Each field saves when you leave it.

- **DAM login** and **Joysound login**: your username (for Joysound, your email) and password. Test login signs in once and says whether it worked. DAM and Joysound only answer from a Japanese IP address: outside Japan, run a VPN to Japan on this computer. Without a login, only YouTube and Niconico songs work.
- **Admin password**: a guest who types it on the phone's profile screen becomes an admin. Changing or clearing it signs every phone out. With none set, no phone can be an admin; the display always is one.
- **Queue**: supervised mode (only a song's singer or an admin can pause, skip or remove it), and how many songs each phone may have queued at once (0 for no limit).
- **Everyone is an admin** (under Queue): every phone can reorder, remove any song, pause, skip and change the key with no password. It overrides supervised mode; the per-phone song limit still applies (set it to 0 for none), and Settings stay on the display.
- **Remote port**: the port phones connect to (8080 unless you change it). A new port takes effect after a restart, and Settings shows a Restart button once you change it. If another program already uses the port, the display says phones can't connect; pick another port.
- **QR code address**: what the QR code on the idle screen points at. If a phone can't open `karafriends.local`, pick this computer's IP address here and scan again.
- **Microphones**: pick each microphone (by the name the system gives it) and its channel; each row has its own Gain and Echo sliders (an admin's phone has the same ones) and a Remove button. Every mic plays through the Mic output picked above the rows (the system default, or any output device, ASIO included in the Windows build); the song keeps playing through the system default. The line under Mic output says what ASIO has: the drivers installed (an interface's own and wrappers such as ASIO4ALL or FlexASIO alike; only 64-bit drivers work), that none are, or a driver that won't load and why. An ASIO mic output also has a Buffer, in samples (smaller means less delay; pick a bigger one if the mics crackle), and a Sample rate, both the driver's setting until you pick one; the rate is the interface's own, so Windows sound through it changes too. "In use" under the output and under each mic says the rate and buffer it runs at. On Windows, Windows mics are Shared (the default) or Exclusive: exclusive cuts a USB mic's delay from 10 ms to about 3, but no other program can use the mic meanwhile, and Windows must allow it (in Sound settings, the mic's Properties, Advanced, "Allow applications to take exclusive control of this device"); a mic Windows won't give stays shared, and its "In use" line says why. A mic that stops (unplugged, or the TV went to sleep) is reopened by itself every two seconds until it is back, and its row shows why it is down.
- **Tools**: the yt-dlp and ffmpeg versions in use. When the display says YouTube downloads are failing, press Update tools: it downloads both again, which takes a few minutes. To use your own copy instead (a newer yt-dlp, say), set `KARAFRIENDS_YTDLP_PATH` or `KARAFRIENDS_FFMPEG_PATH` to the program's full path before starting the app; karafriends then never downloads that tool.
- **Config file**: Export config saves everything on this screen to a file, the DAM and Joysound logins and the admin password included, so keep the file as safe as the logins. Import config reads such a file back, on this computer or another, lists anything it couldn't use, and tests both logins.

The settings live in `config.yaml` in the app's data folder (`%APPDATA%\karafriends` on Windows, `~/Library/Application Support/karafriends` on macOS, `~/.config/karafriends` on Linux); to move them to another computer, use Export config and Import config.

### Phones

- Phones join the same Wi-Fi as the computer and scan the QR code on the idle screen.
- A new phone first picks a nickname on the profile screen. It shows next to the songs that phone queues, and the profile button (top right) changes it later.
- One search box covers DAM and Joysound: search by title or by artist, in both catalogs or just one. To queue a YouTube or Niconico video, paste its link (or its video ID) into the same box.
- The queue is in the now-playing bar at the bottom of the phone's screen. Songs play in the order they were queued.
- The profile screen also switches the remote between English and Japanese (日本語), and turns on notifications for when your song is up soon.
- To become an admin, a guest types the admin password on the profile screen and presses Sign in. An admin can move any song to the top, up or down, and pause, skip or remove any song. Sign out is on the same screen. Phones stay signed in when the app restarts.

### Keys on the display

- `Q`: show or hide the up-next strip under a playing song.
- `S`: open Settings. Escape closes it.

## Building

Dependencies

- Node.js, plus any `yarn` on your PATH (`npm install -g yarn` is enough). The repo pins its Yarn version in `.yarn/releases` via `yarnPath`, so whichever `yarn` you run hands off to it; corepack isn't needed.
- Rust
- On Windows, LLVM, once: `winget install LLVM.LLVM`. Windows builds include ASIO by default, and its bindings need LLVM's libclang; if cargo can't find it, set `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin`. The build downloads Steinberg's ASIO SDK itself, into `buildResources/asio` the first time `yarn dev` or a `yarn build-*` runs (`yarn get-external-resources` does it alone, before a bare `cargo` command); cargo uses `CPAL_ASIO_DIR` instead when it is set. `CARGO_ARGS=--no-default-features yarn build-prod` (or `yarn dev`) builds without ASIO, and without LLVM.

## Running

```sh
yarn install && yarn dev
```

`yarn install` puts dependencies in `node_modules` and keeps its download cache in `.yarn/cache`. Neither is committed.

`yarn dev` builds the native module, then runs `electron-vite dev -w`: the main process and the preload are rebuilt when they change (and the app restarts or the display reloads), and the display and the phone remote come from the Vite dev server, with hot reload. In dev, phones use the dev server too: the display's QR code points at its port (5173, or `KARAFRIENDS_DEV_PORT`), and it passes `/api` on to the app's own server, which then listens on 8080 (or `KARAFRIENDS_REMOCON_PORT`), whatever `config.yaml` says. On Linux, `yarn dev` starts Electron with `--no-sandbox`: on systems that block unprivileged user namespaces (Ubuntu 23.10 and later), Chromium otherwise aborts because `node_modules`' `chrome-sandbox` isn't setuid root.

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
