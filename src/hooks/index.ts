/**
 * Hook Entry Point
 *
 * Routes hook invocations to the appropriate handler.
 */

import * as claudeCode from './claude-code';
import * as cursor from './cursor';
import * as codex from './codex';
import * as opencode from './opencode';

export type AgentType = 'claude-code' | 'cursor' | 'codex' | 'opencode';

/**
 * Process a hook invocation
 */
export async function processHook(
  agent: AgentType,
  hookType: string,
  input: string
): Promise<void> {
  switch (agent) {
    case 'claude-code':
      await claudeCode.processHook(hookType, input);
      break;
    case 'cursor':
      await cursor.processHook(hookType, input);
      break;
    case 'codex':
      await codex.processHook(hookType, input);
      break;
    case 'opencode':
      await opencode.processHook(hookType, input);
      break;
    default:
      console.error(`[assert] Unknown agent type: ${agent}`);
  }
}
