#!/usr/bin/env node
/**
 * Assert Trace CLI
 *
 * Capture agent sessions from any agentic coding tool (Cursor, Claude Code, Codex, etc.)
 * and associate them with git commits.
 */

import { randomUUID } from 'crypto';
import {
  ensureAssertDir,
  savePendingTrace,
  loadPendingTraces,
  clearAllPendingTraces,
  saveSession,
  loadSession,
  getTraceForCommit,
  setTraceForCommit,
  getCurrentCommitSha,
  getCommitForLine,
  installHook,
  saveConfig,
  loadConfig,
  getGitRoot,
} from './storage.js';
import {
  Session,
  HumanTurn,
  AssistantTurn,
  ToolCallBlock,
  PendingTrace,
  Trace,
  FileAttribution,
  SessionSummary,
  DEFAULT_CONFIG,
} from './schema.js';

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
    // Handle case where stdin is not piped
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

function extractFilesModified(session: Session): string[] {
  const files = new Set<string>();
  for (const turn of session.turns) {
    if (turn.type !== 'assistant') continue;
    for (const block of turn.blocks) {
      if (block.type === 'tool_call') {
        const name = block.name.toLowerCase();
        if (
          name.includes('write') ||
          name.includes('edit') ||
          name.includes('create')
        ) {
          const path =
            block.input.path || block.input.file_path || block.input.filepath;
          if (typeof path === 'string') {
            files.add(path);
          }
        }
      }
    }
  }
  return Array.from(files);
}

function extractPrompt(session: Session): string {
  const humanTurn = session.turns.find(
    (t): t is HumanTurn => t.type === 'human',
  );
  return humanTurn?.content || '(no prompt)';
}

function extractModel(session: Session): string | undefined {
  const assistantTurn = session.turns.find(
    (t): t is AssistantTurn => t.type === 'assistant',
  );
  return assistantTurn?.model;
}

function countToolCalls(session: Session): number {
  let count = 0;
  for (const turn of session.turns) {
    if (turn.type === 'assistant') {
      for (const block of turn.blocks) {
        if (block.type === 'tool_call') count++;
      }
    }
  }
  return count;
}

// === Commands ===

async function cmdInit(): Promise<void> {
  try {
    getGitRoot();
  } catch {
    error('Not in a git repository. Run this from a git repo.');
    process.exit(1);
  }

  ensureAssertDir();
  saveConfig(DEFAULT_CONFIG);

  // Install post-commit hook
  installHook(
    'post-commit',
    `
if command -v assert &> /dev/null; then
  assert commit --quiet
fi
`.trim(),
  );

  // Install pre-push hook (for future backend sync)
  installHook(
    'pre-push',
    `
if command -v assert &> /dev/null; then
  assert push --quiet 2>/dev/null || true
fi
`.trim(),
  );

  log('Initialized assert-trace');
  log('  - Installed post-commit hook');
  log('  - Installed pre-push hook');
  log('  - Config saved to .git/assert/config.json');
}

async function cmdCapture(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    error('No input received. Pipe session JSON to stdin.');
    process.exit(1);
  }

  let session: Session;
  try {
    session = JSON.parse(input);
  } catch {
    error('Invalid JSON input');
    process.exit(1);
  }

  // Ensure session has an ID
  if (!session.id) {
    session.id = `sess_${randomUUID().slice(0, 8)}`;
  }

  const filesModified = extractFilesModified(session);

  const pending: PendingTrace = {
    session_id: session.id,
    captured_at: new Date().toISOString(),
    session,
    files_modified: filesModified,
  };

  const filepath = savePendingTrace(pending);
  log(
    `Captured session ${session.id} (${filesModified.length} files modified)`,
  );
}

async function cmdCommit(quiet: boolean = false): Promise<void> {
  const pending = loadPendingTraces();
  if (pending.length === 0) {
    if (!quiet) log('No pending traces to commit');
    return;
  }

  const commitSha = getCurrentCommitSha();

  // Build trace from pending sessions
  const trace: Trace = {
    version: '0.1.0',
    id: `trace_${randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    vcs: {
      type: 'git',
      revision: commitSha,
    },
    files: [],
    sessions: {},
  };

  // Aggregate file attributions and session summaries
  const fileMap = new Map<string, FileAttribution>();

  for (const p of pending) {
    const session = p.session;
    const model = extractModel(session);

    // Add session summary
    trace.sessions[session.id] = {
      prompt: extractPrompt(session),
      source: session.source,
      model,
      tool_calls_count: countToolCalls(session),
      files_modified: p.files_modified,
    };

    // Save full session for later retrieval
    saveSession(session);

    // Add file attributions
    // For now, we attribute entire file changes to the session
    // TODO: compute actual line ranges from git diff
    for (const file of p.files_modified) {
      if (!fileMap.has(file)) {
        fileMap.set(file, {
          path: file,
          conversations: [],
        });
      }
      fileMap.get(file)!.conversations.push({
        id: session.id,
        contributor: {
          type: 'ai',
          model,
        },
        ranges: [], // TODO: populate from diff
      });
    }
  }

  trace.files = Array.from(fileMap.values());

  // Attach to commit
  setTraceForCommit(commitSha, trace);

  // Clear pending
  clearAllPendingTraces();

  if (!quiet) {
    log(
      `Attached ${pending.length} session(s) to commit ${commitSha.slice(0, 7)}`,
    );
  }
}

async function cmdBlame(target: string): Promise<void> {
  // Parse target: file:line or file line
  let filepath: string;
  let line: number;

  if (target.includes(':')) {
    const [f, l] = target.split(':');
    filepath = f;
    line = parseInt(l, 10);
  } else {
    error('Usage: assert blame <file>:<line>');
    process.exit(1);
  }

  if (isNaN(line)) {
    error('Invalid line number');
    process.exit(1);
  }

  // Get commit for this line
  const commitSha = getCommitForLine(filepath, line);
  if (!commitSha) {
    error(`Could not find commit for ${filepath}:${line}`);
    process.exit(1);
  }

  // Get trace for commit
  const trace = getTraceForCommit(commitSha);
  if (!trace) {
    console.log(`${filepath}:${line}`);
    console.log(`  Commit: ${commitSha.slice(0, 7)}`);
    console.log(`  No trace data (not from an AI session)`);
    return;
  }

  // Find relevant session(s) for this file
  const fileAttr = trace.files.find(
    (f) => f.path === filepath || filepath.endsWith(f.path),
  );
  if (!fileAttr) {
    console.log(`${filepath}:${line}`);
    console.log(`  Commit: ${commitSha.slice(0, 7)}`);
    console.log(`  Trace exists but no attribution for this file`);
    return;
  }

  console.log(`${filepath}:${line}`);
  console.log(`  Commit: ${commitSha.slice(0, 7)}`);

  for (const conv of fileAttr.conversations) {
    const summary = trace.sessions[conv.id];
    if (summary) {
      console.log(`\n  Session: ${conv.id}`);
      if (summary.source) {
        console.log(`  Source: ${summary.source}`);
      }
      console.log(`  Model: ${summary.model || 'unknown'}`);
      console.log(`  Prompt: "${summary.prompt}"`);
      if (summary.tool_calls_count) {
        console.log(`  Tool calls: ${summary.tool_calls_count}`);
      }
    }
  }
}

async function cmdShow(sessionId: string): Promise<void> {
  const session = loadSession(sessionId);
  if (!session) {
    error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  console.log(`Session: ${session.id}`);
  if (session.source) {
    console.log(`Source: ${session.source}`);
  }
  console.log(`Turns: ${session.turns.length}`);
  console.log('');

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    if (turn.type === 'human') {
      console.log(`[${i + 1}] Human:`);
      console.log(`    ${turn.content}`);
    } else {
      console.log(`[${i + 1}] Assistant (${turn.model || 'unknown'}):`);
      for (const block of turn.blocks) {
        if (block.type === 'text') {
          console.log(
            `    ${block.text.slice(0, 100)}${block.text.length > 100 ? '...' : ''}`,
          );
        } else if (block.type === 'tool_call') {
          console.log(
            `    [tool] ${block.name}(${JSON.stringify(block.input).slice(0, 50)}...)`,
          );
        } else if (block.type === 'tool_result') {
          const output = block.output || block.error || '';
          console.log(
            `    [result] ${output.slice(0, 50)}${output.length > 50 ? '...' : ''}`,
          );
        }
      }
    }
    console.log('');
  }
}

async function cmdPush(quiet: boolean = false): Promise<void> {
  const config = loadConfig();
  if (!config.backend_url) {
    if (!quiet) log('No backend_url configured. Skipping push.');
    return;
  }

  // TODO: implement backend push
  if (!quiet) log('Push to backend not yet implemented');
}

function printHelp(): void {
  console.log(
    `
assert-trace - Git blame for AI

Usage:
  assert init              Initialize trace in current git repo
  assert capture           Capture session from stdin (for hooks)
  assert commit [--quiet]  Attach pending traces to latest commit
  assert blame <file>:<line>  Show what session produced a line
  assert show <session-id> Show session details
  assert push [--quiet]    Push traces to backend (if configured)
  assert help              Show this help

Examples:
  assert init
  echo '{"id":"s1","turns":[...]}' | assert capture
  assert blame src/index.ts:42
`.trim(),
  );
}

// === Main ===

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'capture':
      await cmdCapture();
      break;
    case 'commit':
      await cmdCommit(args.includes('--quiet'));
      break;
    case 'blame':
      if (!args[1]) {
        error('Usage: assert blame <file>:<line>');
        process.exit(1);
      }
      await cmdBlame(args[1]);
      break;
    case 'show':
      if (!args[1]) {
        error('Usage: assert show <session-id>');
        process.exit(1);
      }
      await cmdShow(args[1]);
      break;
    case 'push':
      await cmdPush(args.includes('--quiet'));
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
