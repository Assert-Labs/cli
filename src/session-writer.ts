/**
 * Session Writer
 *
 * Handles appending events to JSONL session files.
 * Designed for crash recovery - each event is flushed immediately.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type SessionEvent,
  type SessionStartEvent,
  type SessionEndEvent,
  type SessionMetadata,
  serializeSessionEvent,
  parseSessionEvent,
  getSessionFilePath,
} from './schema';

const SESSIONS_DIR = '.sessions';

export interface SessionWriter {
  sessionId: string;
  filePath: string;
  writeEvent(event: SessionEvent): void;
  close(): void;
}

/**
 * Ensure the .sessions directory exists
 */
export function ensureSessionsDir(cwd: string = process.cwd()): string {
  const dir = path.join(cwd, SESSIONS_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface SessionWriterOptions {
  /** If true, write directly to dir without adding .sessions/ subdirectory */
  direct?: boolean;
}

/**
 * Create a new session writer
 */
export function createSessionWriter(
  sessionId: string,
  cwd: string = process.cwd(),
  options: SessionWriterOptions = {}
): SessionWriter {
  let filePath: string;

  if (options.direct) {
    // Write directly to the specified directory
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd, { recursive: true });
    }
    filePath = path.join(cwd, `${sessionId}.jsonl`);
  } else {
    // Write to .sessions/ subdirectory (for repo-local storage)
    ensureSessionsDir(cwd);
    filePath = path.join(cwd, getSessionFilePath(sessionId));
  }

  // Open file in append mode
  const fd = fs.openSync(filePath, 'a');

  return {
    sessionId,
    filePath,
    writeEvent(event: SessionEvent): void {
      const line = serializeSessionEvent(event) + '\n';
      fs.writeSync(fd, line);
      // Ensure data is flushed to disk
      fs.fsyncSync(fd);
    },
    close(): void {
      fs.closeSync(fd);
    },
  };
}

export interface SessionReadOptions {
  /** If true, read directly from dir without .sessions/ subdirectory */
  direct?: boolean;
}

/**
 * Read all events from a session file
 */
export function readSessionEvents(
  sessionId: string,
  cwd: string = process.cwd(),
  options: SessionReadOptions = {}
): SessionEvent[] {
  // Resolve the file(s) holding this session's events. `direct` is the central
  // flat store; otherwise prefer a legacy flat `<id>.jsonl`, else the dir layout.
  let files: string[];
  if (options.direct) {
    const flat = path.join(cwd, `${sessionId}.jsonl`);
    files = fs.existsSync(flat) ? [flat] : [];
  } else {
    const base = path.join(cwd, SESSIONS_DIR);
    const flat = path.join(base, `${sessionId}.jsonl`);
    if (fs.existsSync(flat)) {
      files = [flat];
    } else {
      const match = listSessionDirs(base).find((s) => s.sessionId === sessionId);
      files = match ? sessionEventFiles(match.dir) : [];
    }
  }

  const events: SessionEvent[] = [];
  for (const filePath of files) {
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (line.trim()) events.push(parseSessionEvent(line));
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Session dir name: sortable ISO timestamp + short session id (no rename ever). */
export function sessionDirName(sessionId: string, createdAt: string): string {
  const stamp = createdAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${sessionId.slice(0, 8)}`;
}

/** Session directories under a `.sessions`-style base, keyed by their meta.json sessionId. */
export function listSessionDirs(baseDir: string): { sessionId: string; dir: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { sessionId: string; dir: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(baseDir, e.name, 'meta.json'), 'utf-8'));
      if (meta.sessionId) out.push({ sessionId: meta.sessionId, dir: path.join(baseDir, e.name) });
    } catch {
      /* not a session dir */
    }
  }
  return out;
}

/** The `.jsonl` files in a session dir, in turn order. */
export function sessionEventFiles(sessionDir: string): string[] {
  try {
    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(sessionDir, f));
    const firstTimestamp = (file: string) => {
      try {
        for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          return (JSON.parse(line) as { timestamp?: string }).timestamp ?? '';
        }
      } catch {
        /* malformed files sort by name */
      }
      return '';
    };
    return files.sort((a, b) => {
      const byTimestamp = firstTimestamp(a).localeCompare(firstTimestamp(b));
      return byTimestamp || a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

/**
 * List all session ids in the .sessions directory — both the legacy flat
 * `<id>.jsonl` files and the new `<dir>/` layout (via meta.json).
 */
export function listSessionFiles(cwd: string = process.cwd()): string[] {
  const dir = path.join(cwd, SESSIONS_DIR);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const flat = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => file.replace('.jsonl', ''));
  const dirs = listSessionDirs(dir).map((s) => s.sessionId);
  return [...new Set([...flat, ...dirs])];
}

/**
 * Extract metadata from session events
 */
export function extractSessionMetadata(
  events: SessionEvent[]
): SessionMetadata | null {
  const startEvent = events.find(
    (e): e is SessionStartEvent => e.type === 'session_start'
  );

  if (!startEvent) {
    return null;
  }

  let endEvent: SessionEndEvent | undefined;

  const branches = new Set<string>();
  const filesModified = new Set<string>();
  let turnCount = 0;
  let toolCallCount = 0;

  for (const event of events) {
    switch (event.type) {
      case 'session_start':
        if (event.gitBranch) branches.add(event.gitBranch);
        endEvent = undefined;
        break;
      case 'session_resume':
        endEvent = undefined;
        break;
      case 'session_end':
        endEvent = event;
        break;
      case 'branch_switch':
        branches.add(event.toBranch);
        break;
      case 'human_turn':
        turnCount++;
        break;
      case 'tool_call':
        toolCallCount++;
        break;
      case 'tool_result':
        if (event.filesModified) {
          event.filesModified.forEach((f) => filesModified.add(f));
        }
        break;
      case 'file_attribution':
        filesModified.add(event.filePath);
        break;
    }
  }

  return {
    id: startEvent.sessionId,
    source: startEvent.source,
    startTime: startEvent.timestamp,
    endTime: endEvent?.timestamp,
    branches: Array.from(branches),
    filesModified: Array.from(filesModified),
    turnCount,
    toolCallCount,
  };
}

/** Check whether the latest lifecycle event leaves the session active. */
export function isSessionActive(events: SessionEvent[]): boolean {
  let active = false;
  for (const event of events) {
    if (event.type === 'session_start' || event.type === 'session_resume') {
      active = true;
    } else if (event.type === 'session_end') {
      active = false;
    }
  }
  return active;
}

/**
 * Find all active sessions
 */
export function findActiveSessions(cwd: string = process.cwd()): string[] {
  const sessionIds = listSessionFiles(cwd);
  return sessionIds.filter((id) => {
    const events = readSessionEvents(id, cwd);
    return isSessionActive(events);
  });
}
