import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createSession } from '../src/session-manager';
import { readSessionEvents } from '../src/session-writer';

describe('session-manager', () => {
  let testDir: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-session-test-'));
    testDir = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Ignore cleanup errors
    }
  });

  function initGitRepo(): void {
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: testDir,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test User"', {
      cwd: testDir,
      stdio: 'pipe',
    });
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test\n');
    execSync('git add .', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  }

  describe('createSession', () => {
    it('creates session with start event', () => {
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      expect(session.isActive).toBe(true);
      expect(session.source).toBe('claude-code');

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);
      expect(events[0].type).toBe('session_start');
      expect(events[0].sessionId).toBe(session.sessionId);
    });

    it('records human turns', () => {
      const session = createSession({
        source: 'cursor',
        cwd: testDir,
      });

      const turnId = session.startHumanTurn('Hello, can you help me?');
      expect(turnId).toBeTruthy();

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);
      const humanTurn = events.find((e) => e.type === 'human_turn');
      expect(humanTurn).toBeDefined();
      expect(humanTurn?.type === 'human_turn' && humanTurn.content).toBe(
        'Hello, can you help me?'
      );
    });

    it('records assistant turns with text', () => {
      const session = createSession({
        source: 'codex',
        cwd: testDir,
      });

      session.startHumanTurn('Hello');
      const turnId = session.startAssistantTurn('gpt-4');
      session.addAssistantText(turnId, 'Hello! How can I help?');
      session.endAssistantTurn(turnId, 'hash123');

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);

      const turnStart = events.find((e) => e.type === 'assistant_turn_start');
      expect(turnStart?.type === 'assistant_turn_start' && turnStart.model).toBe(
        'gpt-4'
      );

      const textEvent = events.find((e) => e.type === 'assistant_text');
      expect(textEvent?.type === 'assistant_text' && textEvent.text).toBe(
        'Hello! How can I help?'
      );

      const turnEnd = events.find((e) => e.type === 'assistant_turn_end');
      expect(
        turnEnd?.type === 'assistant_turn_end' && turnEnd.contentHash
      ).toBe('hash123');
    });

    it('records tool calls and results', () => {
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      const turnId = session.startAssistantTurn();
      const toolCallId = session.recordToolCall(turnId, 'Read', {
        file_path: '/test/file.ts',
      });
      session.recordToolResult(turnId, toolCallId, 'file contents', undefined, [
        '/test/file.ts',
      ]);

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);

      const toolCall = events.find((e) => e.type === 'tool_call');
      expect(toolCall?.type === 'tool_call' && toolCall.toolName).toBe('Read');

      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult?.type === 'tool_result' && toolResult.output).toBe(
        'file contents'
      );
    });

    it('records file attribution', () => {
      const session = createSession({
        source: 'cursor',
        cwd: testDir,
      });

      const turnId = session.startAssistantTurn();
      session.recordFileAttribution(
        turnId,
        'src/file.ts',
        'contenthash123',
        'modify',
        [{ startLine: 10, endLine: 20 }]
      );

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);

      const attribution = events.find((e) => e.type === 'file_attribution');
      expect(attribution?.type === 'file_attribution').toBe(true);
      if (attribution?.type === 'file_attribution') {
        expect(attribution.filePath).toBe('src/file.ts');
        expect(attribution.contentHash).toBe('contenthash123');
        expect(attribution.operation).toBe('modify');
        expect(attribution.lineRanges).toEqual([{ startLine: 10, endLine: 20 }]);
      }
    });

    it('records session end with reason', () => {
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      session.end('error', 'Something went wrong');

      const events = readSessionEvents(session.sessionId, testDir);
      const endEvent = events.find((e) => e.type === 'session_end');
      expect(endEvent?.type === 'session_end' && endEvent.reason).toBe('error');
      expect(endEvent?.type === 'session_end' && endEvent.error).toBe(
        'Something went wrong'
      );
    });

    it('prevents writing after session ends', () => {
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      session.end();

      expect(() => session.startHumanTurn('Hello')).toThrow('Session has ended');
    });

    it('captures git branch if in git repo', () => {
      initGitRepo();

      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      session.end();

      const events = readSessionEvents(session.sessionId, testDir);
      const startEvent = events[0];
      expect(startEvent.type).toBe('session_start');
      if (startEvent.type === 'session_start') {
        expect(startEvent.gitBranch).toMatch(/^(main|master)$/);
        expect(startEvent.gitRef).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it('uses provided sessionId', () => {
      const session = createSession({
        source: 'cursor',
        cwd: testDir,
        sessionId: 'my-custom-session-id',
      });

      expect(session.sessionId).toBe('my-custom-session-id');

      session.end();
    });
  });

  describe('full conversation flow', () => {
    it('records a complete conversation', () => {
      const session = createSession({
        source: 'claude-code',
        cwd: testDir,
      });

      // Human asks a question
      session.startHumanTurn('Can you read the README file?');

      // Assistant reads the file
      const turn1 = session.startAssistantTurn('claude-3-opus');
      const tc1 = session.recordToolCall(turn1, 'Read', {
        file_path: 'README.md',
      });
      session.recordToolResult(turn1, tc1, '# My Project\n\nThis is a test.');
      session.addAssistantText(
        turn1,
        'The README contains a project description.'
      );
      session.endAssistantTurn(turn1);

      // Human asks for a change
      session.startHumanTurn('Can you update it to add a license section?');

      // Assistant modifies the file
      const turn2 = session.startAssistantTurn('claude-3-opus');
      const tc2 = session.recordToolCall(turn2, 'Edit', {
        file_path: 'README.md',
        old_string: '# My Project',
        new_string: '# My Project\n\n## License\nMIT',
      });
      session.recordToolResult(turn2, tc2, 'File updated', undefined, [
        'README.md',
      ]);
      session.recordFileAttribution(turn2, 'README.md', 'newhash', 'modify', [
        { startLine: 1, endLine: 4 },
      ]);
      session.addAssistantText(turn2, 'I added a license section to the README.');
      session.endAssistantTurn(turn2);

      session.end('completed');

      // Verify all events were recorded
      const events = readSessionEvents(session.sessionId, testDir);

      expect(events.filter((e) => e.type === 'human_turn')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'assistant_turn_start')).toHaveLength(
        2
      );
      expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'file_attribution')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'session_end')).toHaveLength(1);
    });
  });
});
