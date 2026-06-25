import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createSessionWriter,
  readSessionEvents,
  listSessionFiles,
  extractSessionMetadata,
  isSessionActive,
  findActiveSessions,
  ensureSessionsDir,
} from '../src/session-writer';
import type {
  SessionStartEvent,
  SessionEndEvent,
  HumanTurnEvent,
  ToolCallEvent,
  ToolResultEvent,
  BranchSwitchEvent,
} from '../src/schema';

describe('session-writer', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('ensureSessionsDir', () => {
    it('creates .sessions directory if it does not exist', () => {
      const dir = ensureSessionsDir(testDir);
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toBe(path.join(testDir, '.sessions'));
    });

    it('returns existing directory if already exists', () => {
      ensureSessionsDir(testDir);
      const dir = ensureSessionsDir(testDir);
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('createSessionWriter', () => {
    it('creates session file and writes events', () => {
      const writer = createSessionWriter('test-session', testDir);

      const startEvent: SessionStartEvent = {
        type: 'session_start',
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'test-session',
        source: 'claude-code',
        cwd: '/test/project',
      };

      writer.writeEvent(startEvent);
      writer.close();

      const filePath = path.join(testDir, '.sessions', 'test-session.jsonl');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toBe(JSON.stringify(startEvent) + '\n');
    });

    it('appends multiple events', () => {
      const writer = createSessionWriter('test-session', testDir);

      const event1: SessionStartEvent = {
        type: 'session_start',
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'test-session',
        source: 'cursor',
        cwd: '/test/project',
      };

      const event2: HumanTurnEvent = {
        type: 'human_turn',
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: 'test-session',
        turnId: 'turn-1',
        content: 'Hello',
      };

      writer.writeEvent(event1);
      writer.writeEvent(event2);
      writer.close();

      const events = readSessionEvents('test-session', testDir);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });
  });

  describe('readSessionEvents', () => {
    it('returns empty array for non-existent session', () => {
      const events = readSessionEvents('non-existent', testDir);
      expect(events).toEqual([]);
    });

    it('reads all events from session file', () => {
      const writer = createSessionWriter('test-session', testDir);

      const events: (SessionStartEvent | HumanTurnEvent | SessionEndEvent)[] = [
        {
          type: 'session_start',
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: 'test-session',
          source: 'codex',
          cwd: '/test',
        },
        {
          type: 'human_turn',
          timestamp: '2024-01-01T00:00:01.000Z',
          sessionId: 'test-session',
          turnId: 'turn-1',
          content: 'Test prompt',
        },
        {
          type: 'session_end',
          timestamp: '2024-01-01T00:00:02.000Z',
          sessionId: 'test-session',
          reason: 'completed',
        },
      ];

      events.forEach((e) => writer.writeEvent(e));
      writer.close();

      const readEvents = readSessionEvents('test-session', testDir);
      expect(readEvents).toEqual(events);
    });
  });

  describe('listSessionFiles', () => {
    it('returns empty array when no sessions exist', () => {
      const sessions = listSessionFiles(testDir);
      expect(sessions).toEqual([]);
    });

    it('lists all session IDs', () => {
      ensureSessionsDir(testDir);
      fs.writeFileSync(
        path.join(testDir, '.sessions', 'session-1.jsonl'),
        '{}\n'
      );
      fs.writeFileSync(
        path.join(testDir, '.sessions', 'session-2.jsonl'),
        '{}\n'
      );
      fs.writeFileSync(
        path.join(testDir, '.sessions', 'not-a-session.txt'),
        'ignore'
      );

      const sessions = listSessionFiles(testDir);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
      expect(sessions).not.toContain('not-a-session');
    });
  });

  describe('extractSessionMetadata', () => {
    it('returns null for empty events', () => {
      const metadata = extractSessionMetadata([]);
      expect(metadata).toBeNull();
    });

    it('extracts metadata from events', () => {
      const events = [
        {
          type: 'session_start',
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: 'test',
          source: 'claude-code',
          cwd: '/test',
          gitBranch: 'main',
        } as SessionStartEvent,
        {
          type: 'human_turn',
          timestamp: '2024-01-01T00:00:01.000Z',
          sessionId: 'test',
          turnId: 't1',
          content: 'Hello',
        } as HumanTurnEvent,
        {
          type: 'tool_call',
          timestamp: '2024-01-01T00:00:02.000Z',
          sessionId: 'test',
          turnId: 't1',
          toolCallId: 'tc1',
          toolName: 'Edit',
          input: {},
        } as ToolCallEvent,
        {
          type: 'tool_result',
          timestamp: '2024-01-01T00:00:03.000Z',
          sessionId: 'test',
          turnId: 't1',
          toolCallId: 'tc1',
          filesModified: ['src/file.ts'],
        } as ToolResultEvent,
        {
          type: 'branch_switch',
          timestamp: '2024-01-01T00:00:04.000Z',
          sessionId: 'test',
          fromBranch: 'main',
          toBranch: 'feature',
          fromRef: 'abc',
          toRef: 'def',
        } as BranchSwitchEvent,
        {
          type: 'session_end',
          timestamp: '2024-01-01T00:00:05.000Z',
          sessionId: 'test',
          reason: 'completed',
        } as SessionEndEvent,
      ];

      const metadata = extractSessionMetadata(events);
      expect(metadata).toEqual({
        id: 'test',
        source: 'claude-code',
        startTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-01-01T00:00:05.000Z',
        branches: ['main', 'feature'],
        filesModified: ['src/file.ts'],
        turnCount: 1,
        toolCallCount: 1,
      });
    });
  });

  describe('isSessionActive', () => {
    it('returns true for session without end event', () => {
      const events = [
        {
          type: 'session_start',
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: 'test',
          source: 'cursor',
          cwd: '/test',
        } as SessionStartEvent,
      ];
      expect(isSessionActive(events)).toBe(true);
    });

    it('returns false for session with end event', () => {
      const events = [
        {
          type: 'session_start',
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: 'test',
          source: 'cursor',
          cwd: '/test',
        } as SessionStartEvent,
        {
          type: 'session_end',
          timestamp: '2024-01-01T00:00:01.000Z',
          sessionId: 'test',
          reason: 'completed',
        } as SessionEndEvent,
      ];
      expect(isSessionActive(events)).toBe(false);
    });
  });

  describe('findActiveSessions', () => {
    it('returns only active sessions', () => {
      // Create an active session
      const writer1 = createSessionWriter('active-session', testDir);
      writer1.writeEvent({
        type: 'session_start',
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'active-session',
        source: 'claude-code',
        cwd: '/test',
      });
      writer1.close();

      // Create a completed session
      const writer2 = createSessionWriter('completed-session', testDir);
      writer2.writeEvent({
        type: 'session_start',
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'completed-session',
        source: 'cursor',
        cwd: '/test',
      });
      writer2.writeEvent({
        type: 'session_end',
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: 'completed-session',
        reason: 'completed',
      });
      writer2.close();

      const activeSessions = findActiveSessions(testDir);
      expect(activeSessions).toContain('active-session');
      expect(activeSessions).not.toContain('completed-session');
    });
  });
});
