#!/usr/bin/env bash
# Launch the app under a virtual display and save a screenshot.
#
#   npm run shot -- <name> [seconds-to-wait]    ->  docs/progress/<name>.png
#
# Needs xvfb and ImageMagick (`import`). The app's console output is written to
# docs/progress/<name>.log so CSP violations and errors are easy to spot.
# --no-sandbox is only here because containers usually run as root; the app
# itself still sets sandbox: true on its window. NODE_OPTIONS is cleared
# because Electron rejects options such as --use-openssl-ca that some
# sandboxes set for their network proxy.
set -euo pipefail
cd "$(dirname "$0")/.."

name="${1:?usage: npm run shot -- <name> [seconds]}"
wait_s="${2:-12}"
mkdir -p docs/progress

xvfb-run -a -s "-screen 0 1800x1000x24" bash -c '
  env -u NODE_OPTIONS ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --enable-logging=stderr >"docs/progress/$2.log" 2>&1 &
  pid=$!
  sleep "$1"
  import -window root "docs/progress/$2.png"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
' _ "$wait_s" "$name"

echo "saved docs/progress/$name.png and $name.log"
