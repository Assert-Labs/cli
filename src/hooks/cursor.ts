/**
 * Cursor Hook Handlers
 *
 * Implements hooks for Cursor IDE integration.
 * Cursor uses hooks defined in .cursor/hooks.json
 *
 * Supported hooks:
 * - sessionStart: Called when a new agent session begins
 * - stop: Called when session is stopped
 * - onPreEdit: Called before an edit is made
 * - onPostEdit: Called after an edit completes
 */

import * as fs from 'fs';
import * as path from 'path';
import { createSession, type SessionManager } from '../session-manager';
import { createSessionId, createTurnId } from '../schema';

// Session state file for persistence across hook invocations
const SESSION_STATE_FILE = '.sessions/.cursor-active-session';

interface CursorSessionStart {
  sessionId?: string;
  workspaceRoot: string;
}

interface CursorStop {
  sessionId?: string;
  workspaceRoot: string;
}

interface CursorPreEdit {
  sessionId?: string;
  filePath: string;
  editType: 'insert' | 'replace' | 'delete';
  content?: string;
}

interface CursorPostEdit {
  sessionId?: string;
  filePath: string;
  editType: 'insert' | 'replace' | 'delete';
  success: boolean;
  error?: string;
}

interface ActiveCursorState {
  sessionId: string;
  currentTurnId: string | null;
  pendingEdits: Map<string, { turnId: string; toolCallId: string }>;
}

/**
 * Load active session state from disk
 */
function loadSessionState(cwd: string): ActiveCursorState | null {
  const statePath = path.join(cwd, SESSION_STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      sessionId: data.sessionId,
      currentTurnId: data.currentTurnId ?? null,
      pendingEdits: new Map(Object.entries(data.pendingEdits ?? {})),
    };
  } catch {
    return null;
  }
}

/**
 * Save active session state to disk
 */
function saveSessionState(cwd: string, state: ActiveCursorState): void {
  const statePath = path.join(cwd, SESSION_STATE_FILE);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    sessionId: state.sessionId,
    currentTurnId: state.currentTurnId,
    pendingEdits: Object.fromEntries(state.pendingEdits),
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
    source: 'cursor',
    cwd,
    sessionId,
  });
}

/**
 * Handle sessionStart hook
 */
export function handleSessionStart(data: CursorSessionStart): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || createSessionId();

  const session = createSession({
    source: 'cursor',
    cwd,
    sessionId,
  });

  const state: ActiveCursorState = {
    sessionId,
    currentTurnId: null,
    pendingEdits: new Map(),
  };
  saveSessionState(cwd, state);

  console.error(`[assert] Cursor session started: ${sessionId}`);
}

/**
 * Handle stop hook
 */
export function handleStop(data: CursorStop): void {
  const cwd = data.workspaceRoot || process.cwd();
  const state = loadSessionState(cwd);

  if (!state) {
    console.error('[assert] No active Cursor session found');
    return;
  }

  const session = getSessionManager(state.sessionId, cwd);
  session.end('aborted');

  clearSessionState(cwd);
  console.error(`[assert] Cursor session stopped: ${state.sessionId}`);
}

/**
 * Handle onPreEdit hook
 */
export function handlePreEdit(data: CursorPreEdit): void {
  const cwd = process.cwd();
  const state = loadSessionState(cwd);

  if (!state) {
    return;
  }

  const session = getSessionManager(state.sessionId, cwd);

  // Ensure we have a turn
  if (!state.currentTurnId) {
    state.currentTurnId = session.startAssistantTurn();
  }

  // Record the tool call
  const toolCallId = session.recordToolCall(state.currentTurnId, 'Edit', {
    file_path: data.filePath,
    edit_type: data.editType,
    content: data.content,
  });

  // Store for matching with post-edit
  state.pendingEdits.set(data.filePath, {
    turnId: state.currentTurnId,
    toolCallId,
  });
  saveSessionState(cwd, state);
}

/**
 * Handle onPostEdit hook
 */
export function handlePostEdit(data: CursorPostEdit): void {
  const cwd = process.cwd();
  const state = loadSessionState(cwd);

  if (!state) {
    return;
  }

  const pending = state.pendingEdits.get(data.filePath);
  if (!pending) {
    return;
  }

  const session = getSessionManager(state.sessionId, cwd);

  session.recordToolResult(
    pending.turnId,
    pending.toolCallId,
    data.success ? 'Edit successful' : undefined,
    data.error,
    data.success ? [data.filePath] : undefined
  );

  state.pendingEdits.delete(data.filePath);
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
    case 'sessionStart':
      handleSessionStart(data as CursorSessionStart);
      break;
    case 'stop':
      handleStop(data as CursorStop);
      break;
    case 'onPreEdit':
      handlePreEdit(data as CursorPreEdit);
      break;
    case 'onPostEdit':
      handlePostEdit(data as CursorPostEdit);
      break;
    default:
      console.error(`[assert] Unknown Cursor hook type: ${hookType}`);
  }
}
