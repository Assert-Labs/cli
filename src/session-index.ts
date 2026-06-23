/**
 * Session Index
 *
 * Central index at ~/.assert/sessions/index.json mapping:
 * - Repo IDs → Session IDs
 * - File paths → Session IDs (for quick lookup during commits)
 *
 * This enables the pre-commit hook to quickly find relevant sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionIndexEntry {
  sessionId: string;
  repoId: string;
  gitRoot: string;
  startTime: string;
  endTime?: string;
  filesModified: string[]; // Relative paths within the repo
  isActive: boolean;
}

export interface SessionIndex {
  version: number;
  sessions: Record<string, SessionIndexEntry>; // sessionId → entry
  repoSessions: Record<string, string[]>; // repoId → sessionIds
  fileSessions: Record<string, Record<string, string[]>>; // repoId → { relativePath → sessionIds }
}

const INDEX_VERSION = 1;

/**
 * Get the path to the central sessions directory
 */
export function getSessionsDir(): string {
  const home = os.homedir();
  return path.join(home, '.assert', 'sessions');
}

/**
 * Get the path to the index file
 */
export function getIndexPath(): string {
  return path.join(getSessionsDir(), 'index.json');
}

/**
 * Ensure the sessions directory exists
 */
export function ensureSessionsDir(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load the session index
 */
export function loadIndex(): SessionIndex {
  const indexPath = getIndexPath();

  if (!fs.existsSync(indexPath)) {
    return createEmptyIndex();
  }

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const index = JSON.parse(content) as SessionIndex;

    // Version migration if needed
    if (index.version !== INDEX_VERSION) {
      return migrateIndex(index);
    }

    return index;
  } catch {
    // Corrupted index, start fresh
    return createEmptyIndex();
  }
}

/**
 * Save the session index
 */
export function saveIndex(index: SessionIndex): void {
  ensureSessionsDir();
  const indexPath = getIndexPath();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

/**
 * Create an empty index
 */
export function createEmptyIndex(): SessionIndex {
  return {
    version: INDEX_VERSION,
    sessions: {},
    repoSessions: {},
    fileSessions: {},
  };
}

/**
 * Migrate an old index format to the current version
 */
function migrateIndex(oldIndex: SessionIndex): SessionIndex {
  // For now, just create a fresh index
  // In the future, we'd migrate data here
  return createEmptyIndex();
}

/**
 * Add or update a session in the index
 */
export function indexSession(
  index: SessionIndex,
  sessionId: string,
  repoId: string,
  gitRoot: string,
  startTime: string,
  isActive: boolean = true
): SessionIndex {
  // Add to sessions. Don't clobber an existing entry — a session can span
  // multiple repos and is indexed once per repo; keep the first entry's
  // metadata (startTime, filesModified) intact across those calls.
  if (!index.sessions[sessionId]) {
    index.sessions[sessionId] = {
      sessionId,
      repoId,
      gitRoot,
      startTime,
      filesModified: [],
      isActive,
    };
  }

  // Add to repoSessions
  if (!index.repoSessions[repoId]) {
    index.repoSessions[repoId] = [];
  }
  if (!index.repoSessions[repoId].includes(sessionId)) {
    index.repoSessions[repoId].push(sessionId);
  }

  return index;
}

/**
 * Record a file modification in the index
 */
export function indexFileModification(
  index: SessionIndex,
  sessionId: string,
  repoId: string,
  relativePath: string
): SessionIndex {
  const session = index.sessions[sessionId];
  if (session) {
    if (!session.filesModified.includes(relativePath)) {
      session.filesModified.push(relativePath);
    }
  }

  // Add to fileSessions
  if (!index.fileSessions[repoId]) {
    index.fileSessions[repoId] = {};
  }
  if (!index.fileSessions[repoId][relativePath]) {
    index.fileSessions[repoId][relativePath] = [];
  }
  if (!index.fileSessions[repoId][relativePath].includes(sessionId)) {
    index.fileSessions[repoId][relativePath].push(sessionId);
  }

  return index;
}

/**
 * Mark a session as ended
 */
export function endSession(index: SessionIndex, sessionId: string, endTime: string): SessionIndex {
  const session = index.sessions[sessionId];
  if (session) {
    session.endTime = endTime;
    session.isActive = false;
  }
  return index;
}

/**
 * Find sessions that modified a specific file
 */
export function findSessionsForFile(index: SessionIndex, repoId: string, relativePath: string): string[] {
  return index.fileSessions[repoId]?.[relativePath] || [];
}

/**
 * Find sessions for a repo
 */
export function findSessionsForRepo(index: SessionIndex, repoId: string): string[] {
  return index.repoSessions[repoId] || [];
}

/**
 * Find sessions that touched any of the given files
 */
export function findSessionsForFiles(
  index: SessionIndex,
  repoId: string,
  relativePaths: string[]
): string[] {
  const sessionIds = new Set<string>();

  for (const filePath of relativePaths) {
    const sessions = findSessionsForFile(index, repoId, filePath);
    for (const sessionId of sessions) {
      sessionIds.add(sessionId);
    }
  }

  return Array.from(sessionIds);
}

/**
 * Get active sessions for a repo
 */
export function getActiveSessions(index: SessionIndex, repoId: string): SessionIndexEntry[] {
  const sessionIds = index.repoSessions[repoId] || [];
  return sessionIds
    .map((id) => index.sessions[id])
    .filter((s) => s && s.isActive);
}

/**
 * Clean up old sessions (older than given days)
 */
export function cleanupOldSessions(index: SessionIndex, maxAgeDays: number = 30): SessionIndex {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const sessionId of Object.keys(index.sessions)) {
    const session = index.sessions[sessionId];
    const sessionTime = new Date(session.startTime).getTime();

    if (sessionTime < cutoff && !session.isActive) {
      // Remove from sessions
      delete index.sessions[sessionId];

      // Remove from repoSessions
      const repoSessions = index.repoSessions[session.repoId];
      if (repoSessions) {
        const idx = repoSessions.indexOf(sessionId);
        if (idx !== -1) {
          repoSessions.splice(idx, 1);
        }
      }

      // Remove from fileSessions
      const fileSessions = index.fileSessions[session.repoId];
      if (fileSessions) {
        for (const filePath of Object.keys(fileSessions)) {
          const sessions = fileSessions[filePath];
          const idx = sessions.indexOf(sessionId);
          if (idx !== -1) {
            sessions.splice(idx, 1);
          }
          if (sessions.length === 0) {
            delete fileSessions[filePath];
          }
        }
      }
    }
  }

  return index;
}
