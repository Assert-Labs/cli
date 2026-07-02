/**
 * Assert Schema - JSONL Event-Based Format
 *
 * Sessions are stored as JSONL files in .sessions/ folder.
 * Each line is a JSON-serialized event that's appended as it occurs.
 * This enables streaming writes and crash recovery.
 */

// === Base Event ===
// All events share this structure

export interface BaseEvent {
  type: string;
  timestamp: string; // ISO 8601
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
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  turnId: string;
  toolCallId: string;
  output?: string;
  error?: string;
  // Files modified by this tool call
  filesModified?: string[];
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
  contributor: { type: 'ai' | 'human' | 'unknown'; agent?: SessionSource; modelId?: string };
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
}
export interface LineAttributionEvent extends BaseEvent {
  type: 'line_attribution';
  filePath: string;
  vcsRevision?: string;
  lines: LineOwnership[];
}

// === Union Types ===

export type SessionEvent =
  | SessionStartEvent
  | SessionEndEvent
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

export type SessionSource = 'cursor' | 'claude-code' | 'codex' | 'unknown';

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
