/**
 * Canonical Tool Actions
 *
 * Every agent names its tools differently and passes a different input shape
 * for the same operation: reading a file is `Read {file_path}` in Claude Code,
 * `read {filePath}` in OpenCode, `read {path}` in Pi, and editing is a patch
 * blob under `patchText` (OpenCode) or `command` (Codex). A capture is only
 * useful to a reader that doesn't know which agent produced it if that
 * difference is resolved exactly once, here, at capture time.
 *
 * So each agent adapter declares how *its own* tools map onto the fixed
 * vocabulary below, and every `tool_call` event carries the resulting
 * `ToolAction`. Consumers switch on `action.kind` and read canonical fields;
 * they never inspect `toolName` (beyond labelling an unrecognized tool) and
 * never inspect the raw `input`.
 *
 * Adding an agent means adding a map here, not adding a case downstream.
 */

/**
 * What a tool call did, independent of which agent ran it.
 *
 * - `read`: read a file's contents
 * - `edit`: modify part of an existing file
 * - `write`: create a file or replace its contents
 * - `delete`: remove a file
 * - `search`: search the workspace (grep, glob, codebase search)
 * - `web`: search or fetch something off the machine
 * - `command`: run a shell command
 * - `task`: delegate to a subagent
 * - `todo`: update a plan / todo list
 * - `other`: anything not in this vocabulary, including unregistered and
 *               MCP tools. Deliberately inert: consumers fall back to
 *               `toolName` for a label and show nothing else.
 */
export type ToolActionKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'delete'
  | 'search'
  | 'web'
  | 'command'
  | 'task'
  | 'todo'
  | 'other';

export interface ToolAction {
  kind: ToolActionKind;
  /**
   * Files the call touched, in the order the tool named them. Repo-relative
   * POSIX paths in a published capture (the sanitizer relativizes them against
   * each repo it publishes into).
   */
  paths?: string[];
  /** The shell command line (`command`). */
  command?: string;
  /**
   * The literal thing being looked up: a grep/glob pattern (`search`), the
   * search terms or fetch instruction (`web`), or a subagent's task
   * description (`task`).
   */
  query?: string;
  /** The URL fetched (`web`). */
  url?: string;
}

/** How one agent's tools map onto the canonical vocabulary. */
export type ToolActionMap = Record<string, (input: ToolInput) => ToolAction>;

type ToolInput = Record<string, unknown>;

/** The first of `keys` holding a non-empty string. Keys are the aliases a
 * single agent has used for one field across versions, never a cross-agent
 * grab bag. */
function text(input: ToolInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** As `text`, as a single-entry path list (or undefined when absent). */
function paths(input: ToolInput, ...keys: string[]): string[] | undefined {
  const value = text(input, ...keys);
  return value ? [value] : undefined;
}

// Headers in an apply_patch blob that name a file. The tool passes a whole
// patch with no discrete path field, so the touched paths are read from these.
const APPLY_PATCH_FILE_PREFIXES = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
];

/** File paths named in an apply_patch blob. */
export function applyPatchPaths(patchText: string): string[] {
  const found: string[] = [];
  for (const line of patchText.split('\n')) {
    const trimmed = line.trim();
    for (const prefix of APPLY_PATCH_FILE_PREFIXES) {
      if (!trimmed.startsWith(prefix)) continue;
      const parsed = trimmed.slice(prefix.length).trim().replace(/^['"]|['"]$/g, '');
      if (parsed) found.push(parsed);
    }
  }
  return found;
}

/** An apply_patch call, whichever key the agent passes the blob under. */
function applyPatch(input: ToolInput, ...keys: string[]): ToolAction {
  const patch = text(input, ...keys);
  const touched = patch ? applyPatchPaths(patch) : [];
  return { kind: 'edit', paths: touched.length ? touched : undefined };
}

// ------------------------------------------------------------------
// Per-agent maps. Tool names are matched case-insensitively.
// ------------------------------------------------------------------

const CLAUDE_CODE_TOOLS: ToolActionMap = {
  read: (i) => ({ kind: 'read', paths: paths(i, 'file_path') }),
  write: (i) => ({ kind: 'write', paths: paths(i, 'file_path') }),
  edit: (i) => ({ kind: 'edit', paths: paths(i, 'file_path') }),
  multiedit: (i) => ({ kind: 'edit', paths: paths(i, 'file_path') }),
  notebookedit: (i) => ({ kind: 'edit', paths: paths(i, 'notebook_path') }),
  glob: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  grep: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  bash: (i) => ({ kind: 'command', command: text(i, 'command') }),
  slashcommand: (i) => ({ kind: 'command', command: text(i, 'command') }),
  webfetch: (i) => ({ kind: 'web', url: text(i, 'url'), query: text(i, 'prompt') }),
  websearch: (i) => ({ kind: 'web', query: text(i, 'query') }),
  task: (i) => ({ kind: 'task', query: text(i, 'description') }),
  agent: (i) => ({ kind: 'task', query: text(i, 'description') }),
  todowrite: () => ({ kind: 'todo' }),
  taskcreate: (i) => ({ kind: 'todo', query: text(i, 'description') }),
  taskupdate: () => ({ kind: 'todo' }),
};

const CODEX_TOOLS: ToolActionMap = {
  // Codex passes the patch blob under `command`, the same key its shell tool
  // uses for a command line.
  apply_patch: (i) => applyPatch(i, 'command', 'input', 'patch'),
  shell: (i) => ({ kind: 'command', command: text(i, 'command') }),
  bash: (i) => ({ kind: 'command', command: text(i, 'command') }),
  read_file: (i) => ({ kind: 'read', paths: paths(i, 'path', 'file_path') }),
  web_search: (i) => ({ kind: 'web', query: text(i, 'query') }),
  update_plan: () => ({ kind: 'todo' }),
};

// Cursor hosts other vendors' models and forwards their tool schema verbatim:
// a Claude-backed agent reports `Write {file_path}`, exactly as Claude Code
// does (confirmed against Cursor 3.13 payloads in
// tests/fixtures/cursor-payloads.json). So Cursor's map is Claude's, plus the
// tools Cursor defines itself.
const CURSOR_TOOLS: ToolActionMap = {
  ...CLAUDE_CODE_TOOLS,
  read_file: (i) => ({ kind: 'read', paths: paths(i, 'file_path', 'filePath', 'path') }),
  edit_file: (i) => ({ kind: 'edit', paths: paths(i, 'file_path', 'filePath', 'path') }),
  search_replace: (i) => ({ kind: 'edit', paths: paths(i, 'file_path', 'filePath', 'path') }),
  delete_file: (i) => ({ kind: 'delete', paths: paths(i, 'file_path', 'filePath', 'path') }),
  codebase_search: (i) => ({ kind: 'search', query: text(i, 'query') }),
  glob_file_search: (i) => ({ kind: 'search', query: text(i, 'globPattern', 'pattern') }),
  run_terminal_cmd: (i) => ({ kind: 'command', command: text(i, 'command') }),
  web_search: (i) => ({ kind: 'web', query: text(i, 'search_term', 'query') }),
  fetch_rules: () => ({ kind: 'other' }),
  todo_write: () => ({ kind: 'todo' }),
};

const OPENCODE_TOOLS: ToolActionMap = {
  read: (i) => ({ kind: 'read', paths: paths(i, 'filePath') }),
  write: (i) => ({ kind: 'write', paths: paths(i, 'filePath') }),
  edit: (i) => ({ kind: 'edit', paths: paths(i, 'filePath') }),
  patch: (i) => applyPatch(i, 'patchText'),
  apply_patch: (i) => applyPatch(i, 'patchText'),
  list: (i) => ({ kind: 'search', paths: paths(i, 'path') }),
  glob: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  grep: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  bash: (i) => ({ kind: 'command', command: text(i, 'command') }),
  webfetch: (i) => ({ kind: 'web', url: text(i, 'url') }),
  websearch: (i) => ({ kind: 'web', query: text(i, 'query') }),
  task: (i) => ({ kind: 'task', query: text(i, 'description') }),
  skill: (i) => ({ kind: 'task', query: text(i, 'name') }),
  todowrite: () => ({ kind: 'todo' }),
  todoread: () => ({ kind: 'todo' }),
};

const PI_TOOLS: ToolActionMap = {
  read: (i) => ({ kind: 'read', paths: paths(i, 'path') }),
  write: (i) => ({ kind: 'write', paths: paths(i, 'path') }),
  edit: (i) => ({ kind: 'edit', paths: paths(i, 'path') }),
  delete: (i) => ({ kind: 'delete', paths: paths(i, 'path') }),
  glob: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  grep: (i) => ({ kind: 'search', query: text(i, 'pattern'), paths: paths(i, 'path') }),
  bash: (i) => ({ kind: 'command', command: text(i, 'command') }),
  web_search: (i) => ({ kind: 'web', query: text(i, 'query') }),
  web_fetch: (i) => ({ kind: 'web', url: text(i, 'url') }),
  task: (i) => ({ kind: 'task', query: text(i, 'description') }),
  todo: () => ({ kind: 'todo' }),
};

const TOOLS_BY_SOURCE: Record<string, ToolActionMap> = {
  'claude-code': CLAUDE_CODE_TOOLS,
  codex: CODEX_TOOLS,
  cursor: CURSOR_TOOLS,
  opencode: OPENCODE_TOOLS,
  pi: PI_TOOLS,
};

const ALL_TOOL_MAPS = Object.values(TOOLS_BY_SOURCE);

/** Whether an action says anything beyond its kind. */
function isDetailed(action: ToolAction): boolean {
  return !!(action.paths?.length || action.command || action.query || action.url);
}

/**
 * A best guess across every agent's map, for a capture whose producing agent
 * is unknown, such as captures that predate `session_start`. Agents overwhelmingly
 * agree on what a tool named `read` or `bash` does and disagree only about
 * which key holds its argument, so the first map that finds an argument wins.
 */
function anyAgentAction(toolName: string, input: ToolInput): ToolAction {
  let fallback: ToolAction | undefined;
  for (const map of ALL_TOOL_MAPS) {
    const build = map[toolName];
    if (!build) continue;
    const action = build(input);
    if (isDetailed(action)) return action;
    fallback ??= action;
  }
  return fallback ?? { kind: 'other' };
}

/**
 * The canonical action for a tool call from `source`.
 *
 * A tool the agent's map doesn't list (a new built-in, an MCP tool, a user's
 * custom tool) yields `{ kind: 'other' }` rather than a guess: a wrong
 * canonical field is worse than an honest one, and consumers already have
 * `toolName` to label it.
 */
export function toolAction(
  source: string,
  toolName: string | undefined,
  input: Record<string, unknown> = {},
): ToolAction {
  // Total by construction: this runs inside a capture hook, where throwing
  // loses the whole event (and the agent never sees the failure). An agent
  // that omits the tool name, or a capture written before it was recorded,
  // still yields a usable `other`.
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { kind: 'other' };
  }
  const name = toolName.toLowerCase();
  const map = TOOLS_BY_SOURCE[source];
  if (map == null) return anyAgentAction(name, input);
  const build = map[name];
  return build ? build(input) : { kind: 'other' };
}

/** Drop everything but the kind, for a call whose payload is redacted. */
export function redactedToolAction(action: ToolAction | undefined): ToolAction {
  return { kind: action?.kind ?? 'other' };
}
