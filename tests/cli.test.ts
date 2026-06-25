import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSession } from '../src/session-manager';
import { listSessionFiles, readSessionEvents } from '../src/session-writer';

describe('CLI integration', () => {
  let testDir: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-cli-test-'));
    testDir = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('session management', () => {
    it('creates and lists sessions', () => {
      // Create a session programmatically
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
        sessionId: 'test-session-1',
      });

      session.startHumanTurn('Hello, help me with code');
      const turnId = session.startAssistantTurn('claude-3-opus');
      session.addAssistantText(turnId, 'Sure, I can help!');
      session.endAssistantTurn(turnId);
      session.end('completed');

      // Verify session was created
      const sessionIds = listSessionFiles(testDir);
      expect(sessionIds).toContain('test-session-1');

      // Verify events were recorded
      const events = readSessionEvents('test-session-1', testDir);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('session_start');
      expect(events[events.length - 1].type).toBe('session_end');
    });

    it('records tool calls correctly', () => {
      const session = createSession({
        source: 'cursor',
        cwd: testDir,
      });

      session.startHumanTurn('Read the file');
      const turnId = session.startAssistantTurn();
      const toolCallId = session.recordToolCall(turnId, 'Read', {
        file_path: 'test.txt',
      });
      session.recordToolResult(turnId, toolCallId, 'file contents');
      session.endAssistantTurn(turnId);
      session.end();

      const events = readSessionEvents(session.sessionId, testDir);
      const toolCall = events.find((e) => e.type === 'tool_call');
      const toolResult = events.find((e) => e.type === 'tool_result');

      expect(toolCall).toBeDefined();
      expect(toolResult).toBeDefined();
      if (toolCall?.type === 'tool_call') {
        expect(toolCall.toolName).toBe('Read');
      }
    });

    it('records file modifications', () => {
      const session = createSession({
        source: 'codex',
        cwd: testDir,
      });

      const turnId = session.startAssistantTurn();
      const toolCallId = session.recordToolCall(turnId, 'Edit', {
        file_path: 'src/main.ts',
      });
      session.recordToolResult(turnId, toolCallId, 'Success', undefined, [
        'src/main.ts',
      ]);
      session.recordFileAttribution(
        turnId,
        'src/main.ts',
        'hash123',
        'modify',
        [{ startLine: 1, endLine: 10 }],
      );
      session.endAssistantTurn(turnId);
      session.end();

      const events = readSessionEvents(session.sessionId, testDir);
      const attribution = events.find((e) => e.type === 'file_attribution');

      expect(attribution).toBeDefined();
      if (attribution?.type === 'file_attribution') {
        expect(attribution.filePath).toBe('src/main.ts');
        expect(attribution.operation).toBe('modify');
      }
    });
  });

  describe('session files', () => {
    it('creates .sessions directory on first session', () => {
      expect(fs.existsSync(path.join(testDir, '.sessions'))).toBe(false);

      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });
      session.end();

      expect(fs.existsSync(path.join(testDir, '.sessions'))).toBe(true);
    });

    it('stores sessions as JSONL files', () => {
      const session = createSession({
        source: 'cursor',
        cwd: testDir,
        sessionId: 'jsonl-test',
      });
      session.startHumanTurn('test');
      session.end();

      const filePath = path.join(testDir, '.sessions', 'jsonl-test.jsonl');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
