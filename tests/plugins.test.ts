/**
 * Plugin install paths and generated manifests. Guards the Cursor specifics
 * that silently break capture if wrong: the auto-loaded `local/` directory and
 * the required hooks.json `version` field (per Cursor's plugin/hook docs).
 */

import { describe, it, expect } from 'vitest';
import {
  claudePluginDir,
  cursorPluginDir,
  codexPluginDir,
  codexMarketplacePath,
  codexCliCandidates,
  generateClaudeCodePlugin,
  generateCursorPlugin,
  generateCodexPlugin,
  buildCodexMarketplace,
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

  it('installs the Codex plugin under the personal marketplace root', () => {
    expect(codexPluginDir('/home/u')).toBe('/home/u/.agents/plugins/assert');
    expect(codexMarketplacePath('/home/u')).toBe('/home/u/.agents/plugins/marketplace.json');
  });

  it('Codex hooks.json uses the Claude-style shape and an absolute command path', () => {
    const { hooksJson, pluginJson } = generateCodexPlugin('1.2.3', '/home/u/.assert/bin/assert');
    const hooks = JSON.parse(hooksJson).hooks;
    // Same nesting as Claude Code (Codex mirrors its hook schema).
    expect(hooks.PreToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: '/home/u/.assert/bin/assert hook codex PreToolUse',
    });
    expect(hooks.Stop[0].hooks[0].command).toContain('hook codex Stop');
    // Codex has no session-end event, so we must not subscribe to one.
    expect(hooks.SessionEnd).toBeUndefined();
    expect(JSON.parse(pluginJson).version).toBe('1.2.3');
  });

  it('builds a fresh Codex marketplace pointing at the local bundle', () => {
    const market = JSON.parse(buildCodexMarketplace(null));
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry.name).toBe('assert');
    // Codex resolves a personal marketplace's source.path relative to $HOME.
    expect(entry.source).toEqual({ source: 'local', path: './.agents/plugins/assert' });
    expect(entry.policy.installation).toBe('INSTALLED_BY_DEFAULT');
  });

  it('upserts into an existing Codex marketplace without clobbering other plugins', () => {
    const existing = JSON.stringify({
      name: 'my-stuff',
      plugins: [
        { name: 'other', source: { source: 'local', path: './other' } },
        { name: 'assert', source: { source: 'local', path: './stale' } },
      ],
    });
    const market = JSON.parse(buildCodexMarketplace(existing));
    // Preserves the user's marketplace name and unrelated plugins...
    expect(market.name).toBe('my-stuff');
    expect(market.plugins.map((p: { name: string }) => p.name).sort()).toEqual(['assert', 'other']);
    // ...and refreshes our entry (no stale duplicate).
    const assertEntries = market.plugins.filter((p: { name: string }) => p.name === 'assert');
    expect(assertEntries).toHaveLength(1);
    expect(assertEntries[0].source.path).toBe('./.agents/plugins/assert');
  });

  it('starts fresh when an existing Codex marketplace is unparseable', () => {
    const market = JSON.parse(buildCodexMarketplace('{ not json'));
    expect(market.name).toBe('assert-local');
    expect(market.plugins).toHaveLength(1);
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
