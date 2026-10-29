# karafriends

<img src="https://raw.githubusercontent.com/emmaworley/karafriends/master/icon.png" width="128" />

## Running a party

This part is for the host: the person whose computer plays the songs on the TV. Guests only need their phones.

### Install

Download the zip for your computer from the [Releases page](https://github.com/HyperBCS/karafriends/releases): `win32-x64` for Windows, `darwin-arm64` for an Apple Silicon Mac, `darwin-x64` for an Intel Mac, `linux-x64` for Linux. Unzip it anywhere (it unzips to a `karafriends-<platform>` folder) and run `karafriends` inside. There's no installer; to update, unzip the new version over the old one or next to it.

### On Linux

The Linux zip is for 64-bit Linux as old as Ubuntu 22.04, Linux Mint 21 or Debian 12 (its mic module needs glibc 2.34 or newer), and needs no Python. A desktop install usually has everything it needs; if the app won't start, or on a minimal install, add these:

| Distribution                      | Command                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04 and newer, Debian 13 | `sudo apt install libasound2t64 libpipewire-0.3-0t64 libdbus-1-3 rtkit libnss3 libgtk-3-0t64 libgbm1` |
| Ubuntu 22.04, Mint 21, Debian 12  | `sudo apt install libasound2 libpipewire-0.3-0 libdbus-1-3 rtkit libnss3 libgtk-3-0 libgbm1`          |
| Fedora                            | `sudo dnf install alsa-lib pipewire-libs dbus-libs rtkit nss gtk3 mesa-libgbm`                        |
| Arch                              | `sudo pacman -S alsa-lib libpipewire dbus rtkit nss gtk3 mesa`                                        |

- The PipeWire library is needed even where PipeWire isn't the sound server; without it the app stops at launch with "libpipewire-0.3.so.0: cannot open shared object file". rtkit lets the mics run at real-time priority, which small mic buffers need to play without crackles.
- On Ubuntu 23.10 and newer (and other systems that restrict user namespaces), the app stops at launch with "The SUID sandbox helper binary was found, but is not configured correctly". Fix it once, in the unzipped folder: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`. Unzipping a new version over it undoes this, so run the two commands again after each update. It only works in a folder on a regular disk: `/tmp` and USB sticks are often mounted so that it's ignored. (Starting it as `./karafriends --no-sandbox` works too, but runs the YouTube player without Chromium's sandbox.)
- Phones connect on the remote port (8080/tcp). Most desktops let it in; if you turned on Ubuntu's firewall, open it with `sudo ufw allow 8080/tcp`.
- The mics use PipeWire where it runs (most systems since 2022), else PulseAudio, else ALSA itself. PipeWire gives the least delay; see Microphones below. Ubuntu 22.04 and Mint 21 have PipeWire 0.3.48, older than the 0.3.50 karafriends needs, so there the mics use PulseAudio (pipewire-pulse), and the line under Mic output says so.

### First launch

- The app opens full-screen on the main display. Plug in the TV before starting it, or move the window there.
- The first start downloads ffmpeg and yt-dlp (for YouTube and Niconico songs), so be online and give it a minute. The TV says "Getting YouTube ready…" with how far along it is meanwhile.
- Windows asks whether to let karafriends through the firewall. Allow it on private networks, or phones can't connect.
- The first start (no `config.yaml` yet, so deleting it starts over) opens the setup screen: the DAM and Joysound logins, each checked as you enter it (or Import config, with a file from another karaoke PC's Export config), then the mics and speakers, then an admin password. Each step can be skipped, and Skip setup leaves it. After that, the app opens on the idle screen, with or without a login; Settings has everything the setup screen had.

### Settings

Open Settings with the gear on the idle screen, or press `S`. Escape or Close puts it away. Its tabs run down the left: Accounts (the logins), Party (phones, queue, admin password), Sound (sound and microphones), Display, and Advanced (downloads, tools, config file); the arrow keys move between them, and Settings opens on the last one. A dot on a tab means something there needs a look. Each field saves when you leave it.

- **DAM login** and **Joysound login**: your username (for Joysound, your email) and password. Test login signs in once and says whether it worked. DAM and Joysound only answer from a Japanese IP address: outside Japan, run a VPN to Japan on this computer. Without a login, only YouTube and Niconico songs work.
  **Use DAM** and **Use Joysound** turn a catalog off whatever its login (`damEnabled` and `joysoundEnabled` in `config.yaml`, both on by default): karafriends doesn't sign in to it, and phones don't show it. Each login is checked at launch and whenever it (or its switch) changes, and a line under its title says how it stands. Its catalog (DAM's songs, or Joysound's) is on only once its login has signed in: until then, phones don't show it (no results, no song pages, no Browse) and say why. If DAM or Joysound can't be reached (no connection, or no Japanese IP address: the VPN is off), the TV says so ("Turn on the VPN to Japan"), and karafriends tries again by itself, after 10 seconds, 30, then every minute, so turning the VPN on is enough. A refused login (a wrong password, a Joysound account that isn't a paid member, or another TV app holding Joysound's link) stays off until it's changed, Test login works, or the link is switched; the TV says why.
  Joysound's songs and searches come through the JOYSOUND TV app's API. The first time karafriends gets something from Joysound, it signs in with the email and password and links itself to the account as its JOYSOUND TV app, as the TV app's QR code would; it keeps that link (encrypted by the system, in its own folder, not in `config.yaml`) and only links again if Joysound ends it. Joysound links one TV app to an account at a time: if another one holds the link, karafriends leaves it be and Joysound searches and songs say so. Until karafriends is linked, Test login offers **Switch the TV link to karafriends**, which links it, unlinking any other TV app. A new email drops the old account's link (Joysound keeps karafriends as that account's TV app until another takes its place). Test login also says how the link stands, and links nothing. Songs download only for a paid member: with a free account, searches and song pages work, but Joysound songs fail to download.
- **Phones**: the Address the QR code points phones at, and the Port they connect to (8080 unless you change it). The Address is this computer's IP address on the local network: the first one it finds unless you pick another (with Wi-Fi and Ethernet both connected, pick the one the phones' Wi-Fi is on). The QR code follows a new address within 10 seconds, and a picked one that's gone (another network) goes back to the first. For phones that reach this computer another way (Tailscale, a port forward, a reverse proxy to the Port), pick Custom URL… and type the address they open, such as `https://karaoke.example.ts.net` or `203.0.113.5:8080` (http unless it says https): the QR code and the address under it use it until you pick a LAN address again. It has to be the site's root, with no path, since the remote calls `/api` there; and anyone who can open it can queue songs, so set an admin password if it's on the internet. A new port takes effect after a restart, and Settings shows a Restart button once you change it. If another program already uses the port, the display says phones can't connect; pick another port. Under `yarn dev`, phones use the dev server's port instead (see Running), and the Port field says so.
- **Queue**: supervised mode (only a song's singer or an admin can pause, skip or remove it), and how many songs each phone may have queued at once (0 for no limit).
- **Everyone is an admin** (under Queue): every phone can reorder, remove any song, pause, skip and change the key with no password. It overrides supervised mode; the per-phone song limit still applies (set it to 0 for none), and Settings stay on the display.
- **Admin password**: a guest who types it on the phone's Settings screen becomes an admin. Changing or clearing it signs every phone out. With none set, no phone can be an admin; the display always is one.
- **Display**: the UI scale, and Pitch bars (on unless you turn it off): the song's melody as bars along the top of a DAM or Joysound song, with each mic's pitch over them. A Joysound song's melody is read from its guide melody, about a second after it starts. Both are kept on this computer.
- **Sound**: the Song output the songs play through (the system default unless you pick another; a saved one that isn't connected says so, and the songs play through the default), the audio/video offset, and the Song volume and Guide melody (Joysound's, and the guide vocal of a Joysound song queued with one), for every song, the same ones an admin's phone has. If the chosen output goes away, the songs keep playing silently until it's back; Settings says so.
- **Microphones**: pick each microphone (by the name the system gives it) and its channel; each row has its own Gain and Echo sliders and a Noise gate (an admin's phone has the same ones) and a Remove button. Under each row, a meter shows the mic's level as it comes in (before Gain), so you can see that it works. The Noise gate is off until you raise it (−59 to −20 dB, on the meter's scale): under it, the mic stays quiet on the speakers and draws no pitch line, so a fan, chatter or a mic set down on the table doesn't come through. It opens within 2 ms of a louder sound and closes after 0.2 s under it, so the gaps between words don't chop. The meter marks the gate and turns grey while the level is under it; set the gate just above what the meter shows when nobody sings. Every mic plays through the Mic output picked above the rows (the system default, or any output device, ASIO included in the Windows build; only 64-bit ASIO drivers work); the songs play through the Song output. If an ASIO driver won't load, a line under Mic output says which and why. An ASIO mic output also has a Buffer, in samples (smaller means less delay; pick a bigger one if the mics crackle), and a Sample rate, both the driver's setting until you pick one; the rate is the interface's own, so Windows sound through it changes too. "In use" under the output and under each mic says the rate and buffer it runs at. On Windows, Mic mode is Shared (the default) or Exclusive: exclusive cuts a USB mic's delay from 10 ms to about 3, but no other program can use the mic meanwhile, and Windows must allow it (in Sound settings, the mic's Properties, Advanced, "Allow applications to take exclusive control of this device"); a mic Windows won't give stays shared, and its "In use" line says why. Mics on the channels of one interface share its exclusive stream. "In use" counts the packets Windows lost; a bigger Mic buffer helps. On Linux, the line under Mic output says which sound system the mics use (PipeWire, PulseAudio or ALSA, and why not PipeWire if it isn't), and Mic buffer sets the buffer of every mic and the mic output alike, in samples: smaller means less delay (the default is 128, 2.7 ms at 48 kHz; on PulseAudio 512, since its mics don't run at real-time priority), and a bigger one helps if the mics crackle. With PipeWire, every program's sound runs at that buffer while a mic is open. "In use" ends with "Not real-time" and why, if the system wouldn't run the mics at real-time priority (install rtkit). "System default" follows the mic picked in the system's sound settings. A mic plugged in while Settings is open shows under Add a microphone within a moment (when the system says a device came, or as you open Add a microphone); a listing that takes a while says "Looking for microphones…" first. On Windows the ASIO devices are listed again only while no mic and no mic output is open, since loading the ASIO drivers stops the mics that are open. To pick the sound system yourself, set `KARAFRIENDS_AUDIO_HOST` to `pipewire`, `pulseaudio` or `alsa` before starting the app. A mic that stops (unplugged, gone silent, or the TV went to sleep) is reopened by itself every two seconds until it is back, and its row shows why it is down. If the chosen Mic output is missing, the mics play through the default output and move back within about 10 seconds of its return.
- **Tools**: the yt-dlp and ffmpeg versions in use. When the display says YouTube downloads are failing, press Update tools: it downloads both again, which takes a few minutes. To use your own copy instead (a newer yt-dlp, say), set `KARAFRIENDS_YTDLP_PATH` or `KARAFRIENDS_FFMPEG_PATH` to the program's full path before starting the app; karafriends then never downloads that tool.
- **Config file**: Export config saves everything on this screen to a file, the DAM and Joysound logins and the admin password included, so keep the file as safe as the logins. Import config reads such a file back, on this computer or another, lists anything it couldn't use, and tests both logins. The Joysound link isn't in the file: another computer links itself to the account the first time it's used.

The settings live in `config.yaml` in the app's data folder (`%APPDATA%\karafriends` on Windows, `~/Library/Application Support/karafriends` on macOS, `~/.config/karafriends` on Linux); to move them to another computer, use Export config and Import config. Downloaded songs are kept in its `downloads` folder (Clear downloads in Settings → Advanced empties it), and the queue in `queue.json` next to `config.yaml`.

### Phones

- Phones join the same Wi-Fi as the computer and scan the QR code on the idle screen.
- A new phone first picks a nickname on the Settings screen. It shows next to the songs that phone queues, and the Settings button (the gear, top right) changes it later.
- One search box covers DAM and Joysound: search by title or by artist, in both catalogs or just one (the button at the end of the Title/Artist row). To queue a YouTube or Niconico video, paste its link (or its video ID) into the same box.
- Phones only show DAM's and Joysound's songs while they're on and their login works (see Settings): a catalog that's off is quietly left out of the search, the search's source button shows only when both are on, and a song or artist page from an old link says it isn't available. With neither on, the search box takes YouTube and Niconico links only.
- **Browse** (the compass in the top bar, while Joysound is on) lists Joysound's newest songs, its genres' most popular songs (J-POP, 演歌, アニメ, VOCALOID and more), and its featured lists (with their picture and description, without the TV app's own pitch for its sign-up and buttons), each opening its songs. It's Joysound only: DAM gives karafriends no such lists.
- A DAM or Joysound song's page shows a picture when the catalog has one: DAM's karaoke video title card, or Joysound's album art (from Amazon or Apple). The computer fetches it and passes it on, so phones only ever talk to karafriends. DAM songs also show their length.
- Some Joysound songs have a guide-vocal version as well: another recording, with a singer on the guide channel where the usual version has a synthesised melody. Their page has a second button, **Queue song with guide vocal**. Its guide vocal plays at the Guide melody's level (Settings › Sound, or an admin's phone), muted until that's raised, as the melody is; it shows no pitch bars (they're read from a melody line, not a voice), and the queue labels it "Guide vocal".
- The queue is in the now-playing bar at the bottom of the phone's screen: tap it, or drag it up, to see what's up next, and tap it or drag it down to fold it. Songs play in the order they were queued. With the queue open, the title of the song playing opens its page. Tap a queued song to see who queued it and its buttons: the song's page (to queue it again, say), Remove, and for an admin, Move to top.
- History (the clock, top right) lists the songs sung at this computer, by every phone, newest first. The computer keeps it (the newest 1000 songs, across restarts), so every phone sees the same list; Mine at the top shows just the songs this phone queued.
- The Settings screen also switches the remote between English and Japanese (日本語).
- To become an admin, a guest types the admin password on the Settings screen and presses Sign in. An admin can move any song to the top, up or down, and pause, skip or remove any song. Sign out is on the same screen. Phones stay signed in when the app restarts.

### Keys on the display

- `Q`: show or hide the up-next strip under a playing song.
- `S`: open Settings. Escape closes it.

## Building

Dependencies

- Node.js 22.22.1 or newer (lint-staged 17 and React Router 8 need it; Vite and Electron's tools need 22.12), plus any `yarn` on your PATH (`npm install -g yarn` is enough). The repo pins its Yarn version (4.18.1) in `.yarn/releases` via `yarnPath`, so whichever `yarn` you run hands off to it; corepack isn't needed.
- Rust 1.88 or newer (the crates are edition 2024 and use `let` chains), from rustup: `rustup update stable` keeps it current.
- On Windows, the Visual Studio Build Tools 2022 or newer with the "Desktop development with C++" workload, for Rust's linker and the ASIO SDK's C++.
- The project's TypeScript is 7, the native compiler, which ships no `tsserver`: for type errors in the editor, use VS Code's "TypeScript Native Preview" extension or the editor's bundled TypeScript. `yarn typecheck` needs nothing extra.
- On Windows, LLVM 9 or newer (bindgen's minimum), once: `winget install LLVM.LLVM`. Windows builds include ASIO by default, and its bindings need LLVM's libclang; if cargo can't find it, set `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin`. The build downloads Steinberg's ASIO SDK itself, into `buildResources/asio` the first time `yarn dev` or a `yarn build-*` runs (`yarn get-external-resources` does it alone, before a bare `cargo` command); cargo uses `CPAL_ASIO_DIR` instead when it is set. `CARGO_ARGS=--no-default-features yarn build-prod` (or `yarn dev`) builds without ASIO, and without LLVM.
- On Linux, a C toolchain, pkg-config, the ALSA, PipeWire and D-Bus headers, and libclang 9 or newer (PipeWire's Rust bindings are generated with it):

  | Distribution                                | Command                                                                                                     |
  | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | Ubuntu 24.04 and newer, Debian 12 and newer | `sudo apt install build-essential pkg-config libasound2-dev libpipewire-0.3-dev libdbus-1-dev libclang-dev` |
  | Fedora                                      | `sudo dnf install gcc pkgconf-pkg-config alsa-lib-devel pipewire-devel dbus-devel clang-devel`              |
  | Arch                                        | `sudo pacman -S base-devel alsa-lib libpipewire dbus clang`                                                 |

  The PipeWire headers must be 0.3.53 or newer (Ubuntu 22.04's are older). Where they aren't, `CARGO_ARGS=--no-default-features yarn build-prod` builds without PipeWire, needing neither its headers nor libclang, and the mics use PulseAudio or ALSA.

  Builds use `-C relro-level=partial` from `.cargo/config.toml`. A `RUSTFLAGS` variable replaces it, so include the flag there too. `scripts/checkLazyPipewire.sh` checks a built `native/index.node`.

## Releasing

Release zips come from the Release workflow, one per platform, and each zip is built on its own operating system: Windows and macOS zips can't be built elsewhere, and a Linux zip runs only where glibc is at least the building machine's (the workflow builds on Ubuntu 24.04, so its zip runs on 22.04 and newer; one built on a newer distribution wouldn't).

### A release build on your own machine

With the Building dependencies installed, from a clean checkout of the version to build:

```sh
yarn install --immutable
yarn build-prod      # native module (release), main, preload, display and remote into build/prod
yarn package-prod    # dist/karafriends-<platform>-<arch>/ and its .zip
```

The zip holds a `karafriends-<platform>-<arch>` folder; the app inside is what the Releases page ships. Per platform:

- **Windows**: `yarn build-prod` downloads Steinberg's ASIO SDK the first time and needs LLVM (see Building). The zip is `dist\karafriends-win32-x64.zip`, unsigned, like the released one.
- **macOS**: `CARGO_ARGS="--target aarch64-apple-darwin" yarn build-prod`, then `PACKAGER_ARCH=arm64 yarn package-prod` for Apple Silicon. For Intel Macs, on the same Apple Silicon machine: `rustup target add x86_64-apple-darwin`, then `CARGO_ARGS="--target x86_64-apple-darwin" yarn build-prod` and `PACKAGER_ARCH=x64 yarn package-prod`. The released zips are signed and notarized; a local one is left unsigned (it says so) unless `NOTARIZATION_KEY_PATH` points at the App Store Connect API key and the Developer ID certificate is in the keychain, as the workflow arranges. An unsigned build runs on the Mac that built it; Gatekeeper may refuse it on another Mac.
- **Linux**: build on the oldest distribution the zip is for (Ubuntu 24.04 for the released one). After `yarn build-prod`, `scripts/checkLazyPipewire.sh native/index.node` checks the module will load with an older PipeWire; after `yarn package-prod`, `scripts/smokeLinuxPackage.sh dist/karafriends-linux-x64.zip` starts the packaged app hidden and checks it (CI runs it in an Ubuntu 22.04 container). If `RUSTFLAGS` is set in your shell, add `-C relro-level=partial` to it (see Building).

`yarn build-prod` fetches nothing from the network except the ASIO SDK on Windows: ffmpeg and yt-dlp are downloaded by the app itself at its first launch.

### Publishing a release

1. Set the version in `package.json` and give the CHANGELOG's unreleased section that version and date. Commit and push.
2. Try the workflow first: on GitHub, Actions → Release → Run workflow. It builds, signs and zips all four platforms and keeps each zip as a workflow artifact. Download one and start it.
3. Publish a GitHub Release whose tag is `v` followed by `package.json`'s version (`v0.2.0`). The Release workflow runs on publishing, refuses a tag that doesn't match the version, and uploads the four zips to the release. If one platform fails, the others still upload; fix it and re-run that release's workflow run.

The Build workflow runs on every push: typecheck, lint, the unit and Rust tests, a build on every platform, the smoke tests on Windows and Linux, and the packaged Linux zip on Ubuntu 22.04. A release should only be cut from a green master.

macOS signing needs four repository secrets: `MACOS_SIGNING_CERT_BASE64` and `MACOS_SIGNING_CERT_PASSWORD` (the Developer ID Application certificate as a base64 `.p12` and its password), `MACOS_KEYCHAIN_PASSWORD` (any password for the temporary keychain), and `MACOS_NOTARIZATION_API_KEY_BASE64` (the App Store Connect API key `.p8`, base64; its key id and issuer are in `packager.js`).

## Running

```sh
yarn install && yarn dev
```

`yarn install` puts dependencies in `node_modules` and keeps its download cache in `.yarn/cache`. Neither is committed.

`yarn dev` uses the app's own data folder (Settings, above: `config.yaml`, the queue, the downloads), as a packaged build does, so close the app before starting it: one karafriends runs at a time, and a second launch brings the first to the front. `yarn dev` builds the native module, then runs `electron-vite dev -w`: the main process and the preload are rebuilt when they change (and the app restarts or the display reloads), and the display and the phone remote come from the Vite dev server, with hot reload. In dev, phones use the dev server too: the display's QR code points at its port (5173, or `KARAFRIENDS_DEV_PORT`), and it passes `/api` on to the app's own server, which then listens on 8080 (or `KARAFRIENDS_REMOCON_PORT`), whatever `config.yaml` says. On Linux, `yarn dev` starts Electron with `--no-sandbox`: on systems that block unprivileged user namespaces (Ubuntu 23.10 and later), Chromium otherwise aborts because `node_modules`' `chrome-sandbox` isn't setuid root.

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
- Every test fails if the display logs an error the test doesn't expect.
- The display uses IPC: every test fails if the display requests `/api`, and one launches with the remote port already taken.
- `yarn test:e2e:ci` leaves out `@net` and `@jp`; CI runs it on Windows and Linux.
