#!/bin/sh
# Assert hook runner (generated). Finds Node and runs the bundled CLI:
#   run.sh <agent> <event>   with the hook payload on stdin.
set -u
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=""
if command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
else
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node /opt/node*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
[ -n "$node_bin" ] || exit 0
exec "$node_bin" "$root/dist/cli.mjs" hook "$@"
