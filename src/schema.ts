/**
 * Assert Schema - JSONL Event-Based Format
 *
 * Sessions are stored as JSONL files in .sessions/ folder.
 * Each line is a JSON-serialized event that's appended as it occurs.
 * This enables streaming writes and crash recovery.
 *
 * The format is a contract, not a dump: an event's fields mean the same thing
 * whichever agent produced it. Agent-specific shapes (tool names, input keys,
 * patch blobs) are resolved by the capture adapter, never by a consumer — see
 * ./tool-actions for the canonical tool vocabulary. Fields typed as required
 * here are guaranteed present on every event a consumer sees; `parseSession`
 * (./core) drops anything that doesn't hold up.
 */

import type { ToolAction } from './tool-actions';

export type { ToolAction, ToolActionKind } from './tool-actions';

/** Bumped when the on-disk event shape changes; written to each session's
 * meta.json. 4 = canonical `tool_call.action`. */
export const SESSION_FORMAT_VERSION = 4;

// === Base Event ===
// All events share this structure

export interface BaseEvent {
  type: string;
  timestamp: string; // ISO 8601 — required on every event, always parseable
  sessionId: string;
}

// === Session Lifecycle Events ===

export interface SessionStartEvent extends BaseEvent {
  type: 'session_start';
  source: SessionSource;
  cwd: string; // Working directory when session started
  gitBranch?: string; // Current git branch at start
  gitRef?: string; // Current HEAD ref
}

export interface SessionEndEvent extends BaseEvent {
  type: 'session_end';
  reason: 'completed' | 'aborted' | 'error';
  error?: string;
}

export interface SessionResumeEvent extends BaseEvent {
  type: 'session_resume';
}

// === Turn Events ===
// Human messages and assistant responses

export interface HumanTurnEvent extends BaseEvent {
  type: 'human_turn';
  turnId: string;
  content: string;
}

export interface AssistantTurnStartEvent extends BaseEvent {
  type: 'assistant_turn_start';
  turnId: string;
  model?: string;
  provider?: string; // provider that served the model (e.g. multi-provider tools)
  promptTurnId?: string; // human_turn this assistant turn is responding to
}

export interface AssistantTextEvent extends BaseEvent {
  type: 'assistant_text';
  turnId: string;
  text: string;
}

export interface AssistantReasoningEvent extends BaseEvent {
  type: 'assistant_reasoning';
  turnId: string;
  text: string;
  signature?: string;
}

export interface AssistantTurnEndEvent extends BaseEvent {
  type: 'assistant_turn_end';
  turnId: string;
  // Content hash of the full assistant response for attribution
  contentHash?: string;
}

// === Tool Events ===

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  turnId: string;
  toolCallId: string;
  /** The agent's own name for the tool. A label for an unrecognized tool —
   * never something a consumer should parse to decide what happened. */
  toolName: string;
  /** What the call did, in the canonical vocabulary every agent maps onto.
   * This is the contract consumers read (see ./tool-actions). */
  action: ToolAction;
  /** The agent's raw input, sanitized. Kept so a capture stays inspectable and
   * so future canonical fields can be backfilled — not for display. */
  input?: Record<string, unknown>;
}

/**
 * What one tool call did to one file, against that file's state immediately
 * before the call.
 *
 * This is the only record of an individual edit. Per-turn attribution is taken
 * after the whole turn, so an edit that a later call in the same turn revises
 * leaves no separate trace there, and nothing downstream can reconstruct the
 * intermediate state.
 */
export interface FileChange {
  /** Repo-relative POSIX path in a published capture. */
  path: string;
  additions: number;
  deletions: number;
  /** Unified diff of the change. Omitted when it exceeds `MAX_PATCH_BYTES`. */
  patch?: string;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  turnId: string;
  toolCallId: string;
  output?: string;
  error?: string;
  // Files modified by this tool call
  filesModified?: string[];
  /** Per-file diff of what this call changed. */
  changes?: FileChange[];
}

// === Git Events ===
// Track branch switches during a session

export interface BranchSwitchEvent extends BaseEvent {
  type: 'branch_switch';
  fromBranch?: string;
  toBranch: string;
  fromRef?: string;
  toRef: string;
}

// === File Attribution Events ===
// Record which content contributed to which files

export interface FileAttributionEvent extends BaseEvent {
  type: 'file_attribution';
  turnId: string;
  filePath: string;
  // Hash of the content that was written/modified
  contentHash: string;
  // Line ranges affected (1-indexed, inclusive)
  lineRanges?: LineRange[];
  operation: 'create' | 'modify' | 'delete';
}

// Portable attribution: which content (by line hash) a contributor produced in a
// file, relative to a revision. The source for deriving an agent-trace record.
export interface AttributionEvent extends BaseEvent {
  type: 'attribution';
  filePath: string;
  vcsRevision?: string;
  operation: 'create' | 'modify' | 'delete';
  contributor: {
    type: 'ai' | 'human' | 'unknown';
    agent?: SessionSource;
    modelId?: string;
    provider?: string;
  };
  lineHashes: string[];
}

// Per-line ownership of a file's end state, threaded across sessions. The most
// recent one for a file is the source `assert blame` aligns to the working tree.
export interface LineOwnership {
  hash: string;
  source: 'agent' | 'human' | 'unknown';
  sessionId?: string;
  agent?: SessionSource;
  modelId?: string;
  provider?: string;
  turnId?: string; // assistant turn that wrote the line; links to its prompt/reasoning
}
export interface LineAttributionEvent extends BaseEvent {
  type: 'line_attribution';
  filePath: string;
  vcsRevision?: string;
  lines: LineOwnership[];
  /** The assistant turn whose sync produced this snapshot. */
  turnId?: string;
  /**
   * What this turn did to the file, against its state when the turn began: a
   * diff stat, in the sense `git diff --stat` means it.
   *
   * Recorded here because it cannot be recovered later. `lines` describes the
   * file's end state, so lines the turn deleted leave no trace in it, and the
   * state they were deleted from is not part of the capture. Only the writer
   * still holds both sides.
   */
  churn?: { additions: number; deletions: number };
}

// === Union Types ===

export type SessionEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SessionResumeEvent
  | HumanTurnEvent
  | AssistantTurnStartEvent
  | AssistantTextEvent
  | AssistantReasoningEvent
  | AssistantTurnEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | BranchSwitchEvent
  | FileAttributionEvent
  | AttributionEvent
  | LineAttributionEvent;

// === Supporting Types ===

export type SessionSource = 'cursor' | 'claude-code' | 'codex' | 'opencode' | 'pi' | 'unknown';

export interface LineRange {
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed, inclusive
}

// === Session File Metadata ===
// Extracted from events for quick querying

export interface SessionMetadata {
  id: string;
  source: SessionSource;
  startTime: string;
  endTime?: string;
  branches: string[]; // All branches touched during session
  filesModified: string[]; // All files modified
  turnCount: number;
  toolCallCount: number;
}

// === Content Hash for Attribution ===
// Used to match content across rebases

export interface ContentSignature {
  // Hash of normalized content (whitespace-insensitive)
  hash: string;
  // First N characters for quick identification
  preview: string;
  // Length of original content
  length: number;
}

// === Utility Functions ===

export function createSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

export function createTurnId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function createToolCallId(): string {
  return `tc-${Math.random().toString(36).substring(2, 10)}`;
}

export function parseSessionEvent(line: string): SessionEvent {
  return JSON.parse(line) as SessionEvent;
}

/**
 * Whether a parsed line is a usable event: it has a type, a session, and a
 * real ISO timestamp. Timestamps are load-bearing — events are ordered by them
 * and consumers date sessions from them — so an event without one is dropped
 * rather than defaulted, and nothing downstream has to guard for a missing or
 * zero time.
 */
export function isSessionEvent(value: unknown): value is SessionEvent {
  const event = value as Partial<BaseEvent> | null;
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof event.type === 'string' &&
    event.type.length > 0 &&
    typeof event.sessionId === 'string' &&
    typeof event.timestamp === 'string' &&
    !Number.isNaN(Date.parse(event.timestamp))
  );
}

export function serializeSessionEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

// === Session File Helpers ===

export function getSessionFilePath(sessionId: string): string {
  return `.sessions/${sessionId}.jsonl`;
}

export function parseSessionId(filePath: string): string | null {
  const match = filePath.match(/\.sessions\/([^/]+)\.jsonl$/);
  return match ? match[1] : null;
}
