#!/bin/sh
# Codex cloud diagnostics: run inside a cloud task to learn the execution model.
echo "== whoami/cwd"; whoami; pwd
echo "== process tree (who spawns my shell)"; ps -o pid,ppid,comm,args -p $$ -p $PPID 2>/dev/null; cat /proc/$PPID/cmdline 2>/dev/null | tr '\0' ' '; echo
echo "== ancestors"; p=$PPID; i=0; while [ "$p" -gt 1 ] && [ $i -lt 8 ]; do printf '%s: ' "$p"; tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-200; echo; p=$(awk '/^PPid/{print $2}' /proc/$p/status 2>/dev/null || echo 1); i=$((i+1)); done
echo "== codex binaries"; command -v codex; ls /opt/codex* /usr/local/bin/codex* 2>/dev/null; find / -maxdepth 4 -name 'codex*' -type f 2>/dev/null | head
echo "== ~/.codex"; ls -la ~/.codex 2>/dev/null; cat ~/.codex/config.toml ~/.codex/hooks.json 2>/dev/null | head -40
echo "== env names"; env | cut -d= -f1 | sort | tr '\n' ' '; echo
echo "== node/git"; command -v node; node --version 2>/dev/null; git remote -v 2>/dev/null; git config --get credential.helper 2>/dev/null; cat ~/.git-credentials 2>/dev/null | sed 's/:[^@]*@/:***@/'
echo "== probe log"; cat /tmp/hook-probe-events.jsonl 2>/dev/null | cut -c1-160; echo "LINES=$(wc -l < /tmp/hook-probe-events.jsonl 2>/dev/null)"
