/**
 * Cursor Hook Handlers
 *
 * Thin adapter that translates Cursor hook payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 *
 * Supported hooks (camelCase per Cursor docs): sessionStart, sessionEnd, stop,
 * preToolUse, postToolUse, beforeSubmitPrompt, afterAgentResponse, afterFileEdit.
 *
 * Cursor names the *hooks* in camelCase but the *payload fields* in snake_case
 * (`session_id`, `tool_name`, `tool_input`, `workspace_roots`, `prompt`). See
 * tests/fixtures/cursor-payloads.json, captured from Cursor 3.13. Everything
 * here is read defensively: these fields come off hook stdin, so none of them
 * is guaranteed, and a missing one must degrade rather than throw. Older
 * Cursor builds used camelCase payloads, so both spellings are accepted.
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
  findSessionIdForWorkspace,
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
import { toolAction, type ToolAction } from '../tool-actions';

const SOURCE = 'cursor';

/** Fields Cursor puts on every hook payload. All optional: untrusted input. */
interface CursorBase {
  session_id?: string;
  conversation_id?: string;
  workspace_roots?: string[];
  model?: string;
  model_id?: string;
  // Pre-3.x spellings.
  sessionId?: string;
  workspaceRoot?: string;
}

interface CursorToolUse extends CursorBase {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  tool_use_id?: string;
  duration?: number;
  // Pre-3.x spellings, plus the flat shape afterFileEdit still uses.
  toolName?: string;
  toolInput?: Record<string, unknown>;
  file_path?: string;
  filePath?: string;
  editType?: string;
  success?: boolean;
  error?: string;
}

interface CursorPrompt extends CursorBase {
  prompt?: string;
  content?: string; // pre-3.x
}

interface CursorAgentResponse extends CursorBase {
  text?: string;
}

/** Cursor's id for the conversation. */
function payloadSessionId(data: CursorBase): string | undefined {
  return data.session_id ?? data.sessionId ?? data.conversation_id;
}

/**
 * The workspace this hook belongs to. Cursor runs hooks with the *plugin*
 * directory as cwd on most events, so `process.cwd()` is a last resort that
 * would otherwise attribute the session to `~/.cursor/plugins/...` instead of
 * the user's repo.
 */
function workspaceRoot(data: CursorBase): string {
  return (
    data.workspace_roots?.[0] ??
    data.workspaceRoot ??
    process.env.CURSOR_PROJECT_DIR ??
    process.cwd()
  );
}

function modelId(data: CursorBase): string | undefined {
  return data.model_id ?? data.model;
}

/** Resolve the session id for a hook that may omit it. */
function resolveSessionId(data: CursorBase): string | null {
  return payloadSessionId(data) ?? findSessionIdForWorkspace(workspaceRoot(data), SOURCE);
}

/**
 * Load the session, starting it if we haven't seen it yet. A plugin enabled
 * mid-conversation surfaces a prompt or tool event before any sessionStart.
 */
function ensureSession(data: CursorBase): SessionState | null {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return null;
  return loadState(sessionId, SOURCE) ?? startOrResumeSession(sessionId, SOURCE, workspaceRoot(data)).state;
}

/**
 * The canonical action for a Cursor tool event. `afterFileEdit` names the file
 * at the top level rather than inside `tool_input` and doesn't name a tool at
 * all. In Cursor that shape is always an edit of that file.
 */
function cursorAction(data: CursorToolUse): ToolAction {
  const name = data.tool_name ?? data.toolName ?? '';
  const input = data.tool_input ?? data.toolInput ?? {};
  const action = toolAction(SOURCE, name, input);
  const flatPath = data.file_path ?? data.filePath;
  if (!flatPath || action.paths?.length) return action;
  if (action.kind === 'other') return { kind: 'edit', paths: [flatPath] };
  return { ...action, paths: [flatPath] };
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

export function handleSessionStart(data: CursorBase): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const { resumed } = startOrResumeSession(sessionId, SOURCE, workspaceRoot(data));
  console.error(`[assert] Cursor session ${resumed ? 'resumed' : 'started'}: ${sessionId}`);
}

export function handleSessionEnd(data: CursorBase): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) {
    console.error('[assert] No active Cursor session found');
    return;
  }
  const state = loadState(sessionId, SOURCE);
  if (!state) return;
  endSession(state, 'completed');
}

export function handleStop(data: CursorBase): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;

  // End of a turn, not the session: close the turn, finalize this turn's
  // attribution and materialize it, keeping the session open.
  if (state.currentTurnId) {
    const endEvent: AssistantTurnEndEvent = {
      type: 'assistant_turn_end',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
    };
    writeEvent(state.sessionId, endEvent);
  }
  state.currentTurnId = null;
  saveState(state);
  syncSession(state, undefined, true);
}

export function handlePreToolUse(data: CursorToolUse): void {
  const state = ensureSession(data);
  if (!state) return;

  const turnId = ensureTurn(state, modelId(data));
  const toolCallId = createToolCallId();
  const toolName = data.tool_name ?? data.toolName ?? 'Edit';
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    turnId,
    toolCallId,
    toolName,
    action: resolveActionPaths(cursorAction(data), state.cwd),
    input: data.tool_input ?? data.toolInput,
  };
  writeEvent(state.sessionId, event);

  // Cursor gives a stable tool_use_id, so key pending calls on it and the result
  // matches even when the same tool runs twice in a turn.
  state.pendingToolCalls.set(data.tool_use_id ?? data.file_path ?? toolName, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: CursorToolUse): void {
  const state = ensureSession(data);
  if (!state) return;

  const toolName = data.tool_name ?? data.toolName ?? 'Edit';
  const key = data.tool_use_id ?? data.file_path ?? toolName;
  const toolCallId = state.pendingToolCalls.get(key) || createToolCallId();

  // Track edits against their own repo (multi-repo aware).
  const filesModified = recordActionFiles(state, cursorAction(data));

  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    turnId: state.currentTurnId || createTurnId(),
    toolCallId,
    output: data.tool_output ?? (data.success ? 'Edit successful' : undefined),
    error: data.error,
    filesModified,
  };
  writeEvent(state.sessionId, event);

  state.pendingToolCalls.delete(key);
  saveState(state);
}

export function handleBeforeSubmitPrompt(data: CursorPrompt): void {
  const state = ensureSession(data);
  if (!state) return;

  const promptTurnId = createTurnId();
  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    turnId: promptTurnId,
    content: data.prompt ?? data.content ?? '',
  };
  writeEvent(state.sessionId, event);

  state.currentTurnId = null;
  // The next assistant turn links back to this prompt.
  state.currentPromptId = promptTurnId;
  saveState(state);
}

export function handleAfterAgentResponse(data: CursorAgentResponse): void {
  const state = ensureSession(data);
  if (!state) return;

  if (data.text) {
    const turnId = ensureTurn(state, modelId(data));
    const textEvent: AssistantTextEvent = {
      type: 'assistant_text',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId,
      text: data.text,
    };
    writeEvent(state.sessionId, textEvent);
  }

  if (state.currentTurnId) {
    writeEvent(state.sessionId, {
      type: 'assistant_turn_end',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
    });
    state.currentTurnId = null;
  }
  saveState(state);
}

/**
 * Cursor reports a file edit both as a tool call (pre/postToolUse) and as
 * `afterFileEdit`. The tool call already recorded the transcript, so this only
 * makes sure the edited file's repo is tracked. Emitting a second tool_call
 * here would double-count the edit.
 */
export function handleAfterFileEdit(data: CursorToolUse): void {
  const state = ensureSession(data);
  if (!state) return;
  const filePath = data.file_path ?? data.filePath;
  if (!filePath) return;
  // Via the canonical action so a relative path resolves against the session's
  // workspace. Resolving it against the process cwd instead would track (and
  // publish into) whatever repo the hook process happens to be running in.
  recordActionFiles(state, { kind: 'edit', paths: [filePath] });
  saveState(state);
}

export async function processHook(hookType: string, input: string): Promise<void> {
  if (captureDisabled()) return;
  const data = JSON.parse(input);

  switch (hookType) {
    case 'sessionStart':
      handleSessionStart(data);
      break;
    case 'sessionEnd':
      handleSessionEnd(data);
      break;
    case 'stop':
      handleStop(data);
      break;
    case 'preToolUse':
      handlePreToolUse(data);
      break;
    case 'postToolUse':
      handlePostToolUse(data);
      break;
    case 'beforeSubmitPrompt':
      handleBeforeSubmitPrompt(data);
      break;
    case 'afterAgentResponse':
      handleAfterAgentResponse(data);
      break;
    case 'afterFileEdit':
      handleAfterFileEdit(data);
      break;
    default:
      console.error(`[assert] Unknown Cursor hook type: ${hookType}`);
  }
}
