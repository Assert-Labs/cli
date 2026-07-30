/**
 * The canonical tool vocabulary. The point of these tests is the *sameness*:
 * every agent's way of saying "read this file" / "edit this file" / "run this"
 * has to land on one shape, because consumers of a capture read only that
 * shape and never the agent's raw input.
 */

import { describe, it, expect } from 'vitest';
import { applyPatchPaths, toolAction, redactedToolAction } from '../src/tool-actions';

describe('toolAction', () => {
  it('maps every agent\'s file read onto the same action', () => {
    expect(toolAction('claude-code', 'Read', { file_path: '/repo/src/a.ts' })).toEqual({
      kind: 'read',
      paths: ['/repo/src/a.ts'],
    });
    expect(toolAction('opencode', 'read', { filePath: '/repo/src/a.ts', limit: 20 })).toEqual({
      kind: 'read',
      paths: ['/repo/src/a.ts'],
    });
    expect(toolAction('pi', 'read', { path: '/repo/src/a.ts' })).toEqual({
      kind: 'read',
      paths: ['/repo/src/a.ts'],
    });
    expect(toolAction('cursor', 'read_file', { filePath: '/repo/src/a.ts' })).toEqual({
      kind: 'read',
      paths: ['/repo/src/a.ts'],
    });
  });

  it('maps every agent\'s file write onto the same action', () => {
    expect(toolAction('claude-code', 'Write', { file_path: 'a.ts', content: 'x' })).toEqual({
      kind: 'write',
      paths: ['a.ts'],
    });
    expect(toolAction('opencode', 'write', { filePath: 'a.ts', content: 'x' })).toEqual({
      kind: 'write',
      paths: ['a.ts'],
    });
    expect(toolAction('pi', 'write', { path: 'a.ts', content: 'x' })).toEqual({
      kind: 'write',
      paths: ['a.ts'],
    });
  });

  it('resolves patch blobs to the files they touch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: dummy.txt',
      '+hello',
      '*** Update File: src/x.ts',
      '@@',
      '+const x = 1;',
      '*** End Patch',
    ].join('\n');

    // Codex passes the blob under `command`; OpenCode under `patchText`.
    expect(toolAction('codex', 'apply_patch', { command: patch })).toEqual({
      kind: 'edit',
      paths: ['dummy.txt', 'src/x.ts'],
    });
    expect(toolAction('opencode', 'apply_patch', { patchText: patch })).toEqual({
      kind: 'edit',
      paths: ['dummy.txt', 'src/x.ts'],
    });
  });

  it('separates a shell command from a patch blob passed under the same key', () => {
    expect(toolAction('codex', 'Bash', { command: 'pnpm test' })).toEqual({
      kind: 'command',
      command: 'pnpm test',
    });
  });

  it('distinguishes web lookups from workspace searches', () => {
    expect(toolAction('claude-code', 'WebSearch', { query: 'assert labs' })).toEqual({
      kind: 'web',
      query: 'assert labs',
    });
    expect(toolAction('claude-code', 'WebFetch', { url: 'https://a.dev', prompt: 'summarize' })).toEqual({
      kind: 'web',
      url: 'https://a.dev',
      query: 'summarize',
    });
    expect(toolAction('opencode', 'grep', { pattern: 'TODO', path: 'src' })).toEqual({
      kind: 'search',
      query: 'TODO',
      paths: ['src'],
    });
  });

  it('matches tool names case-insensitively', () => {
    expect(toolAction('opencode', 'TodoWrite', {}).kind).toBe('todo');
    expect(toolAction('claude-code', 'bash', { command: 'ls' }).kind).toBe('command');
  });

  it('reports an unregistered or MCP tool as `other` rather than guessing', () => {
    expect(toolAction('claude-code', 'mcp__linear__create_issue', { title: 'x' })).toEqual({
      kind: 'other',
    });
    expect(toolAction('unknown', 'nonesuch', { file_path: 'a.ts' })).toEqual({
      kind: 'other',
    });
  });

  it('falls back across agents when the capture never recorded its agent', () => {
    // Pre-`session_start` captures have no source; the tool name still tells
    // us what happened, whichever agent's key holds the argument.
    expect(toolAction('unknown', 'Read', { file_path: 'a.ts' })).toEqual({
      kind: 'read',
      paths: ['a.ts'],
    });
    expect(toolAction('unknown', 'read', { filePath: 'a.ts' })).toEqual({
      kind: 'read',
      paths: ['a.ts'],
    });
    expect(toolAction('unknown', 'Bash', { command: 'ls' })).toEqual({
      kind: 'command',
      command: 'ls',
    });
  });

  it('omits canonical fields the call did not carry', () => {
    expect(toolAction('claude-code', 'Read', {})).toEqual({ kind: 'read', paths: undefined });
    expect(toolAction('codex', 'apply_patch', {})).toEqual({ kind: 'edit', paths: undefined });
  });
});

describe('applyPatchPaths', () => {
  it('reads every file header in a patch, including moves', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: old.txt',
      '*** Move to: new.txt',
      "*** Add File: 'quoted path.txt'",
      '*** End Patch',
    ].join('\n');
    expect(applyPatchPaths(patch)).toEqual(['old.txt', 'new.txt', 'quoted path.txt']);
  });

  it('returns nothing for a blob with no file headers', () => {
    expect(applyPatchPaths('*** Begin Patch\n*** End Patch')).toEqual([]);
  });
});

describe('redactedToolAction', () => {
  it('keeps only the kind, so a redacted call reveals nothing but its shape', () => {
    expect(
      redactedToolAction({ kind: 'command', command: 'deploy --token=hunter2' }),
    ).toEqual({ kind: 'command' });
    expect(redactedToolAction(undefined)).toEqual({ kind: 'other' });
  });
});
