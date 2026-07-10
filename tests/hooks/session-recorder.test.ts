import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  startSession,
  recordFileEdit,
  syncSession,
} from '../../src/hooks/session-recorder';
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
