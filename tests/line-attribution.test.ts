import { describe, it, expect } from 'vitest';
import {
  normalizeLine,
  hashLine,
  createFileSnapshot,
  diffSnapshots,
  buildAttribution,
  calculateAgentContribution,
  findSessionLines,
} from '../src/line-attribution';

describe('line-attribution', () => {
  describe('normalizeLine', () => {
    it('trims whitespace', () => {
      expect(normalizeLine('  hello  ')).toBe('hello');
    });

    it('preserves content', () => {
      expect(normalizeLine('const x = 1;')).toBe('const x = 1;');
    });
  });

  describe('hashLine', () => {
    it('produces consistent hashes', () => {
      const hash1 = hashLine('const x = 1;');
      const hash2 = hashLine('const x = 1;');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different content', () => {
      const hash1 = hashLine('const x = 1;');
      const hash2 = hashLine('const x = 2;');
      expect(hash1).not.toBe(hash2);
    });

    it('ignores leading/trailing whitespace', () => {
      const hash1 = hashLine('const x = 1;');
      const hash2 = hashLine('  const x = 1;  ');
      expect(hash1).toBe(hash2);
    });

    it('produces 16-character hex hash', () => {
      const hash = hashLine('test');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('createFileSnapshot', () => {
    it('creates snapshot with correct line count', () => {
      const content = 'line 1\nline 2\nline 3';
      const snapshot = createFileSnapshot('test.ts', content);

      expect(snapshot.filePath).toBe('test.ts');
      expect(snapshot.lines).toHaveLength(3);
    });

    it('assigns correct line numbers (1-indexed)', () => {
      const content = 'first\nsecond\nthird';
      const snapshot = createFileSnapshot('test.ts', content);

      expect(snapshot.lines[0].lineNumber).toBe(1);
      expect(snapshot.lines[1].lineNumber).toBe(2);
      expect(snapshot.lines[2].lineNumber).toBe(3);
    });

    it('preserves original content', () => {
      const content = '  indented line\nnormal line';
      const snapshot = createFileSnapshot('test.ts', content);

      expect(snapshot.lines[0].content).toBe('  indented line');
      expect(snapshot.lines[1].content).toBe('normal line');
    });

    it('computes content hash', () => {
      const content = 'line 1\nline 2';
      const snapshot = createFileSnapshot('test.ts', content);

      expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('diffSnapshots', () => {
    it('detects added lines', () => {
      const before = createFileSnapshot('test.ts', 'line 1\nline 2');
      const after = createFileSnapshot('test.ts', 'line 1\nline 2\nline 3');

      const diffs = diffSnapshots(before, after);
      const added = diffs.filter((d) => d.type === 'added');

      expect(added).toHaveLength(1);
      expect(added[0].content).toBe('line 3');
    });

    it('detects removed lines', () => {
      const before = createFileSnapshot('test.ts', 'line 1\nline 2\nline 3');
      const after = createFileSnapshot('test.ts', 'line 1\nline 3');

      const diffs = diffSnapshots(before, after);
      const removed = diffs.filter((d) => d.type === 'removed');

      expect(removed).toHaveLength(1);
      expect(removed[0].content).toBe('line 2');
    });

    it('detects unchanged lines', () => {
      const before = createFileSnapshot('test.ts', 'line 1\nline 2');
      const after = createFileSnapshot('test.ts', 'line 1\nline 2\nline 3');

      const diffs = diffSnapshots(before, after);
      const unchanged = diffs.filter((d) => d.type === 'unchanged');

      expect(unchanged).toHaveLength(2);
    });

    it('handles complete file rewrite', () => {
      const before = createFileSnapshot('test.ts', 'old 1\nold 2');
      const after = createFileSnapshot('test.ts', 'new 1\nnew 2');

      const diffs = diffSnapshots(before, after);
      const added = diffs.filter((d) => d.type === 'added');
      const removed = diffs.filter((d) => d.type === 'removed');

      expect(added).toHaveLength(2);
      expect(removed).toHaveLength(2);
    });

    it('handles empty files', () => {
      const before = createFileSnapshot('test.ts', '');
      const after = createFileSnapshot('test.ts', 'new content');

      const diffs = diffSnapshots(before, after);
      const added = diffs.filter((d) => d.type === 'added');

      expect(added).toHaveLength(1);
    });

    it('handles line moves correctly', () => {
      const before = createFileSnapshot('test.ts', 'A\nB\nC');
      const after = createFileSnapshot('test.ts', 'B\nA\nC');

      const diffs = diffSnapshots(before, after);
      const unchanged = diffs.filter((d) => d.type === 'unchanged');

      // All lines still exist, just moved - should still match
      expect(unchanged.length).toBe(3);
    });
  });

  describe('buildAttribution', () => {
    it('attributes lines to correct session', () => {
      const snapshot = createFileSnapshot('test.ts', 'line 1\nline 2\nline 3');

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          turnId: 'turn-1',
          timestamp: '2024-01-01T00:00:00Z',
          addedHashes: new Set([snapshot.lines[0].hash, snapshot.lines[1].hash]),
        },
        {
          source: 'human' as const,
          timestamp: '2024-01-01T01:00:00Z',
          addedHashes: new Set([snapshot.lines[2].hash]),
        },
      ];

      const attribution = buildAttribution(snapshot, history);

      expect(attribution[0].source).toBe('agent');
      expect(attribution[0].sessionId).toBe('session-1');
      expect(attribution[1].source).toBe('agent');
      expect(attribution[2].source).toBe('human');
    });

    it('uses most recent source for duplicated lines', () => {
      const snapshot = createFileSnapshot('test.ts', 'duplicated');
      const lineHash = snapshot.lines[0].hash;

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: '2024-01-01T00:00:00Z',
          addedHashes: new Set([lineHash]),
        },
        {
          source: 'human' as const,
          timestamp: '2024-01-01T01:00:00Z',
          addedHashes: new Set([lineHash]),
        },
      ];

      const attribution = buildAttribution(snapshot, history);

      // Human modified it last
      expect(attribution[0].source).toBe('human');
    });

    it('marks unknown lines', () => {
      const snapshot = createFileSnapshot('test.ts', 'mystery line');

      const attribution = buildAttribution(snapshot, []);

      expect(attribution[0].source).toBe('unknown');
    });
  });

  describe('calculateAgentContribution', () => {
    it('calculates correct percentages', () => {
      const attribution = [
        { lineNumber: 1, hash: 'a', source: 'agent' as const, timestamp: '' },
        { lineNumber: 2, hash: 'b', source: 'agent' as const, timestamp: '' },
        { lineNumber: 3, hash: 'c', source: 'human' as const, timestamp: '' },
        { lineNumber: 4, hash: 'd', source: 'unknown' as const, timestamp: '' },
      ];

      const result = calculateAgentContribution(attribution);

      expect(result.agentLines).toBe(2);
      expect(result.humanLines).toBe(1);
      expect(result.unknownLines).toBe(1);
      expect(result.agentPercentage).toBe(50);
    });

    it('handles empty attribution', () => {
      const result = calculateAgentContribution([]);

      expect(result.agentLines).toBe(0);
      expect(result.agentPercentage).toBe(0);
    });
  });

  describe('findSessionLines', () => {
    it('finds lines for a specific session', () => {
      const attribution = [
        { lineNumber: 1, hash: 'a', source: 'agent' as const, sessionId: 's1', timestamp: '' },
        { lineNumber: 2, hash: 'b', source: 'agent' as const, sessionId: 's2', timestamp: '' },
        { lineNumber: 3, hash: 'c', source: 'agent' as const, sessionId: 's1', timestamp: '' },
        { lineNumber: 4, hash: 'd', source: 'human' as const, timestamp: '' },
      ];

      const lines = findSessionLines(attribution, 's1');

      expect(lines).toEqual([1, 3]);
    });
  });

  describe('real-world scenarios', () => {
    it('handles typical code editing workflow', () => {
      // Initial file state
      const initial = createFileSnapshot('component.tsx', `import React from 'react';

function Component() {
  return <div>Hello</div>;
}

export default Component;`);

      // Agent adds a prop
      const afterAgent = createFileSnapshot('component.tsx', `import React from 'react';

interface Props {
  name: string;
}

function Component({ name }: Props) {
  return <div>Hello {name}</div>;
}

export default Component;`);

      const agentDiffs = diffSnapshots(initial, afterAgent);
      const agentAdded = agentDiffs.filter((d) => d.type === 'added');

      // Agent added interface and modified function
      expect(agentAdded.length).toBeGreaterThan(0);

      // Human tweaks the greeting
      const afterHuman = createFileSnapshot('component.tsx', `import React from 'react';

interface Props {
  name: string;
}

function Component({ name }: Props) {
  return <div>Hi there, {name}!</div>;
}

export default Component;`);

      const humanDiffs = diffSnapshots(afterAgent, afterHuman);
      const humanAdded = humanDiffs.filter((d) => d.type === 'added');

      // Human changed one line
      expect(humanAdded.length).toBe(1);
      expect(humanAdded[0].content).toContain('Hi there');
    });

    it('survives rebase (content-based matching)', () => {
      // Original file
      const original = createFileSnapshot('test.ts', `function foo() {
  return 1;
}

function bar() {
  return 2;
}`);

      // After rebase (lines might be reordered in theory, but content same)
      const rebased = createFileSnapshot('test.ts', `function bar() {
  return 2;
}

function foo() {
  return 1;
}`);

      const diffs = diffSnapshots(original, rebased);
      const unchanged = diffs.filter((d) => d.type === 'unchanged');

      // All lines still exist, content-based matching should find them
      // (empty lines might differ)
      expect(unchanged.length).toBeGreaterThanOrEqual(4);
    });
  });
});
