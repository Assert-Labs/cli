/**
 * Trace Schema
 *
 * Data model for capturing agent sessions and associating them with code changes.
 * Compatible with agent-trace.dev spec, extended with session content.
 */

// === Session Types ===
// A session is a conversation between human and AI agent

export interface Session {
  id: string;
  source?: string; // Tool that captured this: "cursor", "claude-code", "codex", etc.
  turns: Turn[];
}

export type Turn = HumanTurn | AssistantTurn;

export interface HumanTurn {
  type: 'human';
  timestamp?: string;
  content: string;
}

export interface AssistantTurn {
  type: 'assistant';
  timestamp?: string;
  model?: string;
  blocks: ContentBlock[];
}

// === Content Blocks ===
// Blocks appear in sequence within an AssistantTurn

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_call_id: string;
  output?: string;
  error?: string;
}

// === Trace Types ===
// A trace links code changes to sessions (stored in git notes)

export interface Trace {
  version: string;
  id: string;
  timestamp: string;
  vcs: {
    type: 'git';
    revision: string; // commit SHA
  };
  files: FileAttribution[];
  sessions: Record<string, SessionSummary>; // session_id -> summary
}

export interface FileAttribution {
  path: string;
  conversations: Conversation[];
}

export interface Conversation {
  id: string; // references sessions[id]
  contributor: {
    type: 'human' | 'ai' | 'mixed';
    model?: string;
  };
  ranges: LineRange[];
}

export interface LineRange {
  start_line: number; // 1-indexed
  end_line: number; // 1-indexed, inclusive
}

export interface SessionSummary {
  prompt: string; // The human prompt that initiated this
  source?: string; // Tool that captured: "cursor", "claude-code", "codex", etc.
  model?: string; // Model used
  tool_calls_count?: number; // How many tool calls were made
  files_modified?: string[]; // Which files were touched
}

// === Pending Trace ===
// Stored before commit, waiting to be attached

export interface PendingTrace {
  session_id: string;
  captured_at: string;
  session: Session;
  files_modified: string[];
}

// === Config ===

export interface TraceConfig {
  version: number;
  backend_url?: string; // Where to push traces (future)
  auto_commit: boolean; // Run assert commit on git commit
  auto_push: boolean; // Sync traces on git push
}

export const DEFAULT_CONFIG: TraceConfig = {
  version: 1,
  auto_commit: true,
  auto_push: true,
};
