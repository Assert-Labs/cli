/**
 * Session Boundaries
 *
 * Records file state at session start/end for computing human vs agent changes.
 *
 * Flow:
 * 1. Session starts → snapshot files that might be touched
 * 2. Agent makes changes → track which files are modified
 * 3. Session ends → snapshot final state of modified files
 * 4. Next session starts → diff from previous end state = human changes
 */

import * as fs from 'fs';
import * as path from 'path';
import { createFileSnapshot, type FileSnapshot, diffSnapshots } from './line-attribution';
import { getSessionsDir } from './session-index';

export interface SessionBoundary {
  sessionId: string;
  repoId: string;
  type: 'start' | 'end';
  timestamp: string;
  gitRef?: string;
  files: FileSnapshot[];
}

export interface BoundaryStore {
  version: number;
  boundaries: SessionBoundary[];
}

const STORE_VERSION = 1;

/**
 * Get the path to the boundaries store for a repo
 */
export function getBoundariesPath(repoId: string): string {
  return path.join(getSessionsDir(), 'boundaries', `${repoId}.json`);
}

/**
 * Ensure boundaries directory exists
 */
function ensureBoundariesDir(): void {
  const dir = path.join(getSessionsDir(), 'boundaries');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load boundaries for a repo
 */
export function loadBoundaries(repoId: string): BoundaryStore {
  const storePath = getBoundariesPath(repoId);

  if (!fs.existsSync(storePath)) {
    return { version: STORE_VERSION, boundaries: [] };
  }

  try {
    const content = fs.readFileSync(storePath, 'utf-8');
    return JSON.parse(content) as BoundaryStore;
  } catch {
    return { version: STORE_VERSION, boundaries: [] };
  }
}

/**
 * Save boundaries for a repo
 */
export function saveBoundaries(repoId: string, store: BoundaryStore): void {
  ensureBoundariesDir();
  const storePath = getBoundariesPath(repoId);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Record a session boundary (start or end)
 */
export function recordBoundary(
  repoId: string,
  sessionId: string,
  type: 'start' | 'end',
  gitRoot: string,
  filePaths: string[],
  gitRef?: string,
  // When given, snapshot from this content instead of the file on disk — used to
  // record a start boundary from a file's pre-session (baseline) state.
  contentByPath?: Map<string, string>
): SessionBoundary {
  const store = loadBoundaries(repoId);

  const files: FileSnapshot[] = [];
  for (const filePath of filePaths) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(gitRoot, filePath);
    const relativePath = path.relative(gitRoot, absolutePath);
    let content: string | undefined;
    if (contentByPath) {
      content = contentByPath.get(relativePath);
    } else if (fs.existsSync(absolutePath)) {
      content = fs.readFileSync(absolutePath, 'utf-8');
    }
    if (content !== undefined) {
      files.push(createFileSnapshot(relativePath, content));
    }
  }

  const boundary: SessionBoundary = {
    sessionId,
    repoId,
    type,
    timestamp: new Date().toISOString(),
    gitRef,
    files,
  };

  store.boundaries.push(boundary);
  saveBoundaries(repoId, store);

  return boundary;
}

/**
 * Get the most recent end boundary for a repo
 */
export function getLastEndBoundary(repoId: string): SessionBoundary | null {
  const store = loadBoundaries(repoId);

  for (let i = store.boundaries.length - 1; i >= 0; i--) {
    if (store.boundaries[i].type === 'end') {
      return store.boundaries[i];
    }
  }

  return null;
}

/**
 * Get boundary by session ID and type
 */
export function getBoundary(
  repoId: string,
  sessionId: string,
  type: 'start' | 'end'
): SessionBoundary | null {
  const store = loadBoundaries(repoId);

  for (const boundary of store.boundaries) {
    if (boundary.sessionId === sessionId && boundary.type === type) {
      return boundary;
    }
  }

  return null;
}

/**
 * Calculate human changes between last session end and current file state
 */
export function calculateHumanChanges(
  repoId: string,
  gitRoot: string,
  filePaths: string[]
): Map<string, { added: Set<string>; removed: Set<string> }> {
  const lastEnd = getLastEndBoundary(repoId);
  const changes = new Map<string, { added: Set<string>; removed: Set<string> }>();

  for (const filePath of filePaths) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(gitRoot, filePath);
    const relativePath = path.relative(gitRoot, absolutePath);

    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const currentContent = fs.readFileSync(absolutePath, 'utf-8');
    const currentSnapshot = createFileSnapshot(relativePath, currentContent);

    const lastSnapshot = lastEnd?.files.find((f) => f.filePath === relativePath);

    if (!lastSnapshot) {
      const added = new Set(currentSnapshot.lines.map((l) => l.hash));
      changes.set(relativePath, { added, removed: new Set() });
    } else {
      const diffs = diffSnapshots(lastSnapshot, currentSnapshot);
      const added = new Set<string>();
      const removed = new Set<string>();
      for (const diff of diffs) {
        if (diff.type === 'added') added.add(diff.hash);
        else if (diff.type === 'removed') removed.add(diff.hash);
      }
      if (added.size > 0 || removed.size > 0) {
        changes.set(relativePath, { added, removed });
      }
    }
  }

  return changes;
}

/**
 * Calculate agent changes for a session
 */
export function calculateAgentChanges(
  repoId: string,
  sessionId: string
): Map<string, { added: Set<string>; removed: Set<string> }> {
  const startBoundary = getBoundary(repoId, sessionId, 'start');
  const endBoundary = getBoundary(repoId, sessionId, 'end');

  const changes = new Map<string, { added: Set<string>; removed: Set<string> }>();

  if (!startBoundary || !endBoundary) {
    return changes;
  }

  // Build map of start state files
  const startFiles = new Map<string, FileSnapshot>();
  for (const file of startBoundary.files) {
    startFiles.set(file.filePath, file);
  }

  // Compare with end state
  for (const endFile of endBoundary.files) {
    const startFile = startFiles.get(endFile.filePath);

    if (!startFile) {
      // File was created by agent
      const added = new Set(endFile.lines.map((l) => l.hash));
      changes.set(endFile.filePath, { added, removed: new Set() });
    } else {
      // Diff the files
      const diffs = diffSnapshots(startFile, endFile);

      const added = new Set<string>();
      const removed = new Set<string>();

      for (const diff of diffs) {
        if (diff.type === 'added') {
          added.add(diff.hash);
        } else if (diff.type === 'removed') {
          removed.add(diff.hash);
        }
      }

      if (added.size > 0 || removed.size > 0) {
        changes.set(endFile.filePath, { added, removed });
      }
    }
  }

  return changes;
}

/**
 * Clean up old boundaries (keep last N per repo)
 */
export function cleanupBoundaries(repoId: string, keepCount: number = 100): void {
  const store = loadBoundaries(repoId);

  if (store.boundaries.length > keepCount) {
    store.boundaries = store.boundaries.slice(-keepCount);
    saveBoundaries(repoId, store);
  }
}
