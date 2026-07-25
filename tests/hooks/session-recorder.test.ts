import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  startSession,
  recordFileEdit,
  syncSession,
  loadState,
  cleanupStaleSessions,
} from '../../src/hooks/session-recorder';
import { loadIndex } from '../../src/session-index';
import { getOrCreateRepoId } from '../../src/repo-identity';
import { repoHasSession, readRepoEvents } from './session-layout';

/**
 * End-to-end capture into a git worktree.
 *
 * A lot of developers run parallel coding-agent sessions in separate `git
 * worktree` checkouts. A worktree's `.git` is a file (`gitdir: …`), not a
 * directory, which used to crash repo-id creation and break git-state reads —
 * so nothing landed in the worktree's `.sessions/`. This proves the full path:
 * start → record edit → sync writes `<worktree>/.sessions/<id>.jsonl`.
 */
describe('session-recorder — git worktree capture', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let mainRepo: string;
  let worktree: string | null;

  function run(cmd: string, cwd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
  }

  beforeEach(() => {
    testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-wt-home-')));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    worktree = null;

    mainRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-wt-repo-')));
    run('git init', mainRepo);
    run('git config user.email "test@test.com"', mainRepo);
    run('git config user.name "Test"', mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# main\n');
    run('git add -A', mainRepo);
    run('git commit -m init', mainRepo);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const dir of [worktree, mainRepo, testHome]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("writes the session into the worktree's .sessions/, not the main checkout", () => {
    worktree = `${mainRepo}-wt`;
    run(`git worktree add -b feature "${worktree}"`, mainRepo);
    const wt = fs.realpathSync(worktree);

    // The agent edits a file inside the worktree.
    const file = path.join(wt, 'feature.ts');
    fs.writeFileSync(file, 'export const x = 1;\n');

    const sessionId = 'wt-capture-test';
    const state = startSession(sessionId, 'claude-code', wt);
    expect(recordFileEdit(state, file)).toBe('feature.ts');
    syncSession(state, undefined, true);

    // Captured in the worktree...
    expect(repoHasSession(wt, sessionId)).toBe(true);
    expect(readRepoEvents(wt, sessionId).length).toBeGreaterThan(0);

    // ...and not misrouted to the main checkout.
    expect(repoHasSession(mainRepo, sessionId)).toBe(false);
  });
});

/**
 * `assert cleanup`: Codex and OpenCode have no reliable session-end hook, so
 * their sessions stay [ACTIVE] after the agent exits. cleanupStaleSessions
 * sweeps sessions whose state file has gone stale and marks them ended — without
 * re-running attribution — while leaving fresh sessions alone.
 */
describe('session-recorder — cleanup of stale sessions', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let repo: string;

  const statePath = (id: string, source: string) =>
    path.join(testHome, '.assert', 'sessions', `${id}.${source}-state.json`);

  beforeEach(() => {
    testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-cleanup-home-')));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-cleanup-repo-')));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'base.ts'), 'const base = 1;\n');
    execSync('git add -A && git commit -m init', { cwd: repo, stdio: 'pipe' });
    getOrCreateRepoId(repo);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const dir of [repo, testHome]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  const startCaptured = (id: string, file: string) => {
    fs.writeFileSync(path.join(repo, file), `export const ${id.replace(/\W/g, '')} = 1;\n`);
    const state = startSession(id, 'opencode', repo);
    recordFileEdit(state, path.join(repo, file));
    syncSession(state, undefined, true);
  };

  it('ends a stale session, leaves a fresh one active', () => {
    startCaptured('stale-1', 'stale.ts');
    startCaptured('fresh-1', 'fresh.ts');

    // Backdate the stale session's state file to 48h ago; keep fresh untouched.
    const old = Date.now() / 1000 - 48 * 60 * 60;
    fs.utimesSync(statePath('stale-1', 'opencode'), old, old);

    const ended = cleanupStaleSessions(24 * 60 * 60 * 1000);
    expect(ended).toEqual(['stale-1']);

    // Stale is ended (loadState hides ended sessions); fresh is still active.
    expect(loadState('stale-1', 'opencode')).toBeNull();
    expect(loadState('fresh-1', 'opencode')).not.toBeNull();

    // Index flips isActive for the swept session only.
    const index = loadIndex();
    expect(index.sessions['stale-1'].isActive).toBe(false);
    expect(index.sessions['stale-1'].endTime).toBeDefined();
    expect(index.sessions['fresh-1'].isActive).toBe(true);

    // The session_end lands in the repo copy so the repo view shows [ended].
    const endEvents = readRepoEvents(repo, 'stale-1').filter((e) => e.type === 'session_end');
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].reason).toBe('aborted');
  });

  it('is idempotent and reports nothing when no session is stale', () => {
    startCaptured('fresh-2', 'f2.ts');
    expect(cleanupStaleSessions(24 * 60 * 60 * 1000)).toEqual([]);
    expect(loadState('fresh-2', 'opencode')).not.toBeNull();
  });
});
