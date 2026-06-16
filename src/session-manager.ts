/**
 * Session Manager
 *
 * High-level API for managing agent sessions.
 * Integrates session writing with git branch tracking.
 */

import {
  type SessionSource,
  type SessionEvent,
  type SessionStartEvent,
  type SessionEndEvent,
  type HumanTurnEvent,
  type AssistantTurnStartEvent,
  type AssistantTextEvent,
  type AssistantTurnEndEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type BranchSwitchEvent,
  type FileAttributionEvent,
  createSessionId,
  createTurnId,
  createToolCallId,
} from './schema';
import { createSessionWriter, type SessionWriter } from './session-writer';
import { findGitRoot, getGitState, createGitWatcher, type GitWatcher } from './git-watcher';

export interface SessionManager {
  readonly sessionId: string;
  readonly source: SessionSource;
  readonly isActive: boolean;

  // Turn management
  startHumanTurn(content: string): string;
  startAssistantTurn(model?: string): string;
  addAssistantText(turnId: string, text: string): void;
  endAssistantTurn(turnId: string, contentHash?: string): void;

  // Tool calls
  recordToolCall(
    turnId: string,
    toolName: string,
    input: Record<string, unknown>
  ): string;
  recordToolResult(
    turnId: string,
    toolCallId: string,
    output?: string,
    error?: string,
    filesModified?: string[]
  ): void;

  // File attribution
  recordFileAttribution(
    turnId: string,
    filePath: string,
    contentHash: string,
    operation: 'create' | 'modify' | 'delete',
    lineRanges?: Array<{ startLine: number; endLine: number }>
  ): void;

  // Session lifecycle
  end(reason?: 'completed' | 'aborted' | 'error', error?: string): void;
}

interface SessionManagerOptions {
  source: SessionSource;
  cwd?: string;
  sessionId?: string;
}

/**
 * Create a new session manager
 */
export function createSession(options: SessionManagerOptions): SessionManager {
  const { source, cwd = process.cwd() } = options;
  const sessionId = options.sessionId ?? createSessionId();

  const writer = createSessionWriter(sessionId, cwd);
  let isActive = true;

  // Set up git watching
  const gitRoot = findGitRoot(cwd);
  let gitWatcher: GitWatcher | null = null;
  let currentBranch: string | null = null;
  let currentRef: string | null = null;

  if (gitRoot) {
    const gitState = getGitState(gitRoot);
    currentBranch = gitState.branch;
    currentRef = gitState.ref;

    gitWatcher = createGitWatcher(gitRoot);
    gitWatcher.onBranchChange((from, to) => {
      if (isActive) {
        const event: BranchSwitchEvent = {
          type: 'branch_switch',
          timestamp: new Date().toISOString(),
          sessionId,
          fromBranch: from.branch ?? undefined,
          toBranch: to.branch ?? 'detached',
          fromRef: from.ref,
          toRef: to.ref,
        };
        writer.writeEvent(event);
        currentBranch = to.branch;
        currentRef = to.ref;
      }
    });
  }

  // Write session start event
  const startEvent: SessionStartEvent = {
    type: 'session_start',
    timestamp: new Date().toISOString(),
    sessionId,
    source,
    cwd,
    gitBranch: currentBranch ?? undefined,
    gitRef: currentRef ?? undefined,
  };
  writer.writeEvent(startEvent);

  function writeEvent(event: SessionEvent): void {
    if (!isActive) {
      throw new Error('Session has ended');
    }
    writer.writeEvent(event);
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get source() {
      return source;
    },
    get isActive() {
      return isActive;
    },

    startHumanTurn(content: string): string {
      const turnId = createTurnId();
      const event: HumanTurnEvent = {
        type: 'human_turn',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        content,
      };
      writeEvent(event);
      return turnId;
    },

    startAssistantTurn(model?: string): string {
      const turnId = createTurnId();
      const event: AssistantTurnStartEvent = {
        type: 'assistant_turn_start',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        model,
      };
      writeEvent(event);
      return turnId;
    },

    addAssistantText(turnId: string, text: string): void {
      const event: AssistantTextEvent = {
        type: 'assistant_text',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        text,
      };
      writeEvent(event);
    },

    endAssistantTurn(turnId: string, contentHash?: string): void {
      const event: AssistantTurnEndEvent = {
        type: 'assistant_turn_end',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        contentHash,
      };
      writeEvent(event);
    },

    recordToolCall(
      turnId: string,
      toolName: string,
      input: Record<string, unknown>
    ): string {
      const toolCallId = createToolCallId();
      const event: ToolCallEvent = {
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        toolCallId,
        toolName,
        input,
      };
      writeEvent(event);
      return toolCallId;
    },

    recordToolResult(
      turnId: string,
      toolCallId: string,
      output?: string,
      error?: string,
      filesModified?: string[]
    ): void {
      const event: ToolResultEvent = {
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        toolCallId,
        output,
        error,
        filesModified,
      };
      writeEvent(event);
    },

    recordFileAttribution(
      turnId: string,
      filePath: string,
      contentHash: string,
      operation: 'create' | 'modify' | 'delete',
      lineRanges?: Array<{ startLine: number; endLine: number }>
    ): void {
      const event: FileAttributionEvent = {
        type: 'file_attribution',
        timestamp: new Date().toISOString(),
        sessionId,
        turnId,
        filePath,
        contentHash,
        operation,
        lineRanges,
      };
      writeEvent(event);
    },

    end(
      reason: 'completed' | 'aborted' | 'error' = 'completed',
      error?: string
    ): void {
      if (!isActive) return;

      const event: SessionEndEvent = {
        type: 'session_end',
        timestamp: new Date().toISOString(),
        sessionId,
        reason,
        error,
      };
      writer.writeEvent(event);

      isActive = false;
      writer.close();
      gitWatcher?.stop();
    },
  };
}

/**
 * Resume an existing session (for crash recovery)
 */
export function resumeSession(
  sessionId: string,
  source: SessionSource,
  cwd: string = process.cwd()
): SessionManager {
  // Just create a new writer that appends to the existing file
  return createSession({ sessionId, source, cwd });
}
