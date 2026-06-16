/**
 * Repo Identity
 *
 * Manages stable repo identification via UUID stored in .git/assert-repo-id.
 * This ID survives repo moves since it lives inside .git/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findGitRoot } from './git-watcher';

const REPO_ID_FILE = 'assert-repo-id';

/**
 * Generate a new repo UUID
 */
export function generateRepoId(): string {
  return crypto.randomUUID();
}

/**
 * Get the path to the repo ID file
 */
export function getRepoIdPath(gitRoot: string): string {
  return path.join(gitRoot, '.git', REPO_ID_FILE);
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
