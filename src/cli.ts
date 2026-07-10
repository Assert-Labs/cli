#!/usr/bin/env node
/**
 * Assert CLI
 *
 * Capture agent sessions from any agentic coding tool (Cursor, Claude Code, Codex, etc.)
 * Sessions are stored centrally in ~/.assert/sessions/ and copied to repo .sessions/
 * only when there are actual code changes to attribute.
 */

import * as fs from 'fs';
import * as path from 'path';
import { processHook, type AgentType } from './hooks/index';
import {
  captureDisabled,
  setCaptureDisabled,
  capturePrivate,
  setCapturePrivate,
  blameFile,
  readSessionFile,
  rebuildBlameIndex,
  publishLocalSessions,
} from './hooks/session-recorder';
import {
  claudePluginDir,
  cursorPluginDir,
  codexConfigPath,
  codexSkillDir,
  detectClaudeCodeVersion,
  generateClaudeCodePlugin,
  generateCursorPlugin,
  upsertCodexConfigHooks,
  findCodexCli,
  detectCodexCliVersion,
  skillMd,
} from './plugins';
import {
  listSessionFiles,
  readSessionEvents,
  extractSessionMetadata,
  findActiveSessions,
  listSessionDirs,
  sessionEventFiles,
} from './session-writer';
import { randomUUID } from 'crypto';
import { findGitRoot, getGitState, fileAtRef } from './git-watcher';
import { buildTrace } from './agent-trace';
import { type AttributionEvent, type SessionEvent, type SessionSource } from './schema';
import { getRepoId } from './repo-identity';
import { getSessionsDir, loadIndex } from './session-index';

import { calculateAgentContribution, hashLine, type AttributionRecord } from './line-attribution';
import { parseSession, getTurn, turnContext, type BlameLine } from './core';
import { execSync } from 'child_process';

// === Helpers ===

function log(msg: string): void {
  console.log(`[assert] ${msg}`);
}

function error(msg: string): void {
  console.error(`[assert] error: ${msg}`);
}

function warn(msg: string): void {
  console.error(`[assert] warning: ${msg}`);
}

// Injected at build time via esbuild `define` (see scripts/build.mjs). Falls
// back to 'dev' when running from source (tsx), where no define is applied.
declare const __ASSERT_VERSION__: string;
const VERSION: string =
  typeof __ASSERT_VERSION__ === 'string' ? __ASSERT_VERSION__ : 'dev';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

// === Commands ===

/**
 * Detect which coding agents are installed on this system
 */
function detectInstalledAgents(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const detected: string[] = [];

  // Claude Code: check for .claude directory
  if (fs.existsSync(path.join(home, '.claude'))) {
    detected.push('claude-code');
  }

  // Cursor: check for .cursor directory
  if (fs.existsSync(path.join(home, '.cursor'))) {
    detected.push('cursor');
  }

  // Codex: check for .codex directory
  if (fs.existsSync(path.join(home, '.codex'))) {
    detected.push('codex');
  }

  return detected;
}

function writePlugin(
  pluginDir: string,
  metaSubdir: string,
  files: { pluginJson: string; hooksJson: string },
): void {
  const metaDir = path.join(pluginDir, metaSubdir);
  const hooksDir = path.join(pluginDir, 'hooks');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'plugin.json'), files.pluginJson + '\n');
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), files.hooksJson + '\n');
}

// Write the shared Agent Skill into a plugin's skills/assert/ directory.
function writeSkill(pluginDir: string): void {
  const skillDir = path.join(pluginDir, 'skills', 'assert');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd());
}

function installClaudeCodePlugin(home: string): void {
  const dir = claudePluginDir(home);
  const claudeVersion = detectClaudeCodeVersion();
  writePlugin(
    dir,
    '.claude-plugin',
    generateClaudeCodePlugin(VERSION, claudeVersion),
  );
  // Claude treats ~/.claude/skills/assert itself as the skill folder.
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd());
  log('✓ Claude Code');
}

function installCursorPlugin(home: string): void {
  // Remove a plugin from the pre-fix location (~/.cursor/plugins/assert), which
  // Cursor never auto-loaded.
  try {
    fs.rmSync(path.join(home, '.cursor', 'plugins', 'assert'), {
      recursive: true,
      force: true,
    });
  } catch {
    /* nothing to clean up */
  }
  const dir = cursorPluginDir(home);
  writePlugin(dir, '.cursor-plugin', generateCursorPlugin(VERSION));
  writeSkill(dir);
  log('✓ Cursor');
}

function installCodexPlugin(home: string): void {
  const assertBin = path.join(home, '.assert', 'bin', 'assert');

  const skillDir = codexSkillDir(home);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd());

  const configPath = codexConfigPath(home);
  let config: string | null = null;
  try {
    config = fs.readFileSync(configPath, 'utf-8');
  } catch {
    /* no config yet */
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    upsertCodexConfigHooks(config, assertBin, configPath),
  );

  log('✓ Codex');

  const cli = findCodexCli(home);
  const pathVersion = detectCodexCliVersion();
  if (pathVersion && !cli) {
    warn(
      `Codex v${pathVersion} does not support hooks; assert capture needs a newer Codex CLI.`,
    );
  } else if (pathVersion && cli !== 'codex') {
    warn(
      `your \`codex\` on PATH (v${pathVersion}) predates hook support; ` +
        'capture runs only with a modern Codex CLI or the Codex app.',
    );
  }
}

/**
 * The (pre-realpath) path of the binary we're running from.
 *
 * For a SEA build the binary IS process.execPath. We must NOT use
 * process.argv[1]: when a SEA binary is launched via PATH (e.g. Homebrew's
 * `assert init`), argv[1] is the bare launch name ("assert"), not a path.
 * Resolving that against the cwd would yield `<cwd>/assert`, which realpath
 * then rejects with ENOENT unless a file named `assert` happens to exist in the
 * cwd — the "path did not exist" failure users hit from a brew install.
 *
 * For the JS layout (npm / from source) argv[1] points at bin/assert.js, and is
 * resolved against the cwd if relative so callers can locate sibling files.
 */
export function runningBinPath(
  runningAsSea: boolean,
  argv1: string | undefined,
  execPath: string,
  cwd: string,
): string {
  if (runningAsSea) return execPath;
  const bin = argv1 ?? '';
  return path.isAbsolute(bin) ? bin : path.resolve(cwd, bin);
}

/**
 * The launcher for the running CLI as found on PATH — i.e. the PATH entry
 * (Homebrew's `/opt/homebrew/bin/assert` shim, or the npm global symlink) whose
 * target IS the binary we're running. Returned WITHOUT resolving symlinks: that
 * un-resolved shim is the stable indirection point a `brew upgrade` / `npm i -g`
 * rewrites in place, so linking ~/.assert/bin/assert to it lets upgrades flow
 * through to the agents' hooks automatically. `excludeDir` (our own
 * ~/.assert/bin) is skipped so we never link to the symlink we manage.
 *
 * Returns null when the running binary isn't reachable via PATH (e.g. invoked by
 * a relative path or from source); callers fall back to the resolved binary.
 */
export function findStableBinPath(
  pathEnv: string,
  binName: string,
  excludeDir: string,
  runningBinReal: string,
  realpath: (p: string) => string | null,
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || path.resolve(dir) === path.resolve(excludeDir)) continue;
    if (realpath(path.join(dir, binName)) === runningBinReal) {
      return path.join(dir, binName);
    }
  }
  return null;
}

async function cmdInit(agent?: string): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const assertDir = path.join(home, '.assert');
  const binDir = path.join(assertDir, 'bin');
  const destBin = path.join(binDir, 'assert');

  // SEA (single self-contained binary) vs the npm/source JS layout only affects
  // how we resolve the running binary's own path (see runningBinPath).
  let runningAsSea = false;
  try {
    runningAsSea = (await import('node:sea')).isSea();
  } catch {
    /* not a SEA build */
  }

  // The agents' hooks invoke a fixed path — $HOME/.assert/bin/assert (see
  // src/plugins.ts) — so capture works regardless of the hook's PATH and no
  // matter how the CLI was installed. We make that path a SYMLINK to the real
  // binary rather than a copy: pointing it at the on-PATH launcher means a later
  // `brew upgrade` / `npm i -g` flows through to the hooks automatically, with
  // no stale duplicate to detect or refresh.
  const currentBin = fs.realpathSync(
    runningBinPath(
      runningAsSea,
      process.argv[1],
      process.execPath,
      process.cwd(),
    ),
  );

  fs.mkdirSync(binDir, { recursive: true });
  // Remove our symlink before searching PATH: a back-link into it (e.g.
  // ~/.local/bin/assert -> here) then dangles and is skipped, avoiding a cycle.
  fs.rmSync(destBin, { force: true });

  const linkTarget =
    findStableBinPath(
      process.env.PATH ?? '',
      'assert',
      binDir,
      currentBin,
      (p) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return null;
        }
      },
    ) ?? currentBin;

  fs.symlinkSync(linkTarget, destBin);

  // Remove leftovers from older copy-based installs (the duplicated dist bundle
  // and the version stamp that backed the now-removed stale check).
  fs.rmSync(path.join(assertDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(assertDir, 'install.json'), { force: true });

  log(`Linked ${destBin} -> ${linkTarget}`);

  // Detect installed agents
  const detectedAgents = detectInstalledAgents();
  const supportedAgents = ['claude-code', 'cursor', 'codex'];

  // Filter to requested agent or all detected+supported
  let agentsToInstall: string[];
  if (agent) {
    if (!supportedAgents.includes(agent)) {
      error(`Unsupported agent: ${agent}`);
      log(`Supported agents: ${supportedAgents.join(', ')}`);
      process.exit(1);
    }
    agentsToInstall = [agent];
  } else {
    agentsToInstall = detectedAgents.filter((a) => supportedAgents.includes(a));
  }

  if (agentsToInstall.length === 0) {
    log('No supported agents detected.');
    log(`Supported agents: ${supportedAgents.join(', ')}`);
    return;
  }

  // Install plugins (each bundles the capture hooks + the guidance skill).
  for (const a of agentsToInstall) {
    if (a === 'claude-code') {
      installClaudeCodePlugin(home);
    } else if (a === 'cursor') {
      installCursorPlugin(home);
    } else if (a === 'codex') {
      installCodexPlugin(home);
    }
  }

  console.log('');
  log('Restart your agent or run /reload-plugins to activate.');
}

async function cmdHook(agent: string, hookType: string): Promise<void> {
  const validAgents = ['claude-code', 'cursor', 'codex'];
  if (!validAgents.includes(agent)) {
    error(`Unknown agent: ${agent}`);
    process.exit(1);
  }

  const input = await readStdin();

  try {
    await processHook(agent as AgentType, hookType, input || '{}');
  } catch (e) {
    error(`Hook processing failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdSessions(): Promise<void> {
  const cwd = process.cwd();
  const sessionIds = listSessionFiles(cwd);

  if (sessionIds.length === 0) {
    log('No sessions found in .sessions/');
    return;
  }

  const activeSessions = new Set(findActiveSessions(cwd));

  log(`Found ${sessionIds.length} session(s):\n`);

  for (const id of sessionIds) {
    const events = readSessionEvents(id, cwd);
    const metadata = extractSessionMetadata(events);

    if (!metadata) {
      console.log(`  ${id} (invalid - no start event)`);
      continue;
    }

    const status = activeSessions.has(id) ? '[ACTIVE]' : '[ended]';
    const source = metadata.source.padEnd(12);
    const turns = `${metadata.turnCount} turns`;
    const tools = `${metadata.toolCallCount} tool calls`;
    const files =
      metadata.filesModified.length > 0
        ? `${metadata.filesModified.length} files`
        : 'no files';

    console.log(`  ${status} ${id}`);
    console.log(
      `           source: ${source} | ${turns} | ${tools} | ${files}`,
    );
    console.log(`           started: ${metadata.startTime}`);
    if (metadata.branches.length > 0) {
      console.log(`           branches: ${metadata.branches.join(', ')}`);
    }
    console.log('');
  }
}

async function cmdShow(sessionId: string): Promise<void> {
  const cwd = process.cwd();
  const events = readSessionEvents(sessionId, cwd);

  if (events.length === 0) {
    error(`Session ${sessionId} not found or empty`);
    process.exit(1);
  }

  const metadata = extractSessionMetadata(events);

  console.log(`Session: ${sessionId}`);
  if (metadata) {
    console.log(`Source: ${metadata.source}`);
    console.log(`Started: ${metadata.startTime}`);
    if (metadata.endTime) {
      console.log(`Ended: ${metadata.endTime}`);
    }
    console.log(`Branches: ${metadata.branches.join(', ') || 'none'}`);
    console.log(`Turns: ${metadata.turnCount}`);
    console.log(`Tool Calls: ${metadata.toolCallCount}`);
    console.log(
      `Files Modified: ${metadata.filesModified.join(', ') || 'none'}`,
    );
  }
  console.log('');
  console.log('Events:');
  console.log('-------');

  for (const event of events) {
    const time = event.timestamp.substring(11, 19);
    switch (event.type) {
      case 'session_start':
        console.log(
          `${time} [session_start] cwd=${event.cwd}, branch=${event.gitBranch || 'none'}`,
        );
        break;
      case 'session_end':
        console.log(`${time} [session_end] reason=${event.reason}`);
        break;
      case 'human_turn':
        const preview = event.content.substring(0, 60);
        console.log(
          `${time} [human] "${preview}${event.content.length > 60 ? '...' : ''}"`,
        );
        break;
      case 'assistant_turn_start':
        console.log(
          `${time} [assistant_start] model=${event.model || 'unknown'}`,
        );
        break;
      case 'assistant_text':
        const text = event.text || '';
        const textPreview = text.substring(0, 60);
        console.log(
          `${time} [assistant_text] "${textPreview}${text.length > 60 ? '...' : ''}"`,
        );
        break;
      case 'assistant_turn_end':
        console.log(`${time} [assistant_end]`);
        break;
      case 'tool_call':
        console.log(
          `${time} [tool_call] ${event.toolName}(${JSON.stringify(event.input).substring(0, 40)}...)`,
        );
        break;
      case 'tool_result':
        const output = event.output || event.error || '';
        console.log(
          `${time} [tool_result] ${output.substring(0, 50)}${output.length > 50 ? '...' : ''}`,
        );
        break;
      case 'branch_switch':
        console.log(
          `${time} [branch_switch] ${event.fromBranch || 'none'} -> ${event.toBranch}`,
        );
        break;
      case 'file_attribution':
        console.log(
          `${time} [file_attribution] ${event.operation} ${event.filePath}`,
        );
        break;
    }
  }
}

async function cmdStatus(): Promise<void> {
  const cwd = process.cwd();

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const gitState = getGitState(gitRoot);
    console.log(`Git branch: ${gitState.branch || 'detached'}`);
    console.log(`Git ref: ${gitState.ref.substring(0, 7)}`);
  } else {
    console.log('Git: not a repository');
  }
  console.log('');

  const activeSessions = findActiveSessions(cwd);
  console.log(`Active sessions: ${activeSessions.length}`);
  for (const id of activeSessions) {
    console.log(`  - ${id}`);
  }

  console.log('');
  console.log(
    `Capture: ${captureDisabled() ? 'disabled (run `assert enable`)' : 'enabled'}`,
  );
  if (!captureDisabled()) {
    console.log(
      `Publish: ${capturePrivate() ? 'private (kept out of this repo; run `assert public`)' : 'public'}`,
    );
  }
  console.log(`Assert version: ${VERSION}`);
  // The hooks invoke ~/.assert/bin/assert, a symlink to the installed binary.
  // If it resolves, hooks run whatever the symlink points at (kept current by
  // brew/npm upgrades); if it's missing or dangling, capture won't fire.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const hookBin = path.join(home, '.assert', 'bin', 'assert');
  try {
    const target = fs.realpathSync(hookBin);
    console.log(`Installed hooks: ${hookBin} -> ${target}`);
  } catch {
    console.log('Installed hooks: not initialized (run `assert init`)');
  }
}

function cmdDisable(): void {
  setCaptureDisabled(true);
  log('Capture disabled. Hooks stay installed; run `assert enable` to resume.');
}

function cmdEnable(): void {
  setCaptureDisabled(false);
  log('Capture enabled.');
}

/**
 * Private mode: keep capturing to the central store, but stop publishing into
 * this repo's `.sessions/` and drop any uncommitted session changes from the
 * working tree (the data stays in ~/.assert).
 */
function cmdPrivate(): void {
  setCapturePrivate(true);
  const gitRoot = findGitRoot(process.cwd());
  let cleaned = false;
  if (gitRoot && fs.existsSync(path.join(gitRoot, '.sessions'))) {
    try {
      execSync('git checkout -- .sessions', { cwd: gitRoot, stdio: 'pipe' });
      execSync('git clean -f -- .sessions', { cwd: gitRoot, stdio: 'pipe' });
      cleaned = true;
    } catch {
      /* best effort — nothing to clean, or not a git repo */
    }
  }
  log('Private mode: sessions are still captured to ~/.assert but no longer written to this repo.');
  if (cleaned) log('Dropped uncommitted .sessions/ changes from the working tree.');
}

/** Public mode (default): resume publishing sessions into the repo's `.sessions/`. */
function cmdPublic(): void {
  setCapturePrivate(false);
  log('Public mode: sessions will be written into this repo again from now on.');
}

/**
 * Reconcile local capture with the repo: publish any local-only (private)
 * sessions into `.sessions/`, then rebuild the derived blame index against the
 * current tree. Never rewrites the immutable per-turn logs. Mostly automatic
 * (hooks + lazy index); this is the manual escape hatch after a branch switch,
 * stash, or a private→public change.
 */
function cmdSync(): void {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    error('Not in a git repository');
    process.exit(1);
  }
  const promoted = publishLocalSessions(gitRoot);
  rebuildBlameIndex(gitRoot);
  log(`Synced: published ${promoted} local session(s) into .sessions/, blame index rebuilt.`);
}

/** Collect attribution events from the committed .sessions/ JSONL files. */
function gatherFragments(gitRoot: string): AttributionEvent[] {
  const base = path.join(gitRoot, '.sessions');
  const out: AttributionEvent[] = [];
  // Legacy flat `<id>.jsonl` plus the `<dir>/` layout (session dirs of `.jsonl`).
  const files: string[] = [];
  try {
    for (const f of fs.readdirSync(base)) if (f.endsWith('.jsonl')) files.push(path.join(base, f));
  } catch {
    return out;
  }
  for (const s of listSessionDirs(base)) files.push(...sessionEventFiles(s.dir));
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'attribution') out.push(o as AttributionEvent);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** Derive an agent-trace TraceRecord for a revision (default HEAD) and print it. */
async function cmdTrace(ref?: string): Promise<void> {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    error('Not a git repository');
    process.exit(1);
  }
  const revision = ref || getGitState(gitRoot).ref;
  const trace = buildTrace(
    gatherFragments(gitRoot),
    (p) => fileAtRef(gitRoot, revision, p),
    revision,
    {
      toolVersion: VERSION,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    },
  );
  console.log(JSON.stringify(trace, null, 2));
}

/**
 * Show line-level attribution for a file (like git blame but for agents)
 */
/** One line of blame: its content plus who authored it. The UI contract. */
export type BlameLineRecord = BlameLine;

/** Blame record for line index `i` (0-indexed), or `unknown` when unattributed. */
export function blameLineRecord(
  attribution: AttributionRecord[] | null,
  lines: string[],
  i: number,
): BlameLineRecord {
  const attr = attribution?.[i];
  const rec: BlameLineRecord = {
    line: i + 1,
    content: lines[i],
    source: attr?.source ?? 'unknown',
  };
  if (attr?.source === 'agent') {
    if (attr.agent) rec.agent = attr.agent;
    if (attr.modelId) rec.modelId = attr.modelId;
    if (attr.sessionId) rec.sessionId = attr.sessionId;
    if (attr.turnId) rec.turnId = attr.turnId;
  }
  return rec;
}

interface BlameOptions {
  json?: boolean;
  ndjson?: boolean;
  range?: [number, number]; // 1-indexed inclusive window
}

async function cmdBlame(filePath: string, opts: BlameOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);

  if (!fs.existsSync(absolutePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const repoInfo = getRepoId(cwd);
  if (!repoInfo) {
    error('Not in a git repository with assert tracking');
    process.exit(1);
  }

  const { gitRoot } = repoInfo;
  const relativePath = path.relative(gitRoot, absolutePath);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const attribution = blameFile(gitRoot, relativePath, content);
  const lines = content.split('\n');
  const total = lines.length;
  const from = Math.max(1, opts.range?.[0] ?? 1);
  const to = Math.min(total, opts.range?.[1] ?? total);

  // NDJSON: a header record, then one record per line, written incrementally so
  // large files stream with bounded memory (never a giant array in one string).
  if (opts.ndjson) {
    process.stdout.write(
      `${JSON.stringify({ type: 'header', file: relativePath, totalLines: total, range: [from, to] })}\n`,
    );
    for (let i = from - 1; i < to; i++) {
      process.stdout.write(`${JSON.stringify({ type: 'line', ...blameLineRecord(attribution, lines, i) })}\n`);
    }
    return;
  }

  if (opts.json) {
    const out: BlameLineRecord[] = [];
    for (let i = from - 1; i < to; i++) out.push(blameLineRecord(attribution, lines, i));
    process.stdout.write(
      `${JSON.stringify({ file: relativePath, totalLines: total, range: [from, to], lines: out })}\n`,
    );
    return;
  }

  if (attribution) {
    const contribution = calculateAgentContribution(attribution);
    console.log(`File: ${relativePath}`);
    console.log(
      `Agent contribution: ${contribution.agentPercentage.toFixed(1)}% (${contribution.agentLines}/${attribution.length} lines)`,
    );
  } else {
    log(`No agent sessions found for ${relativePath}; showing without attribution.`);
  }
  console.log('');

  const labelFor = (attr?: AttributionRecord): string => {
    if (attr?.source === 'agent') {
      const parts: string[] = [];
      if (attr.agent) parts.push(attr.agent);
      if (attr.modelId) parts.push(attr.modelId);
      if (attr.sessionId) parts.push(attr.sessionId.slice(0, 8));
      return parts.length ? parts.join(' · ') : 'agent';
    }
    return attr?.source === 'human' ? 'human' : '(unknown)';
  };
  const idx = Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from - 1 + k);
  const labels = idx.map((i) => labelFor(attribution?.[i]));
  const width = Math.min(64, Math.max(1, ...labels.map((l) => l.length)));
  idx.forEach((i, k) => {
    const raw = labels[k];
    const label =
      raw.length > width ? `${raw.slice(0, width - 1)}…` : raw.padEnd(width);
    console.log(`${String(i + 1).padStart(4)}  ${label}  ${lines[i]}`);
  });
}

/** A line added by a diff, with its head-side line number. */
export interface DiffAddedLine {
  file: string;
  line: number;
  content: string;
}

/** Parse `git diff --unified=0` output into added lines with head line numbers. */
export function parseUnifiedDiffAddedLines(diff: string): DiffAddedLine[] {
  const out: DiffAddedLine[] = [];
  let file: string | null = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (m) newLine = parseInt(m[1], 10);
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (file) out.push({ file, line: newLine, content: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith(' ')) {
      newLine++; // context (only with unified>0)
    }
  }
  return out;
}

interface HashOwner {
  agent?: SessionSource;
  modelId?: string;
  sessionId?: string;
  turnId?: string;
  timestamp: string;
}

/**
 * Index agent-authored line hashes -> owner, from the per-line `line_attribution`
 * events in the given session file contents (carries the turn, so a diff line
 * resolves back to its prompt). Later events win on hash collisions.
 */
export function buildAgentHashIndex(sessionContents: string[]): Map<string, HashOwner> {
  const map = new Map<string, HashOwner>();
  for (const content of sessionContents) {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let ev: SessionEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== 'line_attribution') continue;
      for (const l of ev.lines) {
        if (l.source !== 'agent') continue;
        const prev = map.get(l.hash);
        if (prev && ev.timestamp <= prev.timestamp) continue;
        map.set(l.hash, {
          agent: l.agent,
          modelId: l.modelId,
          sessionId: ev.sessionId,
          turnId: l.turnId,
          timestamp: ev.timestamp,
        });
      }
    }
  }
  return map;
}

/** `A..B` -> {base:A, head:B}; a bare `C` -> that commit's own diff (`C^..C`). */
export function parseDiffRange(spec: string): { base: string; head: string } {
  if (spec.includes('..')) {
    const [base, head] = spec.split('..');
    return { base: base || 'HEAD', head: head || 'HEAD' };
  }
  return { base: `${spec}^`, head: spec };
}

interface DiffLineRecord {
  file: string;
  line: number;
  content: string;
  source: 'agent' | 'unknown';
  agent?: SessionSource;
  modelId?: string;
  sessionId?: string;
  turnId?: string;
}

/**
 * Attribute the added lines of a diff range to their authoring agent/model — a
 * PR-review view. Only the changed lines are looked up (by content hash), and
 * only the sessions committed in the range are read, so cost is O(range) not
 * O(whole repo). Lines with no agent match are reported as `unknown`.
 */
async function cmdBlameDiff(
  rangeSpec: string,
  opts: BlameOptions & { file?: string },
): Promise<void> {
  const cwd = process.cwd();
  const repoInfo = getRepoId(cwd);
  if (!repoInfo) {
    error('Not in a git repository with assert tracking');
    process.exit(1);
  }
  const { gitRoot } = repoInfo;
  const { base, head } = parseDiffRange(rangeSpec);
  const git = (cmd: string): string =>
    execSync(cmd, { cwd: gitRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  const pathArg = opts.file ? ` -- "${opts.file}"` : '';
  let diff: string;
  try {
    diff = git(`git diff --unified=0 ${base} ${head}${pathArg}`);
  } catch {
    error(`git diff failed for ${base}..${head}`);
    process.exit(1);
  }
  const added = parseUnifiedDiffAddedLines(diff);

  // Only the sessions committed in the range matter; read them at head.
  let sessionPaths: string[] = [];
  try {
    const out = git(`git log ${base}..${head} --name-only --pretty=format: -- .sessions/`);
    sessionPaths = [...new Set(out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.jsonl')))];
  } catch {
    /* no sessions in range */
  }
  const sessionContents = sessionPaths
    .map((p) => fileAtRef(gitRoot, head, p))
    .filter((c): c is string => c != null);
  const index = buildAgentHashIndex(sessionContents);

  const records: DiffLineRecord[] = added.map((a) => {
    const owner = index.get(hashLine(a.content));
    const rec: DiffLineRecord = {
      file: a.file,
      line: a.line,
      content: a.content,
      source: owner ? 'agent' : 'unknown',
    };
    if (owner) {
      if (owner.agent) rec.agent = owner.agent;
      if (owner.modelId) rec.modelId = owner.modelId;
      if (owner.sessionId) rec.sessionId = owner.sessionId;
      if (owner.turnId) rec.turnId = owner.turnId;
    }
    return rec;
  });

  if (opts.ndjson) {
    process.stdout.write(`${JSON.stringify({ type: 'header', base, head, addedLines: records.length })}\n`);
    for (const r of records) process.stdout.write(`${JSON.stringify({ type: 'line', ...r })}\n`);
    return;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ base, head, lines: records })}\n`);
    return;
  }

  console.log(`Diff attribution: ${base}..${head}`);
  console.log('');
  let curFile = '';
  for (const r of records) {
    if (r.file !== curFile) {
      curFile = r.file;
      console.log(`── ${curFile}`);
    }
    const label =
      r.source === 'agent'
        ? [r.agent, r.modelId, r.sessionId?.slice(0, 8)].filter(Boolean).join(' · ')
        : '(unknown)';
    console.log(`+${String(r.line).padStart(4)}  ${label.padEnd(48)}  ${r.content}`);
  }
}

/** Resolve + parse a session's normalized model, or exit with an error. */
function loadParsedSession(sessionId: string) {
  const repoInfo = getRepoId(process.cwd());
  if (!repoInfo) {
    error('Not in a git repository with assert tracking');
    process.exit(1);
  }
  const jsonl = readSessionFile(repoInfo.gitRoot, sessionId);
  if (!jsonl) {
    error(`No session found for ${sessionId} in this repo`);
    process.exit(1);
  }
  return parseSession(jsonl);
}

/** The normalized session model (turns with prompts/reasoning/tools linked). */
async function cmdSession(sessionId: string, opts: { json?: boolean } = {}): Promise<void> {
  const session = loadParsedSession(sessionId);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(session)}\n`);
    return;
  }
  console.log(`Session ${session.sessionId} (${session.source}) — ${session.turns.length} turns`);
  console.log('');
  for (const t of session.turns) {
    const prompt = t.prompt?.text.replace(/\s+/g, ' ').slice(0, 60) ?? '(no prompt)';
    console.log(`${t.turnId}  ${t.changedCode ? '±' : ' '}  ${(t.modelId ?? '').padEnd(24)}  ${prompt}`);
  }
}

/** A single turn, fully resolved; `--context` also returns the dig-back chain. */
async function cmdTurn(
  sessionId: string,
  turnId: string,
  opts: { json?: boolean; context?: boolean } = {},
): Promise<void> {
  const session = loadParsedSession(sessionId);
  const turn = getTurn(session, turnId);
  if (!turn) {
    error(`No turn ${turnId} in session ${sessionId}`);
    process.exit(1);
  }
  if (opts.json) {
    const payload = opts.context ? { turn, context: turnContext(session, turnId) } : turn;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  console.log(`Turn ${turn.turnId}  ${turn.modelId ?? ''}`);
  if (turn.prompt) console.log(`\nPrompt:\n  ${turn.prompt.text}`);
  for (const r of turn.reasoning) console.log(`\nReasoning:\n  ${r.text}`);
  for (const tc of turn.toolCalls) console.log(`\nTool: ${tc.name}`);
  for (const txt of turn.text) console.log(`\nAssistant:\n  ${txt}`);
}

/**
 * List all sessions (from central storage and current repo)
 */
async function cmdSessionsAll(): Promise<void> {
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    log('No sessions found (central storage empty)');
    return;
  }

  // Read all session files from central storage
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));

  if (files.length === 0) {
    log('No sessions found');
    return;
  }

  log(`Found ${files.length} session(s) in central storage:\n`);

  const index = loadIndex();

  for (const file of files) {
    const sessionId = file.replace('.jsonl', '');
    const events = readSessionEvents(sessionId, sessionsDir, { direct: true });
    const metadata = extractSessionMetadata(events);

    if (!metadata) {
      console.log(`  ${sessionId} (invalid - no start event)`);
      continue;
    }

    const sessionInfo = index.sessions[sessionId];
    const status = sessionInfo?.isActive ? '[ACTIVE]' : '[ended]';
    const source = metadata.source.padEnd(12);
    const turns = `${metadata.turnCount} turns`;
    const tools = `${metadata.toolCallCount} tool calls`;
    const files =
      metadata.filesModified.length > 0
        ? `${metadata.filesModified.length} files`
        : 'no files';

    console.log(`  ${status} ${sessionId}`);
    console.log(
      `           source: ${source} | ${turns} | ${tools} | ${files}`,
    );
    console.log(`           started: ${metadata.startTime}`);
    if (sessionInfo?.gitRoot) {
      console.log(`           repo: ${sessionInfo.gitRoot}`);
    }
    console.log('');
  }
}

function printHelp(): void {
  console.log(
    `
assert - Capture AI agent sessions and track code attribution

Usage:
  assert init [agent]            Initialize hooks globally (all agents if none specified)
  assert sessions                List sessions in current repo
  assert sessions --all          List all sessions (central storage)
  assert show <session-id>       Show session details
  assert blame <file>            Show line-by-line agent attribution (like git blame)
                                 [--json | --ndjson] [--range <start>:<end>]
  assert blame --diff <a>..<b>   Attribute only a diff's added lines (PR review)
                                 [file] [--json | --ndjson]
  assert trace [ref]             Print an agent-trace record for a revision (default HEAD)
  assert session <id>            Show a session's turns (prompts/reasoning/tools) [--json]
  assert turn <id> <turn-id>     Show one turn, fully resolved [--json] [--context]
  assert status                  Show current status
  assert private                 Keep capturing locally, but stop writing sessions into this repo
  assert public                  Resume writing sessions into this repo (default)
  assert sync                    Publish local sessions into the repo + rebuild the blame index
  assert disable                 Stop capturing entirely (hooks stay installed)
  assert enable                  Resume capturing
  assert help                    Show this help

Supported agents:
  claude-code     Claude Code CLI
  cursor          Cursor IDE
  codex           OpenAI Codex CLI

Examples:
  assert init                    # Initialize hooks for all agents
  assert init claude-code        # Initialize hooks for Claude Code only
  assert sessions                # List sessions in current project
  assert blame src/index.ts      # Show which agent wrote each line
  assert show abc123-xyz         # View a specific session
`.trim(),
  );
}

// === Main ===

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await cmdInit(args[1]);
      break;
    case 'hook':
      if (!args[1] || !args[2]) {
        error('Usage: assert hook <agent> <hookType>');
        process.exit(1);
      }
      await cmdHook(args[1], args[2]);
      break;
    case 'sessions':
    case 'list':
      if (args[1] === '--all' || args[1] === '-a') {
        await cmdSessionsAll();
      } else {
        await cmdSessions();
      }
      break;
    case 'show':
      if (!args[1]) {
        error('Usage: assert show <session-id>');
        process.exit(1);
      }
      await cmdShow(args[1]);
      break;
    case 'blame': {
      const rest = args.slice(1);
      let file: string | undefined;
      let range: [number, number] | undefined;
      let diffSpec: string | undefined;
      const flags = new Set<string>();
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--diff') {
          diffSpec = rest[++i];
          if (!diffSpec) {
            error('Usage: assert blame --diff <base>..<head> [file]');
            process.exit(1);
          }
        } else if (a === '--range') {
          const [s, e] = (rest[++i] ?? '').split(':').map((n) => parseInt(n, 10));
          if (!Number.isFinite(s) || !Number.isFinite(e)) {
            error('Usage: assert blame <file> --range <start>:<end> (1-indexed)');
            process.exit(1);
          }
          range = [s, e];
        } else if (a.startsWith('-')) {
          flags.add(a);
        } else if (file === undefined) {
          file = a;
        }
      }
      const json = flags.has('--json');
      const ndjson = flags.has('--ndjson') || flags.has('--json-lines');
      if (diffSpec) {
        await cmdBlameDiff(diffSpec, { json, ndjson, file });
        break;
      }
      if (!file) {
        error('Usage: assert blame <file> [--json | --ndjson] [--range <start>:<end>] | --diff <base>..<head>');
        process.exit(1);
      }
      await cmdBlame(file, { json, ndjson, range });
      break;
    }
    case 'pre-commit':
      // No-op: retained so pre-commit hooks installed by older versions stay
      // silent. Session data is now synced at turn boundaries, not on commit.
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'trace':
      await cmdTrace(args[1]);
      break;
    case 'session': {
      const rest = args.slice(1);
      const sid = rest.find((a) => !a.startsWith('-'));
      if (!sid) {
        error('Usage: assert session <session-id> [--json]');
        process.exit(1);
      }
      await cmdSession(sid, { json: rest.includes('--json') });
      break;
    }
    case 'turn': {
      const rest = args.slice(1);
      const pos = rest.filter((a) => !a.startsWith('-'));
      if (pos.length < 2) {
        error('Usage: assert turn <session-id> <turn-id> [--json] [--context]');
        process.exit(1);
      }
      await cmdTurn(pos[0], pos[1], { json: rest.includes('--json'), context: rest.includes('--context') });
      break;
    }
    case 'private':
      cmdPrivate();
      break;
    case 'public':
      cmdPublic();
      break;
    case 'sync':
      cmdSync();
      break;
    case 'disable':
      cmdDisable();
      break;
    case 'enable':
      cmdEnable();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      if (command) {
        error(`Unknown command: ${command}`);
      }
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

/** Run the CLI, mapping any uncaught error to a non-zero exit. */
export function run(): void {
  main().catch((e) => {
    error(e.message);
    process.exit(1);
  });
}

// Auto-run only when loaded as the CJS process entry — i.e. the SEA
// single-executable, whose bundled main module IS this file. The npm/ESM build
// (dist/cli.js, "type": "module") has no `require`/`module`, so the bin shim
// (bin/assert.js) calls run() instead; this also keeps the module importable
// from tests without kicking off the CLI.
if (
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module
) {
  run();
}
