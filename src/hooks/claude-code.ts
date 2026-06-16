/**
 * Claude Code Hook Handlers
 *
 * Implements hooks for Claude Code integration.
 * Hooks are invoked via CLI and receive JSON data via stdin.
 *
 * Architecture:
 * - All session data written to central ~/.assert/sessions/
 * - Repo identity tracked via .git/assert-repo-id
 * - File modifications indexed for quick pre-commit lookup
 * - Session boundaries recorded for attribution computation
 * - Session data copied to repo .sessions/ at end only if real changes exist
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  type AssistantTextEvent,
  createTurnId,
  createToolCallId,
} from '../schema';

// Session state file for persistence across hook invocations
const SESSION_STATE_FILE = '.active-session.json';

interface ClaudeCodeSessionStart {
  session_id: string;
  cwd: string;
}

interface ClaudeCodeSessionEnd {
  session_id: string;
  cwd: string;
}

interface ClaudeCodeStop {
  session_id: string;
  cwd: string;
}

interface ClaudeCodeUserPromptSubmit {
  session_id: string;
  prompt: string;
  cwd: string;
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

interface ActiveSessionState {
  sessionId: string;
  repoId: string | null;
  gitRoot: string | null;
  cwd: string;
  currentTurnId: string | null;
  pendingToolCalls: Map<string, string>;
  filesModified: string[]; // Relative paths of files modified this session
  hookInstalledRepos: Set<string>; // Git roots where we've installed pre-commit hook
}

let activeState: ActiveSessionState | null = null;

/**
 * Get path to session state file (in central location)
 */
function getSessionStatePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.state.json`);
}

/**
 * Load active session state from disk
 */
function loadSessionState(sessionId: string): ActiveSessionState | null {
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
      hookInstalledRepos: new Set(data.hookInstalledRepos ?? []),
    };
  } catch {
    return null;
  }
}

/**
 * Save active session state to disk
 */
function saveSessionState(state: ActiveSessionState): void {
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
    hookInstalledRepos: Array.from(state.hookInstalledRepos),
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
 * Ensure pre-commit hook is installed in a git repo
 * Non-destructive: appends to existing hooks
 * CRITICAL: Hook must NEVER block commits - always exits 0
 */
function ensurePreCommitHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');
  const hookMarker = 'Assert: attach session data';

  // Safe hook command: checks binary exists, silences errors, always succeeds
  const safeHookCommand = `
# Assert: attach session data to commits (never blocks)
if [ -x "$HOME/.assert/bin/assert" ]; then
  "$HOME/.assert/bin/assert" pre-commit 2>/dev/null || true
fi`;

  try {
    // Ensure hooks directory exists
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Check if it's a symlink (some tools like husky use symlinks)
    if (fs.existsSync(hookPath) && fs.lstatSync(hookPath).isSymbolicLink()) {
      // Don't modify symlinked hooks - could break other tools
      return;
    }

    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, 'utf-8');
      if (content.includes(hookMarker)) {
        return; // Already installed
      }
      // Append to existing hook
      fs.appendFileSync(hookPath, safeHookCommand + '\n');
    } else {
      // Create new hook
      const hookContent = `#!/bin/sh${safeHookCommand}
`;
      fs.writeFileSync(hookPath, hookContent);
      fs.chmodSync(hookPath, 0o755);
    }
  } catch {
    // Silent failure - never break the user's repo
  }
}

/**
 * Get a session writer for central storage
 */
function getCentralSessionWriter(sessionId: string): SessionWriter {
  const sessionsDir = getSessionsDir();
  ensureSessionsDir();
  return createSessionWriter(sessionId, sessionsDir);
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

  if (!fs.existsSync(centralPath)) {
    return;
  }

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }

  fs.copyFileSync(centralPath, repoPath);
}

/**
 * Handle SessionStart hook
 */
export function handleSessionStart(data: ClaudeCodeSessionStart): void {
  const { session_id, cwd } = data;

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
    sessionId: session_id,
    source: 'claude-code',
    cwd,
    gitBranch,
    gitRef,
  };
  writeEvent(session_id, startEvent);

  // Update central index
  if (repoId) {
    let index = loadIndex();
    index = indexSession(index, session_id, repoId, gitRoot!, new Date().toISOString());
    saveIndex(index);

    // Record session start boundary (snapshot current state of tracked files)
    // We'll snapshot files as they're modified, so start with empty
    recordBoundary(repoId, session_id, 'start', gitRoot!, [], gitRef);
  }

  // Initialize state
  activeState = {
    sessionId: session_id,
    repoId,
    gitRoot,
    cwd,
    currentTurnId: null,
    pendingToolCalls: new Map(),
    filesModified: [],
    hookInstalledRepos: new Set(),
  };
  saveSessionState(activeState);

  console.error(`[assert] Session started: ${session_id}`);
}

/**
 * Handle SessionEnd hook
 */
export function handleSessionEnd(data: ClaudeCodeSessionEnd): void {
  const { session_id } = data;

  activeState = loadSessionState(session_id);
  if (!activeState) {
    console.error(`[assert] No active session found for: ${session_id}`);
    return;
  }

  // Write session end event
  const event = {
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    reason: 'completed',
  };
  writeEvent(session_id, event);

  // Update index
  if (activeState.repoId) {
    let index = loadIndex();
    index = endSessionIndex(index, session_id, new Date().toISOString());
    saveIndex(index);

    // Record session end boundary
    recordBoundary(
      activeState.repoId,
      session_id,
      'end',
      activeState.gitRoot!,
      activeState.filesModified
    );

    // Check if there are actual changes to attribute
    const agentChanges = calculateAgentChanges(activeState.repoId, session_id);
    const hasChanges = Array.from(agentChanges.values()).some(
      (c) => c.added.size > 0 || c.removed.size > 0
    );

    if (hasChanges) {
      // Copy session to repo .sessions/
      copySessionToRepo(session_id, activeState.gitRoot!);
      console.error(`[assert] Session ended with changes: ${session_id}`);
    } else {
      console.error(`[assert] Session ended (no changes): ${session_id}`);
    }
  }

  clearSessionState(session_id);
  activeState = null;
}

/**
 * Handle Stop hook (aborted session)
 */
export function handleStop(data: ClaudeCodeStop): void {
  const { session_id } = data;

  activeState = loadSessionState(session_id);
  if (!activeState) {
    console.error(`[assert] No active session found for: ${session_id}`);
    return;
  }

  // Write session end event
  const event = {
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    reason: 'aborted',
  };
  writeEvent(session_id, event);

  // Update index
  if (activeState.repoId) {
    let index = loadIndex();
    index = endSessionIndex(index, session_id, new Date().toISOString());
    saveIndex(index);

    // Record session end boundary even for aborted sessions
    recordBoundary(
      activeState.repoId,
      session_id,
      'end',
      activeState.gitRoot!,
      activeState.filesModified
    );

    // Check for changes
    const agentChanges = calculateAgentChanges(activeState.repoId, session_id);
    const hasChanges = Array.from(agentChanges.values()).some(
      (c) => c.added.size > 0 || c.removed.size > 0
    );

    if (hasChanges) {
      copySessionToRepo(session_id, activeState.gitRoot!);
    }
  }

  clearSessionState(session_id);
  activeState = null;

  console.error(`[assert] Session aborted: ${session_id}`);
}

/**
 * Handle PreToolUse hook
 */
export function handlePreToolUse(data: ClaudeCodePreToolUse): void {
  const { session_id, tool_name, tool_input } = data;

  activeState = loadSessionState(session_id);
  if (!activeState) {
    return;
  }

  // Ensure we have a turn
  if (!activeState.currentTurnId) {
    activeState.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: session_id,
      turnId: activeState.currentTurnId,
    };
    writeEvent(session_id, startEvent);
  }

  // Record the tool call
  const toolCallId = createToolCallId();
  const event: ToolCallEvent = {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: activeState.currentTurnId,
    toolCallId,
    toolName: tool_name,
    input: tool_input,
  };
  writeEvent(session_id, event);

  // Store the tool call ID for matching with the result
  activeState.pendingToolCalls.set(tool_name, toolCallId);
  saveSessionState(activeState);
}

/**
 * Handle PostToolUse hook
 */
export function handlePostToolUse(data: ClaudeCodePostToolUse): void {
  const { session_id, tool_name, tool_input } = data;
  const cwd = process.cwd();

  activeState = loadSessionState(session_id);
  if (!activeState) {
    return;
  }

  // Get the pending tool call ID
  const toolCallId = activeState.pendingToolCalls.get(tool_name) || createToolCallId();

  // Extract tool response from the data
  const tool_response = ((data as any).tool_response || {}) as Record<string, unknown>;
  const stdout = (tool_response.stdout || '') as string;
  const stderr = (tool_response.stderr || '') as string;
  const tool_output = stdout || undefined;
  const tool_error = stderr || undefined;

  // Check for file modifications
  let filesModified: string[] | undefined;
  const filePath = tool_input.file_path as string | undefined;

  if (filePath) {
    // Find git root for this specific file (might be different from session's gitRoot)
    const fileGitRoot = findGitRoot(path.dirname(filePath));

    if (fileGitRoot) {
      const relativePath = path.relative(fileGitRoot, filePath);

      // Track the modified file
      if (!activeState.filesModified.includes(relativePath)) {
        activeState.filesModified.push(relativePath);
      }

      // Ensure pre-commit hook is installed in this repo
      if (!activeState.hookInstalledRepos.has(fileGitRoot)) {
        ensurePreCommitHook(fileGitRoot);
        activeState.hookInstalledRepos.add(fileGitRoot);
      }

      // Update index (use file's repo, not session's)
      const fileRepoInfo = getOrCreateRepoId(fileGitRoot);
      if (fileRepoInfo) {
        let index = loadIndex();
        index = indexFileModification(index, session_id, fileRepoInfo.repoId, relativePath);
        saveIndex(index);
      }

      filesModified = [relativePath];
    }
  }

  // Record the tool result
  const event: ToolResultEvent = {
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: activeState.currentTurnId || createTurnId(),
    toolCallId,
    output: tool_output,
    error: tool_error,
    filesModified,
  };
  writeEvent(session_id, event);

  // Remove from pending
  activeState.pendingToolCalls.delete(tool_name);
  saveSessionState(activeState);
}

/**
 * Handle UserPromptSubmit hook - captures user prompts
 */
export function handleUserPromptSubmit(data: ClaudeCodeUserPromptSubmit): void {
  const { session_id, prompt } = data;

  activeState = loadSessionState(session_id);
  if (!activeState) {
    return;
  }

  // End previous assistant turn if any
  if (activeState.currentTurnId) {
    activeState.currentTurnId = null;
  }

  // Record human turn
  const turnId = createTurnId();
  const event: HumanTurnEvent = {
    type: 'human_turn',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId,
    content: prompt,
  };
  writeEvent(session_id, event);

  saveSessionState(activeState);
}

/**
 * Handle MessageDisplay hook - captures assistant text/reasoning
 */
export function handleMessageDisplay(data: Record<string, unknown>): void {
  const session_id = data.session_id as string;
  const delta = (data.delta || '') as string;

  // Skip empty deltas
  if (!delta) return;

  activeState = loadSessionState(session_id);
  if (!activeState) {
    return;
  }

  // Ensure we have a turn
  if (!activeState.currentTurnId) {
    activeState.currentTurnId = createTurnId();
    const startEvent: AssistantTurnStartEvent = {
      type: 'assistant_turn_start',
      timestamp: new Date().toISOString(),
      sessionId: session_id,
      turnId: activeState.currentTurnId,
    };
    writeEvent(session_id, startEvent);
  }

  // Record assistant text chunk
  const event: AssistantTextEvent = {
    type: 'assistant_text',
    timestamp: new Date().toISOString(),
    sessionId: session_id,
    turnId: activeState.currentTurnId,
    text: delta,
  };
  writeEvent(session_id, event);

  saveSessionState(activeState);
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
      handleSessionStart(data as ClaudeCodeSessionStart);
      break;
    case 'SessionEnd':
      handleSessionEnd(data as ClaudeCodeSessionEnd);
      break;
    case 'Stop':
      handleStop(data as ClaudeCodeStop);
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
