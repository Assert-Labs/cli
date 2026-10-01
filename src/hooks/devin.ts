/**
 * Devin Hook Handlers
 *
 * Thin adapter that translates Devin hook payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder).
 *
 * Devin speaks Claude Code's hook protocol: the same event names and the same
 * payload fields (`session_id`, `tool_name`, `tool_input`, `tool_use_id`,
 * `tool_response`, `prompt`), plus a per-turn `prompt_id`. Two differences
 * matter here, both seen in real cloud sessions:
 *
 * - No `cwd` on any event. The hook process gets `DEVIN_PROJECT_DIR` instead,
 *   and runs from `/`, so the working directory is resolved from the
 *   environment (or the shell tool's `workdir`) rather than the process.
 * - `SessionStart` can be missed when the plugin finishes loading after the
 *   session began, so every event opens the session lazily if needed.
 *
 * `Stop` fires per turn; `SessionEnd` fires when the session really ends.
 */

import {
  type SessionState,
  loadState,
  saveState,
  startOrResumeSession,
  syncSession,
  endSession,
  beginToolCallEdit,
  changesForToolCall,
  resolveActionPaths,
  writeEvent,
  captureDisabled,
} from './session-recorder';
import {
  type ToolCallEvent,
  type ToolResultEvent,
  type HumanTurnEvent,
  type AssistantTurnStartEvent,
  type AssistantTurnEndEvent,
  createTurnId,
  createToolCallId,
} from '../schema';
import { toolAction } from '../tool-actions';

const SOURCE = 'devin';

interface DevinBase {
  session_id: string;
  hook_event_name?: string;
  prompt_id?: string;
  cwd?: string;
}

interface DevinSessionStart extends DevinBase {
  source?: string;
}

interface DevinSessionEnd extends DevinBase {
  reason?: string;
}

interface DevinUserPromptSubmit extends DevinBase {
  prompt: string;
}

interface DevinPreToolUse extends DevinBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

interface DevinPostToolUse extends DevinPreToolUse {
  tool_response?: { success?: boolean; output?: string | null; error?: string | null } | string;
}

/**
 * The project directory for a session. Devin never sends `cwd`; its hook
 * processes carry `DEVIN_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`), and its
 * shell tool names a `workdir`. The process cwd is the last resort.
 */
export function resolveCwd(
  data: DevinBase & { tool_input?: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const workdir = data.tool_input?.workdir;
  return (
    data.cwd ||
    env.DEVIN_PROJECT_DIR ||
    env.CLAUDE_PROJECT_DIR ||
    (typeof workdir === 'string' && workdir) ||
    process.cwd()
  );
}

/** The session's state, opening the session first if this is its first event. */
function ensureState(data: DevinBase & { tool_input?: Record<string, unknown> }): SessionState {
  return loadState(data.session_id, SOURCE) ?? startOrResumeSession(data.session_id, SOURCE, resolveCwd(data)).state;
}

function ensureTurn(state: SessionState): string {
  if (!state.currentTurnId) {
    state.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
      promptTurnId: state.currentPromptId ?? undefined,
    };
    writeEvent(state.sessionId, startEvent);
  }
  return state.currentTurnId;
}

export function handleSessionStart(data: DevinSessionStart): void {
  const { resumed } = startOrResumeSession(data.session_id, SOURCE, resolveCwd(data));
  console.error(`[assert] Devin session ${resumed ? 'resumed' : 'started'}: ${data.session_id}`);
}

export function handleSessionEnd(data: DevinSessionEnd): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;
  endSession(state, data.reason === 'aborted' ? 'aborted' : 'completed');
}

export function handleUserPromptSubmit(data: DevinUserPromptSubmit): void {
  const state = ensureState(data);

  // A new human turn ends any in-progress assistant turn.
  state.currentTurnId = null;

  const promptTurnId = createTurnId();
  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId: data.session_id,
    turnId: promptTurnId,
    content: data.prompt,
  };
  writeEvent(data.session_id, event);

  state.currentPromptId = promptTurnId;
  saveState(state);
}

export function handlePreToolUse(data: DevinPreToolUse): void {
  const { session_id, tool_name, tool_input } = data;
  const state = ensureState(data);

  const turnId = ensureTurn(state);
  const toolCallId = data.tool_use_id ?? createToolCallId();
  const action = toolAction(SOURCE, tool_name, tool_input);
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId,
    toolCallId,
    toolName: tool_name,
    action: resolveActionPaths(action, state.cwd),
    input: tool_input,
  };
  writeEvent(session_id, event);

  beginToolCallEdit(state, toolCallId, action);
  state.pendingToolCalls.set(data.tool_use_id ?? tool_name, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: DevinPostToolUse): void {
  const { session_id, tool_name, tool_input } = data;
  const state = ensureState(data);

  const pendingKey = data.tool_use_id ?? tool_name;
  const toolCallId =
    data.tool_use_id ?? state.pendingToolCalls.get(pendingKey) ?? createToolCallId();

  const response = data.tool_response;
  const output =
    typeof response === 'string' ? response : response?.output || undefined;
  const error = typeof response === 'string' ? undefined : response?.error || undefined;

  const { changes, filesModified } = changesForToolCall(
    state,
    toolCallId,
    toolAction(SOURCE, tool_name, tool_input),
  );

  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: state.currentTurnId || createTurnId(),
    toolCallId,
    output,
    error,
    filesModified,
    changes,
  };
  writeEvent(session_id, event);

  state.pendingToolCalls.delete(pendingKey);
  saveState(state);
}

export function handleStop(data: DevinBase): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;

  if (state.currentTurnId) {
    const endEvent: AssistantTurnEndEvent = {
      type: 'assistant_turn_end',
      timestamp: new Date().toISOString(),
      sessionId: data.session_id,
      turnId: state.currentTurnId,
    };
    writeEvent(data.session_id, endEvent);
  }
  state.currentTurnId = null;
  saveState(state);
  // Turn boundary: finalize this turn's attribution, keep the session open.
  syncSession(state, undefined, true);
}

export async function processHook(hookType: string, input: string): Promise<void> {
  if (captureDisabled()) return;
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as DevinSessionStart);
      break;
    case 'SessionEnd':
      handleSessionEnd(data as DevinSessionEnd);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(data as DevinUserPromptSubmit);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as DevinPreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as DevinPostToolUse);
      break;
    case 'Stop':
      handleStop(data as DevinBase);
      break;
    case 'PermissionRequest':
    case 'PostCompaction':
      break; // subscribed for completeness; nothing to record
    default:
      console.error(`[assert] Unknown Devin hook type: ${hookType}`);
  }
}
