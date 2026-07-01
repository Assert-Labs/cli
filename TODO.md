# TODO

## Known Risks (Accepted)

- **Concurrent sessions**: `index.json` read-modify-write can lose data if two sessions run simultaneously. Session JSONL is safe (append-only). Fix: per-session index files if this becomes a problem.

## Should Do

- [ ] Skip binary files in snapshots (memory + meaningless hashes)
- [ ] Limit file size for snapshots (e.g., skip files >1MB)
- [ ] `assert cleanup` command to mark stale sessions as abandoned (>24h old state files)
- [ ] Handle git worktrees (`.git` is a file, not directory)

## Nice to Have

- [ ] `assert init --hooks=none` flag to opt out of auto hook initialization
- [ ] `assert init --hooks=global` flag to use `core.hooksPath`
- [ ] `assert cleanup` for Codex sessions, which have no session-end hook to mark
      them ended (they show as `[ACTIVE]` until a stale-session sweep)
- [ ] Cloud sync for reviewers to see attribution data
- [ ] Web UI for git-blame-style attribution (line → prompt linking)
