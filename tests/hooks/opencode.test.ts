/**
 * OpenCode hook adapter. OpenCode drives an in-process plugin whose shim maps
 * its callbacks to Claude/Codex-style events (SessionStart, UserPromptSubmit,
 * Pre/PostToolUse, AssistantText, Stop, SessionEnd) with cwd + model injected.
 * Like Codex it finalizes attribution on Stop (session.idle). These tests guard
 * that finalization, the prompt<->turn link, and lazy session start on resume.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook, extractApplyPatchPaths } from '../../src/hooks/opencode';
import { loadState, setCaptureDisabled, blameFile, readSessionFile } from '../../src/hooks/session-recorder';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { hashLine } from '../../src/line-attribution';
import { parseSession, getTurn } from '../../src/core';
import { readRepoEvents, repoSessionDir } from './session-layout';

describe('opencode hook adapter', () => {
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
    processHook(type, JSON.stringify({ session_id: 's1', cwd: repo, ...data }));

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-opencode-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-opencode-repo-')));
    process.env.HOME = home;
    git('init');
    git('config user.email test@test.com');
    git('config user.name test');
    write('base.ts', 'const base = 1;\n');
    git('add .');
    git('commit -m init');
    getOrCreateRepoId(repo);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.ASSERT_DISABLE;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('records a turn and finalizes attribution on Stop', async () => {
    await hook('SessionStart', {});
    expect(loadState('s1', 'opencode')).not.toBeNull();

    await hook('UserPromptSubmit', { prompt: 'add a feature', model: 'claude-opus-4' });
    await hook('PreToolUse', {
      tool_name: 'edit',
      tool_input: { filePath: 'feature.ts' },
      call_id: 'c1',
      model: 'claude-opus-4',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', {
      tool_name: 'edit',
      tool_input: { filePath: 'feature.ts' },
      tool_response: 'ok',
      call_id: 'c1',
    });
    await hook('AssistantText', { text: 'Done.', model: 'claude-opus-4' });
    await hook('Stop', { model: 'claude-opus-4' });

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    expect(events.find((e) => e.type === 'tool_call')?.toolName).toBe('edit');
    expect(events.find((e) => e.type === 'assistant_text')?.text).toBe('Done.');
    expect(events.find((e) => e.type === 'assistant_turn_start')?.model).toBe('claude-opus-4');

    // Portable attribution is written even without a session-end event.
    const attr = events.find((e) => e.type === 'attribution');
    expect(attr).toBeDefined();
    expect(attr.filePath).toBe('feature.ts');
    expect(attr.contributor).toEqual({ type: 'ai', agent: 'opencode', modelId: 'claude-opus-4' });
    expect(attr.lineHashes).toContain(hashLine('export const x = 1;'));
  });

  it('extracts touched files from an apply_patch blob', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: dummy.txt',
      '+hello',
      '*** Update File: src/x.ts',
      '@@',
      '+const x = 1;',
      '*** End Patch',
    ].join('\n');
    expect(extractApplyPatchPaths(patch)).toEqual(['dummy.txt', 'src/x.ts']);
  });

  it('tracks apply_patch edits (patchText, no discrete file_path)', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'make dummy', model: 'gpt-5.6-sol', provider: 'opencode' });
    const patch = '*** Begin Patch\n*** Add File: dummy.txt\n+hello\n*** End Patch\n';
    await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { patchText: patch },
      call_id: 'c1',
      model: 'gpt-5.6-sol',
      provider: 'opencode',
    });
    write('dummy.txt', 'hello\n');
    await hook('PostToolUse', {
      tool_name: 'apply_patch',
      tool_input: { patchText: patch },
      tool_response: 'Success',
      call_id: 'c1',
    });
    await hook('Stop', { model: 'gpt-5.6-sol', provider: 'opencode' });

    const result = readEvents('s1').find((e) => e.type === 'tool_result');
    expect(result.filesModified).toEqual(['dummy.txt']);

    const content = fs.readFileSync(path.join(repo, 'dummy.txt'), 'utf-8');
    expect(blameFile(repo, 'dummy.txt', content)![0].source).toBe('agent');
  });

  it('captures the provider alongside the model id', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', {
      prompt: 'add it',
      model: 'claude-opus-4',
      provider: 'anthropic',
    });
    await hook('PreToolUse', {
      tool_name: 'edit',
      tool_input: { filePath: 'feature.ts' },
      call_id: 'c1',
      model: 'claude-opus-4',
      provider: 'anthropic',
    });
    write('feature.ts', 'export const p = 1;\n');
    await hook('Stop', { model: 'claude-opus-4', provider: 'anthropic' });

    // The provider rides in the structured data (attribution + blame records)...
    const attr = readEvents('s1').find((e) => e.type === 'attribution');
    expect(attr.contributor).toEqual({
      type: 'ai',
      agent: 'opencode',
      modelId: 'claude-opus-4',
      provider: 'anthropic',
    });

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const blame = blameFile(repo, 'feature.ts', content)!;
    const line = blame.find((b) => b.provider);
    expect(line?.modelId).toBe('claude-opus-4');
    expect(line?.provider).toBe('anthropic');
  });

  it('links the assistant turn to the prompt that triggered it', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'do the thing', model: 'claude-opus-4' });
    await hook('PreToolUse', {
      tool_name: 'write',
      tool_input: { filePath: 'feature.ts' },
      call_id: 'c1',
      model: 'claude-opus-4',
    });
    write('feature.ts', 'export const y = 2;\n');
    await hook('Stop', {});

    const events = readEvents('s1');
    const human = events.find((e) => e.type === 'human_turn');
    const turnStart = events.find((e) => e.type === 'assistant_turn_start');
    expect(turnStart.promptTurnId).toBe(human.turnId);
  });

  it('resolves a captured line back to its prompt via core', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'add a feature', model: 'claude-opus-4' });
    await hook('PreToolUse', {
      tool_name: 'edit',
      tool_input: { filePath: 'feature.ts' },
      call_id: 'c1',
      model: 'claude-opus-4',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('Stop', {});

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const turnId = blameFile(repo, 'feature.ts', content)![0].turnId!;
    const session = parseSession(readSessionFile(repo, 's1')!);
    expect(getTurn(session, turnId)?.prompt?.text).toBe('add a feature');
  });

  it('starts the session lazily when the first event is not SessionStart', async () => {
    // A plugin loaded mid-session (or a resumed session) may surface a prompt
    // before any session.created — it must still be captured, not dropped.
    await hook('UserPromptSubmit', { prompt: 'resumed work', model: 'claude-opus-4' });
    expect(loadState('s1', 'opencode')).not.toBeNull();

    write('feature.ts', 'export const z = 3;\n');
    await hook('Stop', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('resumed work');
    const bySource = new Map(
      blameFile(repo, 'feature.ts', fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8'))!.map(
        (a, i) => ['export const z = 3;'.split('\n')[i], a],
      ),
    );
    expect(bySource.get('export const z = 3;')?.source).toBe('agent');
  });

  it('writes one immutable file per turn; blame reflects the latest', async () => {
    await hook('SessionStart', {});

    write('feature.ts', 'line one\n');
    await hook('AssistantText', { text: 'first' });
    await hook('Stop', {});

    write('feature.ts', 'line one\nline two\n');
    await hook('AssistantText', { text: 'second' });
    await hook('Stop', {});

    const dir = repoSessionDir(repo, 's1')!;
    const turnFiles = fs.readdirSync(dir).filter((f) => /^\d+-.+\.jsonl$/.test(f));
    expect(turnFiles).toHaveLength(2);

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const bySource = new Map(
      blameFile(repo, 'feature.ts', content)!.map((a, i) => [content.split('\n')[i], a]),
    );
    expect(bySource.get('line one')?.source).toBe('agent');
    expect(bySource.get('line two')?.source).toBe('agent');
  });

  it('closes the session on SessionEnd', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'hi', model: 'claude-opus-4' });
    write('feature.ts', 'export const w = 4;\n');
    await hook('Stop', {});
    await hook('SessionEnd', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'session_end')?.reason).toBe('completed');
  });

  it('ignores hooks for an unknown session on Stop/SessionEnd', async () => {
    await processHook('Stop', JSON.stringify({ session_id: 'ghost', cwd: repo }));
    expect(loadState('ghost', 'opencode')).toBeNull();
  });

  it('does not record when capture is disabled', async () => {
    setCaptureDisabled(true);
    try {
      await hook('SessionStart', {});
      expect(loadState('s1', 'opencode')).toBeNull();
    } finally {
      setCaptureDisabled(false);
    }
  });
});
