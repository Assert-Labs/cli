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

1. **Global hooks** are installed to each agent's config directory.
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
# Install hooks for all supported agents
assert install
```

### Requirements

- macOS or Linux, x64 or arm64 (no Windows or Alpine/musl build yet)
- `git` available on your PATH — the CLI shells out to git at runtime
- If installing via NPM or from source: `Node.js 18 or later`

## Supported Agents

| Agent       | Plugin Location                                    |
| ----------- | -------------------------------------------------- |
| Claude Code | `~/.claude/skills/assert/`                         |
| Cursor      | `~/.cursor/plugins/local/assert/`                  |
| Codex       | `~/.codex/config.toml` + `~/.codex/skills/assert/` |

- Codex support requires the **modern Codex CLI** (the Rust build with hooks); the legacy `@openai/codex` (`0.1.x`) has no hook support, and `assert install` warns when it finds only that version.
- Support for Devin, OpenCode, Pi, Amp, and more is upcoming.
- If you would like support to be added for a particular agent, take a look at [CONTRIBUTING.md](CONTRIBUTING.md) and look to see if that agent will be added soon in open [issues](https://github.com/Assert-Labs/cli/issues) and [pull requests](https://github.com/Assert-Labs/cli/pulls).

## Commands

```bash
assert install [agent]      # Install hooks globally (all agents if none specified)
assert sessions             # List sessions in current directory
assert show <session-id>    # Show session details
assert trace [ref]          # Export agent-trace attribution for a revision (default HEAD)
assert status               # Show current status
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
