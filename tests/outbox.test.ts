import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { enqueue, listEntries, drain, backoffMs, outboxDir, type OutboxEntry } from '../src/outbox';
import type { Uploader, SessionUploadBatch, RedactionUpload } from '../src/uploader';

describe('outbox', () => {
  let home: string;
  let originalHome: string | undefined;
  let mirror: string;

  const repo = { id: 'repo-1', remote: 'github.com/acme/app' };
  const session = { id: 's1', source: 'claude-code', dir: '2026-01-01T00-00-00Z-s1', createdAt: '2026-01-01T00:00:00Z' };

  const mirrorFile = (name: string, content = name) => {
    const file = path.join(mirror, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const sessionFile = (name: string, sessionId = 's1') =>
    enqueue({
      kind: 'session-file',
      repo,
      gitRoot: '/repo',
      session: { ...session, id: sessionId },
      file: name,
      path: mirrorFile(`${sessionId}-${name}`, name),
    });

  function fakeUploader(fail = false): Uploader & { sessions: SessionUploadBatch[]; redactions: RedactionUpload[] } {
    const sessions: SessionUploadBatch[] = [];
    const redactions: RedactionUpload[] = [];
    return {
      sessions,
      redactions,
      async uploadSession(batch) {
        if (fail) throw new Error('boom');
        sessions.push(batch);
      },
      async uploadRedaction(upload) {
        if (fail) throw new Error('boom');
        redactions.push(upload);
      },
    };
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-outbox-home-')));
    process.env.HOME = home;
    mirror = path.join(home, 'mirror');
    fs.mkdirSync(mirror);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('queues entries durably, oldest first', () => {
    const a = sessionFile('meta.json');
    const b = sessionFile('0000-t1.jsonl');
    const ids = listEntries().map((e) => e.id);
    expect(ids).toEqual([a.id, b.id]);
    expect(fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('uploads one batch per session, in file order, and removes what succeeded', async () => {
    sessionFile('0000-t1.jsonl');
    sessionFile('meta.json');
    sessionFile('meta.json', 's2');
    const uploader = fakeUploader();
    const result = await drain({ uploaderFor: () => uploader });
    expect(result).toMatchObject({ uploaded: 3, failed: 0, remaining: 0 });
    expect(uploader.sessions.map((b) => b.session.id)).toEqual(['s1', 's2']);
    expect(uploader.sessions[0].files.map((f) => f.name)).toEqual(['0000-t1.jsonl', 'meta.json']);
    expect(uploader.sessions[0].files[1].content).toBe('meta.json');
    expect(uploader.sessions[0].repo).toEqual(repo);
  });

  it('keeps failed entries with a backoff and retries them when forced', async () => {
    sessionFile('meta.json');
    const failing = fakeUploader(true);
    let result = await drain({ uploaderFor: () => failing });
    expect(result).toMatchObject({ uploaded: 0, failed: 1, remaining: 1, lastError: 'boom' });
    const [entry] = listEntries();
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toBe('boom');
    expect(Date.parse(entry.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // Not due yet: left alone.
    const ok = fakeUploader();
    result = await drain({ uploaderFor: () => ok });
    expect(result).toMatchObject({ uploaded: 0, remaining: 1 });
    expect(ok.sessions).toEqual([]);

    result = await drain({ uploaderFor: () => ok, force: true });
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
  });

  it('grows the backoff exponentially up to six hours', () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(4)).toBe(40000);
    expect(backoffMs(40)).toBe(6 * 60 * 60 * 1000);
  });

  it('leaves entries without an uploader untouched', async () => {
    sessionFile('meta.json');
    const result = await drain({ uploaderFor: () => null });
    expect(result).toMatchObject({ uploaded: 0, failed: 0, remaining: 1 });
    expect(listEntries()[0].attempts).toBe(0);
  });

  it('drops entries whose mirror file is gone', async () => {
    const entry = sessionFile('meta.json');
    fs.unlinkSync(entry.path!);
    const uploader = fakeUploader();
    const result = await drain({ uploaderFor: () => uploader });
    expect(uploader.sessions).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it('stops starting requests once the budget is spent', async () => {
    sessionFile('meta.json', 's1');
    sessionFile('meta.json', 's2');
    let t = 0;
    const uploader = fakeUploader();
    const result = await drain({
      uploaderFor: () => uploader,
      budgetMs: 10,
      now: () => (t += 20),
    });
    expect(result.uploaded).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it('sends redactions on their own', async () => {
    const entry: OutboxEntry = enqueue({
      kind: 'redaction',
      repo,
      gitRoot: '/repo',
      session,
      directive: { target: 'last-tool-output', toolOrdinal: 2 },
    });
    const uploader = fakeUploader();
    await drain({ uploaderFor: () => uploader });
    expect(uploader.redactions).toEqual([{ repo, session, directive: entry.directive }]);
    expect(listEntries()).toEqual([]);
  });
});
