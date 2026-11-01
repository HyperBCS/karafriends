# karafriends

<img src="icon.png" width="128" />

karafriends turns a computer connected to a TV into a karaoke machine. It plays songs from DAM, Joysound, YouTube and Niconico. Guests scan a QR code to search and queue songs from their phones.

## Features

- **Song catalogs:** DAM and Joysound, plus YouTube and Niconico videos with optional captions.
- **Phone remote:** search, queue, playback, key changes and emotes from any phone browser, in English or Japanese. Nothing to install.
- **Microphones:** low-latency live mixing with gain, echo and a noise gate per mic. ASIO support on Windows.
- **Pitch bars:** the melody and each singer's pitch for DAM and Joysound songs.
- **Party controls:** supervised mode, per-phone queue limits and an admin password.

## Requirements

- Windows 10 or later (x64), macOS on Apple silicon, or 64-bit Linux with glibc 2.34 or later (Ubuntu 22.04, Debian 12, Linux Mint 21 or newer).
- For DAM and Joysound: an account with each service and a Japanese IP address (a VPN to Japan works). Joysound requires a paid membership.
- Phones on the same network as the computer.
- Internet access on first launch, to download ffmpeg and yt-dlp.

## Installation

Download the zip for your platform from the [releases page](https://github.com/HyperBCS/karafriends/releases), extract it, and run `karafriends` (`karafriends.app` on macOS). There is no installer. To update, extract the new version over the old one.

| Platform              | Download                       |
| --------------------- | ------------------------------ |
| Windows               | `karafriends-win32-x64.zip`    |
| macOS (Apple silicon) | `karafriends-darwin-arm64.zip` |
| Linux                 | `karafriends-linux-x64.zip`    |

**Windows:** The app is not code-signed. If SmartScreen blocks it, select **More info**, then **Run anyway**. The console window that opens alongside shows the app's log; closing it quits karafriends.

**macOS:** Allow microphone access when prompted. You can change it later in System Settings › Privacy & Security › Microphone.

**Linux:** Desktop installs usually include the required libraries. On a minimal install, add them:

| Distribution                      | Command                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04 and newer, Debian 13 | `sudo apt install libasound2t64 libpipewire-0.3-0t64 libdbus-1-3 rtkit libnss3 libgtk-3-0t64 libgbm1` |
| Ubuntu 22.04, Mint 21, Debian 12  | `sudo apt install libasound2 libpipewire-0.3-0 libdbus-1-3 rtkit libnss3 libgtk-3-0 libgbm1`          |
| Fedora                            | `sudo dnf install alsa-lib pipewire-libs dbus-libs rtkit nss gtk3 mesa-libgbm`                        |
| Arch                              | `sudo pacman -S alsa-lib libpipewire dbus rtkit nss gtk3 mesa`                                        |

- On Ubuntu 23.10 and later, if the app exits with "The SUID sandbox helper binary was found, but is not configured correctly", run this in the extracted folder (again after each update): `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.
- If a firewall is enabled, allow the remote port: `sudo ufw allow 8080/tcp`.
- Microphones use PipeWire 0.3.50 or later when available, for the lowest latency, and otherwise PulseAudio or ALSA.

## Quick start

1. Connect the TV and start karafriends. It opens full screen on the main display.
2. On first launch, the setup screen asks for DAM and Joysound logins, microphones and an admin password while ffmpeg and yt-dlp download in the background. Every step can be skipped and changed later in Settings.
3. On Windows, allow karafriends through the firewall on private networks.
4. Guests scan the QR code on the TV to open the remote.

## Usage

### Display keys

| Key              | Action                             |
| ---------------- | ---------------------------------- |
| `S`              | Open Settings (`Esc` closes it)    |
| `Q`              | Show or hide the up-next strip     |
| `Ctrl`+`Cmd`+`F` | Enter or leave full screen (macOS) |

### Settings

| Tab      | Contents                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts | DAM and Joysound logins with **Test login**. Either catalog can be turned off.                                                                                     |
| Party    | The address and port phones connect to (or a custom URL for Tailscale, a reverse proxy or a port forward), supervised mode, per-phone queue limit, admin password. |
| Sound    | Song output, volume and guide melody level, audio/video offset, microphones (gain, echo, noise gate), mic output, mic mode and buffer, ASIO (Windows).             |
| Display  | UI scale and pitch bars.                                                                                                                                           |
| Advanced | Downloads, yt-dlp and ffmpeg updates, config import and export, version and licenses.                                                                              |

### Admins and supervised mode

- In supervised mode, only a song's singer or an admin can pause, skip or remove it.
- Guests become admins by entering the admin password on the phone's Settings screen. Admins can reorder the queue and control any song. Changing the password signs every phone out.
- **Everyone is an admin** gives every phone admin controls without a password.
- The remote uses plain HTTP. On an untrusted network, serve it over HTTPS and set it as the custom URL.

### Joysound

karafriends connects to Joysound as a JOYSOUND TV app, and Joysound allows one TV app per account. If another TV app holds the link, use **Test login**, then **Switch the TV link to karafriends**.

### Data

Settings are stored in `config.yaml`, the queue in `queue.json` and downloaded songs in `downloads/`, all in the app data folder:

| Platform | Folder                                      |
| -------- | ------------------------------------------- |
| Windows  | `%APPDATA%\karafriends`                     |
| macOS    | `~/Library/Application Support/karafriends` |
| Linux    | `~/.config/karafriends`                     |

`config.yaml` and exported config files contain your DAM and Joysound passwords in plain text, so keep them private. Use **Export config** and **Import config** (Settings › Advanced) to move settings to another computer.

### Environment variables

| Variable                                            | Effect                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `KARAFRIENDS_YTDLP_PATH`, `KARAFRIENDS_FFMPEG_PATH` | Use your own yt-dlp or ffmpeg instead of the downloaded copy.    |
| `KARAFRIENDS_AUDIO_HOST`                            | Linux: force `pipewire`, `pulseaudio` or `alsa` for microphones. |

### Troubleshooting

| Problem                              | Solution                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DAM or Joysound can't be reached     | Connect through a VPN to Japan. karafriends retries automatically.                                                                                                      |
| Joysound is off with a working login | Joysound requires a paid membership and allows one linked TV app per account (see [Joysound](#joysound)).                                                               |
| YouTube downloads fail               | Settings › Advanced › Tools: **Check for updates**, then **Update tools**.                                                                                              |
| Phones can't connect                 | Put phones on the same network, check the address in Settings › Party, and allow the port (8080 by default) through the firewall.                                       |
| Microphones crackle                  | Increase the mic buffer in Settings › Sound.                                                                                                                            |
| Microphone delay is noticeable       | Windows: set Mic mode to Exclusive (allow exclusive control in the mic's Windows sound properties) or use an ASIO output. Linux: use PipeWire and a smaller mic buffer. |

## Development

### Building

- Node.js 22.22.1 or later and Yarn. The repository pins Yarn 4.18.1, so any installed `yarn` works.
- Rust 1.88 or later (`rustup update stable`).
- Windows: Visual Studio Build Tools 2022 or later with the "Desktop development with C++" workload, and LLVM 9 or later (`winget install LLVM.LLVM`) for the ASIO bindings. Set `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin` if cargo can't find libclang. The build downloads the ASIO SDK into `buildResources/asio`.
- Linux: a C toolchain, pkg-config, the ALSA, PipeWire (0.3.53 or later) and D-Bus headers, and libclang:

  | Distribution                                | Command                                                                                                     |
  | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | Ubuntu 24.04 and newer, Debian 12 and newer | `sudo apt install build-essential pkg-config libasound2-dev libpipewire-0.3-dev libdbus-1-dev libclang-dev` |
  | Fedora                                      | `sudo dnf install gcc pkgconf-pkg-config alsa-lib-devel pipewire-devel dbus-devel clang-devel`              |
  | Arch                                        | `sudo pacman -S base-devel alsa-lib libpipewire dbus clang`                                                 |

`CARGO_ARGS=--no-default-features` builds without ASIO (Windows) or PipeWire (Linux), and without libclang. Builds use `-C relro-level=partial` from `.cargo/config.toml`; if you set `RUSTFLAGS`, include that flag.

### Commands

| Command                                         | Description                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `yarn install`                                  | Install dependencies.                                                         |
| `yarn dev`                                      | Run with hot reload. Uses the real app data folder, so quit the app first.    |
| `yarn typecheck`, `yarn lint`, `yarn test:unit` | Type check, lint and unit tests.                                              |
| `yarn build-prod`                               | Production build into `build/prod`.                                           |
| `yarn package-prod`                             | Package `build/prod` into `dist/`.                                            |
| `yarn test:e2e:install`, `yarn test:e2e`        | Install the test browser once, then run the end-to-end tests on `build/prod`. |

In development, phones connect through the Vite dev server on port 5173 (`KARAFRIENDS_DEV_PORT`), which forwards `/api` to the app on port 8080 (`KARAFRIENDS_REMOCON_PORT`). On Linux, `yarn dev` starts Electron with `--no-sandbox`.

### Architecture

- `src/main`: the Electron main process. It serves the phone remote, a JSON API (`POST /api/<method>`) and the live state as Server-Sent Events (`GET /api/events`) on the remote port.
- `src/renderer`: the TV display. It calls the same API over Electron IPC, so it keeps working if the remote port is unavailable.
- `src/remocon`: the phone remote.
- `src/common`: code shared by all three. `src/common/api.ts` defines every API method.
- `native`: the Rust audio module for microphones.

### End-to-end tests

The Playwright tests drive the display and an emulated phone against `build/prod`, so rebuild after changing the app. Each test runs a hidden, muted copy of the app with its own profile and port.

- `@net` tests download from YouTube. They use the ffmpeg and yt-dlp of an installed app, so launch the app once first.
- `@jp` tests use the DAM and Joysound logins of an installed app and need a Japanese IP: `KARAFRIENDS_E2E_JP=1 yarn test:e2e --grep @jp`.
- CI runs `yarn test:e2e:ci`, which skips both.

## Releasing

The Release workflow builds each platform's zip on that platform's own OS.

1. Set `version` in `package.json` and rename the changelog's **Unreleased** section to `## <version> (<date>)`. Commit, push and wait for the Build workflow to pass.
2. Optionally, run the Release workflow by hand (Actions › Release › Run workflow) to build the zips as artifacts without publishing.
3. Tag and push: `git tag v<version> && git push origin v<version>`. The workflow checks the tag against `package.json` and the changelog, builds every platform and publishes the release with the changelog section as its notes. A tag containing `-` (for example `v0.3.0-beta.1`) publishes a prerelease.

To build a release zip locally:

```sh
yarn install --immutable
yarn build-prod
yarn package-prod
```

- **macOS:** run `CARGO_ARGS="--target aarch64-apple-darwin" yarn build-prod`, then `PACKAGER_ARCH=arm64 yarn package-prod`. The build is unsigned unless `NOTARIZATION_KEY_PATH` is set and a Developer ID certificate is in the keychain. An unsigned build runs on the Mac that built it, but Gatekeeper may block it on other Macs.
- **Linux:** build on the oldest distribution you support (releases use Ubuntu 24.04). `scripts/checkLazyPipewire.sh` and `scripts/smokeLinuxPackage.sh` check the result.

### macOS signing

The Release workflow signs the macOS zip with a Developer ID Application certificate and notarizes it. Set `MACOS_SIGN` in `.github/workflows/release.yaml` to `"false"` to build unsigned. Signing needs these repository secrets:

| Secret                                                      | Value                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `MACOS_SIGNING_CERT_BASE64`                                 | The Developer ID Application certificate and private key as a `.p12`, base64-encoded. |
| `MACOS_SIGNING_CERT_PASSWORD`                               | The `.p12` password.                                                                  |
| `MACOS_KEYCHAIN_PASSWORD`                                   | Any password, for the workflow's temporary keychain.                                  |
| `MACOS_NOTARIZATION_API_KEY_BASE64`                         | An App Store Connect API key (`.p8`), base64-encoded.                                 |
| `MACOS_NOTARIZATION_KEY_ID`, `MACOS_NOTARIZATION_ISSUER_ID` | Optional. The key's ID and issuer ID; the defaults are in `packager.js`.              |
| `MACOS_SIGNING_IDENTITY`                                    | Optional. The certificate's name, if the keychain holds more than one.                |

`base64 -i file.p12 | pbcopy` copies a file as base64 on macOS.

## License

karafriends is free software under the [GNU General Public License, version 3](LICENSE) (GPL-3.0-only). It is a fork of [emmaworley/karafriends](https://github.com/emmaworley/karafriends) by Connor Worley, Emma Worley and contributors.

The Windows build includes Steinberg's ASIO SDK under the SDK's GPLv3 option. Its source is attached to each release as `asio-sdk-source.zip`. ASIO is a registered trademark of Steinberg Media Technologies GmbH.

ffmpeg and yt-dlp are not bundled. The app downloads them from their projects, under their own licenses.

The license and third-party notices ship with the app and are shown in Settings › Advanced › About.
