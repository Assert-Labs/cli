/**
 * Agent plugin definitions: where each agent auto-loads plugins from, and the
 * plugin/hook files we write there. Kept separate from cli.ts (which runs on
 * import) so it can be unit-tested.
 */

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
