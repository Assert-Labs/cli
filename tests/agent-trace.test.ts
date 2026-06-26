import { describe, it, expect } from 'vitest';
import { buildTrace } from '../src/agent-trace';
import { hashLine } from '../src/line-attribution';
import { type AttributionEvent } from '../src/schema';

// Mirror of agent-trace's required TraceRecord shape (schemas.ts).
function isConformant(r: any): boolean {
  if (typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version)) return false;
  if (typeof r.id !== 'string' || typeof r.timestamp !== 'string') return false;
  if (!Array.isArray(r.files)) return false;
  for (const f of r.files) {
    if (typeof f.path !== 'string' || !Array.isArray(f.conversations)) return false;
    for (const c of f.conversations) {
      if (!Array.isArray(c.ranges)) return false;
      if (c.contributor && !['human', 'ai', 'mixed', 'unknown'].includes(c.contributor.type)) return false;
      for (const rg of c.ranges) {
        if (!Number.isInteger(rg.start_line) || rg.start_line < 1) return false;
        if (!Number.isInteger(rg.end_line) || rg.end_line < 1) return false;
      }
    }
  }
  return true;
}

describe('buildTrace', () => {
  const file = 'src/x.ts';
  const content = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  const fragments: AttributionEvent[] = [
    {
      type: 'attribution',
      timestamp: 't',
      sessionId: 's',
      filePath: file,
      vcsRevision: 'r0',
      operation: 'modify',
      contributor: { type: 'ai', modelId: 'anthropic/claude-x' },
      lineHashes: [hashLine('const a = 1;'), hashLine('const c = 3;')],
    },
  ];
  const opts = { toolVersion: '0.1.3', id: '00000000-0000-0000-0000-000000000000', timestamp: '2026-01-01T00:00:00Z' };
  const trace = buildTrace(fragments, () => content, 'rHEAD', opts);

  it('produces a conformant record with vcs + tool', () => {
    expect(isConformant(trace)).toBe(true);
    expect(trace.tool).toEqual({ name: 'assert', version: '0.1.3' });
    expect(trace.vcs).toEqual({ type: 'git', revision: 'rHEAD' });
  });

  it('attributes matched lines to ai+model, the rest to unknown', () => {
    const f = trace.files.find((f) => f.path === file)!;
    const ai = f.conversations.find((c) => c.contributor?.type === 'ai')!;
    const unknown = f.conversations.find((c) => c.contributor?.type === 'unknown')!;
    expect(ai.contributor!.model_id).toBe('anthropic/claude-x');
    const aiLines = ai.ranges.flatMap((r) => [r.start_line, r.end_line]);
    expect(aiLines).toContain(1);
    expect(aiLines).toContain(3);
    expect(unknown.ranges.some((r) => r.start_line <= 2 && r.end_line >= 2)).toBe(true);
    expect(ai.ranges[0].content_hash).toBeTruthy();
  });

  it('survives line reordering (content-hash based)', () => {
    const reordered = 'const c = 3;\nconst b = 2;\nconst a = 1;';
    const t2 = buildTrace(fragments, () => reordered, 'rHEAD', opts);
    const ai = t2.files[0].conversations.find((c) => c.contributor?.type === 'ai')!;
    const aiLines = new Set(ai.ranges.flatMap((r) => [r.start_line, r.end_line]));
    expect(aiLines.has(1)).toBe(true); // now 'const c = 3;'
    expect(aiLines.has(3)).toBe(true); // now 'const a = 1;'
  });
});
