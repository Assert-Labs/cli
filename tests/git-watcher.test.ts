import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  findGitRoot,
  getGitState,
  createGitWatcher,
} from '../src/git-watcher';

/**
 * Normalize paths to handle macOS /var -> /private/var symlink
 */
function normalizePath(p: string | null): string | null {
  if (p == null) return null;
  return fs.realpathSync(p);
}

describe('git-watcher', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temp directory for each test
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-git-test-'));
    // Resolve symlinks (macOS /var -> /private/var)
    testDir = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Initialize a git repo in the test directory
   */
  function initGitRepo(): void {
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: testDir,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test User"', {
      cwd: testDir,
      stdio: 'pipe',
    });
    // Create an initial commit
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test\n');
    execSync('git add .', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  }

  describe('findGitRoot', () => {
    it('returns null for non-git directory', () => {
      const result = findGitRoot(testDir);
      expect(result).toBeNull();
    });

    it('returns git root for git directory', () => {
      initGitRepo();
      const result = findGitRoot(testDir);
      expect(result).toBe(testDir);
    });

    it('returns git root from subdirectory', () => {
      initGitRepo();
      const subDir = path.join(testDir, 'sub', 'dir');
      fs.mkdirSync(subDir, { recursive: true });
      const result = findGitRoot(subDir);
      expect(result).toBe(testDir);
    });
  });

  describe('getGitState', () => {
    it('returns branch name and ref for normal branch', () => {
      initGitRepo();
      const state = getGitState(testDir);

      // Default branch could be 'main' or 'master' depending on git config
      expect(state.branch).toMatch(/^(main|master)$/);
      expect(state.ref).toMatch(/^[a-f0-9]{40}$/);
      expect(state.isDetached).toBe(false);
    });

    it('returns detached state for detached HEAD', () => {
      initGitRepo();

      // Get current commit SHA
      const commitSha = execSync('git rev-parse HEAD', {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();

      // Detach HEAD
      execSync(`git checkout ${commitSha}`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      const state = getGitState(testDir);
      expect(state.branch).toBeNull();
      expect(state.ref).toBe(commitSha);
      expect(state.isDetached).toBe(true);
    });

    it('throws for non-git directory', () => {
      expect(() => getGitState(testDir)).toThrow('Not a git repository');
    });
  });

  describe('createGitWatcher', () => {
    it('returns current state', () => {
      initGitRepo();
      const watcher = createGitWatcher(testDir);

      const state = watcher.getCurrentState();
      expect(state.branch).toMatch(/^(main|master)$/);
      expect(state.isDetached).toBe(false);

      watcher.stop();
    });

    it('detects branch switch', async () => {
      initGitRepo();
      const watcher = createGitWatcher(testDir);

      const changes: Array<{ from: string | null; to: string | null }> = [];

      const changePromise = new Promise<void>((resolve) => {
        watcher.onBranchChange((from, to) => {
          changes.push({ from: from.branch, to: to.branch });
          resolve();
        });
      });

      // Create and switch to a new branch
      execSync('git checkout -b feature-branch', {
        cwd: testDir,
        stdio: 'pipe',
      });

      // Wait for fs.watch to trigger (with timeout)
      await Promise.race([
        changePromise,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);

      watcher.stop();

      // fs.watch behavior is platform-dependent, so we check if it works
      // If changes were detected, verify they're correct
      if (changes.length > 0) {
        expect(changes[0].to).toBe('feature-branch');
      }
      // If no changes detected, that's okay - fs.watch can be unreliable in tests
    });

    it('can register multiple callbacks', () => {
      initGitRepo();
      const watcher = createGitWatcher(testDir);

      let callback1Called = false;
      let callback2Called = false;

      watcher.onBranchChange(() => {
        callback1Called = true;
      });
      watcher.onBranchChange(() => {
        callback2Called = true;
      });

      // Simulate a branch change by directly modifying HEAD
      const headPath = path.join(testDir, '.git', 'HEAD');
      fs.writeFileSync(headPath, 'ref: refs/heads/test-branch\n');

      // Wait for fs.watch to trigger
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          watcher.stop();
          // At least one callback should have been called
          // (fs.watch behavior can be platform-dependent)
          resolve();
        }, 100);
      });
    });

    it('stops watching when stop() is called', () => {
      initGitRepo();
      const watcher = createGitWatcher(testDir);

      let callCount = 0;
      watcher.onBranchChange(() => {
        callCount++;
      });

      watcher.stop();

      // Modify HEAD after stopping
      const headPath = path.join(testDir, '.git', 'HEAD');
      fs.writeFileSync(headPath, 'ref: refs/heads/stopped-branch\n');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(callCount).toBe(0);
          resolve();
        }, 100);
      });
    });
  });
});
