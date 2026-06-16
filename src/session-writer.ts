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
  let filePath: string;

  if (options.direct) {
    filePath = path.join(cwd, `${sessionId}.jsonl`);
  } else {
    filePath = path.join(cwd, getSessionFilePath(sessionId));
  }

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  return lines.map(parseSessionEvent);
}

/**
 * List all session files in the .sessions directory
 */
export function listSessionFiles(cwd: string = process.cwd()): string[] {
  const dir = path.join(cwd, SESSIONS_DIR);

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => file.replace('.jsonl', ''));
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

  const endEvent = events.find(
    (e): e is SessionEndEvent => e.type === 'session_end'
  );

  const branches = new Set<string>();
  const filesModified = new Set<string>();
  let turnCount = 0;
  let toolCallCount = 0;

  for (const event of events) {
    switch (event.type) {
      case 'session_start':
        if (event.gitBranch) branches.add(event.gitBranch);
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

/**
 * Check if a session is still active (no end event)
 */
export function isSessionActive(events: SessionEvent[]): boolean {
  return !events.some((e) => e.type === 'session_end');
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
