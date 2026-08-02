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
import {
  loadState,
  setCaptureDisabled,
  blameFile,
  readSessionFile,
} from '../../src/hooks/session-recorder';
import { parseSession } from '../../src/core';
import { readRepoEvents, repoSessionDir } from './session-layout';
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
  const readEvents = (id: string) => readRepoEvents(repo, id);

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
    // Canonical, agent-independent view of the call, with the path made
    // repo-relative on the way into `.sessions/`.
    expect(events.find((e) => e.type === 'tool_call')?.action).toEqual({
      kind: 'edit',
      paths: ['feature.ts'],
    });
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

  it('checkpoints ownership before resuming the same session', async () => {
    const transcriptPath = path.join(home, 'claude-transcript.jsonl');
    const transcript: unknown[] = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'create the file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'create-turn',
          model: 'claude-opus-4-5-20251101',
          content: [
            {
              type: 'tool_use',
              id: 'create-tool',
              name: 'Write',
              input: { file_path: path.join(repo, 'feature.ts') },
            },
          ],
        },
      },
    ];
    const writeTranscript = () =>
      fs.writeFileSync(
        transcriptPath,
        transcript.map((event) => JSON.stringify(event)).join('\n') + '\n',
      );

    await hook('SessionStart', {});
    write('feature.ts', 'first line\nsecond line\n');
    writeTranscript();

    // A resumed Claude process emits SessionStart again without the prior Stop.
    // The existing file state must be attributed before the next turn edits it.
    await hook('SessionStart', { transcript_path: transcriptPath });

    transcript.push(
      {
        type: 'user',
        timestamp: '2026-01-01T00:01:00.000Z',
        message: { role: 'user', content: 'edit one line' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:01:01.000Z',
        message: {
          id: 'edit-turn',
          model: 'claude-opus-4-5-20251101',
          content: [
            {
              type: 'tool_use',
              id: 'edit-tool',
              name: 'Edit',
              input: { file_path: path.join(repo, 'feature.ts') },
            },
          ],
        },
      },
    );
    write('feature.ts', 'first line edited\nsecond line\n');
    writeTranscript();
    await hook('Stop', { transcript_path: transcriptPath });

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const byText = new Map(
      blameFile(repo, 'feature.ts', content)!.map((attribution, index) => [
        content.split('\n')[index],
        attribution,
      ]),
    );
    expect(byText.get('first line edited')?.turnId).toBe('edit-turn');
    expect(byText.get('second line')?.turnId).toBe('create-turn');
  });

  it('resumes into the same session directory after SessionEnd', async () => {
    await hook('SessionStart', {});
    const createdAt = loadState('s1', 'claude-code')!.createdAt;
    await hook('UserPromptSubmit', { prompt: 'create the file' });
    await hook('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'feature.ts') },
    });
    write('feature.ts', 'first line\nsecond line\n');
    await hook('SessionEnd', {});
    expect(loadState('s1', 'claude-code')).toBeNull();

    await hook('SessionStart', {});
    expect(loadState('s1', 'claude-code')?.createdAt).toBe(createdAt);
    await hook('UserPromptSubmit', { prompt: 'edit one line' });
    await hook('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'feature.ts') },
    });
    write('feature.ts', 'first line edited\nsecond line\n');
    await hook('Stop', {});

    const sessionDirs = fs
      .readdirSync(path.join(repo, '.sessions'))
      .filter((entry) => entry.endsWith('-s1'));
    expect(sessionDirs).toHaveLength(1);
    expect(repoSessionDir(repo, 's1')).not.toBeNull();
    expect(readEvents('s1').some((event) => event.type === 'session_resume')).toBe(
      true,
    );

    const content = fs.readFileSync(path.join(repo, 'feature.ts'), 'utf-8');
    const turnIds = blameFile(repo, 'feature.ts', content)!.map(
      (attribution) => attribution.turnId,
    );
    expect(turnIds[0]).not.toBe(turnIds[1]);
  });

  it('appends later assistant blocks to an immutable logical turn', async () => {
    const transcriptPath = path.join(home, 'claude-growing-transcript.jsonl');
    const transcript: unknown[] = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'create the file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'tool-block',
          content: [
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: { file_path: path.join(repo, 'feature.ts') },
            },
          ],
        },
      },
    ];
    const writeTranscript = () =>
      fs.writeFileSync(
        transcriptPath,
        transcript.map((event) => JSON.stringify(event)).join('\n') + '\n',
      );

    await hook('SessionStart', {});
    write('feature.ts', 'created\n');
    writeTranscript();
    await hook('Stop', { transcript_path: transcriptPath });

    transcript.push({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        id: 'summary-block',
        content: [{ type: 'text', text: 'Created the file.' }],
      },
    });
    writeTranscript();
    await hook('Stop', { transcript_path: transcriptPath });

    const session = parseSession(readSessionFile(repo, 's1')!);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].toolCalls).toHaveLength(1);
    expect(session.turns[0].text).toEqual(['Created the file.']);

    const turnFiles = fs
      .readdirSync(repoSessionDir(repo, 's1')!)
      .filter((file) => /^\d+-.+\.jsonl$/.test(file));
    expect(turnFiles).toHaveLength(2);
  });

  it('records what a turn did to a file, including deletions', async () => {
    // The snapshot in `lines` only describes the file's end state, so a line
    // the turn deleted leaves no trace in it and the state it was deleted from
    // is not part of the capture. Only the writer holds both sides.
    write('existing.ts', 'keep1\ndrop1\ndrop2\nkeep2\n');
    git('add .');
    git('commit -m base');

    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'trim it' });
    await hook('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'existing.ts') },
    });
    write('existing.ts', 'keep1\nkeep2\nadded\n');
    await hook('Stop', {});

    const attribution = readEvents('s1').find(
      (event) => event.type === 'line_attribution' && event.filePath === 'existing.ts',
    );
    expect(attribution.churn).toEqual({ additions: 1, deletions: 2 });
    expect(attribution.turnId).toBeDefined();
  });

  it('records the diff of each individual edit', async () => {
    // Per-turn attribution is taken after the whole turn, so an edit a later
    // call revises leaves no separate trace there. This is the only record of
    // what one call did.
    write('edited.ts', 'one\ntwo\nthree\n');
    git('add .');
    git('commit -m base');
    const filePath = path.join(repo, 'edited.ts');

    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'edit twice' });

    await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: filePath } });
    write('edited.ts', 'one\nTWO\nthree\nfour\n');
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: filePath } });

    // A second call revising the same file must be measured on its own.
    await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: filePath } });
    write('edited.ts', 'one\nTWO\nthree\n');
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: filePath } });
    await hook('Stop', {});

    const results = readEvents('s1').filter((event) => event.type === 'tool_result');
    expect(results[0].changes).toEqual([
      expect.objectContaining({ path: 'edited.ts', additions: 2, deletions: 1 }),
    ]);
    expect(results[1].changes).toEqual([
      expect.objectContaining({ path: 'edited.ts', additions: 0, deletions: 1 }),
    ]);
    // Enough to render the change later, not just count it.
    expect(results[0].changes[0].patch).toContain('+four');
    expect(results[1].changes[0].patch).toContain('-four');
  });

  it('reports changes for the call that wrote, and none for the read', async () => {
    const filePath = path.join(repo, 'feature.ts');
    await hook('SessionStart', {});

    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: filePath } });
    await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: filePath } });

    await hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: filePath } });
    write('feature.ts', 'export const x = 1;\n');
    await hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: filePath } });
    await hook('Stop', {});

    const results = readEvents('s1').filter((event) => event.type === 'tool_result');
    expect(results[0].changes).toBeUndefined();
    expect(results[1].changes).toEqual([
      expect.objectContaining({ path: 'feature.ts', additions: 1, deletions: 0 }),
    ]);
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
