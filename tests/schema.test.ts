import { describe, it, expect } from 'vitest';
import {
  createSessionId,
  createTurnId,
  createToolCallId,
  parseSessionEvent,
  serializeSessionEvent,
  getSessionFilePath,
  parseSessionId,
  type SessionStartEvent,
  type HumanTurnEvent,
  type ToolCallEvent,
} from '../src/schema';

describe('schema utilities', () => {
  describe('ID generators', () => {
    it('createSessionId generates unique IDs', () => {
      const id1 = createSessionId();
      const id2 = createSessionId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });

    it('createTurnId generates unique IDs', () => {
      const id1 = createTurnId();
      const id2 = createTurnId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[a-z0-9]+$/);
    });

    it('createToolCallId generates unique IDs with prefix', () => {
      const id = createToolCallId();
      expect(id).toMatch(/^tc-[a-z0-9]+$/);
    });
  });

  describe('event serialization', () => {
    it('serializes and parses SessionStartEvent', () => {
      const event: SessionStartEvent = {
        type: 'session_start',
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'test-session',
        source: 'claude-code',
        cwd: '/home/user/project',
        gitBranch: 'main',
        gitRef: 'abc123',
      };

      const serialized = serializeSessionEvent(event);
      expect(serialized).toBe(JSON.stringify(event));

      const parsed = parseSessionEvent(serialized);
      expect(parsed).toEqual(event);
    });

    it('serializes and parses HumanTurnEvent', () => {
      const event: HumanTurnEvent = {
        type: 'human_turn',
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: 'test-session',
        turnId: 'turn-1',
        content: 'Hello, can you help me with this code?',
      };

      const serialized = serializeSessionEvent(event);
      const parsed = parseSessionEvent(serialized);
      expect(parsed).toEqual(event);
    });

    it('serializes and parses ToolCallEvent', () => {
      const event: ToolCallEvent = {
        type: 'tool_call',
        timestamp: '2024-01-01T00:00:02.000Z',
        sessionId: 'test-session',
        turnId: 'turn-1',
        toolCallId: 'tc-123',
        toolName: 'Read',
        input: { file_path: '/path/to/file.ts' },
      };

      const serialized = serializeSessionEvent(event);
      const parsed = parseSessionEvent(serialized);
      expect(parsed).toEqual(event);
    });
  });

  describe('session file path helpers', () => {
    it('getSessionFilePath returns correct path', () => {
      expect(getSessionFilePath('abc123')).toBe('.sessions/abc123.jsonl');
      expect(getSessionFilePath('my-session-id')).toBe('.sessions/my-session-id.jsonl');
    });

    it('parseSessionId extracts ID from path', () => {
      expect(parseSessionId('.sessions/abc123.jsonl')).toBe('abc123');
      expect(parseSessionId('.sessions/my-session-id.jsonl')).toBe('my-session-id');
      expect(parseSessionId('/full/path/.sessions/test.jsonl')).toBe('test');
    });

    it('parseSessionId returns null for invalid paths', () => {
      expect(parseSessionId('not-a-session-file.txt')).toBeNull();
      expect(parseSessionId('.sessions/no-extension')).toBeNull();
      expect(parseSessionId('sessions/wrong-folder.jsonl')).toBeNull();
    });
  });
});
