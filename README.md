<h1>
<p align="center">
  <img width="128" alt="logo" src="https://github.com/user-attachments/assets/a6e95413-74af-4980-bbee-edf398fb290b" />
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
npm install -g @assert-labs/cli
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

| Agent       | Plugin Location             |
| ----------- | --------------------------- |
| Claude Code | `~/.claude/skills/assert/`  |
| Cursor      | `~/.cursor/plugins/assert/` |

- Support for Codex, Devin, OpenCode, Pi, Amp, and more is upcoming.
- If you would like support to be added for a particular agent, take a look at [CONTRIBUTING.md](CONTRIBUTING.md) and look to see if that agent will be added soon in open [issues](https://github.com/Assert-Labs/cli/issues) and [pull requests](https://github.com/Assert-Labs/cli/pulls).

## Commands

```bash
assert install [agent]      # Install hooks globally (all agents if none specified)
assert sessions             # List sessions in current directory
assert show <session-id>    # Show session details
assert status               # Show current status
assert help                 # Show help
```

## License

This repository is licensed under the [MIT License](https://github.com/assert-labs/cli/blob/main/LICENSE)
