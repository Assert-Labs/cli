import { describe, it, expect } from 'vitest';
import { normalizeClaudeTranscript, normalizeModelId } from '../src/transcript';

describe('normalizeModelId', () => {
  it('maps to models.dev convention', () => {
    expect(normalizeModelId('claude-opus-4-5-20251101')).toBe('anthropic/claude-opus-4-5-20251101');
    expect(normalizeModelId('gpt-5')).toBe('openai/gpt-5');
    expect(normalizeModelId('anthropic/claude-x')).toBe('anthropic/claude-x');
    expect(normalizeModelId('<synthetic>')).toBeUndefined();
    expect(normalizeModelId(undefined)).toBeUndefined();
  });
});

describe('normalizeClaudeTranscript', () => {
  const lines = [
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'user', timestamp: 't1', message: { role: 'user', content: 'fix the bug' } },
    {
      type: 'assistant',
      timestamp: 't2',
      message: {
        id: 'turn-1',
        model: 'claude-opus-4-5-20251101',
        content: [
          { type: 'thinking', thinking: 'let me look', signature: 'sig' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'tc-1', name: 'Edit', input: { file_path: 'a.ts' } },
        ],
      },
    },
    { type: 'progress', data: {} },
    { type: 'user', timestamp: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'done' }] } },
  ];
  const events = normalizeClaudeTranscript(lines.map((l) => JSON.stringify(l)).join('\n'), 's1');

  it('drops Claude-internal line types', () => {
    expect(events.find((e) => (e.type as string) === 'file-history-snapshot')).toBeUndefined();
    expect(events.find((e) => (e.type as string) === 'progress')).toBeUndefined();
  });

  it('preserves reasoning as assistant_reasoning', () => {
    const reasoning = events.find((e) => e.type === 'assistant_reasoning');
    expect(reasoning).toMatchObject({ turnId: 'turn-1', text: 'let me look', signature: 'sig' });
  });

  it('maps human turn, model, tool call and tool result', () => {
    expect(events.find((e) => e.type === 'human_turn')).toMatchObject({ content: 'fix the bug' });
    expect(events.find((e) => e.type === 'assistant_turn_start')).toMatchObject({
      turnId: 'turn-1',
      model: 'anthropic/claude-opus-4-5-20251101',
    });
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ toolCallId: 'tc-1', toolName: 'Edit' });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ toolCallId: 'tc-1', output: 'done' });
  });
});
