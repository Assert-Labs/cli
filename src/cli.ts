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
import { execSync } from 'child_process';
import { processHook, type AgentType } from './hooks/index';
import {
  listSessionFiles,
  readSessionEvents,
  extractSessionMetadata,
  findActiveSessions,
} from './session-writer';
import { findGitRoot, getGitState } from './git-watcher';
import { getRepoId } from './repo-identity';
import {
  getSessionsDir,
  loadIndex,
  findSessionsForRepo,
  findSessionsForFiles,
} from './session-index';
import { calculateAgentChanges, getLastEndBoundary } from './boundaries';
import {
  createFileSnapshot,
  buildAttribution,
  calculateAgentContribution,
  type AttributionRecord,
} from './line-attribution';

// === Helpers ===

function log(msg: string): void {
  console.log(`[assert] ${msg}`);
}

function error(msg: string): void {
  console.error(`[assert] error: ${msg}`);
}

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

  // Codex: check for .codex directory (future support)
  // if (fs.existsSync(path.join(home, '.codex'))) {
  //   detected.push('codex');
  // }

  return detected;
}

/**
 * Generate Claude Code plugin files
 */
/**
 * Detect the installed Claude Code version (e.g. "2.1.183"), or null if the
 * `claude` CLI isn't available.
 */
function detectClaudeCodeVersion(): string | null {
  try {
    const out = execSync('claude --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Return true if semver `a` >= `b` (x.y.z). */
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

// Claude Code hook events Assert subscribes to. `minVersion` gates events to
// the version that introduced them (per the Claude Code changelog); omit it for
// foundational events that predate any version supporting skills-dir plugins.
const CLAUDE_HOOK_EVENTS: Array<{ event: string; minVersion?: string }> = [
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'Stop' },
  { event: 'PreToolUse' },
  { event: 'PostToolUse' },
  { event: 'UserPromptSubmit' },
  { event: 'MessageDisplay', minVersion: '2.1.152' },
];

function generateClaudeCodePlugin(claudeVersion: string | null): { pluginJson: string; hooksJson: string } {
  const pluginJson = JSON.stringify({
    name: 'assert',
    description: 'Capture AI agent sessions for code attribution',
    version: '0.1.0',
    author: { name: 'Assert Labs' },
  }, null, 2);

  const hooks: Record<string, unknown> = {};
  for (const { event, minVersion } of CLAUDE_HOOK_EVENTS) {
    // Skip version-gated events the installed Claude Code is too old for.
    // If the version is unknown, include everything (safest).
    if (minVersion && claudeVersion && !versionGte(claudeVersion, minVersion)) {
      continue;
    }
    hooks[event] = [
      { hooks: [{ type: 'command', command: `$HOME/.assert/bin/assert hook claude-code ${event}` }] },
    ];
  }

  const hooksJson = JSON.stringify({ hooks }, null, 2);
  return { pluginJson, hooksJson };
}

/**
 * Generate Cursor plugin files
 */
function generateCursorPlugin(): { pluginJson: string; hooksJson: string } {
  const pluginJson = JSON.stringify({
    name: 'assert',
    description: 'Capture AI agent sessions for code attribution',
    version: '0.1.0',
    author: { name: 'Assert Labs' },
    hooks: 'hooks/hooks.json',
  }, null, 2);

  const cmd = (type: string) => `$HOME/.assert/bin/assert hook cursor ${type}`;
  const hooksJson = JSON.stringify({
    hooks: {
      sessionStart: [{ command: cmd('sessionStart') }],
      sessionEnd: [{ command: cmd('sessionEnd') }],
      stop: [{ command: cmd('stop') }],
      preToolUse: [{ command: cmd('preToolUse') }],
      postToolUse: [{ command: cmd('postToolUse') }],
      beforeSubmitPrompt: [{ command: cmd('beforeSubmitPrompt') }],
      afterAgentResponse: [{ command: cmd('afterAgentResponse') }],
      afterFileEdit: [{ command: cmd('afterFileEdit') }],
    },
  }, null, 2);

  return { pluginJson, hooksJson };
}

/**
 * Install Claude Code plugin to skills directory (auto-loads)
 */
function installClaudeCodePlugin(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const pluginDir = path.join(home, '.claude', 'skills', 'assert');
  const pluginMetaDir = path.join(pluginDir, '.claude-plugin');
  const hooksDir = path.join(pluginDir, 'hooks');

  // Create directories
  fs.mkdirSync(pluginMetaDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  // Tailor the hook events to the installed Claude Code version.
  const claudeVersion = detectClaudeCodeVersion();
  const { pluginJson, hooksJson } = generateClaudeCodePlugin(claudeVersion);
  fs.writeFileSync(path.join(pluginMetaDir, 'plugin.json'), pluginJson + '\n');
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), hooksJson + '\n');

  const ver = claudeVersion ? `Claude Code ${claudeVersion}` : 'Claude Code (version undetected)';
  log(`Installed Claude Code plugin to ~/.claude/skills/assert for ${ver} (auto-loads as assert@skills-dir)`);
}

/**
 * Install Cursor plugin to extensions directory
 */
function installCursorPlugin(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const pluginDir = path.join(home, '.cursor', 'plugins', 'assert');
  const pluginMetaDir = path.join(pluginDir, '.cursor-plugin');
  const hooksDir = path.join(pluginDir, 'hooks');

  // Create directories
  fs.mkdirSync(pluginMetaDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  // Generate and write plugin files
  const { pluginJson, hooksJson } = generateCursorPlugin();
  fs.writeFileSync(path.join(pluginMetaDir, 'plugin.json'), pluginJson + '\n');
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), hooksJson + '\n');

  log('Installed Cursor plugin to ~/.cursor/plugins/assert');
}

async function cmdInstall(agent?: string): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const assertDir = path.join(home, '.assert');
  const binDir = path.join(assertDir, 'bin');
  const distDir = path.join(assertDir, 'dist');
  const destBin = path.join(binDir, 'assert');
  const destDist = path.join(distDir, 'cli.js');

  // Get the source directory (where bin/assert.js and dist/cli.js are)
  let currentBin = process.argv[1];
  if (!path.isAbsolute(currentBin)) {
    currentBin = path.resolve(process.cwd(), currentBin);
  }
  currentBin = fs.realpathSync(currentBin);

  // Check if we're running from the installed copy (~/.assert/bin/assert)
  const isInstalledCopy = currentBin === destBin || currentBin.startsWith(assertDir);

  if (isInstalledCopy) {
    log(`CLI already installed at ${assertDir}`);
  } else {
    // Copy from source
    const sourceDir = path.dirname(path.dirname(currentBin));
    const sourceBin = path.join(sourceDir, 'bin', 'assert.js');
    const sourceDist = path.join(sourceDir, 'dist', 'cli.js');

    if (!fs.existsSync(sourceBin)) {
      error(`Source bin not found: ${sourceBin}`);
      process.exit(1);
    }
    if (!fs.existsSync(sourceDist)) {
      error(`Source dist not found: ${sourceDist}. Run 'pnpm build' first.`);
      process.exit(1);
    }

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    try { fs.unlinkSync(destBin); } catch { /* doesn't exist */ }
    try { fs.unlinkSync(destDist); } catch { /* doesn't exist */ }

    fs.copyFileSync(sourceBin, destBin);
    fs.chmodSync(destBin, 0o755);
    fs.copyFileSync(sourceDist, destDist);

    log(`Installed CLI to ${assertDir}`);
  }

  // Detect installed agents
  const detectedAgents = detectInstalledAgents();
  const supportedAgents = ['claude-code', 'cursor'];

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
    agentsToInstall = detectedAgents.filter(a => supportedAgents.includes(a));
  }

  if (agentsToInstall.length === 0) {
    log('No supported agents detected.');
    log(`Supported agents: ${supportedAgents.join(', ')}`);
    return;
  }

  // Install plugins for each agent
  const installed: string[] = [];
  for (const a of agentsToInstall) {
    if (a === 'claude-code') {
      installClaudeCodePlugin();
      installed.push('claude-code');
    } else if (a === 'cursor') {
      installCursorPlugin();
      installed.push('cursor');
    }
  }

  // Summary
  console.log('');
  log(`Plugins installed for: ${installed.join(', ')}`);
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
    const files = metadata.filesModified.length > 0
      ? `${metadata.filesModified.length} files`
      : 'no files';

    console.log(`  ${status} ${id}`);
    console.log(`           source: ${source} | ${turns} | ${tools} | ${files}`);
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
    console.log(`Files Modified: ${metadata.filesModified.join(', ') || 'none'}`);
  }
  console.log('');
  console.log('Events:');
  console.log('-------');

  for (const event of events) {
    const time = event.timestamp.substring(11, 19);
    switch (event.type) {
      case 'session_start':
        console.log(`${time} [session_start] cwd=${event.cwd}, branch=${event.gitBranch || 'none'}`);
        break;
      case 'session_end':
        console.log(`${time} [session_end] reason=${event.reason}`);
        break;
      case 'human_turn':
        const preview = event.content.substring(0, 60);
        console.log(`${time} [human] "${preview}${event.content.length > 60 ? '...' : ''}"`);
        break;
      case 'assistant_turn_start':
        console.log(`${time} [assistant_start] model=${event.model || 'unknown'}`);
        break;
      case 'assistant_text':
        const text = event.text || '';
        const textPreview = text.substring(0, 60);
        console.log(`${time} [assistant_text] "${textPreview}${text.length > 60 ? '...' : ''}"`);
        break;
      case 'assistant_turn_end':
        console.log(`${time} [assistant_end]`);
        break;
      case 'tool_call':
        console.log(`${time} [tool_call] ${event.toolName}(${JSON.stringify(event.input).substring(0, 40)}...)`);
        break;
      case 'tool_result':
        const output = event.output || event.error || '';
        console.log(`${time} [tool_result] ${output.substring(0, 50)}${output.length > 50 ? '...' : ''}`);
        break;
      case 'branch_switch':
        console.log(`${time} [branch_switch] ${event.fromBranch || 'none'} -> ${event.toBranch}`);
        break;
      case 'file_attribution':
        console.log(`${time} [file_attribution] ${event.operation} ${event.filePath}`);
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
}

/**
 * Show line-level attribution for a file (like git blame but for agents)
 */
async function cmdBlame(filePath: string): Promise<void> {
  const cwd = process.cwd();
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  if (!fs.existsSync(absolutePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const repoInfo = getRepoId(cwd);
  if (!repoInfo) {
    error('Not in a git repository with assert tracking');
    process.exit(1);
  }

  const { repoId, gitRoot } = repoInfo;
  const relativePath = path.relative(gitRoot, absolutePath);

  // Get sessions that touched this file
  const index = loadIndex();
  const sessionIds = findSessionsForFiles(index, repoId, [relativePath]);

  if (sessionIds.length === 0) {
    log(`No agent sessions found for ${relativePath}`);
    log('Showing file without attribution...');
    console.log('');

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      console.log(`${String(i + 1).padStart(4)}  (unknown)  ${lines[i]}`);
    }
    return;
  }

  // Build attribution history from sessions
  const history: Array<{
    source: 'agent' | 'human';
    sessionId?: string;
    turnId?: string;
    timestamp: string;
    addedHashes: Set<string>;
  }> = [];

  for (const sessionId of sessionIds) {
    const changes = calculateAgentChanges(repoId, sessionId);
    const fileChanges = changes.get(relativePath);
    if (fileChanges && fileChanges.added.size > 0) {
      history.push({
        source: 'agent',
        sessionId,
        timestamp: index.sessions[sessionId]?.startTime || '',
        addedHashes: fileChanges.added,
      });
    }
  }

  // Sort history by timestamp
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Create current file snapshot
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const snapshot = createFileSnapshot(relativePath, content);

  // Build attribution
  const attribution = buildAttribution(snapshot, history);
  const contribution = calculateAgentContribution(attribution);

  // Display header
  console.log(`File: ${relativePath}`);
  console.log(`Agent contribution: ${contribution.agentPercentage.toFixed(1)}% (${contribution.agentLines}/${attribution.length} lines)`);
  console.log('');

  // Display blame output
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const attr = attribution[i];
    const lineNum = String(i + 1).padStart(4);

    let source: string;
    if (attr.source === 'agent' && attr.sessionId) {
      source = attr.sessionId.substring(0, 12).padEnd(12);
    } else if (attr.source === 'human') {
      source = 'human       ';
    } else {
      source = '(unknown)   ';
    }

    console.log(`${lineNum}  ${source}  ${lines[i]}`);
  }
}

/**
 * Pre-commit hook: attach relevant session data to staged files
 * CRITICAL: This must NEVER fail or block commits - all errors silently ignored
 */
async function cmdPreCommit(): Promise<void> {
  try {
    const cwd = process.cwd();

    const repoInfo = getRepoId(cwd);
    if (!repoInfo) {
      return;
    }

    const { repoId, gitRoot } = repoInfo;

    // Get staged files
    const { execSync } = await import('child_process');
    let stagedFiles: string[];
    try {
      const output = execSync('git diff --cached --name-only', {
        cwd: gitRoot,
        encoding: 'utf-8',
        timeout: 5000, // 5 second timeout
      });
      stagedFiles = output.trim().split('\n').filter(Boolean);
    } catch {
      return;
    }

    if (stagedFiles.length === 0) {
      return;
    }

    // Find sessions that touched these files
    const index = loadIndex();
    const sessionIds = findSessionsForFiles(index, repoId, stagedFiles);

    if (sessionIds.length === 0) {
      return;
    }

    // Copy relevant session files to repo .sessions/
    const sessionsDir = getSessionsDir();
    const repoSessionsDir = path.join(gitRoot, '.sessions');

    if (!fs.existsSync(repoSessionsDir)) {
      fs.mkdirSync(repoSessionsDir, { recursive: true });
    }

    let copiedCount = 0;
    for (const sessionId of sessionIds) {
      const centralPath = path.join(sessionsDir, `${sessionId}.jsonl`);
      const repoPath = path.join(repoSessionsDir, `${sessionId}.jsonl`);

      if (fs.existsSync(centralPath)) {
        // Check if there are actual agent changes for staged files
        const agentChanges = calculateAgentChanges(repoId, sessionId);
        const hasRelevantChanges = stagedFiles.some((f) => {
          const changes = agentChanges.get(f);
          return changes && (changes.added.size > 0 || changes.removed.size > 0);
        });

        if (hasRelevantChanges) {
          fs.copyFileSync(centralPath, repoPath);
          copiedCount++;
        }
      }
    }

    if (copiedCount > 0) {
      // Stage the session files
      try {
        execSync(`git add "${repoSessionsDir}"`, { cwd: gitRoot, stdio: 'pipe', timeout: 5000 });
      } catch {
        // Silent failure - files copied but not staged
      }
    }
  } catch {
    // CRITICAL: Never throw, never block commits
    // Silent failure is better than blocking user's work
  }
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
    const files = metadata.filesModified.length > 0
      ? `${metadata.filesModified.length} files`
      : 'no files';

    console.log(`  ${status} ${sessionId}`);
    console.log(`           source: ${source} | ${turns} | ${tools} | ${files}`);
    console.log(`           started: ${metadata.startTime}`);
    if (sessionInfo?.gitRoot) {
      console.log(`           repo: ${sessionInfo.gitRoot}`);
    }
    console.log('');
  }
}

function printHelp(): void {
  console.log(`
assert - Capture AI agent sessions and track code attribution

Usage:
  assert install [agent]         Install hooks globally (all agents if none specified)
  assert sessions                List sessions in current repo
  assert sessions --all          List all sessions (central storage)
  assert show <session-id>       Show session details
  assert blame <file>            Show line-by-line agent attribution (like git blame)
  assert pre-commit              Attach relevant session data to staged files
  assert status                  Show current status
  assert help                    Show this help

Supported agents:
  claude-code     Claude Code CLI
  cursor          Cursor IDE
  codex           OpenAI Codex CLI

Git Integration:
  Add to .git/hooks/pre-commit:
    #!/bin/sh
    ~/.assert/bin/assert pre-commit

Examples:
  assert install                 # Install hooks for all agents
  assert install claude-code     # Install hooks for Claude Code only
  assert sessions                # List sessions in current project
  assert blame src/index.ts      # Show which agent wrote each line
  assert show abc123-xyz         # View a specific session
`.trim());
}

// === Main ===

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'install':
      await cmdInstall(args[1]);
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
    case 'blame':
      if (!args[1]) {
        error('Usage: assert blame <file>');
        process.exit(1);
      }
      await cmdBlame(args[1]);
      break;
    case 'pre-commit':
      await cmdPreCommit();
      break;
    case 'status':
      await cmdStatus();
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

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
