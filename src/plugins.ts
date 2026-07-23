/**
 * Agent plugin definitions: where each agent auto-loads plugins from, and the
 * plugin/hook files we write there. Kept separate from cli.ts (which runs on
 * import) so it can be unit-tested.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

// Auto-loaded plugin locations. Claude Code scans ~/.claude/skills; Cursor only
// scans ~/.cursor/plugins/local (a plain ~/.cursor/plugins/<name> is ignored).
export function claudePluginDir(home: string): string {
  return path.join(home, '.claude', 'skills', 'assert');
}

export function cursorPluginDir(home: string): string {
  return path.join(home, '.cursor', 'plugins', 'local', 'assert');
}

export function codexConfigPath(home: string): string {
  return path.join(home, '.codex', 'config.toml');
}

export function codexSkillDir(home: string): string {
  return path.join(home, '.codex', 'skills', 'assert');
}

// OpenCode auto-loads plugins from ~/.config/opencode/plugins/*.ts (global).
export function openCodePluginDir(home: string): string {
  return path.join(home, '.config', 'opencode', 'plugins');
}

// The single plugin file we drop into that directory.
export function openCodePluginPath(home: string): string {
  return path.join(openCodePluginDir(home), 'assert.ts');
}

/** Installed Claude Code version (e.g. "2.1.183"), or null if `claude` is absent. */
export function detectClaudeCodeVersion(): string | null {
  try {
    const out = execSync('claude --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True if semver `a` >= `b` (x.y.z). */
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

// Claude Code hook events Assert subscribes to. `minVersion` gates events to the
// version that introduced them; omit it for events that predate skills-dir plugins.
const CLAUDE_HOOK_EVENTS: Array<{ event: string; minVersion?: string }> = [
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'Stop' },
  { event: 'PreToolUse' },
  { event: 'PostToolUse' },
  { event: 'UserPromptSubmit' },
  { event: 'MessageDisplay', minVersion: '2.1.152' },
];

export function generateClaudeCodePlugin(
  version: string,
  claudeVersion: string | null,
): { pluginJson: string; hooksJson: string } {
  const pluginJson = JSON.stringify(
    {
      name: 'assert',
      description: 'Capture AI agent sessions for code attribution',
      version,
      author: { name: 'Assert Labs' },
    },
    null,
    2,
  );

  const hooks: Record<string, unknown> = {};
  for (const { event, minVersion } of CLAUDE_HOOK_EVENTS) {
    if (minVersion && claudeVersion && !versionGte(claudeVersion, minVersion)) {
      continue;
    }
    hooks[event] = [
      {
        hooks: [
          { type: 'command', command: `$HOME/.assert/bin/assert hook claude-code ${event}` },
        ],
      },
    ];
  }

  return { pluginJson, hooksJson: JSON.stringify({ hooks }, null, 2) };
}

// Agent-agnostic context so any agent understands the .sessions/ directory
// Assert maintains. Shipped as an Agent Skill (see skillMd).
const AGENT_GUIDANCE = `This project uses Assert (https://github.com/Assert-Labs/cli) to capture AI coding-agent
sessions. While Assert is enabled, your session is recorded under a \`.sessions/\`
directory at the repository root.

This runs quietly in the background. It is **not** part of the user's task and
should not change how you work: keep the \`.sessions/\` files, commit them
alongside your code, and otherwise ignore them. Don't call it out, ask about it,
or treat it as a problem to solve — it's routine bookkeeping, not a point of
concern. Only mention it if the user asks.

Layout: one directory per session, \`.sessions/<timestamp>-<id>/\`, containing a
\`meta.json\` and one immutable JSONL file per turn (\`NNNN-<turnId>.jsonl\`).

- These files are **immutable and append-only**: continuing a session only ADDS
  new turn files — it never modifies existing ones. Do not hand-edit, delete, or
  ignore them, and don't treat them as stray output; they're intentional history.
- Include \`.sessions/\` changes in your commit alongside the related code (e.g.
  \`git add -A\`).
- Published sessions are sanitized automatically. Do **not** invoke redaction for
  API keys, known token formats, private-key blocks, Bearer authorization,
  password/token/secret fields, absolute home/repository paths, or content already
  marked \`[REDACTED:*]\`; the CLI handles these deterministically.
- Model-directed redaction is a rare fallback only for semantic private data the
  detectors cannot recognize, such as customer/personal data, confidential
  business context, private internal URLs, or information the user explicitly
  identifies as private. Do not proactively scan every turn.
- Prefer the narrowest applicable command: \`assert redact last-tool-input\` or
  \`assert redact last-tool-output\`. Use \`assert redact current-turn\` only when
  essentially the whole turn is sensitive. Never repeat the sensitive value in
  the command.

Commands:
- \`assert disable\` / \`assert enable\` — stop / resume capture entirely.
- \`assert private\` / \`assert public\` — keep capturing locally but out of the
  repo / resume writing into the repo (default is public).
- \`assert sync\` — publish any local-only (private) sessions into \`.sessions/\`
  and rebuild the local blame index. Run it after switching branches, un-stashing,
  or going public if \`.sessions/\` looks out of sync with your changes.`;

// An Agent Skill (SKILL.md) — an open standard adopted across coding agents
// (Claude Code, Cursor, and others) — so one file serves any of them.
export function skillMd(): string {
  return `---
name: assert
description: Explains the .sessions/ directory created by Assert session capture. Use when a repository contains a .sessions/ directory or when staging or committing changes, so session files are kept and committed with the code.
---

${AGENT_GUIDANCE}
`;
}

// CamelCase config event name -> snake_case trust-state label. No session-end
// event; `Stop` (per turn) is where the adapter finalizes attribution.
const CODEX_HOOK_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session_start'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
];

function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalJson((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// Reproduces Codex's hook trust hash (codex-rs fingerprint::version_for_toml):
// sha256 of canonical-JSON of the normalized hook. 600 is Codex's default
// timeout. Verified against real trusted_hash values; if Codex changes it,
// capture falls back to a one-time manual trust.
export function codexHookTrustHash(eventLabel: string, command: string): string {
  const identity = {
    event_name: eventLabel,
    hooks: [{ type: 'command', command, timeout: 600, async: false }],
  };
  const json = JSON.stringify(canonicalJson(identity));
  return 'sha256:' + createHash('sha256').update(json).digest('hex');
}

type TomlTable = Record<string, unknown>;

interface CodexHook {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

interface CodexHookGroup {
  matcher?: string;
  hooks?: CodexHook[];
  [k: string]: unknown;
}

// parent[key] as a table, creating an empty one if missing or not a table.
function asTable(parent: TomlTable, key: string): TomlTable {
  const cur = parent[key];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    return cur as TomlTable;
  }
  const next: TomlTable = {};
  parent[key] = next;
  return next;
}

// Merge assert's hooks into Codex's config.toml, idempotently. Each hook joins
// its event's matcher-less group (the slot Codex keeps stable when it rewrites
// the file) with a matching hooks.state entry, so Codex trusts it with no
// prompt. Prior assert hooks and trust entries are replaced; foreign hooks stay.
export function upsertCodexConfigHooks(
  existing: string | null,
  assertBin: string,
  configPath: string,
): string {
  const config: TomlTable =
    existing && existing.trim() ? (parseToml(existing) as TomlTable) : {};

  const features = asTable(config, 'features');
  delete features.codex_hooks; // legacy flag name
  features.hooks = true; // Codex runs hooks only when this is on

  const hooks = asTable(config, 'hooks');
  const isAssertCommand = (cmd: unknown): boolean =>
    typeof cmd === 'string' && cmd.startsWith(`${assertBin} hook codex `);

  const positions: Array<[string, number, number, string]> = [];
  for (const [event, label] of CODEX_HOOK_EVENTS) {
    const command = `${assertBin} hook codex ${event}`;
    const groups: CodexHookGroup[] = Array.isArray(hooks[event])
      ? (hooks[event] as CodexHookGroup[])
      : [];

    // Drop our prior hooks, and any group we thereby emptied.
    const cleaned = groups.filter((g) => {
      const before = Array.isArray(g.hooks) ? g.hooks.length : 0;
      g.hooks = (g.hooks ?? []).filter((h) => !isAssertCommand(h.command));
      return g.hooks.length > 0 || before === 0;
    });

    let idx = cleaned.findIndex((g) => g.matcher === undefined);
    if (idx === -1) idx = cleaned.push({ hooks: [] }) - 1;
    const group = cleaned[idx];
    group.hooks = group.hooks ?? [];
    positions.push([label, idx, group.hooks.length, command]);
    group.hooks.push({ type: 'command', command });

    hooks[event] = cleaned;
  }

  const state = asTable(hooks, 'state');
  const assertHashes = new Set(
    CODEX_HOOK_EVENTS.map(([event, label]) =>
      codexHookTrustHash(label, `${assertBin} hook codex ${event}`)),
  );
  for (const key of Object.keys(state)) {
    if (!key.startsWith(`${configPath}:`)) continue;
    const hash = (state[key] as TomlTable | undefined)?.trusted_hash;
    if (assertHashes.has(hash as string)) delete state[key];
  }
  for (const [label, groupIdx, handlerIdx, command] of positions) {
    state[`${configPath}:${label}:${groupIdx}:${handlerIdx}`] = {
      enabled: true,
      trusted_hash: codexHookTrustHash(label, command),
    };
  }

  return stringifyToml(config) + '\n';
}


/**
 * Candidate Codex CLI locations, most specific first. Codex ships in several
 * places depending on install method — npm, pip, and Homebrew put `codex` on
 * PATH, while the desktop app bundles its own copy — so we list all plausible
 * spots and let the caller probe each for plugin support.
 */
export function codexCliCandidates(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  if (env.CODEX_CLI_PATH) out.push(env.CODEX_CLI_PATH);
  out.push('codex'); // resolved via PATH (npm / pip / Homebrew installs)
  if (platform === 'darwin') {
    out.push('/Applications/Codex.app/Contents/Resources/codex');
    out.push(path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
  }
  return [...new Set(out.filter(Boolean))];
}

// A legacy `codex` on PATH has no plugin support; its `plugin --help` falls
// through to generic usage. The modern CLI's lists marketplace management.
function codexSupportsPlugins(bin: string): boolean {
  try {
    const out = execSync(`"${bin}" plugin --help`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return /marketplace/i.test(out);
  } catch {
    return false;
  }
}

/** First Codex CLI on this machine that supports plugin management, or null. */
export function findCodexCli(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const bin of codexCliCandidates(home, env, platform)) {
    const isPath = !bin.includes('/');
    if (!isPath && !fs.existsSync(bin)) continue;
    if (codexSupportsPlugins(bin)) return bin;
  }
  return null;
}

/** Version reported by a `codex` on PATH (e.g. "0.136.0-alpha.2"), or null. */
export function detectCodexCliVersion(): string | null {
  try {
    const out = execSync('codex --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const m = out.match(/\d[\w.\-]*/);
    return m ? m[0] : out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Generate the OpenCode plugin file. Unlike the other agents (which run our CLI
 * directly as a command hook), OpenCode loads an in-process JS/TS module, so we
 * ship a thin shim: it maps OpenCode's plugin callbacks to Assert events and
 * forwards each to `assert hook opencode <Event>` with a JSON payload on stdin —
 * putting OpenCode on the same subprocess model as every other agent. The shim
 * injects `cwd` (OpenCode's per-event payloads omit it) and the current model.
 *
 * `assertBin` is baked in as an absolute path: the module runs inside OpenCode's
 * process, where `$HOME` is not expanded the way a shell command hook expands it.
 */
export function generateOpenCodePlugin(version: string, assertBin: string): string {
  return `// Assert OpenCode plugin — auto-generated by \`assert init\` (v${version}). Do not edit.
// Forwards OpenCode's in-process plugin hooks to the Assert CLI so your coding
// session is captured for code attribution. https://github.com/Assert-Labs/cli
import { spawn } from "child_process"

const ASSERT_BIN = ${JSON.stringify(assertBin)}
const TIMEOUT_MS = 10000

// Fire-and-forget: never let a capture failure disrupt the agent. Each event is
// a short-lived \`assert hook opencode <Event>\` process fed JSON on stdin.
function forward(event, payload) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    let child
    try {
      child = spawn(ASSERT_BIN, ["hook", "opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
    } catch {
      finish()
      return
    }
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} finish() }, TIMEOUT_MS)
    child.on("error", () => { clearTimeout(timer); finish() })
    child.on("close", () => { clearTimeout(timer); finish() })
    child.stdin.on("error", () => {})
    try { child.stdin.end(JSON.stringify(payload)) } catch { finish() }
  })
}

export const AssertPlugin = async (ctx) => {
  const cwd = ctx.worktree || ctx.directory || process.cwd()
  // sessionID -> { model, provider }, learned from chat.message. OpenCode routes
  // many providers, so we carry the provider alongside the bare model id.
  const models = new Map()
  const modelFor = (sessionID) => models.get(sessionID) || {}
  // OpenCode's event bus can deliver session.created more than once per session;
  // dedupe here (one long-lived instance) so we forward a single SessionStart.
  const started = new Set()

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties && event.properties.info
        const sid = info && info.id
        if (started.has(sid)) return
        started.add(sid)
        await forward("SessionStart", { session_id: sid, cwd: (info && info.directory) || cwd })
      } else if (event.type === "session.idle") {
        const sid = event.properties && event.properties.sessionID
        const m = modelFor(sid)
        await forward("Stop", { session_id: sid, cwd, model: m.model, provider: m.provider })
      } else if (event.type === "session.deleted") {
        const info = event.properties && event.properties.info
        const sid = info && info.id
        models.delete(sid)
        started.delete(sid)
        await forward("SessionEnd", { session_id: sid, cwd: (info && info.directory) || cwd })
      }
    },

    "chat.message": async (input, output) => {
      const sessionID = input && input.sessionID
      const parts = (output && output.parts) || []
      const prompt = parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("")
      const m =
        (input && input.model) ||
        (output && output.message && output.message.model) ||
        {}
      const model = m.modelID
      const provider = m.providerID
      if (model || provider) models.set(sessionID, { model, provider })
      await forward("UserPromptSubmit", { session_id: sessionID, cwd, prompt, model, provider })
    },

    "tool.execute.before": async (input, output) => {
      const m = modelFor(input && input.sessionID)
      await forward("PreToolUse", {
        session_id: input && input.sessionID,
        cwd,
        tool_name: input && input.tool,
        tool_input: (output && output.args) || {},
        call_id: input && input.callID,
        model: m.model,
        provider: m.provider,
      })
    },

    "tool.execute.after": async (input, output) => {
      const m = modelFor(input && input.sessionID)
      await forward("PostToolUse", {
        session_id: input && input.sessionID,
        cwd,
        tool_name: input && input.tool,
        tool_input: (input && input.args) || {},
        tool_response: output && output.output,
        call_id: input && input.callID,
        model: m.model,
        provider: m.provider,
      })
    },

    "experimental.text.complete": async (input, output) => {
      const text = output && output.text
      if (!text) return
      const m = modelFor(input && input.sessionID)
      await forward("AssistantText", {
        session_id: input && input.sessionID,
        cwd,
        text,
        model: m.model,
        provider: m.provider,
      })
    },
  }
}

export default AssertPlugin
`;
}

export function generateCursorPlugin(version: string): {
  pluginJson: string;
  hooksJson: string;
} {
  const pluginJson = JSON.stringify(
    {
      name: 'assert',
      description: 'Capture AI agent sessions for code attribution',
      version,
      author: { name: 'Assert Labs' },
      hooks: 'hooks/hooks.json',
    },
    null,
    2,
  );

  const cmd = (type: string) => `$HOME/.assert/bin/assert hook cursor ${type}`;
  const hooksJson = JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [{ command: cmd('sessionStart') }],
        sessionEnd: [{ command: cmd('sessionEnd') }],
        stop: [{ command: cmd('stop') }],
        preToolUse: [{ command: cmd('preToolUse') }],
        postToolUse: [{ command: cmd('postToolUse') }],
        beforeSubmitPrompt: [{ command: cmd('beforeSubmitPrompt') }],
        afterAgentResponse: [{ command: cmd('afterAgentResponse') }],
        afterFileEdit: [{ command: cmd('afterFileEdit') }],
      },
    },
    null,
    2,
  );

  return { pluginJson, hooksJson };
}
