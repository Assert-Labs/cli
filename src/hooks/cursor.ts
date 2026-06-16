/**
 * Cursor Hook Handlers
 *
 * Implements hooks for Cursor IDE integration.
 * Uses central storage at ~/.assert/sessions/
 *
 * Supported hooks (camelCase per Cursor docs):
 * - sessionStart: Called when a new agent session begins
 * - sessionEnd: Called when session ends normally
 * - stop: Called when session is stopped/aborted
 * - preToolUse: Called before a tool is used
 * - postToolUse: Called after a tool completes
 * - beforeSubmitPrompt: Called before user prompt is submitted
 * - afterAgentResponse: Called after agent responds
 * - afterFileEdit: Called after a file is edited
 */

import * as fs from 'fs';
import * as path from 'path';
import { createSessionWriter, type SessionWriter } from '../session-writer';
import { findGitRoot, getGitState } from '../git-watcher';
import { getOrCreateRepoId } from '../repo-identity';
import {
  loadIndex,
  saveIndex,
  indexSession,
  indexFileModification,
  endSession as endSessionIndex,
  getSessionsDir,
  ensureSessionsDir,
} from '../session-index';
import { recordBoundary, calculateAgentChanges } from '../boundaries';
import {
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type HumanTurnEvent,
  type AssistantTurnStartEvent,
  createSessionId,
  createTurnId,
  createToolCallId,
} from '../schema';

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

interface ActiveCursorState {
  sessionId: string;
  repoId: string | null;
  gitRoot: string | null;
  cwd: string;
  currentTurnId: string | null;
  pendingToolCalls: Map<string, string>;
  filesModified: string[];
}

/**
 * Get path to session state file (in central location)
 */
function getSessionStatePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.cursor-state.json`);
}

/**
 * Load active session state from disk
 */
function loadSessionState(sessionId: string): ActiveCursorState | null {
  const statePath = getSessionStatePath(sessionId);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      sessionId: data.sessionId,
      repoId: data.repoId ?? null,
      gitRoot: data.gitRoot ?? null,
      cwd: data.cwd,
      currentTurnId: data.currentTurnId ?? null,
      pendingToolCalls: new Map(Object.entries(data.pendingToolCalls ?? {})),
      filesModified: data.filesModified ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Find session ID from workspace root (for hooks that don't pass sessionId)
 */
function findSessionIdForWorkspace(workspaceRoot: string): string | null {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return null;

  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.cursor-state.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
      if (data.cwd === workspaceRoot || data.gitRoot === workspaceRoot) {
        return data.sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Save active session state to disk
 */
function saveSessionState(state: ActiveCursorState): void {
  ensureSessionsDir();
  const statePath = getSessionStatePath(state.sessionId);
  const data = {
    sessionId: state.sessionId,
    repoId: state.repoId,
    gitRoot: state.gitRoot,
    cwd: state.cwd,
    currentTurnId: state.currentTurnId,
    pendingToolCalls: Object.fromEntries(state.pendingToolCalls),
    filesModified: state.filesModified,
  };
  fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
}

/**
 * Clear active session state
 */
function clearSessionState(sessionId: string): void {
  const statePath = getSessionStatePath(sessionId);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

/**
 * Get a session writer for central storage
 */
function getCentralSessionWriter(sessionId: string): SessionWriter {
  ensureSessionsDir();
  return createSessionWriter(sessionId, getSessionsDir(), { direct: true });
}

/**
 * Write an event to central storage
 */
function writeEvent(sessionId: string, event: Record<string, unknown>): void {
  const writer = getCentralSessionWriter(sessionId);
  writer.writeEvent(event as any);
  writer.close();
}

/**
 * Copy session file from central storage to repo
 */
function copySessionToRepo(sessionId: string, gitRoot: string): void {
  const centralPath = path.join(getSessionsDir(), `${sessionId}.jsonl`);
  const repoDir = path.join(gitRoot, '.sessions');
  const repoPath = path.join(repoDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(centralPath)) return;

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }

  fs.copyFileSync(centralPath, repoPath);
}

/**
 * Handle sessionStart hook
 */
export function handleSessionStart(data: CursorSessionStart): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || createSessionId();

  // Get or create repo identity
  const repoInfo = getOrCreateRepoId(cwd);
  const repoId = repoInfo?.repoId ?? null;
  const gitRoot = repoInfo?.gitRoot ?? null;

  // Get git state if available
  let gitBranch: string | undefined;
  let gitRef: string | undefined;
  if (gitRoot) {
    try {
      const gitState = getGitState(gitRoot);
      gitBranch = gitState.branch ?? undefined;
      gitRef = gitState.ref;
    } catch {
      // Git state unavailable
    }
  }

  // Write session start event to central storage
  const startEvent: SessionStartEvent = {
    type: 'session_start',
    timestamp: new Date().toISOString(),
    sessionId,
    source: 'cursor',
    cwd,
    gitBranch,
    gitRef,
  };
  writeEvent(sessionId, startEvent);

  // Update central index
  if (repoId && gitRoot) {
    let index = loadIndex();
    index = indexSession(index, sessionId, repoId, gitRoot, new Date().toISOString());
    saveIndex(index);

    // Record session start boundary
    recordBoundary(repoId, sessionId, 'start', gitRoot, [], gitRef);
  }

  // Initialize state
  const state: ActiveCursorState = {
    sessionId,
    repoId,
    gitRoot,
    cwd,
    currentTurnId: null,
    pendingToolCalls: new Map(),
    filesModified: [],
  };
  saveSessionState(state);

  console.error(`[assert] Cursor session started: ${sessionId}`);
}

/**
 * Handle sessionEnd hook
 */
export function handleSessionEnd(data: CursorSessionEnd): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) {
    console.error('[assert] No active Cursor session found');
    return;
  }

  const state = loadSessionState(sessionId);
  if (!state) {
    console.error(`[assert] No state found for session: ${sessionId}`);
    return;
  }

  // Write session end event
  const event = {
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId,
    reason: 'completed',
  };
  writeEvent(sessionId, event);

  // Update index
  if (state.repoId && state.gitRoot) {
    let index = loadIndex();
    index = endSessionIndex(index, sessionId, new Date().toISOString());
    saveIndex(index);

    // Record session end boundary
    recordBoundary(state.repoId, sessionId, 'end', state.gitRoot, state.filesModified);

    // Check if there are actual changes to attribute
    const agentChanges = calculateAgentChanges(state.repoId, sessionId);
    const hasChanges = Array.from(agentChanges.values()).some(
      (c) => c.added.size > 0 || c.removed.size > 0
    );

    if (hasChanges) {
      copySessionToRepo(sessionId, state.gitRoot);
      console.error(`[assert] Cursor session ended with changes: ${sessionId}`);
    } else {
      console.error(`[assert] Cursor session ended (no changes): ${sessionId}`);
    }
  } else {
    console.error(`[assert] Cursor session ended: ${sessionId}`);
  }

  clearSessionState(sessionId);
}

/**
 * Handle stop hook (aborted session)
 */
export function handleStop(data: CursorSessionEnd): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) {
    return;
  }

  const state = loadSessionState(sessionId);
  if (!state) {
    return;
  }

  // Write session end event
  const event = {
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId,
    reason: 'aborted',
  };
  writeEvent(sessionId, event);

  // Update index
  if (state.repoId && state.gitRoot) {
    let index = loadIndex();
    index = endSessionIndex(index, sessionId, new Date().toISOString());
    saveIndex(index);

    recordBoundary(state.repoId, sessionId, 'end', state.gitRoot, state.filesModified);

    const agentChanges = calculateAgentChanges(state.repoId, sessionId);
    const hasChanges = Array.from(agentChanges.values()).some(
      (c) => c.added.size > 0 || c.removed.size > 0
    );

    if (hasChanges) {
      copySessionToRepo(sessionId, state.gitRoot);
    }
  }

  clearSessionState(sessionId);
  console.error(`[assert] Cursor session aborted: ${sessionId}`);
}

/**
 * Handle preToolUse hook
 */
export function handlePreToolUse(data: CursorToolUse): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) return;

  const state = loadSessionState(sessionId);
  if (!state) return;

  // Ensure we have a turn
  if (!state.currentTurnId) {
    state.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: state.currentTurnId,
    };
    writeEvent(sessionId, startEvent);
  }

  // Record the tool call
  const toolCallId = createToolCallId();
  const toolName = data.toolName || 'Edit';
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId,
    turnId: state.currentTurnId,
    toolCallId,
    toolName,
    input: data.toolInput || { filePath: data.filePath, editType: data.editType },
  };
  writeEvent(sessionId, event);

  // Store for matching with post-tool-use
  if (data.filePath) {
    state.pendingToolCalls.set(data.filePath, toolCallId);
  }
  saveSessionState(state);
}

/**
 * Handle postToolUse hook
 */
export function handlePostToolUse(data: CursorToolUse): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) return;

  const state = loadSessionState(sessionId);
  if (!state) return;

  const filePath = data.filePath;
  const toolCallId = filePath ? state.pendingToolCalls.get(filePath) : null;

  if (toolCallId && state.currentTurnId) {
    const event: ToolResultEvent = {
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: state.currentTurnId,
      toolCallId,
      output: data.success ? 'Edit successful' : undefined,
      error: data.error,
      filesModified: data.success && filePath ? [filePath] : undefined,
    };
    writeEvent(sessionId, event);

    // Track modified files
    if (data.success && filePath && !state.filesModified.includes(filePath)) {
      state.filesModified.push(filePath);

      // Update index
      if (state.repoId) {
        let index = loadIndex();
        index = indexFileModification(index, sessionId, state.repoId, filePath);
        saveIndex(index);
      }
    }

    state.pendingToolCalls.delete(filePath!);
  }

  saveSessionState(state);
}

/**
 * Handle beforeSubmitPrompt hook
 */
export function handleBeforeSubmitPrompt(data: CursorPrompt): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) return;

  const state = loadSessionState(sessionId);
  if (!state) return;

  const turnId = createTurnId();
  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId,
    turnId,
    content: data.content || '',
  };
  writeEvent(sessionId, event);
}

/**
 * Handle afterAgentResponse hook
 */
export function handleAfterAgentResponse(data: CursorPrompt): void {
  const cwd = data.workspaceRoot || process.cwd();
  const sessionId = data.sessionId || findSessionIdForWorkspace(cwd);

  if (!sessionId) return;

  const state = loadSessionState(sessionId);
  if (!state) return;

  // End current turn if there is one
  if (state.currentTurnId) {
    const event = {
      type: 'assistant_turn_end',
      timestamp: new Date().toISOString(),
      sessionId,
      turnId: state.currentTurnId,
    };
    writeEvent(sessionId, event);
    state.currentTurnId = null;
    saveSessionState(state);
  }
}

/**
 * Handle afterFileEdit hook
 */
export function handleAfterFileEdit(data: CursorToolUse): void {
  handlePostToolUse(data);
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
