/**
 * OpenCode Hook Handlers
 *
 * Thin adapter that translates OpenCode plugin payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 *
 * OpenCode's plugin model is in-process JS/TS callbacks, not per-event
 * subprocesses. The plugin we install (see generateOpenCodePlugin in
 * ../plugins) is a thin shim that forwards each callback to `assert hook
 * opencode <Event>` with a JSON payload on stdin — so from here on the model is
 * identical to the other agents. The shim normalizes OpenCode's hook names to
 * the Claude/Codex-style events used below and injects `cwd` (OpenCode's
 * per-event payloads don't carry it) and the current `model` on every event.
 *
 * Like Codex, OpenCode has no reliable session-end for a normal exit; `Stop`
 * (mapped from `session.idle`, fired when the assistant goes idle) is where we
 * finalize attribution per turn. `SessionEnd` (from `session.deleted`) is a
 * best-effort close.
 */

import {
  type SessionState,
  loadState,
  saveState,
  startOrResumeSession,
  endSession,
  syncSession,
  recordActionFiles,
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

const SOURCE = 'opencode';

// Fields the plugin shim sends on every event.
interface OpenCodeBase {
  session_id: string;
  cwd: string;
  model?: string;
  provider?: string;
}

interface OpenCodeUserPromptSubmit extends OpenCodeBase {
  prompt: string;
}

interface OpenCodePreToolUse extends OpenCodeBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
  call_id?: string;
}

interface OpenCodePostToolUse extends OpenCodePreToolUse {
  tool_response?: unknown;
}

interface OpenCodeAssistantText extends OpenCodeBase {
  text: string;
}

/**
 * Load the session, starting it if we haven't seen it yet. OpenCode fires
 * `session.created` for new sessions, but a plugin loaded mid-session (or a
 * resumed session) may surface a prompt/tool event first — so lazily start it
 * from the cwd rather than dropping the event.
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

export function handleSessionStart(data: OpenCodeBase): void {
  const { resumed } = startOrResumeSession(data.session_id, SOURCE, data.cwd);
  console.error(
    `[assert] OpenCode session ${resumed ? 'resumed' : 'started'}: ${data.session_id}`,
  );
}

export function handleUserPromptSubmit(data: OpenCodeUserPromptSubmit): void {
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

export function handlePreToolUse(data: OpenCodePreToolUse): void {
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

  // OpenCode gives a stable callID per tool call — key pending calls on it so
  // the result matches even when the same tool runs concurrently.
  state.pendingToolCalls.set(data.call_id || data.tool_name, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: OpenCodePostToolUse): void {
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
  const filesModified = recordActionFiles(
    state,
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
  };
  writeEvent(data.session_id, event);

  state.pendingToolCalls.delete(key);
  saveState(state);
}

export function handleAssistantText(data: OpenCodeAssistantText): void {
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

export function handleStop(data: OpenCodeBase): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;

  // OpenCode has no session-end hook on a normal exit; `session.idle` fires
  // when the assistant finishes a turn. Close the turn and finalize attribution.
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

export function handleSessionEnd(data: OpenCodeBase): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;
  endSession(state, 'completed');
}

export async function processHook(hookType: string, input: string): Promise<void> {
  if (captureDisabled()) return;
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as OpenCodeBase);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(data as OpenCodeUserPromptSubmit);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as OpenCodePreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as OpenCodePostToolUse);
      break;
    case 'AssistantText':
      handleAssistantText(data as OpenCodeAssistantText);
      break;
    case 'Stop':
      handleStop(data as OpenCodeBase);
      break;
    case 'SessionEnd':
      handleSessionEnd(data as OpenCodeBase);
      break;
    default:
      console.error(`[assert] Unknown OpenCode hook type: ${hookType}`);
  }
}
