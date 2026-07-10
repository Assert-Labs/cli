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
      createdAt: data.createdAt ?? new Date().toISOString(),
      currentTurnId: data.currentTurnId ?? null,
      currentPromptId: data.currentPromptId ?? null,
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
    createdAt: state.createdAt,
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

    events.push({
      type: 'line_attribution',
      timestamp,
      sessionId: state.sessionId,
      filePath: f,
      vcsRevision: repo.startRef,
      lines: endAttr.map((a) => ({
        hash: a.hash,
        source: a.source,
        ...(a.sessionId ? { sessionId: a.sessionId } : {}),
        ...(a.agent ? { agent: a.agent } : {}),
        ...(a.modelId ? { modelId: a.modelId } : {}),
        ...(a.turnId ? { turnId: a.turnId } : {}),
      })),
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

// Materialize the session in Assert's consistent schema. When the agent provides
// a native transcript (Claude Code), normalize it — preserving reasoning — so
// every agent is stored identically; otherwise use our stitched central log
// (already in that schema, e.g. Cursor).
function resolveSessionFile(state: SessionState, transcriptPath?: string): string {
  const stitched = path.join(getSessionsDir(), `${state.sessionId}.jsonl`);
  if (!transcriptPath || state.source !== 'claude-code') return stitched;
  try {
    const events = normalizeClaudeTranscript(fs.readFileSync(transcriptPath, 'utf-8'), state.sessionId);
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
    const cur = segs[segs.length - 1];
    if (ev.type === 'human_turn') {
      segs.push({ humanTurnId: ev.turnId, lines: [...leading, raw] });
      leading = [];
    } else if (ev.type === 'assistant_turn_start') {
      // The response to the current prompt joins its segment; a second assistant
      // turn without an intervening prompt starts a new one.
      if (cur && !cur.assistantTurnId) {
        cur.assistantTurnId = ev.turnId;
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

  // Immutable per-turn files in a per-session dir (`<time>-<id8>/`): each turn is
  // written once (keyed by turnId), so continuing a session only ADDS files —
  // never rewrites — which keeps the working tree free of session churn.
  const dirName = sessionDirName(state.sessionId, state.createdAt);
  const writeInto = (base: string) => {
    const sdir = path.join(base, dirName);
    fs.mkdirSync(sdir, { recursive: true });
    const metaPath = path.join(sdir, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      const meta = { sessionId: state.sessionId, source: state.source, createdAt: state.createdAt };
      fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    }
    const existing = new Set(
      sessionEventFiles(sdir)
        .map((f) => /^\d+-(.+)\.jsonl$/.exec(path.basename(f))?.[1])
        .filter((id): id is string => !!id),
    );
    turns.forEach((t, i) => {
      if (existing.has(t.turnId)) return; // immutable: already materialized
      const lines = [...t.lines];
      if (i === turns.length - 1) lines.push(...attribution);
      fs.writeFileSync(path.join(sdir, `${String(i).padStart(4, '0')}-${t.turnId}.jsonl`), `${lines.join('\n')}\n`);
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
  const turn = latestTurn(sessionFile);
  for (const repo of Object.values(state.repos)) syncRepo(state, repo, sessionFile, true, turn);

  clearState(state.sessionId, state.source);
}
