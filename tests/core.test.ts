/**
 * Core: the pure interpretation layer (no fs/git). Guards that a session
 * transcript parses into linked turns and that line -> turn -> prompt/reasoning
 * and the "dig back" context chain resolve correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSession,
  getTurn,
  promptForLine,
  reasoningForLine,
  turnContext,
  diffProvenance,
  linesForTurn,
  turnsForFile,
  type BlameLine,
} from '../src/core';

// A two-turn session: a planning turn (no code) then an "implement" turn that
// edits a file — the shallow-prompt case ("now implement").
const jsonl = [
  { type: 'session_start', timestamp: 't0', sessionId: 's1', source: 'codex', cwd: '/x' },
  { type: 'human_turn', timestamp: 't1', sessionId: 's1', turnId: 'p1', content: 'plan the feature' },
  { type: 'assistant_turn_start', timestamp: 't2', sessionId: 's1', turnId: 'a1', model: 'm1', promptTurnId: 'p1' },
  { type: 'assistant_reasoning', timestamp: 't2b', sessionId: 's1', turnId: 'a1', text: 'here is the plan' },
  { type: 'human_turn', timestamp: 't3', sessionId: 's1', turnId: 'p2', content: 'now implement' },
  { type: 'assistant_turn_start', timestamp: 't4', sessionId: 's1', turnId: 'a2', model: 'm2', promptTurnId: 'p2' },
  { type: 'assistant_reasoning', timestamp: 't4b', sessionId: 's1', turnId: 'a2', text: 'implementing it' },
  { type: 'tool_call', timestamp: 't4c', sessionId: 's1', turnId: 'a2', toolCallId: 'tc1', toolName: 'apply_patch', input: { file_path: 'x.ts' } },
  { type: 'tool_result', timestamp: 't4d', sessionId: 's1', turnId: 'a2', toolCallId: 'tc1', output: 'ok' },
  { type: 'assistant_text', timestamp: 't4e', sessionId: 's1', turnId: 'a2', text: 'done' },
  { type: 'line_attribution', timestamp: 't5', sessionId: 's1', filePath: 'x.ts', lines: [{ hash: 'h1', source: 'agent', sessionId: 's1', turnId: 'a2', modelId: 'm2' }] },
].map((e) => JSON.stringify(e)).join('\n');

describe('core', () => {
  it('parses turns with prompts linked by id (no ordering)', () => {
    const session = parseSession(jsonl);
    expect(session.source).toBe('codex');
    expect(session.turns.map((t) => t.turnId)).toEqual(['a1', 'a2']); // ordered by start

    const a2 = getTurn(session, 'a2')!;
    expect(a2.prompt?.text).toBe('now implement');
    expect(a2.modelId).toBe('m2');
    expect(a2.reasoning.map((r) => r.text)).toEqual(['implementing it']);
    expect(a2.text).toEqual(['done']);
    expect(a2.toolCalls[0]).toMatchObject({ name: 'apply_patch', output: 'ok' });
  });

  it('marks only code-producing turns as changedCode', () => {
    const session = parseSession(jsonl);
    expect(getTurn(session, 'a1')!.changedCode).toBe(false); // planning only
    expect(getTurn(session, 'a2')!.changedCode).toBe(true); // owns a line
  });

  it('resolves a line back to its prompt and reasoning', () => {
    const session = parseSession(jsonl);
    const line: BlameLine = { line: 1, content: 'const x = 1;', source: 'agent', sessionId: 's1', turnId: 'a2', modelId: 'm2' };
    expect(promptForLine(line, session)?.text).toBe('now implement');
    expect(reasoningForLine(line, session).map((r) => r.text)).toEqual(['implementing it']);
  });

  it('digs back over no-code turns for context', () => {
    const session = parseSession(jsonl);
    // a2's shallow "now implement" prompt; context reaches back to the plan turn.
    expect(turnContext(session, 'a2').map((t) => t.turnId)).toEqual(['a1', 'a2']);
  });

  it('builds diff provenance: distinct turns + context + lines', () => {
    const session = parseSession(jsonl);
    const blame: BlameLine[] = [
      { line: 1, content: 'const x = 1;', source: 'agent', sessionId: 's1', turnId: 'a2', modelId: 'm2' },
      { line: 2, content: 'const base = 1;', source: 'unknown' },
    ];
    const prov = diffProvenance(blame, session);
    expect(prov).toHaveLength(1);
    expect(prov[0].turn.turnId).toBe('a2');
    expect(prov[0].context.map((t) => t.turnId)).toEqual(['a1', 'a2']);
    expect(prov[0].lines).toEqual([1]);
  });

  it('supports reverse lookups', () => {
    const session = parseSession(jsonl);
    const blame: BlameLine[] = [
      { line: 1, content: 'a', source: 'agent', turnId: 'a2' },
      { line: 2, content: 'b', source: 'agent', turnId: 'a2' },
    ];
    expect(linesForTurn(blame, 'a2').map((l) => l.line)).toEqual([1, 2]);
    expect(turnsForFile(blame, session).map((t) => t.turnId)).toEqual(['a2']);
  });

  it('merges historical assistant message ids that answer the same prompt', () => {
    const session = parseSession(
      [
        {
          type: 'human_turn',
          timestamp: 't1',
          sessionId: 's1',
          turnId: 'p1',
          content: 'create a file',
        },
        {
          type: 'assistant_turn_start',
          timestamp: 't2',
          sessionId: 's1',
          turnId: 'tool-block',
          promptTurnId: 'p1',
          model: 'real-model',
        },
        {
          type: 'tool_call',
          timestamp: 't2',
          sessionId: 's1',
          turnId: 'tool-block',
          toolCallId: 'write-1',
          toolName: 'Write',
          input: { file_path: 'dummy.txt' },
        },
        {
          type: 'human_turn',
          timestamp: 't1',
          sessionId: 's1',
          turnId: 'p1-new-normalizer',
          content: 'create a file',
        },
        {
          type: 'assistant_turn_start',
          timestamp: 't3',
          sessionId: 's1',
          turnId: 'summary-block',
          promptTurnId: 'p1-new-normalizer',
        },
        {
          type: 'assistant_text',
          timestamp: 't3',
          sessionId: 's1',
          turnId: 'summary-block',
          text: 'Created the file.',
        },
        {
          type: 'line_attribution',
          timestamp: 't4',
          sessionId: 's1',
          filePath: 'dummy.txt',
          lines: [
            {
              hash: 'h1',
              source: 'agent',
              sessionId: 's1',
              turnId: 'tool-block',
            },
          ],
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({
      turnId: 'tool-block',
      prompt: { text: 'create a file' },
      text: ['Created the file.'],
      changedCode: true,
      modelId: 'real-model',
    });
    expect(session.turns[0].toolCalls).toHaveLength(1);
    expect(session.turns[0].text).toEqual(['Created the file.']);
    expect(getTurn(session, 'summary-block')).toBe(session.turns[0]);
    expect(
      linesForTurn(
        [
          { line: 1, content: 'a', source: 'agent', turnId: 'tool-block' },
          { line: 2, content: 'b', source: 'agent', turnId: 'summary-block' },
        ],
        'tool-block',
        session,
      ),
    ).toHaveLength(2);
  });
});
