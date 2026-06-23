/**
 * Claude Code Hook Handlers
 *
 * Thin adapter that translates Claude Code hook payloads into the shared,
 * agent-agnostic session recorder (see ./session-recorder). All repo discovery,
 * multi-repo attribution, boundaries, and .sessions/ copying live there.
 */

import {
  type SessionState,
  loadState,
  saveState,
  startSession,
  endSession,
  recordFileEdit,
  writeEvent,
} from './session-recorder';
import {
  type ToolCallEvent,
  type ToolResultEvent,
  type HumanTurnEvent,
  type AssistantTurnStartEvent,
  type AssistantTextEvent,
  createTurnId,
  createToolCallId,
} from '../schema';

const SOURCE = 'claude-code';

interface ClaudeCodeSessionStart {
  session_id: string;
  cwd: string;
}

interface ClaudeCodeSessionEnd {
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

interface ClaudeCodePreToolUse {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface ClaudeCodePostToolUse {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
  tool_error?: string;
}

interface ClaudeCodeUserPromptSubmit {
  session_id: string;
  prompt: string;
  cwd: string;
}

function ensureTurn(state: SessionState): string {
  if (!state.currentTurnId) {
    state.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      turnId: state.currentTurnId,
    };
    writeEvent(state.sessionId, startEvent);
  }
  return state.currentTurnId;
}

export function handleSessionStart(data: ClaudeCodeSessionStart): void {
  startSession(data.session_id, SOURCE, data.cwd);
  console.error(`[assert] Session started: ${data.session_id}`);
}

export function handleSessionEnd(data: ClaudeCodeSessionEnd): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) {
    console.error(`[assert] No active session found for: ${data.session_id}`);
    return;
  }
  endSession(state, 'completed', data.transcript_path);
}

export function handleStop(data: ClaudeCodeSessionEnd): void {
  const state = loadState(data.session_id, SOURCE);
  if (!state) return;
  endSession(state, 'aborted', data.transcript_path);
  console.error(`[assert] Session aborted: ${data.session_id}`);
}

export function handlePreToolUse(data: ClaudeCodePreToolUse): void {
  const { session_id, tool_name, tool_input } = data;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  const turnId = ensureTurn(state);
  const toolCallId = createToolCallId();
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId,
    toolCallId,
    toolName: tool_name,
    input: tool_input,
  };
  writeEvent(session_id, event);

  state.pendingToolCalls.set(tool_name, toolCallId);
  saveState(state);
}

export function handlePostToolUse(data: ClaudeCodePostToolUse): void {
  const { session_id, tool_name, tool_input } = data;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  const toolCallId = state.pendingToolCalls.get(tool_name) || createToolCallId();

  const tool_response = ((data as any).tool_response || {}) as Record<string, unknown>;
  const tool_output = (tool_response.stdout as string) || undefined;
  const tool_error = (tool_response.stderr as string) || undefined;

  // Resolve the edited file's repo and track it (multi-repo aware).
  let filesModified: string[] | undefined;
  const filePath = tool_input.file_path as string | undefined;
  if (filePath) {
    const relativePath = recordFileEdit(state, filePath);
    if (relativePath) {
      filesModified = [relativePath];
    }
  }

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

export function handleUserPromptSubmit(data: ClaudeCodeUserPromptSubmit): void {
  const { session_id, prompt } = data;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  // A new human turn ends any in-progress assistant turn.
  state.currentTurnId = null;

  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: createTurnId(),
    content: prompt,
  };
  writeEvent(session_id, event);

  saveState(state);
}

export function handleMessageDisplay(data: Record<string, unknown>): void {
  const session_id = data.session_id as string;
  const delta = (data.delta || '') as string;
  if (!delta) return;

  const state = loadState(session_id, SOURCE);
  if (!state) return;

  const turnId = ensureTurn(state);
  const event: AssistantTextEvent = {
    type: 'assistant_text',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId,
    text: delta,
  };
  writeEvent(session_id, event);

  saveState(state);
}

export async function processHook(hookType: string, input: string): Promise<void> {
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as ClaudeCodeSessionStart);
      break;
    case 'SessionEnd':
      handleSessionEnd(data as ClaudeCodeSessionEnd);
      break;
    case 'Stop':
      handleStop(data as ClaudeCodeSessionEnd);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as ClaudeCodePreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as ClaudeCodePostToolUse);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(data as ClaudeCodeUserPromptSubmit);
      break;
    case 'MessageDisplay':
      handleMessageDisplay(data);
      break;
    default:
      console.error(`[assert] Unknown hook type: ${hookType}`);
  }
}
