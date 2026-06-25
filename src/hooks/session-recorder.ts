/**
 * Session Recorder
 *
 * Agent-agnostic core for capturing agent sessions. Owns central storage,
 * multi-repo tracking, boundaries, and copying session data into the
 * `.sessions/` of every repo a session touches.
 *
 * Agent-specific hook adapters (claude-code, cursor, codex) only translate
 * their payloads into calls here; all repo/attribution logic lives in one
 * place so every agent behaves identically.
 *
 * Multi-repo: a session launched from a parent directory (e.g. ~/Repos, which
 * is not itself a git repo) can edit files across many repos. We discover and
 * track each repo as files are edited, and attribute/copy to all of them — the
 * session is never tied to a single repo resolved from the launch cwd.
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
import { type SessionEvent, type SessionStartEvent } from '../schema';

/** A single repo touched by a session. */
export interface TouchedRepo {
  repoId: string;
  gitRoot: string;
  filesModified: string[]; // Relative paths within this repo
}

export interface SessionState {
  sessionId: string;
  source: string; // 'claude-code' | 'cursor' | 'codex'
  cwd: string;
  currentTurnId: string | null;
  // Generic per-adapter scratch space for matching tool calls to results.
  pendingToolCalls: Map<string, string>;
  // Every git repo this session has touched, keyed by absolute gitRoot.
  repos: Record<string, TouchedRepo>;
}

// ------------------------------------------------------------------
// State persistence (namespaced by agent source to avoid collisions)
// ------------------------------------------------------------------

function getStatePath(sessionId: string, source: string): string {
  return path.join(getSessionsDir(), `${sessionId}.${source}-state.json`);
}

export function loadState(sessionId: string, source: string): SessionState | null {
  const statePath = getStatePath(sessionId, source);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      sessionId: data.sessionId,
      source: data.source ?? source,
      cwd: data.cwd,
      currentTurnId: data.currentTurnId ?? null,
      pendingToolCalls: new Map(Object.entries(data.pendingToolCalls ?? {})),
      repos: data.repos ?? {},
    };
  } catch {
    return null;
  }
}

export function saveState(state: SessionState): void {
  ensureSessionsDir();
  const statePath = getStatePath(state.sessionId, state.source);
  const data = {
    sessionId: state.sessionId,
    source: state.source,
    cwd: state.cwd,
    currentTurnId: state.currentTurnId,
    pendingToolCalls: Object.fromEntries(state.pendingToolCalls),
    repos: state.repos,
  };
  fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
}

export function clearState(sessionId: string, source: string): void {
  const statePath = getStatePath(sessionId, source);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

/**
 * Find a session id for a workspace root, for agents (e.g. Cursor) whose later
 * hooks don't pass the session id. Matches on cwd or any touched gitRoot.
 */
export function findSessionIdForWorkspace(
  workspaceRoot: string,
  source: string
): string | null {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return null;

  const suffix = `.${source}-state.json`;
  for (const file of fs.readdirSync(sessionsDir).filter((f) => f.endsWith(suffix))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
      if (data.cwd === workspaceRoot || data.repos?.[workspaceRoot]) {
        return data.sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Central event storage
// ------------------------------------------------------------------

function getCentralSessionWriter(sessionId: string): SessionWriter {
  ensureSessionsDir();
  return createSessionWriter(sessionId, getSessionsDir(), { direct: true });
}

export function writeEvent(sessionId: string, event: SessionEvent): void {
  const writer = getCentralSessionWriter(sessionId);
  writer.writeEvent(event);
  writer.close();
}

function copySessionToRepo(srcFile: string, sessionId: string, gitRoot: string): void {
  if (!fs.existsSync(srcFile)) return;
  const repoDir = path.join(gitRoot, '.sessions');
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }
  fs.copyFileSync(srcFile, path.join(repoDir, `${sessionId}.jsonl`));
}

// Transcript line types to drop when distilling, per agent. v1: only the
// clearly-redundant bulk — `progress` (streaming duplicates of the final
// message) and `file-history-snapshot` (file copies git already has). Prompts,
// reasoning, tool calls and tool results are all kept in full.
const DISTILL_DROP_TYPES: Record<string, Set<string>> = {
  'claude-code': new Set(['progress', 'file-history-snapshot']),
};

/**
 * Distill an agent transcript into `destPath`, dropping bulk-junk line types
 * for its source. Returns false if the transcript is missing/unreadable (caller
 * falls back to the stitched central session file). Unknown sources copy as-is.
 */
function distillTranscript(srcPath: string, destPath: string, source: string): boolean {
  if (!fs.existsSync(srcPath)) return false;
  const drop = DISTILL_DROP_TYPES[source];
  try {
    const out: string[] = [];
    for (const line of fs.readFileSync(srcPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      if (drop) {
        try {
          const o = JSON.parse(line);
          if (o && drop.has(o.type)) continue;
        } catch {
          // keep unparseable lines rather than lose data
        }
      }
      out.push(line);
    }
    fs.writeFileSync(destPath, out.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a never-blocking pre-commit hook is installed in a git repo so it
 * attaches session data on commit. Appends to any existing hook.
 */
function ensurePreCommitHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');
  const hookMarker = 'Assert: attach session data';

  const safeHookCommand = `
# Assert: attach session data to commits (never blocks)
if [ -x "$HOME/.assert/bin/assert" ]; then
  "$HOME/.assert/bin/assert" pre-commit 2>/dev/null || true
fi`;

  try {
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    // Don't touch symlinked hooks (e.g. husky) — could break other tools.
    if (fs.existsSync(hookPath) && fs.lstatSync(hookPath).isSymbolicLink()) {
      return;
    }
    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, 'utf-8');
      if (content.includes(hookMarker)) return; // Already installed
      fs.appendFileSync(hookPath, safeHookCommand + '\n');
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh${safeHookCommand}\n`);
      fs.chmodSync(hookPath, 0o755);
    }
  } catch {
    // Silent — never break the user's repo.
  }
}

// ------------------------------------------------------------------
// Multi-repo tracking + attribution (the core)
// ------------------------------------------------------------------

/**
 * Start tracking a repo for the active session (idempotent): indexes the
 * session under the repo, records a session-start boundary, and installs the
 * pre-commit hook. Returns the tracked repo, or null if `gitRoot` isn't a repo.
 */
export function ensureRepoTracked(
  state: SessionState,
  gitRoot: string
): TouchedRepo | null {
  const existing = state.repos[gitRoot];
  if (existing) return existing;

  const repoInfo = getOrCreateRepoId(gitRoot);
  if (!repoInfo) return null;
  const { repoId } = repoInfo;

  // Index the session under this repo (idempotent across repos).
  let index = loadIndex();
  index = indexSession(index, state.sessionId, repoId, gitRoot, new Date().toISOString());
  saveIndex(index);

  // Record a session-start boundary (files snapshotted as modified, so empty).
  let gitRef: string | undefined;
  try {
    gitRef = getGitState(gitRoot).ref;
  } catch {
    // Git state unavailable
  }
  recordBoundary(repoId, state.sessionId, 'start', gitRoot, [], gitRef);

  ensurePreCommitHook(gitRoot);

  const tracked: TouchedRepo = { repoId, gitRoot, filesModified: [] };
  state.repos[gitRoot] = tracked;
  return tracked;
}

/**
 * Record that the agent edited a file. Resolves the file's own repo (which may
 * differ from any other file's), tracks it, and indexes the modification.
 * Returns the path relative to that repo, or null if the file isn't in a repo.
 */
export function recordFileEdit(state: SessionState, filePath: string): string | null {
  const fileGitRoot = findGitRoot(path.dirname(filePath));
  if (!fileGitRoot) return null;

  const repo = ensureRepoTracked(state, fileGitRoot);
  if (!repo) return null;

  const relativePath = path.relative(fileGitRoot, filePath);
  if (!repo.filesModified.includes(relativePath)) {
    repo.filesModified.push(relativePath);
  }

  let index = loadIndex();
  index = indexFileModification(index, state.sessionId, repo.repoId, relativePath);
  saveIndex(index);

  return relativePath;
}

/**
 * Begin a session: write the session_start event, initialize state, and (if the
 * launch cwd is itself a repo) start tracking it. Returns the new state.
 */
export function startSession(
  sessionId: string,
  source: string,
  cwd: string
): SessionState {
  // cwd may not be inside a repo (e.g. a parent dir spanning repos).
  const cwdRepo = getOrCreateRepoId(cwd);
  let gitBranch: string | undefined;
  let gitRef: string | undefined;
  if (cwdRepo) {
    try {
      const gitState = getGitState(cwdRepo.gitRoot);
      gitBranch = gitState.branch ?? undefined;
      gitRef = gitState.ref;
    } catch {
      // Git state unavailable
    }
  }

  const startEvent: SessionStartEvent = {
    type: 'session_start',
    timestamp: new Date().toISOString(),
    sessionId,
    source: source as SessionStartEvent['source'],
    cwd,
    gitBranch,
    gitRef,
  };
  writeEvent(sessionId, startEvent);

  const state: SessionState = {
    sessionId,
    source,
    cwd,
    currentTurnId: null,
    pendingToolCalls: new Map(),
    repos: {},
  };

  if (cwdRepo) {
    ensureRepoTracked(state, cwdRepo.gitRoot);
  }

  saveState(state);
  return state;
}

/**
 * Record an end boundary and copy `sessionFile` into the `.sessions/` of every
 * repo it touched where the agent actually changed files.
 */
export function attributeSessionToRepos(state: SessionState, sessionFile: string): void {
  for (const repo of Object.values(state.repos)) {
    recordBoundary(repo.repoId, state.sessionId, 'end', repo.gitRoot, repo.filesModified);

    const agentChanges = calculateAgentChanges(repo.repoId, state.sessionId);
    const hasChanges = Array.from(agentChanges.values()).some(
      (c) => c.added.size > 0 || c.removed.size > 0
    );

    if (hasChanges) {
      copySessionToRepo(sessionFile, state.sessionId, repo.gitRoot);
      console.error(`[assert] Session ${state.sessionId} attributed to ${repo.gitRoot}`);
    }
  }
}

/**
 * End a session: write the session_end event, mark it ended, and attribute/copy
 * to every touched repo. The data written into each repo's `.sessions/` is the
 * agent's own transcript (distilled) when available — that's the full prompts +
 * reasoning + tool calls — falling back to our stitched central log otherwise.
 */
export function endSession(
  state: SessionState,
  reason: 'completed' | 'aborted',
  transcriptPath?: string
): void {
  writeEvent(state.sessionId, {
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    reason,
  });

  let index = loadIndex();
  index = endSessionIndex(index, state.sessionId, new Date().toISOString());
  saveIndex(index);

  // Prefer the distilled agent transcript; fall back to the stitched log.
  let sessionFile = path.join(getSessionsDir(), `${state.sessionId}.jsonl`);
  if (transcriptPath) {
    const distilled = path.join(getSessionsDir(), `${state.sessionId}.distilled.jsonl`);
    if (distillTranscript(transcriptPath, distilled, state.source)) {
      sessionFile = distilled;
    }
  }

  attributeSessionToRepos(state, sessionFile);

  clearState(state.sessionId, state.source);
}
