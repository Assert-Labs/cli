import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  generateOrgPlugin,
  generateMarketplaceManifests,
  claudeManagedSettings,
  devinRequiredPlugin,
  ORG_PLUGIN_REPO,
} from '../src/org-plugin';
import { DEVIN_HOOK_EVENTS } from '../src/plugins';

describe('org plugin', () => {
  const files = generateOrgPlugin({ version: '9.9.9', cliBundle: '// bundle' });
  const parse = (rel: string) => JSON.parse(files[rel]);

  it('ships a manifest per host, each pointing at its own hooks file', () => {
    expect(parse('.claude-plugin/plugin.json')).toMatchObject({ name: 'assert', version: '9.9.9', hooks: './hooks/claude.json' });
    expect(parse('.codex-plugin/plugin.json')).toMatchObject({ name: 'assert', hooks: './hooks/codex.json' });
    expect(parse('.cursor-plugin/plugin.json')).toMatchObject({ name: 'assert', hooks: './hooks/cursor.json' });
    expect(files['dist/cli.mjs']).toBe('// bundle');
    expect(files['README.md']).toContain(ORG_PLUGIN_REPO);
  });

  it('routes every host to the runner with its own agent name', () => {
    const claude = parse('hooks/claude.json').hooks;
    expect(claude.PostToolUse[0].hooks[0].command).toBe('sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" claude-code PostToolUse');
    expect(Object.keys(claude)).toContain('SessionEnd');
    const codex = parse('hooks/codex.json').hooks;
    expect(codex.Stop[0].hooks[0].command).toContain(' codex Stop');
    expect(codex.SessionEnd).toBeUndefined(); // Codex has no session-end event
    const cursor = parse('hooks/cursor.json').hooks;
    expect(cursor.afterFileEdit[0].command).toContain(' cursor afterFileEdit');
    // Devin reads a bare event map at the plugin root.
    const devin = parse('hooks.json');
    expect(Object.keys(devin)).toEqual([...DEVIN_HOOK_EVENTS]);
    expect(devin.PreToolUse[0].hooks[0].command).toBe('sh "$CLAUDE_PLUGIN_ROOT/scripts/run.sh" devin PreToolUse');
  });

  it('makes this repository the marketplace, with the plugin at ./plugin', () => {
    const manifests = generateMarketplaceManifests();
    for (const rel of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
      expect(JSON.parse(manifests[rel]).plugins).toEqual([
        expect.objectContaining({ name: 'assert', source: './plugin' }),
      ]);
    }
    expect(JSON.parse(devinRequiredPlugin()).requiredPlugins[0]).toEqual({
      source: 'git-subdir',
      url: `https://github.com/${ORG_PLUGIN_REPO}.git`,
      path: 'plugin',
    });
  });

  it('managed settings enable the plugin and make cloud sessions wait for it', () => {
    const settings = JSON.parse(claudeManagedSettings());
    expect(settings.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBe('1');
    expect(settings.extraKnownMarketplaces.assert.source).toEqual({ source: 'github', repo: ORG_PLUGIN_REPO });
    expect(settings.enabledPlugins['assert@assert']).toBe(true);
  });

  describe('run.sh', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-plugin-')));
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      // Stand-in bundle: echo the CLI arguments and the payload it received.
      fs.writeFileSync(
        path.join(dir, 'dist', 'cli.mjs'),
        "process.stdin.on('data', (d) => process.stdout.write(process.argv.slice(2).join(' ') + ' ' + d));\n",
      );
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('runs the bundled CLI with the hook arguments and the payload on stdin', () => {
      const out = execFileSync('sh', [path.join(dir, 'scripts', 'run.sh'), 'devin', 'PostToolUse'], {
        input: '{"tool_name":"exec"}',
        encoding: 'utf-8',
      });
      expect(out).toBe('hook devin PostToolUse {"tool_name":"exec"}');
    });
  });
});
