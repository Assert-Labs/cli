/**
 * Live agent capture tests.
 *
 * Every other test here runs against payloads we wrote ourselves, so they only
 * confirm the adapters match our own assumptions. These drive the real agent
 * binaries headlessly against a throwaway git repo and assert on what actually
 * lands in `.sessions/`, which is the only way to notice an agent changing
 * what it sends.
 *
 * They need each agent installed and authenticated, spend tokens, and take
 * minutes, so they're excluded from `pnpm test`. Run with `pnpm test:live`, or
 * `pnpm test:live -t codex` for one agent.
 *
 * HOME is deliberately left alone: each agent needs its own config and
 * credentials there. The session that lands in the central store is removed
 * afterwards.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSession } from '../../src/core';
import {
  blameFile,
  captureDisabled,
  capturePrivate,
} from '../../src/hooks/session-recorder';
import { SESSION_FORMAT_VERSION, type SessionEvent } from '../../src/schema';

interface LiveAgent {
  /** Value of `session_start.source` this agent records. */
  source: string;
  /** Executable to look for on PATH. */
  bin: string;
  /** Headless invocation for a one-shot prompt in `repo`. */
  args: (prompt: string, repo: string) => string[];
  /** Optional extra reason to skip (e.g. not signed in). */
  unavailable?: () => string | undefined;
}

const AGENTS: LiveAgent[] = [
  {
    source: 'claude-code',
    bin: 'claude',
    args: (prompt) => ['-p', '--dangerously-skip-permissions', prompt],
  },
  {
    source: 'codex',
    bin: 'codex',
    args: (prompt) => ['exec', '--sandbox', 'workspace-write', prompt],
  },
  {
    source: 'opencode',
    bin: 'opencode',
    // OpenCode resolves its project from `--dir` rather than the spawn cwd.
    args: (prompt, repo) => ['run', '--dir', repo, prompt],
  },
  {
    source: 'pi',
    bin: 'pi',
    // Pi defaults to the google provider; pin one we can expect a key for.
    args: (prompt) => ['-p', '--provider', 'openai', prompt],
  },
  {
    source: 'cursor',
    bin: 'cursor-agent',
    args: (prompt) => ['-p', '--force', prompt],
    unavailable: () => {
      const status = spawnSync('cursor-agent', ['status'], { encoding: 'utf-8' });
      return /not logged in/i.test(`${status.stdout}${status.stderr}`)
        ? 'cursor-agent is not logged in (run `cursor-agent login` or set CURSOR_API_KEY)'
        : undefined;
    },
  },
];

const TARGET = 'src/live-check.ts';
const CONTENT = 'export const liveCheck = true';
const PROMPT =
  `Create a file ${TARGET} containing exactly this one line and nothing else: ` +
  `${CONTENT}. Do not create or modify any other file, and do not run git.`;

function onPath(bin: string): boolean {
  return spawnSync('command', ['-v', bin], { shell: true }).status === 0;
}

function makeRepo(source: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `assert-live-${source}-`)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.email', 'live@assert.dev']);
  git(['config', 'user.name', 'Assert Live']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# live capture check\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return repo;
}

/** Session directories published into the repo, newest last. */
function sessionDirs(repo: string): string[] {
  const base = path.join(repo, '.sessions');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name))
    .sort();
}

/** Poll until `check()` holds, or give up. */
async function waitFor<T>(
  check: () => T | undefined,
  timeoutMs: number,
  describe: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(describe());
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Wait for a published session. Several agents forward hooks fire-and-forget,
 * so `.sessions/` can land a moment after the agent process exits.
 */
function waitForSession(repo: string, timeoutMs = 30_000): Promise<string> {
  return waitFor(
    () => {
      const dirs = sessionDirs(repo).filter((dir) => fs.existsSync(path.join(dir, 'meta.json')));
      return dirs.length > 0 ? dirs[dirs.length - 1] : undefined;
    },
    timeoutMs,
    () => `no session published into ${repo}/.sessions`,
  );
}

function readEvents(dir: string): SessionEvent[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .flatMap((file) =>
      fs
        .readFileSync(path.join(dir, file), 'utf-8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as SessionEvent),
    );
}

/** Remove this session from the developer's central store. */
function forgetSession(sessionId: string): void {
  const dir = path.join(os.homedir(), '.assert', 'sessions');
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (entry.startsWith(sessionId)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

describe('live agent capture', () => {
  beforeAll(() => {
    if (captureDisabled()) {
      throw new Error('capture is disabled; run `assert enable` to run these');
    }
    // Private mode captures centrally but writes nothing into the repo, which
    // is the only thing these assert on.
    if (capturePrivate()) {
      throw new Error('capture is private; run `assert public` to run these');
    }
  });

  for (const agent of AGENTS) {
    const missing = !onPath(agent.bin) ? `${agent.bin} is not installed` : agent.unavailable?.();

    it.skipIf(missing != null)(
      `${agent.source} captures a file it wrote`,
      async () => {
        const repo = makeRepo(agent.source);
        let sessionId = '';
        try {
          const run = spawnSync(agent.bin, agent.args(PROMPT, repo), {
            cwd: repo,
            encoding: 'utf-8',
            timeout: 240_000,
          });
          const written = path.join(repo, TARGET);
          // Poll: an agent's own write can land just after its process exits.
          await waitFor(
            () => (fs.existsSync(written) ? true : undefined),
            15_000,
            () =>
              `${agent.bin} did not write ${TARGET}.\n` +
              `stdout: ${run.stdout?.slice(-500)}\nstderr: ${run.stderr?.slice(-500)}`,
          );

          const dir = await waitForSession(repo);
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
          sessionId = meta.sessionId;

          expect(meta.source).toBe(agent.source);
          expect(meta.formatVersion).toBe(SESSION_FORMAT_VERSION);

          const events = readEvents(dir);

          // The prompt we sent must be recorded, not an empty placeholder.
          const prompt = events.find((event) => event.type === 'human_turn');
          expect(prompt?.type === 'human_turn' && prompt.content).toContain(TARGET);

          // Some tool call must claim, in the canonical vocabulary, to have
          // written the file, in repo-relative form.
          const writes = events.filter(
            (event) =>
              event.type === 'tool_call' &&
              (event.action.kind === 'write' || event.action.kind === 'edit') &&
              (event.action.paths ?? []).some((p) => p.endsWith('live-check.ts')),
          );
          expect(
            writes.length,
            `no canonical write/edit action naming ${TARGET}; actions were ` +
              JSON.stringify(
                events
                  .filter((e) => e.type === 'tool_call')
                  .map((e) => (e.type === 'tool_call' ? [e.toolName, e.action] : null)),
              ),
          ).toBeGreaterThan(0);

          // Paths are repo-relative in a published capture.
          for (const event of writes) {
            if (event.type !== 'tool_call') continue;
            for (const p of event.action.paths ?? []) {
              expect(path.isAbsolute(p), `${p} should be repo-relative`).toBe(false);
            }
          }

          // The parse layer the reviewer uses must agree.
          const session = parseSession(
            events.map((event) => JSON.stringify(event)).join('\n'),
          );
          expect(session.source).toBe(agent.source);
          expect(session.turns.length).toBeGreaterThan(0);

          // And the line must blame to this agent rather than "unknown".
          const blame = blameFile(repo, TARGET, fs.readFileSync(written, 'utf-8'));
          expect(blame, 'no attribution recorded for the written file').not.toBeNull();
          const authored = blame!.find((line) => line.source === 'agent');
          expect(authored?.agent).toBe(agent.source);
        } finally {
          if (sessionId) forgetSession(sessionId);
          fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      },
      300_000,
    );
  }
});
