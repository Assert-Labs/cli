/**
 * Pi hook adapter. Pi drives an in-process extension whose shim maps its events
 * to Claude/Codex-style events (SessionStart, UserPromptSubmit, Pre/PostToolUse,
 * AssistantText, Stop, SessionEnd) with cwd + model injected. It finalizes
 * attribution on Stop (agent_settled) and closes cleanly on SessionEnd
 * (session_shutdown). These tests guard that finalization, the prompt<->turn
 * link, provider capture, and lazy session start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook } from '../../src/hooks/pi';
import { loadState, setCaptureDisabled, blameFile, readSessionFile } from '../../src/hooks/session-recorder';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { hashLine } from '../../src/line-attribution';
import { parseSession, getTurn } from '../../src/core';
import { readRepoEvents, repoSessionDir } from './session-layout';

describe('pi hook adapter', () => {
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
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-pi-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-pi-repo-')));
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
    expect(loadState('s1', 'pi')).not.toBeNull();

    await hook('UserPromptSubmit', { prompt: 'add a feature', model: 'gpt-5.6-sol', provider: 'pi' });
    await hook('PreToolUse', {
      tool_name: 'write',
      tool_input: { path: 'feature.ts' },
      call_id: 'c1',
      model: 'gpt-5.6-sol',
      provider: 'pi',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', {
      tool_name: 'write',
      tool_input: { path: 'feature.ts' },
      tool_response: { output: 'ok' },
      call_id: 'c1',
    });
    await hook('AssistantText', { text: 'Done.', model: 'gpt-5.6-sol', provider: 'pi' });
    await hook('Stop', { model: 'gpt-5.6-sol', provider: 'pi' });

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'human_turn')?.content).toBe('add a feature');
    expect(events.find((e) => e.type === 'tool_call')?.toolName).toBe('write');
    expect(events.find((e) => e.type === 'tool_call')?.action).toEqual({
      kind: 'write',
      paths: ['feature.ts'],
    });
    expect(events.find((e) => e.type === 'assistant_text')?.text).toBe('Done.');
    expect(events.find((e) => e.type === 'assistant_turn_start')?.model).toBe('gpt-5.6-sol');

    const attr = events.find((e) => e.type === 'attribution');
    expect(attr).toBeDefined();
    expect(attr.filePath).toBe('feature.ts');
    expect(attr.contributor).toEqual({ type: 'ai', agent: 'pi', modelId: 'gpt-5.6-sol', provider: 'pi' });
    expect(attr.lineHashes).toContain(hashLine('export const x = 1;'));
  });

  it('links the assistant turn to the prompt, resolvable via core', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'add a feature', model: 'gpt-5.6-sol' });
    await hook('PreToolUse', {
      tool_name: 'write',
      tool_input: { path: 'feature.ts' },
      call_id: 'c1',
      model: 'gpt-5.6-sol',
    });
    write('feature.ts', 'export const x = 1;\n');
    await hook('Stop', {});

    const events = readEvents('s1');
    const human = events.find((e) => e.type === 'human_turn');
    const turnStart = events.find((e) => e.type === 'assistant_turn_start');
    expect(turnStart.promptTurnId).toBe(human.turnId);

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const turnId = blameFile(repo, 'feature.ts', content)![0].turnId!;
    const session = parseSession(readSessionFile(repo, 's1')!);
    expect(getTurn(session, turnId)?.prompt?.text).toBe('add a feature');
  });

  it('starts the session lazily when the first event is not SessionStart', async () => {
    await hook('UserPromptSubmit', { prompt: 'resumed work', model: 'gpt-5.6-sol' });
    expect(loadState('s1', 'pi')).not.toBeNull();

    write('feature.ts', 'export const z = 3;\n');
    await hook('Stop', {});

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    expect(blameFile(repo, 'feature.ts', content)![0].source).toBe('agent');
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

  it('closes the session on SessionEnd (session_shutdown)', async () => {
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'hi', model: 'gpt-5.6-sol' });
    write('feature.ts', 'export const w = 4;\n');
    await hook('Stop', {});
    await hook('SessionEnd', {});

    const events = readEvents('s1');
    expect(events.find((e) => e.type === 'session_end')?.reason).toBe('completed');
    // Ended sessions are hidden from loadState.
    expect(loadState('s1', 'pi')).toBeNull();
  });

  it('ignores hooks for an unknown session', async () => {
    await processHook('Stop', JSON.stringify({ session_id: 'ghost', cwd: repo }));
    expect(loadState('ghost', 'pi')).toBeNull();
  });

  it('does not record when capture is disabled', async () => {
    setCaptureDisabled(true);
    try {
      await hook('SessionStart', {});
      expect(loadState('s1', 'pi')).toBeNull();
    } finally {
      setCaptureDisabled(false);
    }
  });
});
