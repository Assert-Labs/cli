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

  it('reproduces Codex trust hashes (locked to real values)', () => {
    // Verified against actual ~/.codex/config.toml hooks.state entries.
    expect(
      codexHookTrustHash('post_tool_use', '/Users/devin/.git-ai/bin/git-ai checkpoint codex --hook-input stdin'),
    ).toBe('sha256:e468ceb1c401075dc6dc766afc4ec76cc79b8f4240094e05acda7b168016fe07');
    expect(
      codexHookTrustHash('session_start', '/Users/devin/.assert/bin/assert hook codex SessionStart'),
    ).toBe('sha256:75887e86ce590d45417742351517972414613cc838c5f3fa8ec3025080f966e9');
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
