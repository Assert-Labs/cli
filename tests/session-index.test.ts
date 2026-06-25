import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionsDir,
  getIndexPath,
  loadIndex,
  saveIndex,
  createEmptyIndex,
  indexSession,
  indexFileModification,
  endSession,
  findSessionsForFile,
  findSessionsForRepo,
  findSessionsForFiles,
  getActiveSessions,
  cleanupOldSessions,
} from '../src/session-index';

describe('session-index', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    // Use a temp directory as HOME
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('paths', () => {
    it('returns correct sessions directory', () => {
      expect(getSessionsDir()).toBe(path.join(testHome, '.assert', 'sessions'));
    });

    it('returns correct index path', () => {
      expect(getIndexPath()).toBe(path.join(testHome, '.assert', 'sessions', 'index.json'));
    });
  });

  describe('loadIndex', () => {
    it('returns empty index if no file exists', () => {
      const index = loadIndex();

      expect(index.version).toBe(1);
      expect(index.sessions).toEqual({});
      expect(index.repoSessions).toEqual({});
      expect(index.fileSessions).toEqual({});
    });

    it('loads existing index', () => {
      const sessionsDir = getSessionsDir();
      fs.mkdirSync(sessionsDir, { recursive: true });

      const testIndex = createEmptyIndex();
      testIndex.sessions['test-session'] = {
        sessionId: 'test-session',
        repoId: 'repo-1',
        gitRoot: '/test/repo',
        startTime: '2024-01-01T00:00:00Z',
        filesModified: [],
        isActive: true,
      };

      fs.writeFileSync(getIndexPath(), JSON.stringify(testIndex));

      const loaded = loadIndex();
      expect(loaded.sessions['test-session']).toBeDefined();
    });
  });

  describe('saveIndex', () => {
    it('creates directory if needed', () => {
      const index = createEmptyIndex();
      saveIndex(index);

      expect(fs.existsSync(getIndexPath())).toBe(true);
    });

    it('writes valid JSON', () => {
      const index = createEmptyIndex();
      index.sessions['test'] = {
        sessionId: 'test',
        repoId: 'repo-1',
        gitRoot: '/test',
        startTime: '2024-01-01T00:00:00Z',
        filesModified: [],
        isActive: true,
      };

      saveIndex(index);

      const content = fs.readFileSync(getIndexPath(), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.sessions['test'].sessionId).toBe('test');
    });
  });

  describe('indexSession', () => {
    it('adds session to index', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');

      expect(index.sessions['session-1']).toBeDefined();
      expect(index.sessions['session-1'].repoId).toBe('repo-1');
      expect(index.sessions['session-1'].isActive).toBe(true);
    });

    it('adds session to repoSessions mapping', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');

      expect(index.repoSessions['repo-1']).toContain('session-1');
    });

    it('handles multiple sessions per repo', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexSession(index, 'session-2', 'repo-1', '/test/repo', '2024-01-01T01:00:00Z');

      expect(index.repoSessions['repo-1']).toHaveLength(2);
    });
  });

  describe('indexFileModification', () => {
    it('tracks file in session', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/test.ts');

      expect(index.sessions['session-1'].filesModified).toContain('src/test.ts');
    });

    it('tracks file in fileSessions mapping', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/test.ts');

      expect(index.fileSessions['repo-1']['src/test.ts']).toContain('session-1');
    });

    it('handles multiple sessions modifying same file', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexSession(index, 'session-2', 'repo-1', '/test/repo', '2024-01-01T01:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/test.ts');
      index = indexFileModification(index, 'session-2', 'repo-1', 'src/test.ts');

      expect(index.fileSessions['repo-1']['src/test.ts']).toHaveLength(2);
    });
  });

  describe('endSession', () => {
    it('marks session as inactive', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = endSession(index, 'session-1', '2024-01-01T01:00:00Z');

      expect(index.sessions['session-1'].isActive).toBe(false);
      expect(index.sessions['session-1'].endTime).toBe('2024-01-01T01:00:00Z');
    });
  });

  describe('findSessionsForFile', () => {
    it('finds sessions that modified a file', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/test.ts');

      const sessions = findSessionsForFile(index, 'repo-1', 'src/test.ts');
      expect(sessions).toContain('session-1');
    });

    it('returns empty array for unknown file', () => {
      const index = createEmptyIndex();
      const sessions = findSessionsForFile(index, 'repo-1', 'unknown.ts');
      expect(sessions).toEqual([]);
    });
  });

  describe('findSessionsForFiles', () => {
    it('finds sessions across multiple files', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexSession(index, 'session-2', 'repo-1', '/test/repo', '2024-01-01T01:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/a.ts');
      index = indexFileModification(index, 'session-2', 'repo-1', 'src/b.ts');

      const sessions = findSessionsForFiles(index, 'repo-1', ['src/a.ts', 'src/b.ts']);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });

    it('deduplicates sessions', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/a.ts');
      index = indexFileModification(index, 'session-1', 'repo-1', 'src/b.ts');

      const sessions = findSessionsForFiles(index, 'repo-1', ['src/a.ts', 'src/b.ts']);
      expect(sessions).toHaveLength(1);
    });
  });

  describe('getActiveSessions', () => {
    it('returns only active sessions', () => {
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', 'repo-1', '/test/repo', '2024-01-01T00:00:00Z');
      index = indexSession(index, 'session-2', 'repo-1', '/test/repo', '2024-01-01T01:00:00Z');
      index = endSession(index, 'session-1', '2024-01-01T00:30:00Z');

      const active = getActiveSessions(index, 'repo-1');
      expect(active).toHaveLength(1);
      expect(active[0].sessionId).toBe('session-2');
    });
  });

  describe('cleanupOldSessions', () => {
    it('removes old inactive sessions', () => {
      let index = createEmptyIndex();

      // Old session (31 days ago)
      const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      index = indexSession(index, 'old-session', 'repo-1', '/test/repo', oldTime, false);
      index = endSession(index, 'old-session', oldTime);

      // Recent session
      index = indexSession(index, 'new-session', 'repo-1', '/test/repo', new Date().toISOString());

      index = cleanupOldSessions(index, 30);

      expect(index.sessions['old-session']).toBeUndefined();
      expect(index.sessions['new-session']).toBeDefined();
    });

    it('keeps active sessions regardless of age', () => {
      let index = createEmptyIndex();

      const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      index = indexSession(index, 'old-active', 'repo-1', '/test/repo', oldTime, true);

      index = cleanupOldSessions(index, 30);

      expect(index.sessions['old-active']).toBeDefined();
    });
  });
});
