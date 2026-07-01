/**
 * Agent plugin definitions: where each agent auto-loads plugins from, and the
 * plugin/hook files we write there. Kept separate from cli.ts (which runs on
 * import) so it can be unit-tested.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

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
sessions. While Assert is enabled, your session is recorded to JSONL files under a
\`.sessions/\` directory at the repository root.

- This capture is intentional. \`.sessions/\` files are part of the project's
  history — do not delete or ignore them, and don't treat them as stray output.
- When \`.sessions/\` changes appear, include them in your commit alongside the
  related code (e.g. \`git add -A\` or \`git add .sessions\`). They appear only
  while Assert is enabled; capture is paused with \`assert disable\`.`;

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

const CODEX_HOOKS_BEGIN = '# >>> assert (managed by `assert install`) >>>';
const CODEX_HOOKS_END = '# <<< assert (managed by `assert install`) <<<';

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

function countCodexHookGroups(config: string, event: string): number {
  const re = new RegExp(`^\\s*\\[\\[hooks\\.${event}\\]\\]\\s*$`, 'gm');
  return (config.match(re) ?? []).length;
}

// `assertBin` is absolute: Codex does not shell-expand command strings. Emits the
// hooks plus matching trust state so capture runs with no manual approval.
export function buildCodexConfigBlock(base: string, assertBin: string, configPath: string): string {
  const hooks: string[] = [];
  const state: string[] = [];
  for (const [event, label] of CODEX_HOOK_EVENTS) {
    const command = `${assertBin} hook codex ${event}`;
    const index = countCodexHookGroups(base, event);
    hooks.push('', `[[hooks.${event}]]`, '', `[[hooks.${event}.hooks]]`,
      'type = "command"', `command = "${command}"`);
    state.push('', `[hooks.state."${configPath}:${label}:${index}:0"]`,
      'enabled = true', `trusted_hash = "${codexHookTrustHash(label, command)}"`);
  }
  return [CODEX_HOOKS_BEGIN, ...hooks, ...state, CODEX_HOOKS_END].join('\n');
}

// Replace the assert-owned block in config.toml, leaving the rest untouched.
export function upsertCodexConfigHooks(
  existing: string | null,
  assertBin: string,
  configPath: string,
): string {
  let base = existing ?? '';
  const start = base.indexOf(CODEX_HOOKS_BEGIN);
  if (start !== -1) {
    const mark = base.indexOf(CODEX_HOOKS_END, start);
    const end = mark === -1 ? base.length : mark + CODEX_HOOKS_END.length;
    base = base.slice(0, start) + base.slice(end);
  }
  base = base.replace(/\s*$/, '');
  const block = buildCodexConfigBlock(base, assertBin, configPath);
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`;
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
