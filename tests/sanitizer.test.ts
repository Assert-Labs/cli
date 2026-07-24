import { describe, expect, it } from 'vitest';
import { sanitizeSessionJsonl } from '../src/sanitizer';

describe('session sanitizer', () => {
  it('redacts high-confidence secrets and normalizes repository paths', () => {
    const jsonl = JSON.stringify({
      type: 'tool_call',
      timestamp: 't1',
      sessionId: 's1',
      turnId: 'a1',
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: {
        command: "curl -H 'Authorization: Bearer abcdefghijklmnop' /repo/src/a.ts",
        token: 'secret-value',
      },
    });
    const output = sanitizeSessionJsonl(jsonl, '/repo');
    expect(output).toContain('Bearer [REDACTED:TOKEN]');
    expect(output).toContain('[REDACTED:SENSITIVE_FIELD]');
    expect(output).toContain('$REPO/src/a.ts');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('secret-value');
  });

  it('normalizes captured file arguments without rewriting other input', () => {
    const patchText = '*** Update File: /repo/src/a.ts';
    const jsonl = JSON.stringify({
      type: 'tool_call', timestamp: 't1', sessionId: 's1', turnId: 'a1',
      toolCallId: 'tc1', toolName: 'Edit',
      input: {
        filePath: '/repo/src/a.ts',
        file_path: 'src\\b.ts',
        patchText,
        command: 'read /repo/src/a.ts',
      },
    });
    const event = JSON.parse(sanitizeSessionJsonl(jsonl, '/repo'));
    expect(event.input.filePath).toBe('src/a.ts');
    expect(event.input.file_path).toBe('src/b.ts');
    expect(event.input.patchText).toBe(patchText.replace('/repo', '$REPO'));
    expect(event.input.command).toBe('read $REPO/src/a.ts');
  });

  it('applies model-directed field redaction', () => {
    const jsonl = [
      JSON.stringify({
        type: 'tool_call', timestamp: 't1', sessionId: 's1', turnId: 'a1',
        toolCallId: 'tc1', toolName: 'Read', input: { path: 'private.txt' },
      }),
      JSON.stringify({
        type: 'tool_result', timestamp: 't2', sessionId: 's1', turnId: 'a1',
        toolCallId: 'tc1', output: 'private customer information',
      }),
    ].join('\n');
    const output = sanitizeSessionJsonl(jsonl, '/repo', [
      { target: 'last-tool-output', toolCallId: 'tc1' },
    ]);
    expect(output).toContain('[REDACTED:AGENT]');
    expect(output).not.toContain('private customer information');
  });

  it('uses stable ordinals when normalized tool ids differ', () => {
    const jsonl = [
      JSON.stringify({
        type: 'tool_call', timestamp: 't1', sessionId: 's1', turnId: 'a1',
        toolCallId: 'native-id', toolName: 'Read', input: { path: 'private.txt' },
      }),
      JSON.stringify({
        type: 'tool_result', timestamp: 't2', sessionId: 's1', turnId: 'a1',
        toolCallId: 'native-id', output: 'private output',
      }),
    ].join('\n');
    const output = sanitizeSessionJsonl(jsonl, '/repo', [
      { target: 'last-tool-output', toolCallId: 'central-id', toolOrdinal: 0 },
    ]);
    expect(output).toContain('[REDACTED:AGENT]');
    expect(output).not.toContain('private output');
  });
});
