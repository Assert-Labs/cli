#!/bin/sh
# Hook probe: append one JSON line per hook event to <project>/.hook-probe/events.jsonl.
# usage: log.sh <host> <event>   (event payload arrives on stdin)
root="${CLAUDE_PROJECT_DIR:-${DEVIN_PROJECT_DIR:-$PWD}}"
mkdir -p "$root/.hook-probe" 2>/dev/null || { root="$PWD"; mkdir -p "$root/.hook-probe"; }
input=$(cat 2>/dev/null)
[ -n "$input" ] || input=null
node_bin=$(command -v node 2>/dev/null || echo none)
printf '{"host":"%s","event":"%s","ts":"%s","cwd":"%s","pluginRoot":"%s","remote":"%s","node":"%s","payload":%s}\n' \
  "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" \
  "${CLAUDE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}" \
  "${CLAUDE_CODE_REMOTE:-}" "$node_bin" "$input" >> "$root/.hook-probe/events.jsonl"
echo "[hook-probe] $1 $2" >&2
exit 0
