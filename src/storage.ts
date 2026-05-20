/**
 * Storage utilities for traces
 *
 * - Pending traces: .git/assert/pending/
 * - Full sessions: .git/assert/sessions/
 * - Config: .git/assert/config.json
 * - Git notes: refs/notes/assert-traces
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { PendingTrace, Session, Trace, TraceConfig, DEFAULT_CONFIG } from "./schema.js";

// === Path Helpers ===

export function getGitRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Not in a git repository");
  }
}

export function getAssertDir(): string {
  return join(getGitRoot(), ".git", "assert");
}

export function ensureAssertDir(): void {
  const assertDir = getAssertDir();
  const dirs = [
    assertDir,
    join(assertDir, "pending"),
    join(assertDir, "sessions"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// === Config ===

export function getConfigPath(): string {
  return join(getAssertDir(), "config.json");
}

export function loadConfig(): TraceConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: TraceConfig): void {
  ensureAssertDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// === Pending Traces ===

export function savePendingTrace(trace: PendingTrace): string {
  ensureAssertDir();
  const filename = `${trace.session_id}.json`;
  const filepath = join(getAssertDir(), "pending", filename);
  writeFileSync(filepath, JSON.stringify(trace, null, 2));
  return filepath;
}

export function loadPendingTraces(): PendingTrace[] {
  const pendingDir = join(getAssertDir(), "pending");
  if (!existsSync(pendingDir)) {
    return [];
  }
  const files = readdirSync(pendingDir).filter(f => f.endsWith(".json"));
  return files.map(f => {
    const content = readFileSync(join(pendingDir, f), "utf-8");
    return JSON.parse(content) as PendingTrace;
  });
}

export function clearPendingTrace(sessionId: string): void {
  const filepath = join(getAssertDir(), "pending", `${sessionId}.json`);
  if (existsSync(filepath)) {
    unlinkSync(filepath);
  }
}

export function clearAllPendingTraces(): void {
  const pendingDir = join(getAssertDir(), "pending");
  if (!existsSync(pendingDir)) return;
  const files = readdirSync(pendingDir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    unlinkSync(join(pendingDir, f));
  }
}

// === Full Sessions ===

export function saveSession(session: Session): string {
  ensureAssertDir();
  const filename = `${session.id}.json`;
  const filepath = join(getAssertDir(), "sessions", filename);
  writeFileSync(filepath, JSON.stringify(session, null, 2));
  return filepath;
}

export function loadSession(sessionId: string): Session | null {
  const filepath = join(getAssertDir(), "sessions", `${sessionId}.json`);
  if (!existsSync(filepath)) {
    return null;
  }
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

// === Git Notes ===

const NOTES_REF = "refs/notes/assert-traces";

export function getTraceForCommit(commitSha: string): Trace | null {
  try {
    const content = execSync(`git notes --ref=${NOTES_REF} show ${commitSha}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function setTraceForCommit(commitSha: string, trace: Trace): void {
  const json = JSON.stringify(trace);
  try {
    // Try to add, if exists, use -f to overwrite
    execSync(`git notes --ref=${NOTES_REF} add -f -m '${json.replace(/'/g, "'\\''")}' ${commitSha}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(`Failed to set git note: ${e}`);
  }
}

export function getCurrentCommitSha(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

export function getCommitForLine(filepath: string, line: number): string | null {
  try {
    // git blame -L <line>,<line> -p <file> gives us the commit for that line
    const output = execSync(`git blame -L ${line},${line} -p "${filepath}"`, {
      encoding: "utf-8",
    });
    // First line is the commit SHA
    const sha = output.split(" ")[0];
    return sha && sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

// === Git Hooks ===

export function getHooksDir(): string {
  return join(getGitRoot(), ".git", "hooks");
}

export function installHook(hookName: string, script: string): void {
  const hookPath = join(getHooksDir(), hookName);

  // If hook exists, append our script (preserve existing hooks)
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes("# assert-trace")) {
      // Already installed, update it
      const updated = existing.replace(
        /# assert-trace start[\s\S]*# assert-trace end/,
        `# assert-trace start\n${script}\n# assert-trace end`
      );
      writeFileSync(hookPath, updated);
    } else {
      // Append
      writeFileSync(hookPath, `${existing}\n\n# assert-trace start\n${script}\n# assert-trace end\n`);
    }
  } else {
    // Create new hook
    writeFileSync(hookPath, `#!/bin/sh\n\n# assert-trace start\n${script}\n# assert-trace end\n`);
  }

  // Make executable
  execSync(`chmod +x "${hookPath}"`);
}
