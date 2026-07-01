import { describe, it, expect } from 'vitest';
import {
  normalizeLine,
  hashLine,
  createFileSnapshot,
  diffSnapshots,
  buildAttribution,
  threadAttribution,
  calculateAgentContribution,
  findSessionLines,
  type FileSnapshot,
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

    it('treats a reorder as add + remove (matching git, not an order-free match)', () => {
      // git diff of A\nB\nC -> B\nA\nC reports one addition and one removal (a
      // line moved), not "all three unchanged". Attribution follows git here.
      const before = createFileSnapshot('test.ts', 'A\nB\nC\n');
      const after = createFileSnapshot('test.ts', 'B\nA\nC\n');

      const diffs = diffSnapshots(before, after);
      const added = diffs.filter((d) => d.type === 'added');
      const removed = diffs.filter((d) => d.type === 'removed');

      expect(added).toHaveLength(1);
      expect(removed).toHaveLength(1);
    });
  });

  // Parity with native git. Expected added/removed COUNTS were produced by
  // `git diff --no-index --unified=0` over each before/after pair (counts are
  // invariant — they follow from the unique LCS length — so they must always
  // match git). Content multisets are asserted only for cases where the diff is
  // positionally unambiguous; a pure reorder (move_AB) has more than one
  // minimal diff, so only its counts are pinned. To regenerate, run that git
  // command over the pairs below. Contents are newline-terminated so git and our
  // split('\n') model agree on line count (the trailing '' is always unchanged).
  describe('diffSnapshots (git parity corpus)', () => {
    interface Case {
      name: string;
      before: string;
      after: string;
      added: number;
      removed: number;
      addedContent?: string[];
      removedContent?: string[];
    }
    const corpus: Case[] = [
      { name: 'append_end', before: 'a\nb\n', after: 'a\nb\nc\n', added: 1, removed: 0, addedContent: ['c'] },
      { name: 'remove_middle', before: 'a\nb\nc\n', after: 'a\nc\n', added: 0, removed: 1, removedContent: ['b'] },
      { name: 'blank_among_blanks', before: 'x\n\n\ny\n', after: 'x\n\n\n\ny\n', added: 1, removed: 0, addedContent: [''] },
      { name: 'dup_lines', before: 'foo\nfoo\n', after: 'foo\nfoo\nfoo\n', added: 1, removed: 0, addedContent: ['foo'] },
      { name: 'move_AB', before: 'A\nB\nC\n', after: 'B\nA\nC\n', added: 1, removed: 1 },
      { name: 'full_rewrite', before: 'old1\nold2\n', after: 'new1\nnew2\n', added: 2, removed: 2, addedContent: ['new1', 'new2'], removedContent: ['old1', 'old2'] },
      { name: 'markdown_para', before: '# Title\n\nintro\n\nbody\n', after: '# Title\n\nintro\n\nmore\n\nbody\n', added: 2, removed: 0, addedContent: ['', 'more'] },
      { name: 'insert_blank_code', before: 'line1\nline2\n', after: 'line1\n\nline2\n', added: 1, removed: 0, addedContent: [''] },
      { name: 'empty_to_content', before: '', after: 'new\n', added: 1, removed: 0, addedContent: ['new'] },
      { name: 'content_to_empty', before: 'old\n', after: '', added: 0, removed: 1, removedContent: ['old'] },
      { name: 'identical', before: 'same\nlines\n', after: 'same\nlines\n', added: 0, removed: 0 },
      { name: 'leading_insert', before: 'b\nc\n', after: 'a\nb\nc\n', added: 1, removed: 0, addedContent: ['a'] },
    ];

    for (const c of corpus) {
      it(`matches git for: ${c.name}`, () => {
        const diffs = diffSnapshots(
          createFileSnapshot('f', c.before),
          createFileSnapshot('f', c.after),
        );
        const added = diffs.filter((d) => d.type === 'added').map((d) => d.content).sort();
        const removed = diffs.filter((d) => d.type === 'removed').map((d) => d.content).sort();

        expect(added).toHaveLength(c.added);
        expect(removed).toHaveLength(c.removed);
        if (c.addedContent) expect(added).toEqual([...c.addedContent].sort());
        if (c.removedContent) expect(removed).toEqual([...c.removedContent].sort());
      });
    }
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

    it('never attributes blank lines to a session (markdown blame regression)', () => {
      // A markdown doc with human-authored blank lines. The agent session adds a
      // heading; because any multi-line edit / new-file diff includes the empty
      // hash in its added set, the bug attributed *every* blank line to the
      // session. Simulate that by putting the empty hash in addedHashes.
      const content = '# Title\n\nintro paragraph\n\nclosing paragraph\n';
      const snapshot = createFileSnapshot('doc.md', content);
      const blankLineIndexes = snapshot.lines
        .map((l, i) => (l.content.trim() === '' ? i : -1))
        .filter((i) => i >= 0);
      expect(blankLineIndexes.length).toBeGreaterThan(0); // sanity: doc has blanks

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: '2024-01-01T00:00:00Z',
          addedHashes: new Set([hashLine('# Title'), hashLine('')]),
        },
      ];

      const attribution = buildAttribution(snapshot, history);

      // The real line the session added is still attributed to it.
      expect(attribution[0].source).toBe('agent');
      expect(attribution[0].sessionId).toBe('session-1');

      // Every blank line stays unknown — none claimed by the session.
      for (const i of blankLineIndexes) {
        expect(attribution[i].source).toBe('unknown');
        expect(attribution[i].sessionId).toBeUndefined();
      }
      expect(findSessionLines(attribution, 'session-1')).toEqual([1]);
    });
  });

  describe('threadAttribution', () => {
    it('does not claim pre-existing blank lines when a session edits the file', () => {
      // The markdown blame bug: hash-set matching claimed every blank line.
      // Threading aligns positionally, so pre-existing blanks stay unknown.
      const before = createFileSnapshot('doc.md', 'alpha\n\nbeta\n\ngamma\n');
      const after = createFileSnapshot('doc.md', 'alpha\n\nbeta\n\ngamma\n\ndelta\n');

      const attr = threadAttribution(before, [
        { after, source: 'agent', sessionId: 's1', timestamp: 't' },
      ]);

      // Pre-existing content + its blank lines (2,4,6) remain unknown...
      for (const ln of [1, 2, 3, 4, 5, 6]) {
        expect(attr[ln - 1].source).toBe('unknown');
      }
      // ...only the appended paragraph is the agent's.
      expect(after.lines[6].content).toBe('delta');
      expect(attr[6]).toMatchObject({ source: 'agent', sessionId: 's1' });
    });

    it('threads agent and human edits across steps', () => {
      const s0 = createFileSnapshot('f', 'base\n');
      const e0 = createFileSnapshot('f', 'base\nagent1\n');
      const human = createFileSnapshot('f', 'base\nagent1\nhuman1\n');
      const e1 = createFileSnapshot('f', 'base\nagent1\nhuman1\nagent2\n');

      const attr = threadAttribution(s0, [
        { after: e0, source: 'agent', sessionId: 's1', timestamp: '1' },
        { after: human, source: 'human', timestamp: '2' },
        { after: e1, source: 'agent', sessionId: 's2', timestamp: '3' },
      ]);

      expect(attr[0].source).toBe('unknown'); // base (pre-existing)
      expect(attr[1]).toMatchObject({ source: 'agent', sessionId: 's1' });
      expect(attr[2].source).toBe('human');
      expect(attr[3]).toMatchObject({ source: 'agent', sessionId: 's2' });
    });

    it('attributes a newly created file entirely to the agent (blanks included)', () => {
      const nonExistent: FileSnapshot = { filePath: 'f', lines: [], contentHash: '' };
      const after = createFileSnapshot('f', 'a\n\nb\n');

      const attr = threadAttribution(nonExistent, [
        { after, source: 'agent', sessionId: 's1', timestamp: 't' },
      ]);

      expect(attr.every((a) => a.source === 'agent')).toBe(true);
      expect(calculateAgentContribution(attr).agentPercentage).toBe(100);
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

    it('excludes blank lines from the ratio (agent-authored file stays 100%)', () => {
      // 3 agent content lines + 2 blank lines (which hash to hashLine('')).
      const blank = hashLine('');
      const attribution = [
        { lineNumber: 1, hash: 'a', source: 'agent' as const, timestamp: '' },
        { lineNumber: 2, hash: blank, source: 'unknown' as const, timestamp: '' },
        { lineNumber: 3, hash: 'b', source: 'agent' as const, timestamp: '' },
        { lineNumber: 4, hash: blank, source: 'unknown' as const, timestamp: '' },
        { lineNumber: 5, hash: 'c', source: 'agent' as const, timestamp: '' },
      ];

      const result = calculateAgentContribution(attribution);

      expect(result.agentLines).toBe(3);
      expect(result.unknownLines).toBe(0); // blank lines not counted as unknown
      expect(result.agentPercentage).toBe(100);
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

    it('keeps content matched when lines shift down (the real rebase case)', () => {
      const original = createFileSnapshot(
        'test.ts',
        'function foo() {\n  return 1;\n}\n',
      );
      // A rebase/human adds an import above; foo shifts down but is unchanged.
      const shifted = createFileSnapshot(
        'test.ts',
        "import x from 'x';\n\nfunction foo() {\n  return 1;\n}\n",
      );

      const diffs = diffSnapshots(original, shifted);
      const unchanged = diffs.filter((d) => d.type === 'unchanged').map((d) => d.content);
      const added = diffs.filter((d) => d.type === 'added').map((d) => d.content);

      // foo's lines keep their identity across the shift...
      expect(unchanged).toEqual(
        expect.arrayContaining(['function foo() {', '  return 1;', '}']),
      );
      // ...and only the inserted lines are attributed as added.
      expect(added).toContain("import x from 'x';");
      expect(added).not.toContain('function foo() {');
    });
  });
});
