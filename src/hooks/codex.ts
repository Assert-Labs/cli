/**
 * Codex CLI Hook Handlers
 *
 * Thin adapter that translates OpenAI Codex hook payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 *
 * Codex mirrors Claude Code's hook model: the same event names (SessionStart,
 * UserPromptSubmit, PreToolUse, PostToolUse, Stop) and the same payload fields
 * (session_id, cwd, tool_name, tool_input, tool_response, prompt). The one
 * difference that matters here: Codex has no session-end event, so `Stop`
 * (which fires per turn) is where we finalize attribution.
 */

import {
  type SessionState,
  loadState,
  saveState,
  startOrResumeSession,
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

const SOURCE = 'codex';

// Fields Codex sends on every hook event.
interface CodexBase {
  session_id: string;
  cwd: string;
  model?: string;
}

interface CodexSessionStart extends CodexBase {
  source?: string; // startup | resume | clear | compact
}

interface CodexPreToolUse extends CodexBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface CodexPostToolUse extends CodexPreToolUse {
  tool_response?: unknown;
}

interface CodexUserPromptSubmit extends CodexBase {
  prompt: string;
}

interface CodexStop extends CodexBase {
  last_assistant_message?: string | null;
}

function ensureTurn(state: SessionState, model?: string): string {
  if (!state.currentTurnId) {
    state.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
      model,
      promptTurnId: state.currentPromptId ?? undefined,
    };
    writeEvent(state.sessionId, startEvent);
  }
  return state.currentTurnId;
}

export function handleSessionStart(data: CodexSessionStart): void {
  const { resumed } = startOrResumeSession(data.session_id, SOURCE, data.cwd);
  console.error(`[assert] Codex session ${resumed ? 'resumed' : 'started'}: ${data.session_id}`);
}

export function handleUserPromptSubmit(data: CodexUserPromptSubmit): void {
  const state = loadState(data.session_id, SOURCE);
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

export function handlePreToolUse(data: CodexPreToolUse): void {
  const { session_id, tool_name, tool_input } = data;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  const turnId = ensureTurn(state, data.model);
  const toolCallId = createToolCallId();
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId,
    toolCallId,
    toolName: tool_name,
    action: resolveActionPaths(toolAction(SOURCE, tool_name, tool_input), state.cwd),
    input: tool_input,
  };
  writeEvent(session_id, event);

  state.pendingToolCalls.set(tool_name, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: CodexPostToolUse): void {
  const { session_id, tool_name, tool_input } = data;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  const toolCallId = state.pendingToolCalls.get(tool_name) || createToolCallId();

  const response = (data.tool_response ?? {}) as Record<string, unknown>;
  const tool_output =
    typeof data.tool_response === 'string'
      ? data.tool_response
      : (response.stdout as string) || (response.output as string) || undefined;
  const tool_error = (response.stderr as string) || (response.error as string) || undefined;

  // Best-effort: surface the edited files so their repos are tracked
  // (multi-repo aware) from the canonical action's paths. Attribution itself
  // comes from the git diff, not this field, so an unregistered tool just
  // means slightly less transcript metadata.
  const filesModified = recordActionFiles(
    state,
    toolAction(SOURCE, tool_name, tool_input),
  );

  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: state.currentTurnId || createTurnId(),
    toolCallId,
    output: tool_output,
    error: tool_error,
    filesModified,
  };
  writeEvent(session_id, event);

  state.pendingToolCalls.delete(tool_name);
  saveState(state);
}

export function handleStop(data: CodexStop): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;

  // Codex has no session-end hook; Stop fires at the end of each assistant
  // turn. Record the final message, close the turn, and finalize attribution.
  const message = data.last_assistant_message;
  if (message) {
    const turnId = ensureTurn(state, data.model);
    const textEvent: AssistantTextEvent = {
      type: 'assistant_text',
      timestamp: new Date().toISOString(),
      sessionId: data.session_id,
      turnId,
      text: message,
    };
    writeEvent(data.session_id, textEvent);
  }
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

export async function processHook(hookType: string, input: string): Promise<void> {
  if (captureDisabled()) return;
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as CodexSessionStart);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(data as CodexUserPromptSubmit);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as CodexPreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as CodexPostToolUse);
      break;
    case 'Stop':
      handleStop(data as CodexStop);
      break;
    default:
      console.error(`[assert] Unknown Codex hook type: ${hookType}`);
  }
}
