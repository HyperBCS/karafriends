#!/usr/bin/env bash
# Checks that the Linux native module still loads with a libpipewire older
# than 0.3.50 (Ubuntu 22.04 has 0.3.48), which lacks pw_stream_get_time_n.
#
#   scripts/checkLazyPipewire.sh [native/index.node]
#
# Run it after `yarn build-native-dev` or `yarn build-prod`. Two checks:
#
# 1. readelf: every pw_* import is a JUMP_SLOT (bound when first called,
#    thanks to -z lazy in native/karafriends/build.rs), not a GLOB_DAT (bound
#    as the module loads, so a missing one stops the app at launch). rustc
#    emits PLT calls only with partial RELRO, which .cargo/config.toml asks
#    for. A RUSTFLAGS variable, even an empty one, replaces that config: set
#    `-C relro-level=partial` in it too.
# 2. A stand-in libpipewire-0.3.so.0 with every pw_* function the module
#    imports but pw_stream_get_time_n, reporting version 0.3.48: node loads
#    the module against it, and linuxAudio() must then say PipeWire is too
#    old (the fallback in linux.rs). The stand-in's run sees no sound server
#    and an ALSA whose default device is the null plugin, so no real device
#    is opened.
#
# Needs readelf, cc and node.

set -euo pipefail

module="${1:-native/index.node}"
if [[ ! -f "$module" ]]; then
  echo "checkLazyPipewire: $module not found; build it first (yarn build-native-dev)" >&2
  exit 1
fi
module="$(realpath "$module")"

fail() {
  echo "checkLazyPipewire: FAILED: $*" >&2
  exit 1
}

# 1. Relocations: "offset info type value name + addend" per line.
relocations="$(readelf -rW "$module" | awk '$5 ~ /^pw_/ { print $3, $5 }' | sort -u -k2)"
if [[ -z "$relocations" ]]; then
  echo "checkLazyPipewire: $module imports no pw_* function (built without the pipewire feature?); nothing to check"
  exit 0
fi
eager="$(grep -v '_JUMP_SLOT ' <<<"$relocations" || true)"
if [[ -n "$eager" ]]; then
  fail "these libpipewire imports are bound when the module loads, so it won't load with
an older libpipewire (Ubuntu 22.04's 0.3.48 has no pw_stream_get_time_n):
$eager
Build every crate with -C relro-level=partial (.cargo/config.toml does this
unless RUSTFLAGS is set; if it is, add the flag to it)."
fi
if readelf -dW "$module" | grep -Eq '\((BIND_NOW|FLAGS)\).*\bBIND_NOW\b|\(FLAGS_1\).*\bNOW\b'; then
  fail "$module is linked with -z now, so its imports are bound as it loads; build.rs links it with -z lazy"
fi
count="$(wc -l <<<"$relocations")"
echo "checkLazyPipewire: all $count pw_* imports are JUMP_SLOT, bound when first called"

# 2. Load against the stand-in libpipewire.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/lib" "$scratch/run" "$scratch/home"
{
  echo '/* Stand-in libpipewire 0.3.48: no pw_stream_get_time_n. */'
  awk '{ print $2 }' <<<"$relocations" | while read -r name; do
    case "$name" in
    pw_stream_get_time_n) ;;
    pw_get_library_version) echo 'const char *pw_get_library_version(void) { return "0.3.48"; }' ;;
    *) echo "void *$name(void) { return 0; }" ;;
    esac
  done
} >"$scratch/stub.c"
cc -shared -fPIC -Wl,-soname,libpipewire-0.3.so.0 -o "$scratch/lib/libpipewire-0.3.so.0" "$scratch/stub.c"
# cpal counts PipeWire as running when its socket exists; a plain file will do,
# since the version check comes first.
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
const audio = m.exports.linuxAudio();
console.log(audio.status);
if (!/PipeWire 0\.3\.48 is older than 0\.3\.50/.test(audio.status)) process.exit(3);
'
set +e
output="$(env -i PATH="$PATH" HOME="$scratch/home" \
  XDG_RUNTIME_DIR="$scratch/run" PIPEWIRE_RUNTIME_DIR="$scratch/run" \
  ALSA_CONFIG_PATH="$scratch/asound.conf" LD_LIBRARY_PATH="$scratch/lib" \
  "$(command -v node)" -e "$load" "$module" 2>&1)"
status=$?
set -e
case $status in
0) echo "checkLazyPipewire: loads with libpipewire 0.3.48 and falls back: $output" ;;
2) fail "the module won't load with libpipewire 0.3.48: $output" ;;
3) fail "the module loads with libpipewire 0.3.48, but linuxAudio() doesn't say PipeWire is too old: $output" ;;
*) fail "node exited with $status: $output" ;;
esac
