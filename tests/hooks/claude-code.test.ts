/**
 * Claude Code hook adapter. `Stop` is a turn boundary (session stays open);
 * `SessionEnd` finalizes attribution. `MessageDisplay` streams assistant text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook } from '../../src/hooks/claude-code';
import { loadState, setCaptureDisabled, blameFile } from '../../src/hooks/session-recorder';
import { hashLine } from '../../src/line-attribution';

describe('claude-code hook adapter', () => {
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
  const readEvents = (id: string) =>
    fs
      .readFileSync(path.join(repo, '.sessions', `${id}.jsonl`), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  // Claude Code sends absolute file paths.
  const hook = (type: string, data: Record<string, unknown>) =>
    processHook(type, JSON.stringify({ session_id: 's1', cwd: repo, ...data }));

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-claude-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-claude-repo-')));
    process.env.HOME = home;
    git('init');
    git('config user.email test@test.com');
    git('config user.name test');
    write('base.ts', 'const base = 1;\n');
    git('add .');
    git('commit -m init');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.ASSERT_DISABLE;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('captures a turn and finalizes attribution on SessionEnd', async () => {
    await hook('SessionStart', {});
    expect(loadState('s1', 'claude-code')).not.toBeNull();

    await hook('UserPromptSubmit', { prompt: 'add a feature' });
    const filePath = path.join(repo, 'feature.ts');
    await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: filePath } });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
      tool_response: { stdout: 'ok' },
    });
    await hook('MessageDisplay', { delta: 'Done.' });
    await hook('SessionEnd', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    expect(events.find((e) => e.type === 'tool_call')?.toolName).toBe('Edit');
    expect(events.find((e) => e.type === 'assistant_text')?.text).toBe('Done.');

    const attr = events.find((e) => e.type === 'attribution');
    expect(attr?.filePath).toBe('feature.ts');
    expect(attr?.contributor.type).toBe('ai');
    expect(attr?.lineHashes).toContain(hashLine('export const x = 1;'));

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(blameFile(repo, 'feature.ts', content)![0].source).toBe('agent');
  });

  it('keeps the session open on Stop (turn boundary, not session end)', async () => {
    await hook('SessionStart', {});
    write('feature.ts', 'export const x = 1;\n');
    await hook('Stop', {});

    // Stop syncs but does not end the session.
    expect(loadState('s1', 'claude-code')).not.toBeNull();
    expect(readEvents('s1').some((e) => e.type === 'session_end')).toBe(false);
  });

  it('does not record when capture is disabled', async () => {
    setCaptureDisabled(true);
    try {
      await hook('SessionStart', {});
      expect(loadState('s1', 'claude-code')).toBeNull();
    } finally {
      setCaptureDisabled(false);
    }
  });
});
