/**
 * Codex CLI Hook Handlers
 *
 * Implements hooks for OpenAI Codex CLI integration.
 * Codex stores sessions in ~/.codex/sessions/ and supports hooks.
 *
 * Supported hooks:
 * - SessionStart: Called when a new session begins
 * - Stop: Called when session is stopped
 * - PreToolUse: Called before a tool is invoked
 * - PostToolUse: Called after a tool completes (with output)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createSession, type SessionManager } from '../session-manager';
import { createSessionId } from '../schema';

// Session state file for persistence across hook invocations
const SESSION_STATE_FILE = '.sessions/.codex-active-session';

interface CodexSessionStart {
  session_id: string;
  cwd: string;
  model?: string;
}

interface CodexStop {
  session_id: string;
  cwd: string;
}

interface CodexPreToolUse {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface CodexPostToolUse {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
  tool_error?: string;
}

interface ActiveCodexState {
  sessionId: string;
  currentTurnId: string | null;
  pendingToolCalls: Map<string, string>;
  model?: string;
}

/**
 * Load active session state from disk
 */
function loadSessionState(cwd: string): ActiveCodexState | null {
  const statePath = path.join(cwd, SESSION_STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      sessionId: data.sessionId,
      currentTurnId: data.currentTurnId ?? null,
      pendingToolCalls: new Map(Object.entries(data.pendingToolCalls ?? {})),
      model: data.model,
    };
  } catch {
    return null;
  }
}

/**
 * Save active session state to disk
 */
function saveSessionState(cwd: string, state: ActiveCodexState): void {
  const statePath = path.join(cwd, SESSION_STATE_FILE);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    sessionId: state.sessionId,
    currentTurnId: state.currentTurnId,
    pendingToolCalls: Object.fromEntries(state.pendingToolCalls),
    model: state.model,
  };
  fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
}

/**
 * Clear active session state
 */
function clearSessionState(cwd: string): void {
  const statePath = path.join(cwd, SESSION_STATE_FILE);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

/**
 * Get session manager for active session
 */
function getSessionManager(sessionId: string, cwd: string): SessionManager {
  return createSession({
    source: 'codex',
    cwd,
    sessionId,
  });
}

/**
 * Handle SessionStart hook
 */
export function handleSessionStart(data: CodexSessionStart): void {
  const { session_id, cwd, model } = data;

  const session = createSession({
    source: 'codex',
    cwd,
    sessionId: session_id,
  });

  const state: ActiveCodexState = {
    sessionId: session_id,
    currentTurnId: null,
    pendingToolCalls: new Map(),
    model,
  };
  saveSessionState(cwd, state);

  console.error(`[assert] Codex session started: ${session_id}`);
}

/**
 * Handle Stop hook
 */
export function handleStop(data: CodexStop): void {
  const { session_id, cwd } = data;
  const state = loadSessionState(cwd);

  if (!state || state.sessionId !== session_id) {
    console.error(`[assert] No active Codex session found: ${session_id}`);
    return;
  }

  const session = getSessionManager(session_id, cwd);
  session.end('aborted');

  clearSessionState(cwd);
  console.error(`[assert] Codex session stopped: ${session_id}`);
}

/**
 * Handle PreToolUse hook
 */
export function handlePreToolUse(data: CodexPreToolUse): void {
  const { session_id, tool_name, tool_input } = data;
  const cwd = process.cwd();
  const state = loadSessionState(cwd);

  if (!state || state.sessionId !== session_id) {
    return;
  }

  const session = getSessionManager(session_id, cwd);

  // Ensure we have a turn
  if (!state.currentTurnId) {
    state.currentTurnId = session.startAssistantTurn(state.model);
  }

  // Record the tool call
  const toolCallId = session.recordToolCall(
    state.currentTurnId,
    tool_name,
    tool_input
  );

  state.pendingToolCalls.set(tool_name, toolCallId);
  saveSessionState(cwd, state);
}

/**
 * Handle PostToolUse hook
 */
export function handlePostToolUse(data: CodexPostToolUse): void {
  const { session_id, tool_name, tool_input, tool_output, tool_error } = data;
  const cwd = process.cwd();
  const state = loadSessionState(cwd);

  if (!state || state.sessionId !== session_id) {
    return;
  }

  const toolCallId = state.pendingToolCalls.get(tool_name);
  if (!toolCallId || !state.currentTurnId) {
    return;
  }

  const session = getSessionManager(session_id, cwd);

  // Determine files modified from tool input
  let filesModified: string[] | undefined;
  const fileModifyingTools = [
    'write_file',
    'edit_file',
    'create_file',
    'patch_file',
  ];
  if (fileModifyingTools.includes(tool_name.toLowerCase())) {
    const filePath = (tool_input.path as string) || (tool_input.file as string);
    if (filePath) {
      filesModified = [filePath];
    }
  }

  session.recordToolResult(
    state.currentTurnId,
    toolCallId,
    tool_output,
    tool_error,
    filesModified
  );

  state.pendingToolCalls.delete(tool_name);
  saveSessionState(cwd, state);
}

/**
 * Process hook invocation from stdin
 */
export async function processHook(
  hookType: string,
  input: string
): Promise<void> {
  const data = JSON.parse(input);

  switch (hookType) {
    case 'SessionStart':
      handleSessionStart(data as CodexSessionStart);
      break;
    case 'Stop':
      handleStop(data as CodexStop);
      break;
    case 'PreToolUse':
      handlePreToolUse(data as CodexPreToolUse);
      break;
    case 'PostToolUse':
      handlePostToolUse(data as CodexPostToolUse);
      break;
    default:
      console.error(`[assert] Unknown Codex hook type: ${hookType}`);
  }
}
