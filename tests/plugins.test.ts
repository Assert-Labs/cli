/**
 * Plugin install paths and generated manifests. Guards the Cursor specifics
 * that silently break capture if wrong: the auto-loaded `local/` directory and
 * the required hooks.json `version` field (per Cursor's plugin/hook docs).
 */

import { describe, it, expect } from 'vitest';
import { parse } from 'smol-toml';
import {
  claudePluginDir,
  cursorPluginDir,
  codexConfigPath,
  codexSkillDir,
  codexCliCandidates,
  codexHookTrustHash,
  openCodePluginDir,
  openCodePluginPath,
  generateClaudeCodePlugin,
  generateCursorPlugin,
  generateOpenCodePlugin,
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
    expect(skill).toContain('Do **not** invoke redaction for');
    expect(skill).toContain('rare fallback');
    expect(skill).toContain('Do not proactively scan every turn');
    // Frames capture as low-key background bookkeeping, not a task concern.
    expect(skill.toLowerCase()).toContain('background');
    expect(skill.toLowerCase()).toContain('routine bookkeeping');
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

  const CODEX_EVENTS: ReadonlyArray<readonly [string, string]> = [
    ['SessionStart', 'session_start'],
    ['UserPromptSubmit', 'user_prompt_submit'],
    ['PreToolUse', 'pre_tool_use'],
    ['PostToolUse', 'post_tool_use'],
    ['Stop', 'stop'],
  ];

  it('merges hooks with trust state keyed to the hook slot, idempotently', () => {
    const bin = '/home/u/.assert/bin/assert';
    const cfg = '/home/u/.codex/config.toml';
    const once = upsertCodexConfigHooks('[features]\nhooks = true\n', bin, cfg);
    const parsed = parse(once) as any;

    expect(parsed.features.hooks).toBe(true); // Codex runs hooks only when on
    expect(once).not.toContain('SessionEnd');

    // Each event has one hook in a matcher-less group, with a hooks.state entry
    // keyed to that exact slot and carrying the hash Codex computes for it.
    for (const [event, label] of CODEX_EVENTS) {
      const command = `${bin} hook codex ${event}`;
      const groups = parsed.hooks[event];
      const gi = groups.findIndex((g: any) => g.matcher === undefined);
      const hi = groups[gi].hooks.findIndex((hook: any) => hook.command === command);
      expect(hi).toBeGreaterThanOrEqual(0);
      const entry = parsed.hooks.state[`${cfg}:${label}:${gi}:${hi}`];
      expect(entry.enabled).toBe(true);
      expect(entry.trusted_hash).toBe(codexHookTrustHash(label, command));
    }

    // Re-running is a no-op.
    expect(upsertCodexConfigHooks(once, bin, cfg)).toBe(once);
  });

  it('joins the existing matcher-less group and keys trust to that slot', () => {
    const bin = '/home/u/.assert/bin/assert';
    const cfg = '/home/u/.codex/config.toml';
    const existing = '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "other"\n';
    const parsed = parse(upsertCodexConfigHooks(existing, bin, cfg)) as any;
    // Our Stop hook joins group 0 (the foreign catch-all) as its 2nd hook.
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks.map((hook: any) => hook.command)).toEqual([
      'other',
      `${bin} hook codex Stop`,
    ]);
    expect(parsed.hooks.state[`${cfg}:stop:0:1`].enabled).toBe(true);
    expect(parsed.hooks.state[`${cfg}:session_start:0:0`].enabled).toBe(true);
  });

  it('reinstalling over a Codex-reserialized config produces no duplicate keys', () => {
    const bin = '/home/u/.assert/bin/assert';
    const cfg = '/home/u/.codex/config.toml';
    const h = codexHookTrustHash;
    // Our hooks hoisted into Codex's body (a shared event merged with a foreign
    // hook), and stale higher-index trust keys left behind from prior installs.
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
      `[hooks.state."${cfg}:post_tool_use:1:0"]`,
      `trusted_hash = "${h('post_tool_use', `${bin} hook codex PostToolUse`)}"`,
      '',
      `[hooks.state."${cfg}:session_start:1:0"]`,
      `trusted_hash = "${h('session_start', `${bin} hook codex SessionStart`)}"`,
      '',
      // A foreign trust entry (different source prefix) must survive untouched.
      '[hooks.state."plugin@x:hooks.json:post_tool_use:0:0"]',
      'trusted_hash = "sha256:foreign"',
      '',
      '[projects."/home/u/work"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    const out = upsertCodexConfigHooks(reserialized, bin, cfg);

    const stateKeys = [...out.matchAll(/\[hooks\.state\."([^"]+)"\]/g)].map((m) => m[1]);
    expect(new Set(stateKeys).size).toBe(stateKeys.length);

    // One assert hook per event; foreign hook, its trust entry, and unrelated
    // sections all survive.
    for (const [event] of CODEX_EVENTS) {
      expect(out.split(`command = "${bin} hook codex ${event}"`).length - 1).toBe(1);
    }
    expect(out.split('command = "other"').length - 1).toBe(1);
    expect(out).toContain('[hooks.state."plugin@x:hooks.json:post_tool_use:0:0"]');
    expect(out).toContain('[projects."/home/u/work"]');

    // Stable: a second pass is a no-op.
    expect(upsertCodexConfigHooks(out, bin, cfg)).toBe(out);
  });

  it('installs the OpenCode plugin under the auto-loaded plugins/ directory', () => {
    expect(openCodePluginDir('/home/u')).toBe('/home/u/.config/opencode/plugins');
    expect(openCodePluginPath('/home/u')).toBe('/home/u/.config/opencode/plugins/assert.ts');
  });

  it('OpenCode plugin forwards each callback to `assert hook opencode`', () => {
    const bin = '/home/u/.assert/bin/assert';
    const src = generateOpenCodePlugin('1.2.3', bin);
    // The absolute binary path is baked in (the module runs inside OpenCode,
    // where $HOME is not shell-expanded), and the CLI subcommand is fixed.
    expect(src).toContain(`const ASSERT_BIN = ${JSON.stringify(bin)}`);
    expect(src).toContain('"hook", "opencode", event');
    expect(src).toContain('v1.2.3');
    // Maps OpenCode's plugin surface to the adapter's events.
    for (const evt of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'AssistantText', 'Stop', 'SessionEnd']) {
      expect(src).toContain(`"${evt}"`);
    }
    for (const cb of ['event:', '"chat.message"', '"tool.execute.before"', '"tool.execute.after"', '"experimental.text.complete"']) {
      expect(src).toContain(cb);
    }
    // Exports both a named and default plugin so OpenCode loads it either way.
    expect(src).toContain('export const AssertPlugin');
    expect(src).toContain('export default AssertPlugin');
    // Carries the provider (OpenCode is multi-provider) alongside the model.
    expect(src).toContain('providerID');
    expect(src).toContain('provider');
    // Dedupes SessionStart — OpenCode's event bus can deliver session.created twice.
    expect(src).toContain('started.has(sid)');
    expect(src).toContain('started.add(sid)');
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
