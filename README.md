<h1>
<p align="center">
  <img width="128" alt="logo" src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/logo.png?v=1" />
  <br>Assert
</h1>
  <p align="center">
    Share session data from any coding agent.
    <br />
    <a href="#about">About</a>
    ·
    <a href="#installation">Installation</a>
    ·
    <a href="#session-format">Session Format</a>
    ·
    <a href="#supported-agents">Supported Agents</a> 
    ·
    <a href="https://docs.assert.dev">Documentation</a>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@assertlabs/cli"><img src="https://img.shields.io/npm/v/@assertlabs/cli.svg?v=1" alt="npm version"></a>
    <a href="https://github.com/Assert-Labs/cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@assertlabs/cli.svg?v=1" alt="license"></a>
    <a href="https://github.com/Assert-Labs/cli/actions/workflows/ci.yml"><img src="https://github.com/Assert-Labs/cli/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
    <a href="https://github.com/Assert-Labs/cli/actions/workflows/release.yml"><img src="https://github.com/Assert-Labs/cli/actions/workflows/release.yml/badge.svg" alt="release"></a>
    <a href="https://discord.gg/YqKKrBmam"><img src="https://img.shields.io/badge/Discord-%235865F2.svg?logo=discord&logoColor=white" alt="discord"></a>
  </p>
</p>

## About

Capture AI agent sessions from any agentic coding tool as part of your repository's history and reference them during code review.

## How It Works

1. **Global hooks** are initialized in each agent's config directory.
2. As the agent works, every event (prompts, tool calls, responses) is captured
   to a central store outside your repo.
3. At each turn boundary, that turn's events are written into `.sessions/` as a
   new JSONL file — one per turn, inside a per-session directory. Files already
   written are never rewritten, so capture only ever adds to your working tree.
4. A repo gets nothing until the agent changes a file in it, and a session
   spanning several repos is written into each one it touched.

## Installation

> [!NOTE]
> Right now, only MacOS/Linux operating systems are supported.

**Native Install (Recommended):**

```bash
curl https://assert.dev/install -fsS | bash
```

**Homebrew:**

```bash
brew install assert-labs/tap/assert
```

**NPM:**

```bash
npm install -g @assertlabs/cli
```

**From Source:**

```bash
git clone https://github.com/Assert-Labs/cli.git
cd cli
pnpm install
pnpm build
npm install -g .
```

### Initializing Hooks

```bash
# Initialize hooks for all supported agents
assert init
```

Restart your agent (or reload its plugins) after `assert init` so it picks up
the newly installed hooks.

**Install order doesn't matter.** `assert init` pre-installs the hook for every
supported agent — including ones you haven't installed yet — into that agent's
standard plugin directory. An agent you install _later_ auto-discovers the hook
on its first run, no re-init required. You can still re-run `assert init` any
time to refresh hooks (e.g. after upgrading assert, or to pick up an agent's
version-specific features), or `assert init <agent>` to (re)install just one.

### Requirements

- macOS or Linux, x64 or arm64 (no Windows or Alpine/musl build yet)
- `git` available on your PATH — the CLI shells out to git at runtime
- If installing via NPM or from source: `Node.js 18 or later`

## Session Format

Sessions are JSONL: one JSON event per line, in one schema regardless of which
agent produced them. Every event carries a `type`, a `sessionId`, and an ISO
`timestamp`.

Agents disagree about everything else — Claude Code reads a file with
`Read {file_path}`, OpenCode with `read {filePath}`, Pi with `read {path}`, and
Codex edits by passing a whole patch blob under `command`. Each agent's adapter
resolves that at capture time, so every `tool_call` carries a canonical
`action` alongside the tool's own name:

```jsonc
{
  "type": "tool_call",
  "timestamp": "2026-07-20T10:00:03.000Z",
  "sessionId": "…",
  "turnId": "…",
  "toolCallId": "…",
  "toolName": "apply_patch", // the agent's name for the tool
  "action": {
    // the canonical, cross-agent view
    "kind": "edit",
    "paths": ["src/a.ts"], // repo-relative, POSIX
  },
  "input": { "command": "*** Begin Patch…" }, // the agent's raw payload
}
```

`action.kind` is one of `read`, `edit`, `write`, `delete`, `search`, `web`,
`command`, `task`, `todo`, or `other`, with `paths`, `command`, `query`, and
`url` carrying the details. A tool the adapter doesn't recognize (a new
built-in, an MCP tool) is reported as `other` rather than guessed at.

Read `action`; treat `toolName` as a display label and `input` as debugging
detail. `@assertlabs/cli/core` exposes `parseSession()`, which returns this
model with linked turns and prompts (and fills in `action` for captures written
before it existed).

## Supported Agents

<!-- prettier-ignore -->
<table>
  <tr>
    <th colspan="2" align="left">Agent</th>
    <th align="left">Plugin Location</th>
  </tr>
  <tr>
    <td align="center" width="40"><a href="https://claude.com/claude-code"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/claude-code.svg" alt="Claude Code" width="28" align="bottom" /></a></td>
    <td>Claude Code</td>
    <td><code>~/.claude/skills/assert/</code></td>
  </tr>
  <tr>
    <td align="center" width="40"><a href="https://openai.com/codex"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/codex.svg" alt="Codex" width="28" align="bottom" /></a></td>
    <td>Codex</td>
    <td><code>~/.codex/config.toml</code></td>
  </tr>
  <tr>
    <td align="center" width="40"><a href="https://cursor.com"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/cursor.svg" alt="Cursor" width="24.56" align="bottom" /></a></td>
    <td>Cursor</td>
    <td><code>~/.cursor/plugins/local/assert/</code></td>
  </tr>
  <tr>
    <td align="center" width="40"><a href="https://opencode.ai"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/opencode.svg" alt="OpenCode" width="28" align="bottom" /></a></td>
    <td>OpenCode</td>
    <td><code>~/.config/opencode/plugins/assert.ts</code></td>
  </tr>
  <tr>
    <td align="center" width="40"><a href="https://pi.dev"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/pi.svg" alt="Pi" width="28" align="bottom" /></a></td>
    <td>Pi</td>
    <td><code>~/.pi/agent/extensions/assert.ts</code></td>
  </tr>
</table>

- Codex support requires the **modern Codex CLI** (the Rust build with hooks); the legacy `@openai/codex` (`0.1.x`) has no hook support, and `assert init` warns when it finds only that version.
- If you would like support to be added for a particular agent, take a look at [CONTRIBUTING.md](CONTRIBUTING.md) and look to see if that agent will be added soon in open [issues](https://github.com/Assert-Labs/cli/issues) and [pull requests](https://github.com/Assert-Labs/cli/pulls).

## Commands

```bash
assert init [agent]         # Initialize hooks globally (all agents if none specified)
assert sessions             # List sessions in current directory (--all for central storage)
assert show <session-id>    # Show session details
assert blame <file>         # Show line-by-line agent attribution (like git blame)
                            #   [--json | --ndjson] [--range <start>:<end>]
assert blame --diff <a>..<b> # Attribute only a diff's added lines (PR review)
assert trace [ref]          # Export agent-trace attribution for a revision (default HEAD)
assert status               # Show current status
assert private              # Keep capturing, but stop writing sessions into this repo
assert public               # Resume writing sessions into this repo (default)
assert sync                 # Publish local-only sessions into the repo + rebuild blame index
assert cleanup              # Mark stale still-open sessions ended (default idle > 24h; --hours <n>)
assert redact <target>      # Redact current-turn, last-tool-input, or last-tool-output
assert disable              # Pause capture (hooks stay installed)
assert enable               # Resume capture
assert help                 # Show help
```

## Controlling Capture

Session data is written into a repo's `.sessions/` as the agent works, so it
shows up in `git status` like any other file — you stage and commit it yourself.

- **Skip files:** add a `.assertignore` to the repo root (gitignore-style
  patterns, e.g. `dist/`, `*.log`). Changes that only touch ignored paths won't
  trigger capture or appear in session data.
- **Turn off persistently:** `assert disable` pauses capture (hooks stay
  installed) until you run `assert enable`. `assert status` shows the current
  state.
- **Turn off for one session:** set `ASSERT_DISABLE=1` in the environment your
  agent runs in.
- **Keep sessions local:** `assert private` keeps capturing to the central store
  but stops writing into this repo's `.sessions/`; `assert public` (the default)
  resumes. `assert sync` publishes any local-only sessions into the repo and
  rebuilds the blame index — handy after switching branches or going public.

## Agent Trace

Captured sessions can be exported as [Agent Trace](https://agent-trace.dev)
records — an open standard for AI code attribution
([spec & reference](https://github.com/cursor/agent-trace)). `assert trace`
derives a conformant `TraceRecord` for a revision from your committed session
data (attributing lines to the contributing model), so any tool can consume the
attribution:

```bash
assert trace            # agent-trace record for HEAD
assert trace <ref>      # for a specific commit
```

## License

This repository is licensed under the [MIT License](https://github.com/assert-labs/cli/blob/main/LICENSE)
