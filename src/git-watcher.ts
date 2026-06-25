/**
 * Git Watcher
 *
 * Event-driven git branch tracking using fs.watch on .git/HEAD.
 * No polling required - reacts immediately to branch switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface GitState {
  branch: string | null;
  ref: string;
  isDetached: boolean;
}

export interface GitWatcher {
  getCurrentState(): GitState;
  onBranchChange(callback: (from: GitState, to: GitState) => void): void;
  stop(): void;
}

/**
 * Find the git root directory
 */
export function findGitRoot(cwd: string = process.cwd()): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get current git state
 */
export function getGitState(gitRoot: string): GitState {
  const headPath = path.join(gitRoot, '.git', 'HEAD');

  if (!fs.existsSync(headPath)) {
    throw new Error(`Not a git repository: ${gitRoot}`);
  }

  const headContent = fs.readFileSync(headPath, 'utf-8').trim();

  // Check if HEAD points to a branch (ref: refs/heads/...)
  const refMatch = headContent.match(/^ref: refs\/heads\/(.+)$/);

  if (refMatch) {
    // HEAD points to a branch
    const branch = refMatch[1];
    const ref = getHeadRef(gitRoot);
    return { branch, ref, isDetached: false };
  }

  // Detached HEAD - HEAD contains a commit SHA directly
  return { branch: null, ref: headContent, isDetached: true };
}

function git(gitRoot: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

/** Repo-relative files changed since `sinceRef` (committed + uncommitted). */
export function getChangedFiles(gitRoot: string, sinceRef?: string): string[] {
  const files = new Set<string>();
  for (const line of git(gitRoot, 'status --porcelain --untracked-files=all').split('\n')) {
    if (!line) continue;
    let p = line.slice(3);
    const rename = p.indexOf(' -> ');
    if (rename !== -1) p = p.slice(rename + 4);
    files.add(p.replace(/^"|"$/g, ''));
  }
  if (sinceRef && sinceRef !== 'unknown') {
    for (const p of git(gitRoot, `diff --name-only ${sinceRef} HEAD`).split('\n')) {
      if (p) files.add(p);
    }
  }
  files.delete('');
  return [...files].filter((f) => !f.startsWith('.sessions/'));
}

/** Content of a repo-relative file at `ref`, or null if it didn't exist there. */
export function fileAtRef(gitRoot: string, ref: string | undefined, relPath: string): string | null {
  if (!ref || ref === 'unknown') return null;
  try {
    return execSync(`git show "${ref}:${relPath}"`, {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Get the actual commit SHA that HEAD points to
 */
function getHeadRef(gitRoot: string): string {
  try {
    const result = execSync('git rev-parse HEAD', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Create a git watcher that monitors for branch changes
 */
export function createGitWatcher(gitRoot: string): GitWatcher {
  const headPath = path.join(gitRoot, '.git', 'HEAD');
  const callbacks: Array<(from: GitState, to: GitState) => void> = [];
  let currentState = getGitState(gitRoot);
  let watcher: fs.FSWatcher | null = null;

  // Start watching the HEAD file
  watcher = fs.watch(headPath, { persistent: false }, () => {
    const newState = getGitState(gitRoot);

    // Check if there was an actual change
    if (
      newState.branch !== currentState.branch ||
      newState.ref !== currentState.ref
    ) {
      const oldState = currentState;
      currentState = newState;

      // Notify all callbacks
      callbacks.forEach((cb) => cb(oldState, newState));
    }
  });

  return {
    getCurrentState(): GitState {
      return currentState;
    },

    onBranchChange(callback: (from: GitState, to: GitState) => void): void {
      callbacks.push(callback);
    },

    stop(): void {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

/**
 * Watch for branch changes and return a cleanup function
 */
export function watchGitBranch(
  cwd: string,
  onBranchChange: (from: GitState, to: GitState) => void
): (() => void) | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return null;
  }

  const watcher = createGitWatcher(gitRoot);
  watcher.onBranchChange(onBranchChange);

  return () => watcher.stop();
}
