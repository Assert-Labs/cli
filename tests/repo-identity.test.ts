import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  generateRepoId,
  getRepoIdPath,
  getOrCreateRepoId,
  getRepoId,
  removeRepoId,
} from '../src/repo-identity';

describe('repo-identity', () => {
  let testDir: string;
  let gitRoot: string;

  beforeEach(() => {
    // Create a temp directory with a git repo
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-')));
    gitRoot = path.join(testDir, 'repo');
    fs.mkdirSync(gitRoot);
    execSync('git init', { cwd: gitRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    // Clean up
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('generateRepoId', () => {
    it('generates a valid UUID', () => {
      const id = generateRepoId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('generates unique IDs', () => {
      const id1 = generateRepoId();
      const id2 = generateRepoId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('getRepoIdPath', () => {
    it('returns path inside .git directory', () => {
      const idPath = getRepoIdPath(gitRoot);
      expect(idPath).toBe(path.join(gitRoot, '.git', 'assert-repo-id'));
    });
  });

  describe('getOrCreateRepoId', () => {
    it('creates a new repo ID if none exists', () => {
      const result = getOrCreateRepoId(gitRoot);

      expect(result).not.toBeNull();
      expect(result!.repoId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result!.gitRoot).toBe(gitRoot);

      // Verify file was created
      const idPath = getRepoIdPath(gitRoot);
      expect(fs.existsSync(idPath)).toBe(true);
    });

    it('returns existing repo ID if already set', () => {
      const result1 = getOrCreateRepoId(gitRoot);
      const result2 = getOrCreateRepoId(gitRoot);

      expect(result1!.repoId).toBe(result2!.repoId);
    });

    it('works from subdirectory of git repo', () => {
      const subDir = path.join(gitRoot, 'src', 'components');
      fs.mkdirSync(subDir, { recursive: true });

      const result = getOrCreateRepoId(subDir);

      expect(result).not.toBeNull();
      expect(result!.gitRoot).toBe(gitRoot);
    });

    it('returns null for non-git directory', () => {
      const nonGitDir = path.join(testDir, 'not-a-repo');
      fs.mkdirSync(nonGitDir);

      const result = getOrCreateRepoId(nonGitDir);
      expect(result).toBeNull();
    });
  });

  describe('getRepoId', () => {
    it('returns null if no repo ID exists', () => {
      const result = getRepoId(gitRoot);
      expect(result).toBeNull();
    });

    it('returns repo ID if it exists', () => {
      // First create it
      const created = getOrCreateRepoId(gitRoot);

      // Then get it
      const result = getRepoId(gitRoot);

      expect(result).not.toBeNull();
      expect(result!.repoId).toBe(created!.repoId);
    });
  });

  describe('removeRepoId', () => {
    it('removes repo ID file', () => {
      getOrCreateRepoId(gitRoot);
      const idPath = getRepoIdPath(gitRoot);

      expect(fs.existsSync(idPath)).toBe(true);

      const removed = removeRepoId(gitRoot);
      expect(removed).toBe(true);
      expect(fs.existsSync(idPath)).toBe(false);
    });

    it('returns false if no repo ID exists', () => {
      const removed = removeRepoId(gitRoot);
      expect(removed).toBe(false);
    });
  });

  describe('git worktrees', () => {
    // git worktree add needs a commit to point at.
    function commitAndAddWorktree(branch: string, wt: string): void {
      execSync('git config user.email "test@test.com"', { cwd: gitRoot, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitRoot, stdio: 'pipe' });
      fs.writeFileSync(path.join(gitRoot, 'seed.txt'), 'seed\n');
      execSync('git add -A', { cwd: gitRoot, stdio: 'pipe' });
      execSync('git commit -m seed', { cwd: gitRoot, stdio: 'pipe' });
      execSync(`git worktree add -b ${branch} "${wt}"`, { cwd: gitRoot, stdio: 'pipe' });
    }

    it('creates the repo id from a worktree (regression: .git is a file there)', () => {
      const wt = path.join(testDir, 'wt');
      commitAndAddWorktree('feature', wt);

      // In a linked worktree, <wt>/.git is a FILE (`gitdir: …`), not a directory.
      expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);

      // Pre-fix this threw ENOTDIR (writing into the .git file as a dir).
      const wtId = getOrCreateRepoId(wt);
      expect(wtId).not.toBeNull();
      expect(wtId!.repoId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('shares one repo id across the main checkout and its worktrees', () => {
      const wt = path.join(testDir, 'wt');
      commitAndAddWorktree('feature', wt);

      const wtId = getOrCreateRepoId(wt);
      const mainId = getRepoId(gitRoot);

      expect(mainId).not.toBeNull();
      expect(mainId!.repoId).toBe(wtId!.repoId);
      // The id lives in the shared (main) git dir, not the worktree's gitdir.
      expect(fs.existsSync(path.join(gitRoot, '.git', 'assert-repo-id'))).toBe(true);
    });
  });

  describe('repo moves', () => {
    it('preserves repo ID when repo is moved', () => {
      // Create repo ID
      const originalId = getOrCreateRepoId(gitRoot);

      // Move the repo
      const newLocation = path.join(testDir, 'moved-repo');
      fs.renameSync(gitRoot, newLocation);

      // Get repo ID from new location
      const movedId = getRepoId(newLocation);

      expect(movedId).not.toBeNull();
      expect(movedId!.repoId).toBe(originalId!.repoId);
    });
  });
});
