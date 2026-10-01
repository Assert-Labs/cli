# hook-probe

Throwaway plugin that logs every hook event it receives to
`<project>/.hook-probe/events.jsonl` (one JSON line per event: host, event,
cwd, plugin root, whether `node` exists, and the raw payload). In a cloud
session, ask the agent to commit that file so it shows up in the PR diff.

Push this directory as its own repo (e.g. `Assert-Labs/hook-probe`) so every
host can install it by `owner/repo`. Manifests for each host sit side by side:

- `.claude-plugin/plugin.json` + `hooks/claude.json` — Claude Code. Devin also
  loads this manifest (it reads `.claude-plugin` when no `.devin-plugin` exists).
- `.cursor-plugin/plugin.json` + `hooks/cursor.json` — Cursor.
- `.codex-plugin/plugin.json` + `hooks/codex.json` — Codex (local only).
- `in-repo/` — the same hooks as repo-committed files, for comparing plugin
  hooks against in-repo hooks. Copy `log.sh` to `<repo>/.hook-probe/log.sh`
  and the dotfiles to the repo root.

`hooks.json` at the root is Devin's native hooks file (same shape as
`.devin/hooks.v1.json`). Its commands locate `log.sh` through whichever
plugin-root variable the host sets, falling back to Devin's plugin cache path.
