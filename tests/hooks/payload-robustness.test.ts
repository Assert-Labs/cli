/**
 * Hook payloads are untrusted input: JSON on stdin from an agent whose shape we
 * don't control and which changes between releases. Throwing is worse than
 * producing a wrong value, because the agent reports the hook as completed
 * either way and the event is lost with no trace.
 *
 * Every agent, every hook, every degenerate payload: never throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { processHook, type AgentType } from '../../src/hooks/index';

/** The hook names each adapter dispatches on. */
const HOOKS: Record<AgentType, string[]> = {
  'claude-code': [
    'SessionStart',
    'SessionEnd',
    'Stop',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'MessageDisplay',
  ],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
  cursor: [
    'sessionStart',
    'sessionEnd',
    'stop',
    'preToolUse',
    'postToolUse',
    'beforeSubmitPrompt',
    'afterAgentResponse',
    'afterFileEdit',
  ],
  opencode: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'AssistantText',
    'Stop',
    'SessionEnd',
  ],
  pi: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'AssistantText',
    'Stop',
    'SessionEnd',
  ],
};

/** Payload shapes an agent might plausibly hand us, none of them valid. */
const DEGENERATE: Array<[string, string]> = [
  ['empty object', '{}'],
  ['null fields', '{"session_id":null,"tool_name":null,"tool_input":null,"cwd":null}'],
  ['wrong types', '{"session_id":42,"tool_name":[],"tool_input":"nope","cwd":true}'],
  ['nested nulls', '{"session_id":"s","tool_name":"Bash","tool_input":{"command":null}}'],
  ['renamed fields', '{"sessionID":"s","toolname":"Bash","args":{"cmd":"ls"}}'],
  ['array payload', '[]'],
  ['bare string', '"hello"'],
  ['empty string field', '{"session_id":"","tool_name":"","tool_input":{}}'],
  ['unicode + control chars', '{"session_id":"s","tool_name":"\\u0000\\ud83d\\ude00","tool_input":{}}'],
];

describe('hook payload robustness', () => {
  let originalHome: string | undefined;
  let home: string;
  let repo: string;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-robust-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-robust-repo-')));
    process.env.HOME = home;
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name test', { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'base.ts'), 'const base = 1;\n');
    execSync('git add . && git commit -m init', { cwd: repo, stdio: 'pipe' });
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (const agent of Object.keys(HOOKS) as AgentType[]) {
    describe(agent, () => {
      for (const hookType of HOOKS[agent]) {
        for (const [label, payload] of DEGENERATE) {
          it(`survives ${hookType} with ${label}`, async () => {
            await expect(processHook(agent, hookType, payload)).resolves.not.toThrow();
          });
        }
      }

      it('survives an unknown hook type', async () => {
        await expect(processHook(agent, 'NoSuchHook', '{}')).resolves.not.toThrow();
      });
    });
  }
});
