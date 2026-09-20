#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Ubuntu dependencies: ibus ibus-libpinyin libglib2.0-bin dbus-x11 xvfb xauth xdotool.
for executable in ibus ibus-daemon xvfb-run dbus-run-session xdotool; do
  command -v "$executable" >/dev/null || { echo "Missing native IME test dependency: $executable" >&2; exit 1; }
done
ime_test_dir=$(mktemp -d)
trap 'rm -rf "$ime_test_dir"' EXIT
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright}"
mkdir -m 700 "$ime_test_dir/runtime" "$ime_test_dir/config" "$ime_test_dir/cache"
export XDG_RUNTIME_DIR="$ime_test_dir/runtime"
export XDG_CONFIG_HOME="$ime_test_dir/config"
export XDG_CACHE_HOME="$ime_test_dir/cache"
xvfb-run -a dbus-run-session -- bash -eu -c '
  ibus-daemon --daemonize --replace --xim --panel=disable
  trap "ibus exit >/dev/null 2>&1 || true" EXIT
  for attempt in {1..20}; do
    # Some IBus versions return failure on activation despite setting the engine.
    ibus engine libpinyin >/dev/null 2>&1 || true
    if [[ $(ibus engine 2>/dev/null) == libpinyin ]]; then
      node tests/native-ime.cjs
      exit
    fi
    sleep 0.2
  done
  echo "Could not activate IBus libpinyin (install ibus-libpinyin)." >&2
  exit 1
'
