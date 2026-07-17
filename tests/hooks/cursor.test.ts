/**
 * Cursor hook adapter. Cursor's later hooks may omit the session id (resolved
 * from the workspace), and it finalizes attribution on `sessionEnd`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook } from '../../src/hooks/cursor';
import { loadState, setCaptureDisabled, blameFile, readSessionFile } from '../../src/hooks/session-recorder';
import { parseSession, getTurn } from '../../src/core';
import { readRepoEvents } from './session-layout';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { hashLine } from '../../src/line-attribution';

describe('cursor hook adapter', () => {
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

  const hook = (type: string, data: Record<string, unknown>) =>
    processHook(type, JSON.stringify({ sessionId: 's1', workspaceRoot: repo, ...data }));

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-cursor-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-cursor-repo-')));
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

  it('captures a turn and finalizes attribution on sessionEnd', async () => {
    await hook('sessionStart', {});
    expect(loadState('s1', 'cursor')).not.toBeNull();

    await hook('beforeSubmitPrompt', { content: 'add a feature' });
    await hook('preToolUse', { toolName: 'edit_file', filePath: 'feature.ts' });
    write('feature.ts', 'export const x = 1;\n');
    await hook('postToolUse', { toolName: 'edit_file', filePath: 'feature.ts', success: true });
    await hook('afterAgentResponse', {});
    await hook('sessionEnd', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    expect(events.find((e) => e.type === 'tool_call')?.toolName).toBe('edit_file');
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);

    const attr = events.find((e) => e.type === 'attribution');
    expect(attr?.filePath).toBe('feature.ts');
    expect(attr?.contributor.type).toBe('ai');
    expect(attr?.lineHashes).toContain(hashLine('export const x = 1;'));

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const blame = blameFile(repo, 'feature.ts', content)!;
    expect(blame[0].source).toBe('agent');
  });

  it('resolves the session id from the workspace when a hook omits it', async () => {
    await processHook('sessionStart', JSON.stringify({ sessionId: 's2', workspaceRoot: repo }));
    write('feature.ts', 'export const y = 2;\n');
    // Later hooks carry no sessionId — Cursor resolves it from workspaceRoot.
    await processHook('beforeSubmitPrompt', JSON.stringify({ workspaceRoot: repo, content: 'resolved' }));
    await processHook('afterFileEdit', JSON.stringify({ workspaceRoot: repo, filePath: 'feature.ts', success: true }));
    await processHook('stop', JSON.stringify({ workspaceRoot: repo }));

    const events = readEvents('s2');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('resolved');
  });

  it('checkpoints ownership before resuming the same session', async () => {
    await hook('sessionStart', {});
    await hook('beforeSubmitPrompt', { content: 'create the file' });
    await hook('preToolUse', { toolName: 'edit_file', filePath: 'feature.ts' });
    write('feature.ts', 'first line\nsecond line\n');

    // Resume without a stop from the first process.
    await hook('sessionStart', {});

    await hook('beforeSubmitPrompt', { content: 'edit one line' });
    await hook('preToolUse', { toolName: 'edit_file', filePath: 'feature.ts' });
    write('feature.ts', 'first line edited\nsecond line\n');
    await hook('stop', {});

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const byText = new Map(
      blameFile(repo, 'feature.ts', content)!.map((attribution, index) => [
        content.split('\n')[index],
        attribution,
      ]),
    );
    const session = parseSession(readSessionFile(repo, 's1')!);
    expect(getTurn(session, byText.get('first line edited')!.turnId!)?.prompt?.text).toBe(
      'edit one line',
    );
    expect(getTurn(session, byText.get('second line')!.turnId!)?.prompt?.text).toBe(
      'create the file',
    );
  });

  it('does not record when capture is disabled', async () => {
    setCaptureDisabled(true);
    try {
      await hook('sessionStart', {});
      expect(loadState('s1', 'cursor')).toBeNull();
    } finally {
      setCaptureDisabled(false);
    }
  });
});
