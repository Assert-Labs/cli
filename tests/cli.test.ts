import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSession } from '../src/session-manager';
import { listSessionFiles, readSessionEvents } from '../src/session-writer';
import {
  runningBinPath,
  findStableBinPath,
  blameLineRecord,
  parseUnifiedDiffAddedLines,
  buildAgentHashIndex,
  parseDiffRange,
} from '../src/cli';
import { hashLine, type AttributionRecord } from '../src/line-attribution';

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

  describe('runningBinPath (init binary resolution)', () => {
    // Regression: a SEA binary launched via PATH (e.g. Homebrew `assert
    // init`) gets process.argv[1] === "assert" (the bare launch name). The
    // installer must use process.execPath, NOT resolve "assert" against the cwd
    // and realpath it — that throws ENOENT ("path did not exist") unless a file
    // named `assert` happens to exist in the cwd.
    it('uses execPath for a SEA build, ignoring the bare argv[1] launch name', () => {
      const execPath = '/opt/homebrew/Cellar/assert/0.1.6/bin/assert';
      expect(
        runningBinPath(true, 'assert', execPath, '/some/working/dir'),
      ).toBe(execPath);
    });

    it('ignores argv[1] for SEA even when it would resolve to a real-looking path', () => {
      expect(runningBinPath(true, '../assert', '/exec/path', '/cwd')).toBe(
        '/exec/path',
      );
    });

    it('resolves a relative argv[1] against the cwd for the JS layout', () => {
      expect(runningBinPath(false, 'bin/assert.js', '/usr/bin/node', '/proj')).toBe(
        '/proj/bin/assert.js',
      );
    });

    it('keeps an absolute argv[1] as-is for the JS layout', () => {
      expect(
        runningBinPath(false, '/proj/bin/assert.js', '/usr/bin/node', '/proj'),
      ).toBe('/proj/bin/assert.js');
    });
  });

  describe('findStableBinPath (upgrade-friendly symlink target)', () => {
    const sep = path.delimiter;

    // The Homebrew shim /opt/homebrew/bin/assert is a symlink to the cellar
    // binary, which is also what's running. We want the *shim* path back (not
    // realpath'd), because brew rewrites that shim on upgrade.
    it('returns the un-resolved PATH shim that points at the running binary', () => {
      const running = '/opt/homebrew/Cellar/assert/0.1.6/bin/assert';
      const realpaths: Record<string, string> = {
        '/opt/homebrew/bin/assert': running,
      };
      const pathEnv = ['/usr/bin', '/opt/homebrew/bin'].join(sep);
      expect(
        findStableBinPath(pathEnv, 'assert', '/home/u/.assert/bin', running, (p) =>
          realpaths[p] ?? null,
        ),
      ).toBe('/opt/homebrew/bin/assert');
    });

    it('skips our own ~/.assert/bin so it never links to the symlink it manages', () => {
      const running = '/opt/homebrew/Cellar/assert/0.1.6/bin/assert';
      const excludeDir = '/home/u/.assert/bin';
      const realpaths: Record<string, string> = {
        // The managed symlink also resolves to the running binary…
        '/home/u/.assert/bin/assert': running,
        // …but the real shim is the one we want.
        '/opt/homebrew/bin/assert': running,
      };
      const pathEnv = [excludeDir, '/opt/homebrew/bin'].join(sep);
      expect(
        findStableBinPath(pathEnv, 'assert', excludeDir, running, (p) =>
          realpaths[p] ?? null,
        ),
      ).toBe('/opt/homebrew/bin/assert');
    });

    // init removes ~/.assert/bin/assert before searching, so a back-link into
    // it (~/.local/bin/assert -> there) dangles (realpath null) and is skipped —
    // otherwise linking to it would form a cycle.
    it('skips a dangling back-link, choosing the real shim', () => {
      const running = '/opt/homebrew/Cellar/assert/0.1.6/bin/assert';
      const pathEnv = ['/home/u/.local/bin', '/opt/homebrew/bin'].join(sep);
      const realpaths: Record<string, string> = { '/opt/homebrew/bin/assert': running };
      expect(
        findStableBinPath(pathEnv, 'assert', '/home/u/.assert/bin', running, (p) => realpaths[p] ?? null),
      ).toBe('/opt/homebrew/bin/assert');
    });

    it('returns null when no PATH entry resolves to the running binary', () => {
      const pathEnv = ['/usr/bin', '/usr/local/bin'].join(sep);
      expect(
        findStableBinPath(pathEnv, 'assert', '/home/u/.assert/bin', '/some/where/assert', () => null),
      ).toBe(null);
    });

    it('ignores a same-named binary on PATH that is a different install', () => {
      const running = '/opt/homebrew/Cellar/assert/0.1.6/bin/assert';
      const realpaths: Record<string, string> = {
        '/usr/local/bin/assert': '/usr/local/lib/other/assert', // different tool
      };
      const pathEnv = ['/usr/local/bin'].join(sep);
      expect(
        findStableBinPath(pathEnv, 'assert', '/home/u/.assert/bin', running, (p) =>
          realpaths[p] ?? null,
        ),
      ).toBe(null);
    });
  });

  describe('blameLineRecord (structured blame for --json/--ndjson)', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const attribution: AttributionRecord[] = [
      { lineNumber: 1, hash: 'h1', source: 'agent', sessionId: 'sess-1234-5678', agent: 'codex', modelId: 'openai/gpt-5.5', turnId: 'turn-42', timestamp: 't' },
      { lineNumber: 2, hash: 'h2', source: 'human', timestamp: 't' },
      { lineNumber: 3, hash: 'h3', source: 'unknown', timestamp: 't' },
    ];

    it('emits full agent/model/session/turn for agent lines', () => {
      expect(blameLineRecord(attribution, lines, 0)).toEqual({
        line: 1,
        content: 'const a = 1;',
        source: 'agent',
        agent: 'codex',
        modelId: 'openai/gpt-5.5',
        sessionId: 'sess-1234-5678', // full id, not truncated
        turnId: 'turn-42',
      });
    });

    it('omits agent fields for human and unknown lines', () => {
      expect(blameLineRecord(attribution, lines, 1)).toEqual({ line: 2, content: 'const b = 2;', source: 'human' });
      expect(blameLineRecord(attribution, lines, 2)).toEqual({ line: 3, content: 'const c = 3;', source: 'unknown' });
    });

    it('falls back to unknown when there is no attribution', () => {
      expect(blameLineRecord(null, lines, 0)).toEqual({ line: 1, content: 'const a = 1;', source: 'unknown' });
    });
  });

  describe('diff-mode blame (--diff for PR review)', () => {
    it('parses added lines with head line numbers, skipping removals', () => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 111..222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,0 +2,2 @@',
        '+const added1 = 1;',
        '+const added2 = 2;',
        '@@ -5 +7 @@',
        '-const old = 3;',
        '+const changed = 3;',
        'diff --git a/src/b.ts b/src/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/b.ts',
        '@@ -0,0 +1 @@',
        '+export const b = 1;',
      ].join('\n');

      expect(parseUnifiedDiffAddedLines(diff)).toEqual([
        { file: 'src/a.ts', line: 2, content: 'const added1 = 1;' },
        { file: 'src/a.ts', line: 3, content: 'const added2 = 2;' },
        { file: 'src/a.ts', line: 7, content: 'const changed = 3;' },
        { file: 'src/b.ts', line: 1, content: 'export const b = 1;' },
      ]);
    });

    it('indexes agent line hashes (with turn), latest attribution winning collisions', () => {
      const h = hashLine('const added1 = 1;');
      const content = [
        JSON.stringify({ type: 'line_attribution', timestamp: '2', sessionId: 's1', filePath: 'a', lines: [{ hash: h, source: 'agent', agent: 'codex', modelId: 'openai/gpt-5.5', turnId: 'turn-9' }] }),
        JSON.stringify({ type: 'line_attribution', timestamp: '1', sessionId: 's0', filePath: 'a', lines: [{ hash: h, source: 'agent', agent: 'claude-code', modelId: 'old', turnId: 'turn-0' }] }),
        JSON.stringify({ type: 'human_turn', timestamp: '3', sessionId: 's1', turnId: 't', content: 'hi' }),
      ].join('\n');

      const idx = buildAgentHashIndex([content]);
      // turnId surfaces so a diff line resolves to its prompt; latest wins.
      expect(idx.get(h)).toMatchObject({ agent: 'codex', modelId: 'openai/gpt-5.5', sessionId: 's1', turnId: 'turn-9' });
    });

    it('parses the range spec (A..B, or a bare commit)', () => {
      expect(parseDiffRange('main..feature')).toEqual({ base: 'main', head: 'feature' });
      expect(parseDiffRange('abc123')).toEqual({ base: 'abc123^', head: 'abc123' });
    });
  });
});
