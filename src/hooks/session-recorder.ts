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
import { createHash } from 'crypto';
import {
  createSessionWriter,
  sessionDirName,
  listSessionDirs,
  sessionEventFiles,
  type SessionWriter,
} from '../session-writer';
import { findGitRoot, getGitState, getChangedFiles, fileAtRef } from '../git-watcher';
import { getOrCreateRepoId, getRepoId } from '../repo-identity';
import {
  loadIndex,
  saveIndex,
  indexSession,
  indexFileModification,
  endSession as endSessionIndex,
  resumeSession as resumeSessionIndex,
  getSessionsDir,
  ensureSessionsDir,
} from '../session-index';
import {
  type SessionEvent,
  type SessionStartEvent,
  type LineOwnership,
  type LineAttributionEvent,
  serializeSessionEvent,
} from '../schema';
import { normalizeClaudeTranscript } from '../transcript';
import {
  hashLine,
  createFileSnapshot,
  carryAttribution,
  type FileSnapshot,
  type AttributionRecord,
} from '../line-attribution';

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

function privateFlagPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.assert', 'private');
}

/**
 * Private mode: still capture to the central store, but don't publish sessions
 * into the repo's `.sessions/`. Set via `ASSERT_PRIVATE` or `assert private`.
 */
export function capturePrivate(): boolean {
  return !!process.env.ASSERT_PRIVATE || fs.existsSync(privateFlagPath());
}

export function setCapturePrivate(priv: boolean): void {
  const flag = privateFlagPath();
  if (priv) {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, '');
  } else {
    try {
      fs.unlinkSync(flag);
    } catch {
      /* already public */
    }
  }
}

export interface SessionState {
  sessionId: string;
  source: string; // 'claude-code' | 'cursor' | 'codex'
  cwd: string;
  createdAt: string; // session creation time; seeds the (stable) session dir name
  endedAt?: string;
  currentTurnId: string | null;
  // Latest human_turn id; the assistant turn links to it (line -> prompt).
  currentPromptId: string | null;
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

function loadStoredState(sessionId: string, source: string): SessionState | null {
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
      createdAt: data.createdAt ?? new Date().toISOString(),
      endedAt: data.endedAt,
      currentTurnId: data.currentTurnId ?? null,
      currentPromptId: data.currentPromptId ?? null,
      pendingToolCalls: new Map(Object.entries(data.pendingToolCalls ?? {})),
      repos: data.repos ?? {},
    };
  } catch {
    return null;
  }
}

export function loadState(sessionId: string, source: string): SessionState | null {
  const state = loadStoredState(sessionId, source);
  return state?.endedAt ? null : state;
}

export function saveState(state: SessionState): void {
  ensureSessionsDir();
  const statePath = getStatePath(state.sessionId, state.source);
  const data = {
    sessionId: state.sessionId,
    source: state.source,
    cwd: state.cwd,
    createdAt: state.createdAt,
    endedAt: state.endedAt,
    currentTurnId: state.currentTurnId,
    currentPromptId: state.currentPromptId,
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
      if (!data.endedAt && (data.cwd === workspaceRoot || data.repos?.[workspaceRoot])) {
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

/** The session's most recent assistant turn (id + model) — what new lines this
 * sync are attributed to. */
function latestTurn(sessionFile: string): { turnId?: string; model?: string } {
  const turn: { turnId?: string; model?: string } = {};
  try {
    for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.type === 'assistant_turn_start') {
        if (o.turnId) turn.turnId = o.turnId;
        if (o.model) turn.model = o.model;
      }
    }
  } catch {
    /* no session file */
  }
  return turn;
}

const EMPTY_LINE_HASH = hashLine('');

/** A snapshot with no lines — a file that didn't exist (all of `after` is new). */
function emptySnapshot(filePath: string): FileSnapshot {
  return { filePath, lines: [], contentHash: '' };
}

/** Reconstruct a snapshot / attribution from a stored line_attribution event. */
function snapshotFromOwnership(filePath: string, lines: LineOwnership[]): FileSnapshot {
  return {
    filePath,
    lines: lines.map((l, i) => ({ lineNumber: i + 1, hash: l.hash, content: '' })),
    contentHash: '',
  };
}
function attributionFromOwnership(lines: LineOwnership[]): AttributionRecord[] {
  return lines.map((l, i) => ({
    lineNumber: i + 1,
    hash: l.hash,
    source: l.source,
    sessionId: l.sessionId,
    agent: l.agent,
    modelId: l.modelId,
    turnId: l.turnId,
    timestamp: '',
  }));
}

/** Directories holding a repo's session files: the published `.sessions/` and
 * the local mirror (`~/.assert/sessions/<repoId>/`, which also has unpublished/
 * private sessions). */
function repoSessionDirs(gitRoot: string): string[] {
  const dirs = [path.join(gitRoot, '.sessions')];
  const repoId = getRepoId(gitRoot)?.repoId;
  if (repoId) dirs.push(path.join(getSessionsDir(), repoId));
  return dirs;
}

/** Copy local-only (private) session dirs from the mirror into the repo's
 * `.sessions/`, skipping ones already published. Returns the count published. */
export function publishLocalSessions(gitRoot: string): number {
  const repoId = getRepoId(gitRoot)?.repoId;
  if (!repoId) return 0;
  const mirrorBase = path.join(getSessionsDir(), repoId);
  const repoBase = path.join(gitRoot, '.sessions');
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(mirrorBase, { withFileTypes: true });
  } catch {
    return 0;
  }
  let published = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue; // skip blame-index.json etc.
    const dest = path.join(repoBase, d.name);
    if (fs.existsSync(dest)) continue; // already published
    fs.cpSync(path.join(mirrorBase, d.name), dest, { recursive: true });
    published++;
  }
  return published;
}

/** The raw session `.jsonl` text for a session in this repo — from the
 * published `.sessions/` or the local mirror. Null if absent. */
export function readSessionFile(gitRoot: string, sessionId: string): string | null {
  for (const base of repoSessionDirs(gitRoot)) {
    const flat = path.join(base, `${sessionId}.jsonl`); // legacy layout
    if (fs.existsSync(flat)) return fs.readFileSync(flat, 'utf-8');
    const match = listSessionDirs(base).find((s) => s.sessionId === sessionId);
    const files = match ? sessionEventFiles(match.dir) : [];
    if (files.length) {
      return `${files.map((f) => fs.readFileSync(f, 'utf-8').replace(/\n+$/, '')).join('\n')}\n`;
    }
  }
  return null;
}

/** Every session `.jsonl` under a base dir — legacy flat files + `<dir>/` layout.
 * Uses readdir only (no meta.json reads), so it's cheap enough for the hot path. */
function allSessionEventFiles(base: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      files.push(path.join(base, e.name)); // legacy flat
    } else if (e.isDirectory()) {
      try {
        for (const f of fs.readdirSync(path.join(base, e.name))) {
          if (f.endsWith('.jsonl')) files.push(path.join(base, e.name, f));
        }
      } catch {
        /* skip */
      }
    }
  }
  return files;
}

// --- Blame index: a local, derived, regenerable cache so `assert blame` reads
// O(1) instead of scanning every turn file. Not committed; keyed by a cheap
// fingerprint of the turn-file set so it self-rebuilds on drift (pull/branch).

interface BlameIndex {
  signature: string;
  files: Record<string, LineAttributionEvent>;
}

function blameIndexPath(gitRoot: string): string | null {
  const repoId = getRepoId(gitRoot)?.repoId;
  return repoId ? path.join(getSessionsDir(), repoId, 'blame-index.json') : null;
}

/** Fingerprint of the turn-file set (names only — no content reads). */
function blameSignature(gitRoot: string): string {
  const names: string[] = [];
  for (const base of repoSessionDirs(gitRoot)) names.push(...allSessionEventFiles(base));
  names.sort();
  return createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
}

/** Rebuild the per-file latest-line_attribution index by scanning turn files. */
export function rebuildBlameIndex(gitRoot: string): BlameIndex {
  const files: Record<string, LineAttributionEvent> = {};
  for (const base of repoSessionDirs(gitRoot)) {
    for (const file of allSessionEventFiles(base)) {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let ev: SessionEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== 'line_attribution') continue;
        const cur = files[ev.filePath];
        if (!cur || ev.timestamp > cur.timestamp) files[ev.filePath] = ev;
      }
    }
  }
  const index: BlameIndex = { signature: blameSignature(gitRoot), files };
  const p = blameIndexPath(gitRoot);
  if (p) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(index));
    } catch {
      /* best-effort cache */
    }
  }
  return index;
}

/** Latest line_attribution for a file via the local index, rebuilt on drift. */
function indexedLatestLineAttribution(gitRoot: string, filePath: string): LineAttributionEvent | null {
  const p = blameIndexPath(gitRoot);
  const sig = blameSignature(gitRoot);
  if (p) {
    try {
      const cached: BlameIndex = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (cached.signature === sig) return cached.files[filePath] ?? null;
    } catch {
      /* missing/corrupt -> rebuild */
    }
  }
  return rebuildBlameIndex(gitRoot).files[filePath] ?? null;
}

/** Newest line_attribution for a file (across published `.sessions/` and the
 * local mirror) whose event satisfies `accept`. Null if none. */
function scanLineAttribution(
  gitRoot: string,
  filePath: string,
  accept: (ev: LineAttributionEvent) => boolean,
): LineAttributionEvent | null {
  let latest: LineAttributionEvent | null = null;
  for (const base of repoSessionDirs(gitRoot)) {
    for (const file of allSessionEventFiles(base)) {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let ev: SessionEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== 'line_attribution' || ev.filePath !== filePath) continue;
        if (accept(ev) && (!latest || ev.timestamp > latest.timestamp)) latest = ev;
      }
    }
  }
  return latest;
}

/** Most recent line_attribution for a file, excluding `excludeSessionId` (this
 * session, for idempotent re-finalize). Null if none. */
export function latestLineAttribution(
  gitRoot: string,
  filePath: string,
  excludeSessionId?: string,
): LineAttributionEvent | null {
  return scanLineAttribution(gitRoot, filePath, (ev) => ev.sessionId !== excludeSessionId);
}

/** This session's own most recent line_attribution for a file — the running
 * per-turn ownership state we thread forward. */
function sessionLineAttribution(
  gitRoot: string,
  filePath: string,
  sessionId: string,
): LineAttributionEvent | null {
  return scanLineAttribution(gitRoot, filePath, (ev) => ev.sessionId === sessionId);
}

/**
 * Per changed file, thread per-line ownership up to the current file state and
 * attribute this turn's new lines to `turn`. Threading starts from this
 * session's own previous attribution when present (so each turn's insertions get
 * that turn's id), otherwise from the latest other-session attribution carried
 * over the start baseline (human edits between sessions). Emits a
 * line_attribution event (for blame) and an attribution event (for traces).
 */
function fileAttributions(
  state: SessionState,
  repo: TouchedRepo,
  changed: string[],
  baseline: Map<string, string>,
  turn: { turnId?: string; model?: string },
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const timestamp = new Date().toISOString();
  const agentEdit = {
    source: 'agent' as const,
    sessionId: state.sessionId,
    agent: state.source as SessionStartEvent['source'],
    modelId: turn.model,
    turnId: turn.turnId,
    timestamp,
  };

  for (const f of changed) {
    let endContent: string;
    try {
      endContent = fs.readFileSync(path.join(repo.gitRoot, f), 'utf-8');
    } catch {
      continue; // deleted — nothing to attribute
    }
    const endSnap = createFileSnapshot(f, endContent);
    const baseContent = baseline.get(f) ?? '';
    const baseSnap = baseContent ? createFileSnapshot(f, baseContent) : emptySnapshot(f);

    let curSnap: FileSnapshot;
    let curAttr: AttributionRecord[];
    const self = sessionLineAttribution(repo.gitRoot, f, state.sessionId);
    if (self) {
      // Continue threading this session's own ownership; earlier turns keep
      // their turnId, only genuinely new lines become `turn`.
      curSnap = snapshotFromOwnership(f, self.lines);
      curAttr = attributionFromOwnership(self.lines);
    } else {
      const prev = latestLineAttribution(repo.gitRoot, f, state.sessionId);
      curSnap = baseSnap;
      curAttr = prev
        ? carryAttribution(
            snapshotFromOwnership(f, prev.lines),
            attributionFromOwnership(prev.lines),
            baseSnap,
            { source: 'human', timestamp },
          )
        : baseSnap.lines.map((l) => ({
            lineNumber: l.lineNumber,
            hash: l.hash,
            source: 'unknown' as const,
            timestamp: '',
          }));
    }
    const endAttr = carryAttribution(curSnap, curAttr, endSnap, agentEdit);
    const ownership: LineOwnership[] = endAttr.map((a) => ({
      hash: a.hash,
      source: a.source,
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.agent ? { agent: a.agent } : {}),
      ...(a.modelId ? { modelId: a.modelId } : {}),
      ...(a.turnId ? { turnId: a.turnId } : {}),
    }));
    if (self && JSON.stringify(self.lines) === JSON.stringify(ownership)) {
      continue;
    }

    events.push({
      type: 'line_attribution',
      timestamp,
      sessionId: state.sessionId,
      filePath: f,
      vcsRevision: repo.startRef,
      lines: ownership,
    });

    // Agent's own lines (excluding blanks, which carry no identity) for traces.
    const aiHashes = [
      ...new Set(
        endAttr
          .filter((a) => a.source === 'agent' && a.sessionId === state.sessionId && a.hash !== EMPTY_LINE_HASH)
          .map((a) => a.hash),
      ),
    ];
    if (aiHashes.length) {
      events.push({
        type: 'attribution',
        timestamp,
        sessionId: state.sessionId,
        filePath: f,
        vcsRevision: repo.startRef,
        operation: baseContent ? 'modify' : 'create',
        contributor: { type: 'ai', agent: state.source as SessionStartEvent['source'], modelId: turn.model },
        lineHashes: aiHashes,
      });
    }
  }
  return events;
}

/**
 * Per-line attribution of `filePath`'s working-tree content: the latest
 * committed ownership aligned to the current file (edits since = human). Null if
 * no session has attributed the file. Powers `assert blame`.
 */
export function blameFile(
  gitRoot: string,
  filePath: string,
  currentContent: string,
): AttributionRecord[] | null {
  const prev = indexedLatestLineAttribution(gitRoot, filePath);
  if (!prev) return null;
  return carryAttribution(
    snapshotFromOwnership(filePath, prev.lines),
    attributionFromOwnership(prev.lines),
    createFileSnapshot(filePath, currentContent),
    { source: 'human', timestamp: '' },
  );
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
    createdAt: new Date().toISOString(),
    currentTurnId: null,
    currentPromptId: null,
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
 * Start a new session or checkpoint and resume an existing one. Agent processes
 * may emit their start hook again after reconnect, resume, or compaction. That
 * must never replace active state: doing so loses the per-turn ownership needed
 * to distinguish earlier work from the next edit.
 */
export function startOrResumeSession(
  sessionId: string,
  source: string,
  cwd: string,
  transcriptPath?: string,
): { state: SessionState; resumed: boolean } {
  const existing = loadStoredState(sessionId, source);
  if (!existing) {
    return { state: startSession(sessionId, source, cwd), resumed: false };
  }

  existing.cwd = cwd;
  const cwdRepo = getOrCreateRepoId(cwd);
  if (cwdRepo) ensureRepoTracked(existing, cwdRepo.gitRoot);

  // Finalize the working state against the transcript that existed before the
  // resumed process accepts more work. This preserves all previous turn IDs.
  syncSession(existing, transcriptPath, true);

  existing.endedAt = undefined;
  writeEvent(sessionId, {
    type: 'session_resume',
    timestamp: new Date().toISOString(),
    sessionId,
  });
  let index = loadIndex();
  for (const repo of Object.values(existing.repos)) {
    index = indexSession(
      index,
      sessionId,
      repo.repoId,
      repo.gitRoot,
      existing.createdAt,
      true,
    );
  }
  index = resumeSessionIndex(index, sessionId);
  saveIndex(index);

  // Pending calls belong to the previous process. A new assistant turn keeps
  // future edits separate while retaining the current prompt link if needed.
  existing.pendingToolCalls.clear();
  existing.currentTurnId = null;
  saveState(existing);
  return { state: existing, resumed: true };
}

// Materialize the session in Assert's consistent schema. When the agent provides
// a native transcript (Claude Code), normalize it — preserving reasoning — so
// every agent is stored identically; otherwise use our stitched central log
// (already in that schema, e.g. Cursor).
function resolveSessionFile(state: SessionState, transcriptPath?: string): string {
  const stitched = path.join(getSessionsDir(), `${state.sessionId}.jsonl`);
  if (!transcriptPath || state.source !== 'claude-code') return stitched;
  try {
    const lifecycleEvents = fs
      .readFileSync(stitched, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SessionEvent)
      .filter((event) =>
        ['session_start', 'session_resume', 'session_end'].includes(event.type),
      );
    const events = [
      ...normalizeClaudeTranscript(
        fs.readFileSync(transcriptPath, 'utf-8'),
        state.sessionId,
      ),
      ...lifecycleEvents,
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!events.length) return stitched;
    const out = path.join(getSessionsDir(), `${state.sessionId}.normalized.jsonl`);
    fs.writeFileSync(out, events.map(serializeSessionEvent).join('\n') + '\n');
    return out;
  } catch {
    return stitched;
  }
}

interface TurnBucket {
  turnId: string;
  lines: string[];
}

/** Identity of an immutable transcript event, ignoring turn ids that older
 * normalizers generated differently for the same native message. */
function immutableEventKey(line: string): string {
  try {
    const event = JSON.parse(line) as SessionEvent;
    switch (event.type) {
      case 'assistant_reasoning':
        return `${event.type}\0${event.timestamp}\0${event.text}`;
      case 'assistant_text':
        return `${event.type}\0${event.timestamp}\0${event.text}`;
      case 'tool_call':
        return `${event.type}\0${event.timestamp}\0${event.toolCallId}`;
      case 'tool_result':
        return `${event.type}\0${event.timestamp}\0${event.toolCallId}`;
      default:
        return line;
    }
  } catch {
    return line;
  }
}

/**
 * Split a transcript into per-turn buckets ("exchanges"): a turn starts at a
 * human_turn (the prompt) or an assistant_turn_start, and holds everything until
 * the next one. Each bucket is keyed by its assistant turnId (what blame's
 * line_attribution references), falling back to the prompt id. Leading orphan
 * events (session_start) fold into the first bucket. Stable across re-splits of
 * a grown transcript, so materialized turn files stay immutable.
 */
function splitTranscriptByTurn(transcript: string): TurnBucket[] {
  interface Segment {
    assistantTurnId?: string;
    humanTurnId?: string;
    lines: string[];
  }
  const segs: Segment[] = [];
  let leading: string[] = [];

  for (const raw of transcript.split('\n')) {
    if (!raw.trim()) continue;
    let ev: { type?: string; turnId?: string };
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      ev.type === 'session_start' ||
      ev.type === 'session_resume' ||
      ev.type === 'session_end'
    ) {
      continue; // lifecycle events are materialized independently
    }
    const cur = segs[segs.length - 1];
    if (ev.type === 'human_turn') {
      segs.push({ humanTurnId: ev.turnId, lines: [...leading, raw] });
      leading = [];
    } else if (ev.type === 'session_resume') {
      leading.push(raw);
    } else if (ev.type === 'assistant_turn_start') {
      // Claude may emit several assistant message blocks for one logical turn.
      // Repeated starts with the same canonical id stay in the prompt segment.
      if (
        cur &&
        (!cur.assistantTurnId || cur.assistantTurnId === ev.turnId)
      ) {
        cur.assistantTurnId ??= ev.turnId;
        cur.lines.push(raw);
      } else {
        segs.push({ assistantTurnId: ev.turnId, lines: [...leading, raw] });
        leading = [];
      }
    } else if (cur) {
      cur.lines.push(raw);
    } else {
      leading.push(raw); // orphan before any turn (e.g. session_start)
    }
  }
  return segs.map((s) => ({ turnId: s.assistantTurnId ?? s.humanTurnId ?? 'session', lines: s.lines }));
}

/**
 * Sync the session into one repo: find what the agent changed there via git
 * (any change, however made), honoring `.assertignore`. Writes the session
 * (consistent schema) into `<repo>/.sessions/<id>.jsonl`. On `final`, also
 * appends threaded per-line attribution (for `assert blame`) and portable
 * `attribution` events (for traces).
 */
function syncRepo(
  state: SessionState,
  repo: TouchedRepo,
  sessionFile: string,
  final: boolean,
  turn: { turnId?: string; model?: string },
): void {
  const ignore = loadAssertIgnore(repo.gitRoot);
  const changed = getChangedFiles(repo.gitRoot, repo.startRef).filter((f) => !isIgnored(f, ignore));
  if (changed.length === 0) return;

  let index = loadIndex();
  for (const f of changed) index = indexFileModification(index, state.sessionId, repo.repoId, f);
  saveIndex(index);

  let transcript = '';
  try {
    transcript = fs.readFileSync(sessionFile, 'utf-8');
  } catch {
    /* no session file yet */
  }
  const turns = splitTranscriptByTurn(transcript);
  const lifecycleEvents = transcript
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter(
      (event): event is SessionEvent =>
        event != null &&
        (event.type === 'session_start' ||
          event.type === 'session_resume' ||
          event.type === 'session_end'),
    );

  // Attribution for changed files (full current ownership), appended to the
  // latest turn's file so blame reads the newest snapshot per file.
  let attribution: string[] = [];
  if (final) {
    const baseline = new Map<string, string>();
    for (const f of changed) baseline.set(f, fileAtRef(repo.gitRoot, repo.startRef, f) ?? '');
    attribution = fileAttributions(state, repo, changed, baseline, turn).map(serializeSessionEvent);
  }

  // Changes can happen outside an assistant turn (e.g. bash/formatter, or a
  // direct syncSession); still materialize the orphan transcript + attribution
  // under a session-level bucket so blame has a home.
  if (turns.length === 0) {
    const orphan = transcript.split('\n').filter((l) => l.trim());
    if (orphan.length === 0 && attribution.length === 0) return;
    turns.push({ turnId: turn.turnId ?? state.currentTurnId ?? 'session', lines: orphan });
  }

  // Immutable per-turn files in a per-session dir (`<time>-<id8>/`). A logical
  // turn may gain later assistant blocks, so append only its missing events in
  // continuation files; existing files are never rewritten.
  const dirName = sessionDirName(state.sessionId, state.createdAt);
  const writeInto = (base: string) => {
    const sdir = path.join(base, dirName);
    fs.mkdirSync(sdir, { recursive: true });
    const metaPath = path.join(sdir, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      const meta = { sessionId: state.sessionId, source: state.source, createdAt: state.createdAt };
      fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    }
    for (const event of lifecycleEvents) {
      const timestamp = event.timestamp.replace(/\D/g, '');
      const lifecyclePath = path.join(
        sdir,
        `zzzz-${timestamp}-${event.type}.jsonl`,
      );
      if (!fs.existsSync(lifecyclePath)) {
        fs.writeFileSync(lifecyclePath, `${serializeSessionEvent(event)}\n`);
      }
    }
    const existingEventKeys = new Set<string>();
    let nextFileIndex = 0;
    for (const file of sessionEventFiles(sdir)) {
      const match = /^(\d+)-(.+)\.jsonl$/.exec(path.basename(file));
      if (!match) continue;
      nextFileIndex = Math.max(nextFileIndex, Number.parseInt(match[1], 10) + 1);
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (line.trim()) existingEventKeys.add(immutableEventKey(line));
      }
    }
    turns.forEach((t, i) => {
      const lines = [...t.lines];
      if (i === turns.length - 1) lines.push(...attribution);
      const missingLines = lines.filter(
        (line) => !existingEventKeys.has(immutableEventKey(line)),
      );
      if (missingLines.length === 0) return;
      fs.writeFileSync(
        path.join(
          sdir,
          `${String(nextFileIndex++).padStart(4, '0')}-${t.turnId}.jsonl`,
        ),
        `${missingLines.join('\n')}\n`,
      );
      for (const line of missingLines) {
        existingEventKeys.add(immutableEventKey(line));
      }
    });
  };

  writeInto(path.join(getSessionsDir(), repo.repoId));
  if (!capturePrivate()) writeInto(path.join(repo.gitRoot, '.sessions'));
}

/**
 * Materialize the session into every touched repo with changes. Called at each
 * turn boundary so session data lands in the working tree (visible in
 * `git status`) before the developer commits — never injected at commit time.
 *
 * Pass `final` to also write portable attribution events and boundaries (the
 * trace/blame data normally written only at session end). Agents without a
 * session-end hook (Codex) use this on every turn; it is idempotent.
 */
export function syncSession(
  state: SessionState,
  transcriptPath?: string,
  final = false,
): void {
  const sessionFile = resolveSessionFile(state, transcriptPath);
  const turn = latestTurn(sessionFile);
  for (const repo of Object.values(state.repos)) syncRepo(state, repo, sessionFile, final, turn);
}

/**
 * End a session: write session_end, mark it ended, and do a final sync that also
 * records attribution (events + boundaries).
 */
export function endSession(
  state: SessionState,
  reason: 'completed' | 'aborted',
  transcriptPath?: string
): void {
  const endedAt = new Date().toISOString();
  writeEvent(state.sessionId, {
    type: 'session_end',
    timestamp: endedAt,
    sessionId: state.sessionId,
    reason,
  });

  let index = loadIndex();
  index = endSessionIndex(index, state.sessionId, endedAt);
  saveIndex(index);

  const sessionFile = resolveSessionFile(state, transcriptPath);
  const turn = latestTurn(sessionFile);
  for (const repo of Object.values(state.repos)) syncRepo(state, repo, sessionFile, true, turn);

  state.endedAt = endedAt;
  state.currentTurnId = null;
  state.pendingToolCalls.clear();
  saveState(state);
}
