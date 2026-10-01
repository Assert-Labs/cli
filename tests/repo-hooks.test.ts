import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  generateShim,
  upsertClaudeSettings,
  upsertCursorHooks,
  upsertDevinHooks,
  upsertCodexHooks,
  installRepoHooks,
  SHIM_PATH,
} from '../src/repo-hooks';

describe('repo hooks', () => {
  it('merges Claude settings: keeps other keys and foreign hooks, replaces ours, idempotent', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.assert/hook.sh" claude-code PreToolUse' }] }],
      },
    });
    const once = upsertClaudeSettings(existing);
    const settings = JSON.parse(once);
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
    expect(settings.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual([
      'echo other',
      '"$CLAUDE_PROJECT_DIR/.assert/hook.sh" claude-code Stop',
    ]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0]).toEqual({
      type: 'command',
      command: '"$CLAUDE_PROJECT_DIR/.assert/hook.sh" claude-code SessionEnd',
    });
    expect(upsertClaudeSettings(once)).toBe(once);
  });

  it('writes the Devin file as a bare event map with timeouts', () => {
    const hooks = JSON.parse(upsertDevinHooks(null));
    expect(hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: '"$DEVIN_PROJECT_DIR/.assert/hook.sh" devin PostToolUse',
      timeout: 30,
    });
    expect(hooks.hooks).toBeUndefined();
  });

  it('writes Cursor hooks in its flat shape, keeping foreign entries', () => {
    const existing = JSON.stringify({ version: 1, hooks: { stop: [{ command: './other.sh' }] } });
    const once = upsertCursorHooks(existing);
    const file = JSON.parse(once);
    expect(file.version).toBe(1);
    expect(file.hooks.stop).toEqual([{ command: './other.sh' }, { command: './.assert/hook.sh cursor stop' }]);
    expect(file.hooks.afterFileEdit).toEqual([{ command: './.assert/hook.sh cursor afterFileEdit' }]);
    expect(upsertCursorHooks(once)).toBe(once);
  });

  it('writes Codex hooks under a hooks key, relative to the repo root', () => {
    const file = JSON.parse(upsertCodexHooks('{bad json'));
    expect(file.hooks.Stop[0].hooks[0].command).toBe('./.assert/hook.sh codex Stop');
    expect(file.hooks.SessionEnd).toBeUndefined();
  });

  describe('installRepoHooks and the shim', () => {
    let repo: string;
    let assertHome: string;
    beforeEach(() => {
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-repohooks-')));
      assertHome = path.join(repo, 'assert-home');
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    const fakeCli = () => {
      const cli = path.join(assertHome, 'npm', 'node_modules', '@assertlabs', 'cli', 'bin', 'assert.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(
        cli,
        "process.stdin.on('data', (d) => process.stdout.write(process.argv.slice(2).join(' ') + ' ' + d));\n",
      );
    };

    it('writes every host file and an executable shim', () => {
      const written = installRepoHooks(repo, '1.2.3');
      expect(written).toEqual([
        SHIM_PATH,
        '.claude/settings.json',
        '.cursor/hooks.json',
        '.devin/hooks.v1.json',
        '.codex/hooks.json',
      ]);
      const shim = path.join(repo, SHIM_PATH);
      expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(shim, 'utf-8')).toBe(generateShim('1.2.3'));
      expect(fs.readFileSync(shim, 'utf-8')).toContain('@assertlabs/cli@$version');
      // Re-running is a no-op.
      const before = fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf-8');
      installRepoHooks(repo, '1.2.3');
      expect(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf-8')).toBe(before);
    });

    it('runs an installed CLI with the hook arguments and payload', () => {
      installRepoHooks(repo, '1.2.3');
      fakeCli();
      const out = execFileSync('sh', [path.join(repo, SHIM_PATH), 'cursor', 'afterFileEdit'], {
        input: '{"file_path":"a.ts"}',
        encoding: 'utf-8',
        env: { ...process.env, ASSERT_HOME: assertHome },
      });
      expect(out).toBe('hook cursor afterFileEdit {"file_path":"a.ts"}');
    });

    it('exits 0 when the CLI is missing and cannot be installed', () => {
      installRepoHooks(repo, '1.2.3');
      // A PATH with node but no npm, so the install step fails without network.
      const bin = path.join(repo, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const out = execFileSync('/bin/sh', [path.join(repo, SHIM_PATH), 'devin', 'Stop'], {
        input: '{}',
        encoding: 'utf-8',
        env: { HOME: repo, PATH: bin, ASSERT_HOME: assertHome },
      });
      expect(out).toBe('');
      expect(fs.existsSync(path.join(assertHome, '.installing'))).toBe(false);
    });
  });
});
