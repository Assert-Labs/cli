# Assert

Capture AI agent sessions from any agentic coding tool (Cursor, Claude Code, Codex, etc.)

Sessions are stored as JSONL files in `.sessions/` directory.

## Installation

```bash
git clone https://github.com/assert-labs/trace.git
cd trace
pnpm install
pnpm build
npm install -g .
```

## Quick Start

```bash
# Install hooks for all supported agents
assert install

# That's it! Sessions are now captured automatically.
```

## How It Works

1. **Global hooks** are installed to each agent's config directory
2. When an agent session starts, a new JSONL file is created in `.sessions/`
3. All events (prompts, tool calls, responses) are appended to the session file
4. Git branch changes are tracked automatically

## Commands

```bash
assert install [agent]      # Install hooks globally (all agents if none specified)
assert sessions             # List sessions in current directory
assert show <session-id>    # Show session details
assert status               # Show current status
assert help                 # Show help
```

## Supported Agents

- **claude-code** - Claude Code CLI
- **cursor** - Cursor IDE
- **codex** - OpenAI Codex CLI

## Example

```bash
$ assert sessions

[assert] Found 2 session(s):

  [ACTIVE] abc123-xyz
           source: claude-code | 5 turns | 12 tool calls | 3 files
           started: 2024-01-15T10:30:00Z
           branches: main, feature/auth

  [ended] def456-uvw
           source: cursor      | 3 turns | 8 tool calls | 1 files
           started: 2024-01-15T09:00:00Z

$ assert show abc123-xyz

Session: abc123-xyz
Source: claude-code
Started: 2024-01-15T10:30:00Z
Branches: main, feature/auth
Turns: 5
Tool Calls: 12
Files Modified: src/auth.ts, src/login.ts, tests/auth.test.ts

Events:
-------
10:30:00 [session_start] cwd=/project, branch=main
10:30:05 [human] "Add error handling to the login function"
10:30:06 [assistant_start] model=claude-sonnet-4-20250514
10:30:07 [tool_call] Read({"file_path": "/project/src/login.ts"})
...
```

## Storage

- **Sessions**: `.sessions/<session-id>.jsonl`
- Each line is a JSON event (session_start, human_turn, tool_call, etc.)
