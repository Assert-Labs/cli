/**
 * Devin hook adapter. Devin speaks Claude Code's hook protocol but sends no
 * `cwd`, may miss `SessionStart` when its plugin loads late, and reports tool
 * results as `{success, output, error}`. Payload shapes come from a real cloud
 * session (tests/fixtures/devin-payloads.json).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook, resolveCwd } from '../../src/hooks/devin';
import { loadState, blameFile } from '../../src/hooks/session-recorder';
import { hashLine } from '../../src/line-attribution';
import { readRepoEvents, repoHasSession } from './session-layout';
import fixture from '../fixtures/devin-payloads.json';

describe('devin hook adapter', () => {
  let originalHome: string | undefined;
  let home: string;
  let repo: string;

  const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' });
  const write = (rel: string, content: string) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  const readEvents = (id: string) => readRepoEvents(repo, id);

  // Devin sends no cwd; the hook process has DEVIN_PROJECT_DIR instead.
  const hook = (type: string, data: Record<string, unknown>) =>
    processHook(type, JSON.stringify({ session_id: 's1', hook_event_name: type, ...data }));

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-devin-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-devin-repo-')));
    process.env.HOME = home;
    process.env.DEVIN_PROJECT_DIR = repo;
    git('init');
    git('config user.email test@test.com');
    git('config user.name test');
    write('base.ts', 'const base = 1;\n');
    git('add .');
    git('commit -m init');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.DEVIN_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('records a turn from real cloud payloads and finalizes attribution on Stop', async () => {
    await hook('SessionStart', { source: 'startup' });
    expect(loadState('s1', 'devin')?.cwd).toBe(repo);

    await hook('UserPromptSubmit', { prompt: 'add a feature', prompt_id: 'p1' });
    // The fixture carries its own session id; this test's session is s1.
    const [pre, post] = fixture;
    await hook('PreToolUse', { ...pre.payload, session_id: 's1' });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', { ...post.payload, session_id: 's1' });
    await hook('Stop', { stop_hook_active: false });

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.toolName).toBe('exec');
    expect(call?.toolCallId).toBe('toolu_011trpHnAeW7eCRDMonz5q76');
    expect(call?.action).toEqual({
      kind: 'command',
      command: 'echo probe >> README.md; git checkout -- README.md',
    });
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.toolCallId).toBe(call?.toolCallId);
    expect(result?.output).toContain('Exit code: 0');
    expect(result?.error).toBeUndefined();
    expect(events.some((e) => e.type === 'assistant_turn_end')).toBe(true);
    // Stop is a turn boundary: attribution lands, the session stays open.
    expect(events.find((e) => e.type === 'attribution')?.lineHashes).toContain(
      hashLine('export const x = 1;'),
    );
    expect(loadState('s1', 'devin')).not.toBeNull();
    expect(blameFile(repo, 'feature.ts', 'export const x = 1;\n')![0].source).toBe('agent');
  });

  it('opens the session lazily when the plugin missed SessionStart', async () => {
    const filePath = path.join(repo, 'feature.ts');
    await hook('PreToolUse', {
      tool_name: 'write',
      tool_input: { file_path: filePath, content: 'export const y = 2;\n' },
      tool_use_id: 't1',
    });
    expect(loadState('s1', 'devin')?.cwd).toBe(repo);
    write('feature.ts', 'export const y = 2;\n');
    await hook('PostToolUse', {
      tool_name: 'write',
      tool_input: { file_path: filePath, content: 'export const y = 2;\n' },
      tool_use_id: 't1',
      tool_response: { success: true, output: '', error: null },
    });
    await hook('Stop', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'tool_call')?.action).toEqual({
      kind: 'write',
      paths: ['feature.ts'],
    });
    expect(events.find((e) => e.type === 'tool_result')?.filesModified).toEqual(['feature.ts']);
    expect(events.find((e) => e.type === 'attribution')?.filePath).toBe('feature.ts');
  });

  it('surfaces a failed tool as an error', async () => {
    await hook('SessionStart', {});
    await hook('PreToolUse', { tool_name: 'exec', tool_input: { command: 'false' }, tool_use_id: 't2' });
    await hook('PostToolUse', {
      tool_name: 'exec',
      tool_input: { command: 'false' },
      tool_use_id: 't2',
      tool_response: { success: false, output: null, error: 'exit 1' },
    });
    write('feature.ts', 'x\n');
    await hook('Stop', {});
    const result = readEvents('s1').find((e) => e.type === 'tool_result');
    expect(result?.error).toBe('exit 1');
    expect(result?.output).toBeUndefined();
  });

  it('closes the session on SessionEnd', async () => {
    await hook('SessionStart', {});
    write('feature.ts', 'x\n');
    await hook('SessionEnd', { reason: 'completed' });
    expect(loadState('s1', 'devin')).toBeNull();
    expect(repoHasSession(repo, 's1')).toBe(true);
    expect(readEvents('s1').some((e) => e.type === 'session_end')).toBe(true);
  });

  it('resolves the project directory from the environment, then the shell workdir', () => {
    expect(resolveCwd({ session_id: 's' }, { DEVIN_PROJECT_DIR: '/p' })).toBe('/p');
    expect(resolveCwd({ session_id: 's' }, { CLAUDE_PROJECT_DIR: '/c' })).toBe('/c');
    expect(resolveCwd({ session_id: 's', tool_input: { workdir: '/w' } }, {})).toBe('/w');
    expect(resolveCwd({ session_id: 's', cwd: '/explicit' }, { DEVIN_PROJECT_DIR: '/p' })).toBe('/explicit');
    expect(resolveCwd({ session_id: 's' }, {})).toBe(process.cwd());
  });
});
