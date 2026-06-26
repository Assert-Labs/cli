/**
 * Agent plugin definitions: where each agent auto-loads plugins from, and the
 * plugin/hook files we write there. Kept separate from cli.ts (which runs on
 * import) so it can be unit-tested.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Auto-loaded plugin locations. Claude Code scans ~/.claude/skills; Cursor only
// scans ~/.cursor/plugins/local (a plain ~/.cursor/plugins/<name> is ignored).
export function claudePluginDir(home: string): string {
  return path.join(home, '.claude', 'skills', 'assert');
}

export function cursorPluginDir(home: string): string {
  return path.join(home, '.cursor', 'plugins', 'local', 'assert');
}

// Codex loads plugins through a marketplace, not a fixed auto-load directory.
// We ship a personal marketplace at ~/.agents/plugins/marketplace.json (a path
// Codex reads automatically) whose entry points at the bundle under it.
export function codexPluginDir(home: string): string {
  return path.join(home, '.agents', 'plugins', 'assert');
}

// Codex resolves a personal marketplace's `source.path` relative to $HOME (the
// directory above `.agents/plugins/`), so the bundle path must be home-relative.
const CODEX_PLUGIN_SOURCE_PATH = './.agents/plugins/assert';

export function codexMarketplacePath(home: string): string {
  return path.join(home, '.agents', 'plugins', 'marketplace.json');
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

// Codex hook events Assert subscribes to. Codex mirrors Claude Code's hook
// schema (same event names and the `{ hooks: [{ type, command }] }` shape), so
// this matches generateClaudeCodePlugin's output. Codex has no session-end
// event; `Stop` (per turn) is where the adapter finalizes attribution.
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];

export function generateCodexPlugin(
  version: string,
  // Absolute path to the installed assert binary. Codex does not shell-expand
  // command strings (its config uses absolute paths), so we cannot rely on
  // `$HOME` the way the Claude Code and Cursor hooks do.
  assertBin: string,
): { pluginJson: string; hooksJson: string } {
  const pluginJson = JSON.stringify(
    {
      name: 'assert',
      description: 'Capture AI agent sessions for code attribution',
      version,
      author: { name: 'Assert Labs' },
      skills: './skills/',
      interface: { displayName: 'Assert' },
    },
    null,
    2,
  );

  const hooks: Record<string, unknown> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [{ type: 'command', command: `${assertBin} hook codex ${event}` }],
      },
    ];
  }

  return { pluginJson, hooksJson: JSON.stringify({ hooks }, null, 2) };
}

interface CodexMarketplace {
  name: string;
  interface?: { displayName?: string };
  plugins: Array<Record<string, unknown>>;
}

// The marketplace entry Codex uses to find and install the bundle. INSTALLED_BY_DEFAULT
// so capture is on after a restart without a manual `/plugins` install step.
function codexPluginEntry(): Record<string, unknown> {
  return {
    name: 'assert',
    source: { source: 'local', path: CODEX_PLUGIN_SOURCE_PATH },
    policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
}

/**
 * Build the personal-marketplace JSON, upserting the `assert` entry. Preserves
 * any existing marketplace the user maintains at that path (we only own our own
 * entry), and creates a fresh one when `existing` is null or unparseable.
 */
export function buildCodexMarketplace(existing: string | null): string {
  let marketplace: CodexMarketplace = {
    name: 'assert-local',
    interface: { displayName: 'Assert' },
    plugins: [],
  };
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as CodexMarketplace;
      if (parsed && Array.isArray(parsed.plugins)) {
        marketplace = parsed;
      }
    } catch {
      /* unparseable: start fresh */
    }
  }

  const entry = codexPluginEntry();
  const idx = marketplace.plugins.findIndex((p) => p.name === 'assert');
  if (idx >= 0) {
    marketplace.plugins[idx] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  return JSON.stringify(marketplace, null, 2);
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

/** Install the assert plugin via the Codex CLI. Idempotent; best-effort. */
export function codexPluginInstall(bin: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`"${bin}" plugin add assert@assert-local`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: out.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (err.stderr || err.stdout || err.message || '').trim() };
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
