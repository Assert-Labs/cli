# Assert Trace

Trace agent actions to lines of code.

## Installation

```bash
git clone https://github.com/assert-labs/trace.git
cd trace
pnpm install
pnpm build
npm link
```

## Quick Start

```bash
# Initialize in a git repo
assert init

# That's it! Traces are now captured automatically via git hooks.
```

## How It Works

1. **Agent hook** captures session data when an agent completes (Cursor, Claude Code, etc.)
2. **post-commit hook** attaches traces to commits as git notes
3. **assert blame** shows what prompt/session produced a line of code

```
Agent writes code
       ↓
[Agent stop hook] → assert capture
       ↓
Session stored in .git/assert/pending/
       ↓
git commit
       ↓
[post-commit hook] → assert commit
       ↓
Trace attached as git note
       ↓
assert blame file:line → shows prompt + session
```

## Commands

```bash
assert init              # Initialize in current repo
assert capture           # Capture session from stdin (used by hooks)
assert commit            # Attach pending traces to latest commit
assert blame <file>:<line>  # Show what produced a line
assert show <session-id> # Show full session details
assert help              # Show help
```

## Example

```bash
$ assert blame src/auth/login.ts:42

src/auth/login.ts:42
  Commit: abc1234

  Session: sess_xyz789
  Model: claude-sonnet-4-20250514
  Prompt: "Add error handling to the login function"
  Tool calls: 3
```

## Schema

Sessions follow this structure:

```typescript
interface Session {
  id: string;
  turns: Turn[];
}

type Turn = HumanTurn | AssistantTurn;

interface HumanTurn {
  type: 'human';
  content: string; // The prompt
}

interface AssistantTurn {
  type: 'assistant';
  model?: string;
  blocks: ContentBlock[]; // Text, tool calls, tool results
}
```

## Storage

- **Pending traces**: `.git/assert/pending/`
- **Full sessions**: `.git/assert/sessions/`
- **Git notes**: `refs/notes/assert-traces`
