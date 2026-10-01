/**
 * Repo Identity
 *
 * Manages stable repo identification via UUID stored in the repo's common git
 * dir as assert-repo-id. This ID survives repo moves since it lives inside the
 * git dir, and is shared by every linked worktree of the same repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { findGitRoot, commonGitDir } from './git-watcher';

const REPO_ID_FILE = 'assert-repo-id';

/**
 * Generate a new repo UUID
 */
export function generateRepoId(): string {
  return crypto.randomUUID();
}

/**
 * Get the path to the repo ID file, in the repo's common git dir so every
 * linked worktree resolves to the same file. Falls back to `<gitRoot>/.git`
 * only if git can't report the common dir.
 */
export function getRepoIdPath(gitRoot: string): string {
  const dir = commonGitDir(gitRoot) ?? path.join(gitRoot, '.git');
  return path.join(dir, REPO_ID_FILE);
}

/**
 * Get or create a repo ID for a git repository
 * Returns null if not a git repository
 */
export function getOrCreateRepoId(cwd: string): { repoId: string; gitRoot: string } | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return null;
  }

  const idPath = getRepoIdPath(gitRoot);

  // Check if ID already exists
  if (fs.existsSync(idPath)) {
    const existingId = fs.readFileSync(idPath, 'utf-8').trim();
    if (existingId) {
      return { repoId: existingId, gitRoot };
    }
  }

  // Create new ID
  const newId = generateRepoId();
  fs.writeFileSync(idPath, newId + '\n', 'utf-8');
  return { repoId: newId, gitRoot };
}

/**
 * Get repo ID without creating one
 * Returns null if no ID exists or not a git repo
 */
export function getRepoId(cwd: string): { repoId: string; gitRoot: string } | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return null;
  }

  const idPath = getRepoIdPath(gitRoot);
  if (!fs.existsSync(idPath)) {
    return null;
  }

  const repoId = fs.readFileSync(idPath, 'utf-8').trim();
  return repoId ? { repoId, gitRoot } : null;
}

/**
 * Remove repo ID (for testing/cleanup)
 */
export function removeRepoId(gitRoot: string): boolean {
  const idPath = getRepoIdPath(gitRoot);
  if (fs.existsSync(idPath)) {
    fs.unlinkSync(idPath);
    return true;
  }
  return false;
}

/**
 * Normalize a git remote URL to `host/owner/repo`: no scheme, credentials,
 * port, or `.git` suffix, so the same repo matches however it was cloned.
 * Returns null for a URL that doesn't look like a hosted remote.
 */
export function normalizeRemote(url: string): string | null {
  let rest = url.trim();
  if (!rest) return null;
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(rest); // git@host:owner/repo.git
  if (scp && !rest.includes('://')) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    rest = rest.replace(/^[a-z+]+:\/\//i, ''); // scheme
    rest = rest.replace(/^[^@/]+@/, ''); // user[:token]@
    rest = rest.replace(/^([^/:]+):\d+\//, '$1/'); // :port
  }
  rest = rest.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(parts[0])) return null;
  return parts.join('/').toLowerCase();
}

/** The repo's `origin` remote as `host/owner/repo`, or null without one. */
export function getRemoteIdentity(gitRoot: string): string | null {
  try {
    const out = execSync('git remote get-url origin', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return normalizeRemote(out);
  } catch {
    return null;
  }
}
