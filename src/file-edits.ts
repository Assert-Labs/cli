/**
 * Per-call file diffs.
 *
 * A tool call's effect on a file is only visible between the call starting and
 * finishing: per-turn attribution is taken afterwards, so an edit that a later
 * call in the same turn revises leaves no separate trace. The pre-call contents
 * are therefore stashed on PreToolUse and diffed on PostToolUse.
 *
 * Diffing shells out to git, as the rest of the CLI does, rather than carrying
 * a diff implementation of its own.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import type { FileChange } from './schema';

/** Patches beyond this are dropped; the counts are still recorded. */
const MAX_PATCH_BYTES = 64 * 1024;

function pendingDir(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.pending`);
}

/** Stable, collision-free name for a stashed file. */
function stashName(toolCallId: string, filePath: string): string {
  const digest = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return `${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '')}-${digest}`;
}

/**
 * Stash the current contents of each path so the call's effect can be measured
 * once it finishes. A path that does not exist yet is stashed as empty, which
 * is what makes a newly created file read as all additions.
 */
export function stashBeforeEdit(
  sessionsDir: string,
  sessionId: string,
  toolCallId: string,
  filePaths: string[],
): void {
  if (filePaths.length === 0) return;
  const dir = pendingDir(sessionsDir, sessionId);
  for (const filePath of filePaths) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      /* new file: nothing there yet */
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, stashName(toolCallId, filePath)), content);
    } catch {
      /* capture must never break the agent */
    }
  }
}

/** Added and removed line counts from `git diff --numstat` output. */
function parseNumstat(output: string): { additions: number; deletions: number } {
  const [line] = output.split('\n').filter((l) => l.trim());
  const [additions, deletions] = (line ?? '').split('\t');
  return {
    additions: Number.parseInt(additions, 10) || 0,
    deletions: Number.parseInt(deletions, 10) || 0,
  };
}

function gitDiff(before: string, after: string, args: string[]): string {
  try {
    return execFileSync(
      'git',
      ['diff', '--no-index', '--no-color', ...args, before, after],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (error) {
    // git exits 1 when the files differ, which is the normal case here.
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/**
 * Diff each stashed file against its current contents, then discard the stash.
 * `relativize` maps an absolute path to how it should be recorded.
 */
export function collectEditChanges(
  sessionsDir: string,
  sessionId: string,
  toolCallId: string,
  filePaths: string[],
  relativize: (filePath: string) => string | null,
): FileChange[] {
  const dir = pendingDir(sessionsDir, sessionId);
  const changes: FileChange[] = []
  for (const filePath of filePaths) {
    const stash = path.join(dir, stashName(toolCallId, filePath));
    if (!fs.existsSync(stash)) continue;
    const recordedPath = relativize(filePath) ?? filePath;
    try {
      const { additions, deletions } = parseNumstat(
        gitDiff(stash, filePath, ['--numstat']),
      );
      if (additions > 0 || deletions > 0) {
        const patch = gitDiff(stash, filePath, [
          `--src-prefix=a/${recordedPath}/`,
          `--dst-prefix=b/${recordedPath}/`,
        ]);
        changes.push({
          path: recordedPath,
          additions,
          deletions,
          ...(patch.length > 0 && patch.length <= MAX_PATCH_BYTES ? { patch } : {}),
        });
      }
    } catch {
      /* a diff we cannot take is not worth failing capture over */
    }
    try {
      fs.unlinkSync(stash);
    } catch {
      /* already gone */
    }
  }
  return changes;
}

/** Drop any stashes a session left behind, e.g. a call with no result hook. */
export function clearPendingEdits(sessionsDir: string, sessionId: string): void {
  try {
    fs.rmSync(pendingDir(sessionsDir, sessionId), { recursive: true, force: true });
  } catch {
    /* nothing to clean up */
  }
}
