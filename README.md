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
2. When an agent session starts, a new JSONL file is created in `.sessions/`.
3. All events (prompts, tool calls, responses) are appended to the session file.

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
standard plugin directory. An agent you install *later* auto-discovers the hook
on its first run, no re-init required. You can still re-run `assert init` any
time to refresh hooks (e.g. after upgrading assert, or to pick up an agent's
version-specific features), or `assert init <agent>` to (re)install just one.

### Requirements

- macOS or Linux, x64 or arm64 (no Windows or Alpine/musl build yet)
- `git` available on your PATH — the CLI shells out to git at runtime
- If installing via NPM or from source: `Node.js 18 or later`

## Supported Agents

<!-- prettier-ignore -->
<table>
  <tr>
    <th colspan="2" align="left">Agent</th>
    <th align="left">Plugin Location</th>
  </tr>
  <tr>
    <td align="center" width="36"><a href="https://claude.com/claude-code"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/claude-code.svg" alt="Claude Code" height="22" /></a></td>
    <td>Claude Code</td>
    <td><code>~/.claude/skills/assert/</code></td>
  </tr>
  <tr>
    <td align="center" width="36"><a href="https://openai.com/codex"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/codex.svg" alt="Codex" height="22" /></a></td>
    <td>Codex</td>
    <td><code>~/.codex/config.toml</code> + <code>~/.codex/skills/assert/</code></td>
  </tr>
  <tr>
    <td align="center" width="36"><a href="https://cursor.com"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/cursor.svg" alt="Cursor" height="22" /></a></td>
    <td>Cursor</td>
    <td><code>~/.cursor/plugins/local/assert/</code></td>
  </tr>
  <tr>
    <td align="center" width="36"><a href="https://opencode.ai"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/opencode.svg" alt="OpenCode" height="22" /></a></td>
    <td>OpenCode</td>
    <td><code>~/.config/opencode/plugins/assert.ts</code></td>
  </tr>
  <tr>
    <td align="center" width="36"><a href="https://pi.dev"><img src="https://raw.githubusercontent.com/Assert-Labs/cli/main/assets/agents/pi.svg" alt="Pi" height="22" /></a></td>
    <td>Pi</td>
    <td><code>~/.pi/agent/extensions/assert.ts</code> + <code>~/.pi/agent/skills/assert/</code></td>
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
