/**
 * Upload outbox: a durable queue of session files waiting to reach Assert.
 *
 * Each immutable file the recorder writes into the local mirror
 * (`~/.assert/sessions/<repoId>/<sessionDir>/…`) gets one entry here when the
 * publish mode is `assert`. An entry points at the mirror file rather than
 * copying it (mirror files are never rewritten) and is deleted once the
 * upload is acknowledged. Draining is bounded by a time budget so a hook never
 * waits on the network for long; whatever is left goes with the next turn
 * boundary or `assert push`. Nothing is ever dropped except entries whose
 * mirror file no longer exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { RedactionDirective } from './sanitizer';
import type { SessionUploadBatch, Uploader, UploadRepo, UploadSession } from './uploader';

export interface OutboxEntry {
  id: string;
  kind: 'session-file' | 'redaction';
  repo: UploadRepo;
  gitRoot: string;
  session: UploadSession;
  /** session-file: basename inside the session dir, and the mirror path. */
  file?: string;
  path?: string;
  /** redaction: the directive to apply server-side. */
  directive?: RedactionDirective;
  enqueuedAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

export type NewOutboxEntry = Omit<OutboxEntry, 'id' | 'enqueuedAt' | 'attempts'>;

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export function outboxDir(): string {
  return path.join(homeDir(), '.assert', 'outbox');
}

function entryPath(id: string): string {
  return path.join(outboxDir(), `${id}.json`);
}

function writeEntry(entry: OutboxEntry): void {
  fs.mkdirSync(outboxDir(), { recursive: true });
  const file = entryPath(entry.id);
  // Write-then-rename so a reader never sees a partial entry.
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(entry)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

export function enqueue(entry: NewOutboxEntry): OutboxEntry {
  const full: OutboxEntry = {
    ...entry,
    id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  };
  writeEntry(full);
  return full;
}

/** Every entry, oldest first. */
export function listEntries(): OutboxEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries: OutboxEntry[] = [];
  for (const name of names.sort()) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(outboxDir(), name), 'utf-8')));
    } catch {
      /* partial write or foreign file; skipped, never deleted */
    }
  }
  return entries;
}

function remove(entry: OutboxEntry): void {
  try {
    fs.unlinkSync(entryPath(entry.id));
  } catch {
    /* already gone */
  }
}

/** Exponential backoff after a failed attempt: 5s, 10s, 20s … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(5000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

function due(entry: OutboxEntry, now: number): boolean {
  return !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now;
}

export interface DrainOptions {
  /** The client for an entry's repo, or null to leave that entry queued
   * untouched (e.g. no token is configured for it yet). */
  uploaderFor: (entry: OutboxEntry) => Uploader | null;
  /** Stop starting new requests once this much time has passed. */
  budgetMs?: number;
  /** Retry entries before their backoff elapses (`assert push`). */
  force?: boolean;
  now?: () => number;
}

export interface DrainResult {
  uploaded: number;
  failed: number;
  /** Entries still queued afterwards (including ones not attempted). */
  remaining: number;
  lastError?: string;
}

/**
 * Upload due entries, one request per session. Succeeded entries are removed;
 * failed ones record the error and a backoff and stay queued.
 */
export async function drain(options: DrainOptions): Promise<DrainResult> {
  const now = options.now ?? Date.now;
  const start = now();
  const budget = options.budgetMs ?? 4000;
  const all = listEntries();
  const candidates = all.filter((e) => options.force || due(e, start));

  const groups = new Map<string, OutboxEntry[]>();
  for (const entry of candidates) {
    const key = `${entry.kind}:${entry.session.id}:${entry.kind === 'redaction' ? entry.id : ''}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(entry);
  }

  const result: DrainResult = { uploaded: 0, failed: 0, remaining: 0 };
  let started = false;
  for (const entries of groups.values()) {
    // Always attempt at least one request; the budget bounds what follows.
    if (started && now() - start > budget) break;
    started = true;
    const first = entries[0];
    const uploader = options.uploaderFor(first);
    if (!uploader) continue;
    try {
      if (first.kind === 'redaction') {
        await uploader.uploadRedaction({
          repo: first.repo,
          session: first.session,
          directive: first.directive!,
        });
      } else {
        const files: SessionUploadBatch['files'] = [];
        for (const entry of entries) {
          let content: string;
          try {
            content = fs.readFileSync(entry.path!, 'utf-8');
          } catch {
            remove(entry); // mirror file is gone; nothing left to upload
            continue;
          }
          files.push({ name: entry.file!, content });
        }
        if (files.length === 0) continue;
        files.sort((a, b) => a.name.localeCompare(b.name));
        await uploader.uploadSession({ repo: first.repo, session: first.session, files });
      }
      for (const entry of entries) remove(entry);
      result.uploaded += entries.length;
    } catch (e) {
      const message = (e as Error).message;
      result.lastError = message;
      for (const entry of entries) {
        if (!fs.existsSync(entryPath(entry.id))) continue;
        entry.attempts += 1;
        entry.lastError = message;
        entry.nextAttemptAt = new Date(now() + backoffMs(entry.attempts)).toISOString();
        writeEntry(entry);
        result.failed += 1;
      }
    }
  }
  result.remaining = listEntries().length;
  return result;
}
