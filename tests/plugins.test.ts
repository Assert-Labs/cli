/**
 * Plugin install paths and generated manifests. Guards the Cursor specifics
 * that silently break capture if wrong: the auto-loaded `local/` directory and
 * the required hooks.json `version` field (per Cursor's plugin/hook docs).
 */

import { describe, it, expect } from 'vitest';
import {
  claudePluginDir,
  cursorPluginDir,
  codexConfigPath,
  codexSkillDir,
  codexCliCandidates,
  codexHookTrustHash,
  generateClaudeCodePlugin,
  generateCursorPlugin,
  upsertCodexConfigHooks,
  skillMd,
} from '../src/plugins';

describe('plugins', () => {
  it('installs the Cursor plugin under the auto-loaded local/ directory', () => {
    expect(cursorPluginDir('/home/u')).toBe('/home/u/.cursor/plugins/local/assert');
  });

  it('installs the Claude Code plugin under skills/', () => {
    expect(claudePluginDir('/home/u')).toBe('/home/u/.claude/skills/assert');
  });

  it('Cursor hooks.json has the required version and valid hook events', () => {
    const { hooksJson, pluginJson } = generateCursorPlugin('1.2.3');
    const hooks = JSON.parse(hooksJson);
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.sessionStart[0].command).toContain('hook cursor sessionStart');
    expect(hooks.hooks.afterFileEdit[0].command).toContain('hook cursor afterFileEdit');
    expect(JSON.parse(pluginJson).version).toBe('1.2.3');
  });

  it('ships a standard Agent Skill conveying that .sessions/ is intentional', () => {
    const skill = skillMd();
    expect(skill).toMatch(/^---\nname: assert\n/);
    expect(skill).toContain('.sessions/');
    expect(skill.toLowerCase()).toContain('commit');
    expect(skill.toLowerCase()).toContain('enabled');
  });

  it('Claude Code plugin gates version-specific events', () => {
    const old = JSON.parse(generateClaudeCodePlugin('0.1.0', '2.1.100').hooksJson);
    expect(old.hooks.MessageDisplay).toBeUndefined();
    expect(old.hooks.SessionStart[0].hooks[0].command).toContain('hook claude-code SessionStart');

    const recent = JSON.parse(generateClaudeCodePlugin('0.1.0', '2.1.183').hooksJson);
    expect(recent.hooks.MessageDisplay).toBeDefined();
  });

  it('writes Codex hooks to config.toml and the skill under ~/.codex/skills', () => {
    expect(codexConfigPath('/home/u')).toBe('/home/u/.codex/config.toml');
    expect(codexSkillDir('/home/u')).toBe('/home/u/.codex/skills/assert');
  });

  it('reproduces Codex trust hashes (locked to Codex fingerprint algorithm)', () => {
    expect(
      codexHookTrustHash('session_start', '/home/u/.assert/bin/assert hook codex SessionStart'),
    ).toBe('sha256:befa9a0b1858bd0854da8558edf920c6312d776efe1e8f56841d36b2da457496');
    expect(
      codexHookTrustHash('post_tool_use', '/home/u/.assert/bin/assert hook codex PostToolUse'),
    ).toBe('sha256:cdc0560525a90af8125d5a65d0a05ee33c59be244c05ff384aa1c63c93600587');
  });

  it('writes config.toml hooks with pre-computed trust state, idempotently', () => {
    const bin = '/home/u/.assert/bin/assert';
    const cfg = '/home/u/.codex/config.toml';
    const once = upsertCodexConfigHooks('[features]\nhooks = true\n', bin, cfg);
    expect(once).toContain('[features]');
    expect(once).toContain('[[hooks.SessionStart.hooks]]');
    expect(once).toContain('command = "/home/u/.assert/bin/assert hook codex Stop"');
    expect(once).toContain('[hooks.state."/home/u/.codex/config.toml:session_start:0:0"]');
    expect(once).toContain('trusted_hash = "sha256:');
    expect(once).not.toContain('SessionEnd');
    // Re-running is a no-op (single managed block, stable hashes/indices).
    const twice = upsertCodexConfigHooks(once, bin, cfg);
    expect(twice).toBe(once);
    expect(twice.match(/managed by `assert install`\) >>>/g)).toHaveLength(1);
  });

  it('indexes the trust key past pre-existing hook groups for the same event', () => {
    const existing = '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "other"\n';
    const out = upsertCodexConfigHooks(existing, '/home/u/.assert/bin/assert', '/home/u/.codex/config.toml');
    // Our Stop is the 2nd group (index 1); SessionStart is still index 0.
    expect(out).toContain('[hooks.state."/home/u/.codex/config.toml:stop:1:0"]');
    expect(out).toContain('[hooks.state."/home/u/.codex/config.toml:session_start:0:0"]');
  });

  it('reinstalling over a Codex-reserialized config produces no duplicate keys', () => {
    const bin = '/home/u/.assert/bin/assert';
    const cfg = '/home/u/.codex/config.toml';
    const h = codexHookTrustHash;
    // Our hooks hoisted into Codex's body (a shared event merged with a foreign
    // hook), the marker block gone, and stale `:1:0` trust keys left behind.
    const reserialized = [
      '[[hooks.PostToolUse]]',
      '',
      '[[hooks.PostToolUse.hooks]]',
      `command = "${bin} hook codex PostToolUse"`,
      'type = "command"',
      '',
      '[[hooks.PostToolUse.hooks]]',
      'command = "other"',
      'type = "command"',
      '',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      `command = "${bin} hook codex SessionStart"`,
      'type = "command"',
      '',
      `[hooks.state."${cfg}:post_tool_use:0:0"]`,
      `trusted_hash = "${h('post_tool_use', `${bin} hook codex PostToolUse`)}"`,
      '',
      `[hooks.state."${cfg}:post_tool_use:0:1"]`,
      'trusted_hash = "sha256:other"',
      '',
      `[hooks.state."${cfg}:post_tool_use:1:0"]`,
      `trusted_hash = "${h('post_tool_use', `${bin} hook codex PostToolUse`)}"`,
      '',
      `[hooks.state."${cfg}:session_start:1:0"]`,
      `trusted_hash = "${h('session_start', `${bin} hook codex SessionStart`)}"`,
      '',
      '[projects."/home/u/work"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    const out = upsertCodexConfigHooks(reserialized, bin, cfg);

    const stateKeys = [...out.matchAll(/\[hooks\.state\."([^"]+)"\]/g)].map((m) => m[1]);
    expect(new Set(stateKeys).size).toBe(stateKeys.length);

    // One assert hook per event; foreign hook and unrelated sections survive.
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect(out.split(`command = "${bin} hook codex ${event}"`).length - 1).toBe(1);
    }
    expect(out.split('command = "other"').length - 1).toBe(1);
    expect(out).toContain('trusted_hash = "sha256:other"');
    expect(out).toContain('[projects."/home/u/work"]');

    // Stable: a second pass is a no-op.
    expect(upsertCodexConfigHooks(out, bin, cfg)).toBe(out);
  });

  it('probes PATH, the desktop app, and CODEX_CLI_PATH for the Codex CLI', () => {
    // PATH is always a candidate (npm/pip/Homebrew installs land there).
    const linux = codexCliCandidates('/home/u', {}, 'linux');
    expect(linux).toContain('codex');
    // macOS also checks the bundled desktop-app CLI, in /Applications and ~/.
    const mac = codexCliCandidates('/Users/u', {}, 'darwin');
    expect(mac).toContain('/Applications/Codex.app/Contents/Resources/codex');
    expect(mac).toContain('/Users/u/Applications/Codex.app/Contents/Resources/codex');
    // An explicit override is tried first.
    const overridden = codexCliCandidates('/Users/u', { CODEX_CLI_PATH: '/opt/codex' }, 'darwin');
    expect(overridden[0]).toBe('/opt/codex');
  });
});
