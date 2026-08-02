/**
 * Pi Hook Handlers
 *
 * Thin adapter that translates Pi (pi.dev) extension payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 *
 * Pi's extension model is in-process TypeScript callbacks, not per-event
 * subprocesses. The extension we install (see generatePiExtension in ../plugins)
 * is a thin shim that forwards each callback to `assert hook pi <Event>` with a
 * JSON payload on stdin — so from here on the model is identical to the other
 * agents. The shim normalizes Pi's event names to the Claude/Codex-style events
 * used below and injects `cwd`, `session_id`, and the current model on each.
 *
 * Unlike Codex/OpenCode, Pi fires a reliable `session_shutdown` on exit, so
 * `SessionEnd` closes the session cleanly. `Stop` (from `agent_settled`, fired
 * when Pi finishes a response and will not continue automatically) finalizes
 * attribution per turn.
 */

import {
  type SessionState,
  loadState,
  saveState,
  startOrResumeSession,
  endSession,
  syncSession,
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
  type AssistantTextEvent,
  type AssistantTurnEndEvent,
  createTurnId,
  createToolCallId,
} from '../schema';
import { toolAction } from '../tool-actions';

const SOURCE = 'pi';

// Fields the extension shim sends on every event.
interface PiBase {
  session_id: string;
  cwd: string;
  model?: string;
  provider?: string;
}

interface PiUserPromptSubmit extends PiBase {
  prompt: string;
}

interface PiPreToolUse extends PiBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
  call_id?: string;
}

interface PiPostToolUse extends PiPreToolUse {
  tool_response?: unknown;
}

interface PiAssistantText extends PiBase {
  text: string;
}

/**
 * Load the session, starting it if we haven't seen it yet. Pi fires
 * `session_start` at startup, but a shim loaded mid-session (or a resumed
 * session) may surface a prompt/tool event first — so lazily start it from the
 * cwd rather than dropping the event.
 */
function ensureSession(sessionId: string, cwd: string): SessionState | null {
  const existing = loadState(sessionId, SOURCE);
  if (existing) return existing;
  return startOrResumeSession(sessionId, SOURCE, cwd).state;
}

function ensureTurn(state: SessionState, model?: string, provider?: string): string {
  if (!state.currentTurnId) {
    state.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
      model,
      provider,
      promptTurnId: state.currentPromptId ?? undefined,
    };
    writeEvent(state.sessionId, startEvent);
  }
  return state.currentTurnId;
}

export function handleSessionStart(data: PiBase): void {
  const { resumed } = startOrResumeSession(data.session_id, SOURCE, data.cwd);
  console.error(`[assert] Pi session ${resumed ? 'resumed' : 'started'}: ${data.session_id}`);
}

export function handleUserPromptSubmit(data: PiUserPromptSubmit): void {
  const state = ensureSession(data.session_id, data.cwd);
  if (!state) return;

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

  // The next assistant turn links back to this prompt.
  state.currentPromptId = promptTurnId;
  saveState(state);
}

export function handlePreToolUse(data: PiPreToolUse): void {
  const state = ensureSession(data.session_id, data.cwd);
  if (!state) return;

  const turnId = ensureTurn(state, data.model, data.provider);
  const toolCallId = createToolCallId();
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: data.session_id,
    turnId,
    toolCallId,
    toolName: data.tool_name,
    action: resolveActionPaths(
      toolAction(SOURCE, data.tool_name, data.tool_input),
      state.cwd,
    ),
    input: data.tool_input,
  };
  writeEvent(data.session_id, event);

  // Pi gives a stable toolCallId per call — key pending calls on it so the
  // result matches even when the same tool runs concurrently.
  beginToolCallEdit(state, toolCallId, toolAction(SOURCE, data.tool_name, data.tool_input ?? {}));
  state.pendingToolCalls.set(data.call_id || data.tool_name, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: PiPostToolUse): void {
  const state = ensureSession(data.session_id, data.cwd);
  if (!state) return;

  const key = data.call_id || data.tool_name;
  const toolCallId = state.pendingToolCalls.get(key) || createToolCallId();

  const response = (data.tool_response ?? {}) as Record<string, unknown>;
  const tool_output =
    typeof data.tool_response === 'string'
      ? data.tool_response
      : (response.output as string) || undefined;
  const tool_error = (response.error as string) || undefined;

  // Best-effort: surface the edited file(s) so their repo is tracked (multi-repo
  // aware). Attribution itself comes from the git diff, not this field.
  const { changes, filesModified } = changesForToolCall(
    state,
    toolCallId,
    toolAction(SOURCE, data.tool_name, data.tool_input ?? {}),
  );

  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId: data.session_id,
    turnId: state.currentTurnId || createTurnId(),
    toolCallId,
    output: tool_output,
    error: tool_error,
    filesModified,
    changes,
  };
  writeEvent(data.session_id, event);

  state.pendingToolCalls.delete(key);
  saveState(state);
}

export function handleAssistantText(data: PiAssistantText): void {
  const state = ensureSession(data.session_id, data.cwd);
  if (!state) return;
  if (!data.text) return;

  const turnId = ensureTurn(state, data.model, data.provider);
  const event: AssistantTextEvent = {
    type: 'assistant_text',
    timestamp: new Date().toISOString(),
    sessionId: data.session_id,
    turnId,
    text: data.text,
  };
  writeEvent(data.session_id, event);
  saveState(state);
}

export function handleStop(data: PiBase): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;

  // `agent_settled` fires when Pi finishes a response. Close the turn and
  // finalize attribution; the session stays open until session_shutdown.
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
  // Finalize: writes portable attribution + boundaries, idempotently per turn.
  syncSession(state, undefined, true);
}

export function handleSessionEnd(data: PiBase): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;
  endSession(state, 'completed');
}

export async function processHook(hookType: string, input: string): Promise<void> {
  if (captureDisabled()) return;
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as PiBase);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(data as PiUserPromptSubmit);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as PiPreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as PiPostToolUse);
      break;
    case 'AssistantText':
      handleAssistantText(data as PiAssistantText);
      break;
    case 'Stop':
      handleStop(data as PiBase);
      break;
    case 'SessionEnd':
      handleSessionEnd(data as PiBase);
      break;
    default:
      console.error(`[assert] Unknown Pi hook type: ${hookType}`);
  }
}
