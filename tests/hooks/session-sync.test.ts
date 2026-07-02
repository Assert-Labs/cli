/**
 * Git-driven session sync: materialization timing, capturing all changes
 * (not just edited files), .assertignore, the toggle, and attribution baseline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  startSession,
  recordFileEdit,
  syncSession,
  endSession,
  blameFile,
  writeEvent,
} from '../../src/hooks/session-recorder';
import { processHook } from '../../src/hooks/claude-code';
import { loadState, setCaptureDisabled, setCapturePrivate } from '../../src/hooks/session-recorder';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { loadIndex, findSessionsForFiles } from '../../src/session-index';
import { hashLine } from '../../src/line-attribution';

describe('git-driven session sync', () => {
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
  const repoSession = (id: string) => path.join(repo, '.sessions', `${id}.jsonl`);

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-sync-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-sync-repo-')));
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
    delete process.env.ASSERT_PRIVATE;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('materializes only once a change exists', () => {
    const state = startSession('s1', 'claude-code', repo);

    syncSession(state);
    expect(fs.existsSync(repoSession('s1'))).toBe(false);

    write('edited.ts', 'x\n');
    syncSession(state);
    expect(fs.existsSync(repoSession('s1'))).toBe(true);
  });

  it('captures changes not made through edit tools', () => {
    const state = startSession('s2', 'claude-code', repo);

    // A direct edit...
    recordFileEdit(state, write('edited.ts', 'a\n'));
    // ...and a file changed some other way (formatter / bash / codegen).
    write('generated.ts', 'b\n');
    endSession(state, 'completed');

    const index = loadIndex();
    expect(findSessionsForFiles(index, repoId, ['edited.ts'])).toContain('s2');
    expect(findSessionsForFiles(index, repoId, ['generated.ts'])).toContain('s2');
  });

  it('respects .assertignore', () => {
    write('.assertignore', 'ignored/\n*.log\n');
    git('add .assertignore');
    git('commit -m ignore');

    const state = startSession('s3', 'claude-code', repo);

    write('ignored/x.ts', '1\n');
    write('debug.log', 'noise\n');
    syncSession(state);
    expect(fs.existsSync(repoSession('s3'))).toBe(false);

    write('real.ts', '1\n');
    syncSession(state);
    expect(fs.existsSync(repoSession('s3'))).toBe(true);

    const index = loadIndex();
    expect(findSessionsForFiles(index, repoId, ['ignored/x.ts'])).not.toContain('s3');
    expect(findSessionsForFiles(index, repoId, ['real.ts'])).toContain('s3');
  });

  it('does not record state when ASSERT_DISABLE is set', async () => {
    process.env.ASSERT_DISABLE = '1';
    await processHook('SessionStart', JSON.stringify({ session_id: 's4', cwd: repo }));
    expect(loadState('s4', 'claude-code')).toBeNull();
  });

  it('`assert disable` pauses capture until re-enabled', async () => {
    setCaptureDisabled(true);
    await processHook('SessionStart', JSON.stringify({ session_id: 's6', cwd: repo }));
    expect(loadState('s6', 'claude-code')).toBeNull();

    setCaptureDisabled(false);
    await processHook('SessionStart', JSON.stringify({ session_id: 's6', cwd: repo }));
    expect(loadState('s6', 'claude-code')).not.toBeNull();
  });

  it('private mode does not publish into the repo but blame still works locally', () => {
    setCapturePrivate(true);
    const state = startSession('p1', 'claude-code', repo);
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const priv = 1;\n');
    endSession(state, 'completed');
    setCapturePrivate(false);

    // Nothing published into the repo's .sessions/ ...
    expect(fs.existsSync(repoSession('p1'))).toBe(false);

    // ... but the assembled per-repo file is mirrored locally, so blame works.
    const content = fs.readFileSync(path.join(repo, 'base.ts'), 'utf-8');
    const attr = blameFile(repo, 'base.ts', content)!;
    expect(attr[0].source).toBe('unknown'); // pre-existing 'const base = 1;'
    expect(attr[1]).toMatchObject({ source: 'agent', sessionId: 'p1', agent: 'claude-code' });
  });

  it('writes portable attribution events into the session on end', () => {
    const state = startSession('s7', 'claude-code', repo);
    write('feature.ts', 'export const x = 1;\n');
    endSession(state, 'completed');

    const events = fs
      .readFileSync(repoSession('s7'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const attr = events.find((e) => e.type === 'attribution');
    expect(attr).toBeDefined();
    expect(attr.filePath).toBe('feature.ts');
    expect(attr.contributor.type).toBe('ai');
    expect(attr.lineHashes).toContain(hashLine('export const x = 1;'));
  });

  it('attributes only agent-added lines, not pre-existing ones', () => {
    const state = startSession('s5', 'claude-code', repo);
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const added = 2;\n');
    endSession(state, 'completed');

    const content = fs.readFileSync(path.join(repo, 'base.ts'), 'utf-8');
    const attr = blameFile(repo, 'base.ts', content)!;
    expect(attr[0].source).toBe('unknown'); // pre-existing 'const base = 1;'
    expect(attr[1]).toMatchObject({ source: 'agent', sessionId: 's5', agent: 'claude-code' });
  });

  it('records the agent and model id on attributed lines for blame', () => {
    const state = startSession('s6', 'claude-code', repo);
    writeEvent('s6', {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: 's6',
      turnId: 't1',
      model: 'anthropic/claude-opus-4-8',
    });
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const added = 2;\n');
    endSession(state, 'completed');

    const content = fs.readFileSync(path.join(repo, 'base.ts'), 'utf-8');
    const attr = blameFile(repo, 'base.ts', content)!;
    expect(attr[1]).toMatchObject({
      source: 'agent',
      agent: 'claude-code',
      modelId: 'anthropic/claude-opus-4-8',
    });
  });

  it('threads attribution across sessions and human edits for blame', () => {
    // Attribution baseline is the file at the session's start ref, so work is
    // threaded once committed (the normal flow: each contributor commits).
    const s1 = startSession('b1', 'claude-code', repo);
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const one = 1;\n');
    endSession(s1, 'completed');
    git('add -A');
    git('commit -m s1');

    // A human edits between sessions and commits.
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const human = 0;\n');
    git('add -A');
    git('commit -m human');

    const s2 = startSession('b2', 'claude-code', repo);
    fs.appendFileSync(path.join(repo, 'base.ts'), 'const two = 2;\n');
    endSession(s2, 'completed');

    const content = fs.readFileSync(path.join(repo, 'base.ts'), 'utf-8');
    const bySource = new Map(
      blameFile(repo, 'base.ts', content)!.map((a, i) => [content.split('\n')[i], a]),
    );
    expect(bySource.get('const base = 1;')!.source).toBe('unknown');
    expect(bySource.get('const one = 1;')).toMatchObject({ source: 'agent', sessionId: 'b1' });
    expect(bySource.get('const human = 0;')!.source).toBe('human');
    expect(bySource.get('const two = 2;')).toMatchObject({ source: 'agent', sessionId: 'b2' });
  });
});
