/**
 * Codex hook adapter. Codex mirrors Claude Code's hook schema but has no
 * session-end event, so attribution is finalized on every `Stop` (per turn).
 * These tests guard that finalization and its idempotency across turns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook } from '../../src/hooks/codex';
import { loadState, setCaptureDisabled, blameFile, readSessionFile } from '../../src/hooks/session-recorder';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { hashLine } from '../../src/line-attribution';
import { parseSession, getTurn } from '../../src/core';
import { readRepoEvents, repoSessionDir } from './session-layout';

describe('codex hook adapter', () => {
  let originalHome: string | undefined;
  let home: string;
  let repo: string;
  let repoId: string;

  const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' });
  const write = (rel: string, content: string) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  const readEvents = (id: string) => readRepoEvents(repo, id);

  const hook = (type: string, data: Record<string, unknown>) =>
    processHook(type, JSON.stringify({ session_id: 's1', cwd: repo, ...data }));

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-codex-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-codex-repo-')));
    process.env.HOME = home;
    git('init');
    git('config user.email test@test.com');
    git('config user.name test');
    write('base.ts', 'const base = 1;\n');
    git('add .');
    git('commit -m init');
    repoId = getOrCreateRepoId(repo)!.repoId;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.ASSERT_DISABLE;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('records a turn and finalizes attribution on Stop', async () => {
    await hook('SessionStart', {});
    expect(loadState('s1', 'codex')).not.toBeNull();

    await hook('UserPromptSubmit', { prompt: 'add a feature' });
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      model: 'gpt-5-codex',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      tool_response: { output: 'ok' },
    });
    await hook('Stop', { last_assistant_message: 'Done.' });

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    expect(events.find((e) => e.type === 'tool_call')?.toolName).toBe('apply_patch');
    expect(events.find((e) => e.type === 'assistant_text')?.text).toBe('Done.');
    expect(events.find((e) => e.type === 'assistant_turn_start')?.model).toBe('gpt-5-codex');

    // Portable attribution is written even without a session-end event.
    const attr = events.find((e) => e.type === 'attribution');
    expect(attr).toBeDefined();
    expect(attr.filePath).toBe('feature.ts');
    expect(attr.contributor).toEqual({ type: 'ai', agent: 'codex', modelId: 'gpt-5-codex' });
    expect(attr.lineHashes).toContain(hashLine('export const x = 1;'));
  });

  it('links the assistant turn to the prompt that triggered it', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'do the thing' });
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      model: 'gpt-5-codex',
    });
    write('feature.ts', 'export const y = 2;\n');
    await hook('Stop', { last_assistant_message: 'Done.' });

    const events = readEvents('s1');
    const human = events.find((e) => e.type === 'human_turn');
    const turnStart = events.find((e) => e.type === 'assistant_turn_start');
    // Explicit link — no ordering needed to find a line's prompt.
    expect(turnStart.promptTurnId).toBe(human.turnId);
  });

  it('resolves a captured line back to its prompt via core', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'add a feature' });
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      model: 'gpt-5-codex',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('Stop', { last_assistant_message: 'Done.' });

    // blame gives the line's turnId; core (parseSession) resolves it to the prompt.
    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const turnId = blameFile(repo, 'feature.ts', content)![0].turnId!;
    const session = parseSession(readSessionFile(repo, 's1')!);
    expect(getTurn(session, turnId)?.prompt?.text).toBe('add a feature');
  });

  it('writes one immutable file per turn; blame reflects the latest', async () => {
    await hook('SessionStart', {});

    write('feature.ts', 'line one\n');
    await hook('Stop', { last_assistant_message: 'first' });

    write('feature.ts', 'line one\nline two\n');
    await hook('Stop', { last_assistant_message: 'second' });

    // Two turns -> two immutable turn files (the first is never rewritten).
    const dir = repoSessionDir(repo, 's1')!;
    const turnFiles = fs.readdirSync(dir).filter((f) => /^\d+-.+\.jsonl$/.test(f));
    expect(turnFiles).toHaveLength(2);

    // Blame reflects the latest turn (both added lines), not a stale snapshot.
    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const bySource = new Map(
      blameFile(repo, 'feature.ts', content)!.map((a, i) => [content.split('\n')[i], a]),
    );
    expect(bySource.get('line one')?.source).toBe('agent');
    expect(bySource.get('line two')?.source).toBe('agent');
  });

  it('checkpoints ownership before resuming the same session', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'create the file' });
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      model: 'gpt-5-codex',
    });
    write('feature.ts', 'first line\nsecond line\n');

    // Resume without a stop from the first process.
    await hook('SessionStart', { source: 'resume' });

    await hook('UserPromptSubmit', { prompt: 'edit one line' });
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { file_path: 'feature.ts' },
      model: 'gpt-5-codex',
    });
    write('feature.ts', 'first line edited\nsecond line\n');
    await hook('Stop', { last_assistant_message: 'Done.' });

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

  it('ignores hooks for an unknown session', async () => {
    await processHook(
      'PreToolUse',
      JSON.stringify({ session_id: 'ghost', cwd: repo, tool_name: 'x', tool_input: {} }),
    );
    expect(loadState('ghost', 'codex')).toBeNull();
  });

  it('does not record when capture is disabled', async () => {
    setCaptureDisabled(true);
    try {
      await hook('SessionStart', {});
      expect(loadState('s1', 'codex')).toBeNull();
    } finally {
      setCaptureDisabled(false);
    }
  });
});
