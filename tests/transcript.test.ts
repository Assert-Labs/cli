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

  it('uses stable prompt ids when normalizing a growing transcript', () => {
    const initial = lines.slice(0, 3).map((line) => JSON.stringify(line)).join('\n');
    const first = normalizeClaudeTranscript(initial, 's1');
    const second = normalizeClaudeTranscript(
      `${initial}\n${JSON.stringify({ type: 'assistant', timestamp: 't4', message: { id: 'turn-2', content: [] } })}`,
      's1',
    );
    expect(first.find((event) => event.type === 'human_turn')?.turnId).toBe(
      second.find((event) => event.type === 'human_turn')?.turnId,
    );
  });

  it('uses one logical turn id for assistant blocks answering the same prompt', () => {
    const transcript = [
      {
        type: 'user',
        timestamp: 't1',
        message: { role: 'user', content: 'create a file' },
      },
      {
        type: 'assistant',
        timestamp: 't2',
        message: {
          id: 'tool-block',
          content: [
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: { file_path: 'dummy.txt' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: 't3',
        message: {
          id: 'summary-block',
          content: [{ type: 'text', text: 'Created the file.' }],
        },
      },
    ];
    const events = normalizeClaudeTranscript(
      transcript.map((line) => JSON.stringify(line)).join('\n'),
      's1',
    );
    const assistantTurnIds = new Set(
      events
        .filter((event) => event.type.startsWith('assistant_') || event.type === 'tool_call')
        .map((event) => 'turnId' in event && event.turnId),
    );
    expect([...assistantTurnIds]).toEqual(['tool-block']);
  });

  it('uses stable fallback ids for assistant messages without native ids', () => {
    const transcript = [
      {
        type: 'user',
        timestamp: 't1',
        message: { role: 'user', content: 'help' },
      },
      {
        type: 'assistant',
        timestamp: 't2',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const first = normalizeClaudeTranscript(transcript, 's1');
    const second = normalizeClaudeTranscript(transcript, 's1');
    expect(
      first.find((event) => event.type === 'assistant_turn_start')?.turnId,
    ).toBe(second.find((event) => event.type === 'assistant_turn_start')?.turnId);
  });

  it('keeps repeated metadata-free messages as distinct logical turns', () => {
    const transcript = [
      { type: 'user', message: { role: 'user', content: 'repeat' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'same' }] },
      },
      { type: 'user', message: { role: 'user', content: 'repeat' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'same' }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const events = normalizeClaudeTranscript(transcript, 's1');
    const promptIds = events
      .filter((event) => event.type === 'human_turn')
      .map((event) => event.turnId);
    const assistantIds = events
      .filter((event) => event.type === 'assistant_turn_start')
      .map((event) => event.turnId);
    expect(new Set(promptIds).size).toBe(2);
    expect(new Set(assistantIds).size).toBe(2);
  });
});
