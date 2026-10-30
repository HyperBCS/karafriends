#!/usr/bin/env bash
# Checks the packaged Linux app (yarn package-prod's zip) on the system it
# runs on. CI runs it in an ubuntu:22.04 container, the oldest Ubuntu the zip
# is for, because the build runs on 24.04 and a module that only loads there
# would pass every other check.
#
#   scripts/smokeLinuxPackage.sh [--install-deps] [dist/karafriends-linux-x64.zip]
#
# --install-deps (as root, on Ubuntu or Debian) first installs what a desktop
# install has: Electron's libraries, libpipewire and libpulse, Xvfb, and
# unzip and curl. Without a zip it stops there.
#
# What it checks:
# 1. The zip's layout: the karafriends binary, the main process's entry, the
#    native module, and the bundled 7za, which runs.
# 2. The native module loads, in the packaged Electron run as Node, against
#    this system's libraries (on 22.04, libpipewire 0.3.48), and
#    linuxAudio() names a sound system.
# 3. The app starts hidden, with a throwaway profile and LOCAL_ONLY: its main
#    process prints that the server is up, the server answers with the
#    remote's page, and the app is still running 10 seconds later.
# 4. With SMOKE_TOOLS=download (CI), the app downloads yt-dlp and ffmpeg as on
#    a first launch, and both run here (--version). Without it the app runs
#    with no network expected; give a yt-dlp to try with SMOKE_YTDLP=<file>.
#
# What it can't check: sound (there's no sound server or device here), the
# display's WebGL, and a real desktop session.
#
# With SMOKE_LOGS=<dir>, a failed run leaves its logs there (the app's
# output, the native module's load, and the profile's own logs), for CI to
# keep: the job's log is only shown to the repo's admins.

set -euo pipefail

if [[ "${1:-}" == "--install-deps" ]]; then
  shift
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  # Electron's runtime libraries (as Ubuntu's desktop has them), the native
  # module's (libasound2, libdbus-1-3, libpipewire-0.3-0 and libpulse0), a
  # virtual display, and the tools this script uses.
  apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xvfb xauth \
    libgtk-3-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libxss1 libxshmfence1 libx11-xcb1 libpango-1.0-0 libcairo2 \
    libexpat1 libasound2 libdbus-1-3 libpipewire-0.3-0 libpulse0
  # Without a zip, that's all.
  if [[ $# -eq 0 ]]; then exit 0; fi
fi

zip="${1:?usage: smokeLinuxPackage.sh [--install-deps] <karafriends-linux-x64.zip>}"
zip="$(realpath "$zip")"

fail() {
  echo "smokeLinuxPackage: FAILED: $*" >&2
  exit 1
}
step() { echo "smokeLinuxPackage: $*"; }

if [[ -r /etc/os-release ]]; then
  step "on $(. /etc/os-release && echo "$PRETTY_NAME"), glibc $(ldd --version | head -n1 | awk '{ print $NF }')"
fi

scratch="$(mktemp -d)"
app_pid=""
cleanup() {
  local status=$?
  # setsid made the app its own process group: xvfb-run, Xvfb, and
  # Electron's processes.
  if [[ -n "$app_pid" ]]; then kill -- "-$app_pid" 2>/dev/null || true; fi
  if [[ $status -ne 0 && -n "${SMOKE_LOGS:-}" ]]; then
    mkdir -p "$SMOKE_LOGS"
    cp "$scratch"/*.log "$SMOKE_LOGS"/ 2>/dev/null || true
    if [[ -d "$scratch/profile" ]]; then
      (cd "$scratch/profile" && find . -name "*.log" -o -name "*.json" -o -name "config.yaml") |
        while read -r file; do
          mkdir -p "$SMOKE_LOGS/profile/$(dirname "$file")"
          cp "$scratch/profile/$file" "$SMOKE_LOGS/profile/$file"
        done
    fi
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

# 1. The layout.
unzip -q "$zip" -d "$scratch/unzipped"
app="$scratch/unzipped/$(basename "$zip" .zip)"
for file in karafriends resources/app/build/prod/main/index.js resources/extraResources/7za; do
  [[ -f "$app/$file" ]] || fail "the zip has no $(basename "$zip" .zip)/$file"
done
[[ -x "$app/karafriends" ]] || fail "karafriends isn't executable"
"$app/resources/extraResources/7za" i >/dev/null || fail "the bundled 7za doesn't run"
modules=("$app"/resources/app/build/prod/main/chunks/*.node)
[[ -f "${modules[0]}" ]] || fail "the zip has no native module in resources/app/build/prod/main/chunks"
step "the zip has the app, its native module and a 7za that runs"

# 2. The native module, in the packaged Electron as Node. No sound server,
# but a pipewire-0 file, which cpal takes for PipeWire's socket, so
# linuxAudio() asks this system's libpipewire for its version (22.04's 0.3.48
# is too old, and the module falls back); and an ALSA whose default device is
# the null plugin, so no device is opened.
mkdir -p "$scratch/run"
chmod 700 "$scratch/run"
: >"$scratch/run/pipewire-0"
printf 'pcm.!default { type null }\n' >"$scratch/asound.conf"
load='
const m = { exports: {} };
try {
  process.dlopen(m, process.argv[1]);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
console.log(m.exports.linuxAudio().status);
'
set +e
output="$(ELECTRON_RUN_AS_NODE=1 XDG_RUNTIME_DIR="$scratch/run" \
  PIPEWIRE_RUNTIME_DIR="$scratch/run" ALSA_CONFIG_PATH="$scratch/asound.conf" \
  "$app/karafriends" -e "$load" "${modules[0]}" 2>"$scratch/load.log")"
status=$?
set -e
[[ $status -eq 0 ]] || fail "the native module doesn't load here: $(cat "$scratch/load.log")"
[[ "$output" == "Sound system:"* ]] || fail "linuxAudio() said: $output $(cat "$scratch/load.log")"
step "the native module loads: $output"

# 3. A hidden launch, with a throwaway profile, on a virtual display.
port=18080
profile="$scratch/profile"
mkdir -p "$profile" "$scratch/tmp"
printf 'remoconPort: %s\n' "$port" >"$profile/config.yaml"
if [[ -n "${SMOKE_YTDLP:-}" ]]; then
  mkdir -p "$profile/externalResources/ytdlp"
  cp "$SMOKE_YTDLP" "$profile/externalResources/ytdlp/yt-dlp"
  chmod 755 "$profile/externalResources/ytdlp/yt-dlp"
fi
KARAFRIENDS_HIDE_WINDOW=1 KARAFRIENDS_LOCAL_ONLY=1 KARAFRIENDS_REMOCON_PORT="$port" \
  TMPDIR="$scratch/tmp" XDG_RUNTIME_DIR="$scratch/run" \
  setsid xvfb-run --auto-servernum "$app/karafriends" --no-sandbox --mute-audio \
  --enable-unsafe-swiftshader --disable-dev-shm-usage --user-data-dir="$profile" \
  >"$scratch/app.log" 2>&1 &
app_pid=$!
show_log() {
  echo "--- the app's output ---" >&2
  cat "$scratch/app.log" >&2
}
up=""
for _ in $(seq 60); do
  if grep -q "Server is now running" "$scratch/app.log"; then
    up=1
    break
  fi
  if grep -q "Phones can't connect" "$scratch/app.log" || ! kill -0 "$app_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
[[ -n "$up" ]] || {
  show_log
  fail "the app's server didn't start"
}
page="$(curl -fsS "http://127.0.0.1:$port/")" || {
  show_log
  fail "the server didn't answer"
}
[[ "$page" == *"<title>karafriends</title>"* ]] || {
  show_log
  fail "the server didn't answer with the remote's page"
}
sleep 10
kill -0 "$app_pid" 2>/dev/null || {
  show_log
  fail "the app quit within 10 seconds of starting"
}
step "the app starts hidden and serves the remote"

# 4. The tools: yt-dlp is the standalone build, which brings its own Python,
# and ffmpeg BtbN's static build (src/common/externalResourcesPlan.ts).
tools="$profile/externalResources"
if [[ "${SMOKE_TOOLS:-}" == "download" ]]; then
  for _ in $(seq 300); do
    if [[ -f "$tools/versions.json" ]] && grep -q '"ffmpeg"' "$tools/versions.json" &&
      grep -q '"ytdlp"' "$tools/versions.json"; then
      break
    fi
    kill -0 "$app_pid" 2>/dev/null || break
    sleep 1
  done
  [[ -x "$tools/ytdlp/yt-dlp" && -x "$tools/ffmpeg/ffmpeg" ]] || {
    show_log
    fail "the app didn't download yt-dlp and ffmpeg"
  }
fi
if [[ -x "$tools/ytdlp/yt-dlp" ]]; then
  version="$(TMPDIR="$scratch/tmp" "$tools/ytdlp/yt-dlp" --version 2>&1)" ||
    fail "yt-dlp doesn't run here: $version"
  step "yt-dlp runs: $version"
fi
if [[ -x "$tools/ffmpeg/ffmpeg" ]]; then
  version="$("$tools/ffmpeg/ffmpeg" -version 2>&1 | head -n1)" ||
    fail "ffmpeg doesn't run here: $version"
  step "ffmpeg runs: $version"
fi

step "passed"
