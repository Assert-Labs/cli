/**
 * Plugin install paths and generated manifests. Guards the Cursor specifics
 * that silently break capture if wrong: the auto-loaded `local/` directory and
 * the required hooks.json `version` field (per Cursor's plugin/hook docs).
 */

import { describe, it, expect } from 'vitest';
import {
  claudePluginDir,
  cursorPluginDir,
  generateClaudeCodePlugin,
  generateCursorPlugin,
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
});
