/**
 * Cursor Hook Handlers
 *
 * Thin adapter that translates Cursor hook payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 *
 * Supported hooks (camelCase per Cursor docs): sessionStart, sessionEnd, stop,
 * preToolUse, postToolUse, beforeSubmitPrompt, afterAgentResponse, afterFileEdit.
 */

import * as path from 'path';
import {
  type SessionState,
  loadState,
  saveState,
  startSession,
  endSession,
  syncSession,
  recordFileEdit,
  writeEvent,
  findSessionIdForWorkspace,
  captureDisabled,
} from './session-recorder';
import {
  type ToolCallEvent,
  type ToolResultEvent,
  type HumanTurnEvent,
  type AssistantTurnStartEvent,
  createSessionId,
  createTurnId,
  createToolCallId,
} from '../schema';

const SOURCE = 'cursor';

interface CursorSessionStart {
  sessionId?: string;
  workspaceRoot?: string;
}

interface CursorSessionEnd {
  sessionId?: string;
  workspaceRoot?: string;
}

interface CursorToolUse {
  sessionId?: string;
  workspaceRoot?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  filePath?: string;
  editType?: string;
  content?: string;
  success?: boolean;
  error?: string;
}

interface CursorPrompt {
  sessionId?: string;
  workspaceRoot?: string;
  content?: string;
}

/** Resolve the session id for a hook that may omit it. */
function resolveSessionId(data: { sessionId?: string; workspaceRoot?: string }): string | null {
  if (data.sessionId) return data.sessionId;
  const cwd = data.workspaceRoot || process.cwd();
  return findSessionIdForWorkspace(cwd, SOURCE);
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

export function handleSessionStart(data: CursorSessionStart): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || createSessionId();
  startSession(sessionId, SOURCE, cwd);
  console.error(`[assert] Cursor session started: ${sessionId}`);
}

export function handleSessionEnd(data: CursorSessionEnd): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) {
    console.error('[assert] No active Cursor session found');
    return;
  }
  const state = loadState(sessionId, SOURCE);
  if (!state) return;
  endSession(state, 'completed');
}

export function handleStop(data: CursorSessionEnd): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;
  // End of a turn, not the session: sync changes so far, keep the session open.
  state.currentTurnId = null;
  saveState(state);
  syncSession(state);
}

export function handlePreToolUse(data: CursorToolUse): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;

  const turnId = ensureTurn(state);
  const toolCallId = createToolCallId();
  const toolName = data.toolName || 'Edit';
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId,
    turnId,
    toolCallId,
    toolName,
    input: data.toolInput || { filePath: data.filePath, editType: data.editType },
  };
  writeEvent(sessionId, event);

  // Key pending calls by filePath (Cursor matches results by file).
  state.pendingToolCalls.set(data.filePath || toolName, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: CursorToolUse): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;

  const filePath = data.filePath;
  const key = filePath || data.toolName || 'Edit';
  const toolCallId = state.pendingToolCalls.get(key) || createToolCallId();

  // Track the edit against its own repo (multi-repo aware). Cursor may give an
  // absolute or workspace-relative path.
  let filesModified: string[] | undefined;
  if (data.success && filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(state.cwd, filePath);
    const relativePath = recordFileEdit(state, absPath);
    if (relativePath) {
      filesModified = [relativePath];
    }
  }

  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId,
    turnId: state.currentTurnId || createTurnId(),
    toolCallId,
    output: data.success ? 'Edit successful' : undefined,
    error: data.error,
    filesModified,
  };
  writeEvent(sessionId, event);

  state.pendingToolCalls.delete(key);
  saveState(state);
}

export function handleBeforeSubmitPrompt(data: CursorPrompt): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;

  const promptTurnId = createTurnId();
  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId,
    turnId: promptTurnId,
    content: data.content || '',
  };
  writeEvent(sessionId, event);

  state.currentTurnId = null;
  // The next assistant turn links back to this prompt.
  state.currentPromptId = promptTurnId;
  saveState(state);
}

export function handleAfterAgentResponse(data: CursorPrompt): void {
  const sessionId = resolveSessionId(data);
  if (!sessionId) return;
  const state = loadState(sessionId, SOURCE);
  if (!state) return;

  if (state.currentTurnId) {
    writeEvent(sessionId, {
      type: 'assistant_turn_end',
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: state.currentTurnId,
    });
    state.currentTurnId = null;
    saveState(state);
  }
}

export function handleAfterFileEdit(data: CursorToolUse): void {
  handlePostToolUse(data);
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
