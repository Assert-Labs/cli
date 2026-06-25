import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getBoundariesPath,
  loadBoundaries,
  saveBoundaries,
  recordBoundary,
  getLastEndBoundary,
  getBoundary,
  calculateHumanChanges,
  calculateAgentChanges,
  cleanupBoundaries,
} from '../src/boundaries';

describe('boundaries', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let testRepoDir: string;

  beforeEach(() => {
    // Use temp directories
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-home-'));
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-repo-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(testRepoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('getBoundariesPath', () => {
    it('returns path under sessions directory', () => {
      const boundariesPath = getBoundariesPath('repo-123');
      expect(boundariesPath).toContain('.assert/sessions/boundaries');
      expect(boundariesPath).toContain('repo-123.json');
    });
  });

  describe('loadBoundaries', () => {
    it('returns empty store if no file exists', () => {
      const store = loadBoundaries('nonexistent-repo');

      expect(store.version).toBe(1);
      expect(store.boundaries).toEqual([]);
    });
  });

  describe('saveBoundaries', () => {
    it('creates boundaries file', () => {
      const store = { version: 1, boundaries: [] };
      saveBoundaries('test-repo', store);

      const boundariesPath = getBoundariesPath('test-repo');
      expect(fs.existsSync(boundariesPath)).toBe(true);
    });
  });

  describe('recordBoundary', () => {
    it('records session start boundary', () => {
      // Create a test file
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'const x = 1;');

      const boundary = recordBoundary(
        'repo-1',
        'session-1',
        'start',
        testRepoDir,
        ['test.ts'],
        'abc123'
      );

      expect(boundary.type).toBe('start');
      expect(boundary.sessionId).toBe('session-1');
      expect(boundary.repoId).toBe('repo-1');
      expect(boundary.files).toHaveLength(1);
      expect(boundary.files[0].filePath).toBe('test.ts');
    });

    it('records session end boundary', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'const x = 2;');

      const boundary = recordBoundary(
        'repo-1',
        'session-1',
        'end',
        testRepoDir,
        ['test.ts'],
        'def456'
      );

      expect(boundary.type).toBe('end');
    });

    it('captures file content in snapshot', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'line 1\nline 2\nline 3');

      const boundary = recordBoundary('repo-1', 'session-1', 'start', testRepoDir, ['test.ts']);

      expect(boundary.files[0].lines).toHaveLength(3);
      expect(boundary.files[0].lines[0].content).toBe('line 1');
    });

    it('handles missing files gracefully', () => {
      const boundary = recordBoundary(
        'repo-1',
        'session-1',
        'start',
        testRepoDir,
        ['nonexistent.ts']
      );

      expect(boundary.files).toHaveLength(0);
    });
  });

  describe('getLastEndBoundary', () => {
    it('returns null if no boundaries exist', () => {
      const result = getLastEndBoundary('nonexistent-repo');
      expect(result).toBeNull();
    });

    it('returns most recent end boundary', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'content 1');

      recordBoundary('repo-1', 'session-1', 'start', testRepoDir, ['test.ts']);

      fs.writeFileSync(testFile, 'content 2');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      fs.writeFileSync(testFile, 'content 3');
      recordBoundary('repo-1', 'session-2', 'start', testRepoDir, ['test.ts']);

      fs.writeFileSync(testFile, 'content 4');
      const lastEnd = recordBoundary('repo-1', 'session-2', 'end', testRepoDir, ['test.ts']);

      const result = getLastEndBoundary('repo-1');
      expect(result?.sessionId).toBe('session-2');
      expect(result?.type).toBe('end');
    });

    it('skips start boundaries', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'content');

      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);
      recordBoundary('repo-1', 'session-2', 'start', testRepoDir, ['test.ts']);

      const result = getLastEndBoundary('repo-1');
      expect(result?.sessionId).toBe('session-1');
    });
  });

  describe('getBoundary', () => {
    it('retrieves specific boundary', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'content');

      recordBoundary('repo-1', 'session-1', 'start', testRepoDir, ['test.ts']);
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      const startBoundary = getBoundary('repo-1', 'session-1', 'start');
      const endBoundary = getBoundary('repo-1', 'session-1', 'end');

      expect(startBoundary?.type).toBe('start');
      expect(endBoundary?.type).toBe('end');
    });

    it('returns null for nonexistent boundary', () => {
      const result = getBoundary('repo-1', 'nonexistent', 'start');
      expect(result).toBeNull();
    });
  });

  describe('calculateHumanChanges', () => {
    it('detects lines added by human after session', () => {
      const testFile = path.join(testRepoDir, 'test.ts');

      // Agent leaves file in this state
      fs.writeFileSync(testFile, 'line 1\nline 2');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      // Human adds a line
      fs.writeFileSync(testFile, 'line 1\nline 2\nline 3');

      const changes = calculateHumanChanges('repo-1', testRepoDir, ['test.ts']);

      expect(changes.has('test.ts')).toBe(true);
      const fileChanges = changes.get('test.ts')!;
      expect(fileChanges.added.size).toBe(1); // 'line 3' was added
    });

    it('detects lines removed by human after session', () => {
      const testFile = path.join(testRepoDir, 'test.ts');

      // Agent leaves file in this state
      fs.writeFileSync(testFile, 'line 1\nline 2\nline 3');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      // Human removes a line
      fs.writeFileSync(testFile, 'line 1\nline 3');

      const changes = calculateHumanChanges('repo-1', testRepoDir, ['test.ts']);

      expect(changes.has('test.ts')).toBe(true);
      const fileChanges = changes.get('test.ts')!;
      expect(fileChanges.removed.size).toBe(1); // 'line 2' was removed
    });

    it('handles new files (all lines are human additions)', () => {
      const testFile = path.join(testRepoDir, 'new-file.ts');

      // No prior session touched this file
      fs.writeFileSync(testFile, 'new content\nmore content');

      const changes = calculateHumanChanges('repo-1', testRepoDir, ['new-file.ts']);

      expect(changes.has('new-file.ts')).toBe(true);
      const fileChanges = changes.get('new-file.ts')!;
      expect(fileChanges.added.size).toBe(2);
    });

    it('returns empty changes if file unchanged', () => {
      const testFile = path.join(testRepoDir, 'test.ts');

      fs.writeFileSync(testFile, 'unchanged content');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      // File not modified
      const changes = calculateHumanChanges('repo-1', testRepoDir, ['test.ts']);

      expect(changes.size).toBe(0);
    });
  });

  describe('calculateAgentChanges', () => {
    it('calculates lines added by agent during session', () => {
      const testFile = path.join(testRepoDir, 'test.ts');

      // Before agent
      fs.writeFileSync(testFile, 'original line');
      recordBoundary('repo-1', 'session-1', 'start', testRepoDir, ['test.ts']);

      // After agent
      fs.writeFileSync(testFile, 'original line\nagent added this');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['test.ts']);

      const changes = calculateAgentChanges('repo-1', 'session-1');

      expect(changes.has('test.ts')).toBe(true);
      expect(changes.get('test.ts')!.added.size).toBe(1);
    });

    it('handles file creation by agent', () => {
      const testFile = path.join(testRepoDir, 'new-file.ts');

      // No file at start (record with empty file list or file doesn't exist)
      recordBoundary('repo-1', 'session-1', 'start', testRepoDir, []);

      // Agent creates file
      fs.writeFileSync(testFile, 'new file content\nline 2');
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['new-file.ts']);

      const changes = calculateAgentChanges('repo-1', 'session-1');

      expect(changes.has('new-file.ts')).toBe(true);
      expect(changes.get('new-file.ts')!.added.size).toBe(2);
    });

    it('returns empty if no boundaries recorded', () => {
      const changes = calculateAgentChanges('repo-1', 'nonexistent-session');
      expect(changes.size).toBe(0);
    });
  });

  describe('cleanupBoundaries', () => {
    it('keeps only recent boundaries', () => {
      const testFile = path.join(testRepoDir, 'test.ts');
      fs.writeFileSync(testFile, 'content');

      // Record many boundaries
      for (let i = 0; i < 150; i++) {
        recordBoundary('repo-1', `session-${i}`, 'start', testRepoDir, ['test.ts']);
      }

      const storeBefore = loadBoundaries('repo-1');
      expect(storeBefore.boundaries.length).toBe(150);

      cleanupBoundaries('repo-1', 100);

      const storeAfter = loadBoundaries('repo-1');
      expect(storeAfter.boundaries.length).toBe(100);
    });
  });

  describe('real-world workflow', () => {
    it('tracks interleaved agent and human edits', () => {
      const testFile = path.join(testRepoDir, 'component.tsx');

      // Initial state
      fs.writeFileSync(testFile, 'function Component() {\n  return null;\n}');

      // Agent session 1 - adds props
      recordBoundary('repo-1', 'session-1', 'start', testRepoDir, ['component.tsx']);
      fs.writeFileSync(
        testFile,
        'interface Props {\n  name: string;\n}\n\nfunction Component({ name }: Props) {\n  return <div>{name}</div>;\n}'
      );
      recordBoundary('repo-1', 'session-1', 'end', testRepoDir, ['component.tsx']);

      // Human edits - changes greeting
      fs.writeFileSync(
        testFile,
        'interface Props {\n  name: string;\n}\n\nfunction Component({ name }: Props) {\n  return <div>Hello, {name}!</div>;\n}'
      );

      // Agent session 2 - adds export
      recordBoundary('repo-1', 'session-2', 'start', testRepoDir, ['component.tsx']);

      // Detect what human changed
      const humanChanges = calculateHumanChanges('repo-1', testRepoDir, ['component.tsx']);
      expect(humanChanges.has('component.tsx')).toBe(true);
      expect(humanChanges.get('component.tsx')!.added.size).toBeGreaterThan(0);

      fs.writeFileSync(
        testFile,
        'interface Props {\n  name: string;\n}\n\nfunction Component({ name }: Props) {\n  return <div>Hello, {name}!</div>;\n}\n\nexport default Component;'
      );
      recordBoundary('repo-1', 'session-2', 'end', testRepoDir, ['component.tsx']);

      // Calculate what session-2 added
      const agentChanges = calculateAgentChanges('repo-1', 'session-2');
      expect(agentChanges.has('component.tsx')).toBe(true);
      expect(agentChanges.get('component.tsx')!.added.size).toBeGreaterThan(0);
    });
  });
});
