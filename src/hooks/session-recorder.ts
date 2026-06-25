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
import { findGitRoot, getGitState, getChangedFiles, fileAtRef } from '../git-watcher';
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
import { recordBoundary } from '../boundaries';
import { type SessionEvent, type SessionStartEvent } from '../schema';

/** A single repo touched by a session. */
export interface TouchedRepo {
  repoId: string;
  gitRoot: string;
  startRef?: string; // HEAD when first tracked — the attribution baseline.
}

function disabledFlagPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.assert', 'disabled');
}

/** Capture is off when ASSERT_DISABLE is set or `assert disable` was run. */
export function captureDisabled(): boolean {
  return !!process.env.ASSERT_DISABLE || fs.existsSync(disabledFlagPath());
}

export function setCaptureDisabled(disabled: boolean): void {
  const flag = disabledFlagPath();
  if (disabled) {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, '');
  } else {
    try {
      fs.unlinkSync(flag);
    } catch {
      /* already enabled */
    }
  }
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

/** Patterns from a repo's `.assertignore` (gitignore-ish: `*`, `**`, trailing `/`). */
function loadAssertIgnore(gitRoot: string): RegExp[] {
  try {
    return fs
      .readFileSync(path.join(gitRoot, '.assertignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((glob) => {
        const body = glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .split('**')
          .map((s) => s.replace(/\*/g, '[^/]*'))
          .join('.*');
        return new RegExp('^' + body + (glob.endsWith('/') ? '' : '(/|$)'));
      });
  } catch {
    return [];
  }
}

function isIgnored(rel: string, patterns: RegExp[]): boolean {
  const base = rel.split('/').pop() ?? rel;
  return patterns.some((re) => re.test(rel) || re.test(base));
}

// ------------------------------------------------------------------
// Multi-repo tracking + attribution (the core)
// ------------------------------------------------------------------

/**
 * Start tracking a repo for the active session (idempotent): indexes the session
 * under the repo and records its baseline ref. Returns the tracked repo, or null
 * if `gitRoot` isn't a repo.
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

  let index = loadIndex();
  index = indexSession(index, state.sessionId, repoId, gitRoot, new Date().toISOString());
  saveIndex(index);

  let startRef: string | undefined;
  try {
    startRef = getGitState(gitRoot).ref;
  } catch {
    // Git state unavailable
  }

  const tracked: TouchedRepo = { repoId, gitRoot, startRef };
  state.repos[gitRoot] = tracked;
  return tracked;
}

/**
 * Record that the agent touched a file: track its repo (which may differ from
 * other files') so we sync that repo later. Returns the repo-relative path for
 * transcript metadata, or null if the file isn't in a repo.
 */
export function recordFileEdit(state: SessionState, filePath: string): string | null {
  const fileGitRoot = findGitRoot(path.dirname(filePath));
  if (!fileGitRoot) return null;
  if (!ensureRepoTracked(state, fileGitRoot)) return null;
  return path.relative(fileGitRoot, filePath);
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

// Prefer the distilled agent transcript (full prompts + reasoning + tool calls);
// fall back to our stitched central log.
function resolveSessionFile(state: SessionState, transcriptPath?: string): string {
  const stitched = path.join(getSessionsDir(), `${state.sessionId}.jsonl`);
  if (!transcriptPath) return stitched;
  const distilled = path.join(getSessionsDir(), `${state.sessionId}.distilled.jsonl`);
  return distillTranscript(transcriptPath, distilled, state.source) ? distilled : stitched;
}

/**
 * Sync the session into one repo: find what the agent changed there via git
 * (any change, however made), honoring `.assertignore`. If anything changed,
 * index those files and copy the session data into `<repo>/.sessions/`. On
 * `final`, also record start/end attribution boundaries for `assert blame`.
 */
function syncRepo(state: SessionState, repo: TouchedRepo, sessionFile: string, final: boolean): void {
  const ignore = loadAssertIgnore(repo.gitRoot);
  const changed = getChangedFiles(repo.gitRoot, repo.startRef).filter((f) => !isIgnored(f, ignore));
  if (changed.length === 0) return;

  let index = loadIndex();
  for (const f of changed) index = indexFileModification(index, state.sessionId, repo.repoId, f);
  saveIndex(index);

  if (final) {
    const baseline = new Map<string, string>();
    for (const f of changed) baseline.set(f, fileAtRef(repo.gitRoot, repo.startRef, f) ?? '');
    recordBoundary(repo.repoId, state.sessionId, 'start', repo.gitRoot, changed, repo.startRef, baseline);
    recordBoundary(repo.repoId, state.sessionId, 'end', repo.gitRoot, changed);
  }

  copySessionToRepo(sessionFile, state.sessionId, repo.gitRoot);
}

/**
 * Materialize the session into every touched repo with changes. Called at each
 * turn boundary so session data lands in the working tree (visible in
 * `git status`) before the developer commits — never injected at commit time.
 */
export function syncSession(state: SessionState, transcriptPath?: string): void {
  const sessionFile = resolveSessionFile(state, transcriptPath);
  for (const repo of Object.values(state.repos)) syncRepo(state, repo, sessionFile, false);
}

/**
 * End a session: write session_end, mark it ended, and do a final sync that also
 * records attribution boundaries.
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

  const sessionFile = resolveSessionFile(state, transcriptPath);
  for (const repo of Object.values(state.repos)) syncRepo(state, repo, sessionFile, true);

  clearState(state.sessionId, state.source);
}
