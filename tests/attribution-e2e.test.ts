/**
 * End-to-end attribution tests
 *
 * These tests simulate complete workflows:
 * - Agent sessions making changes
 * - Human edits between sessions
 * - Attribution computation for git blame-like output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getOrCreateRepoId, removeRepoId } from '../src/repo-identity';
import {
  loadIndex,
  saveIndex,
  createEmptyIndex,
  indexSession,
  indexFileModification,
  endSession,
  findSessionsForFiles,
} from '../src/session-index';
import { recordBoundary, calculateAgentChanges, calculateHumanChanges } from '../src/boundaries';
import {
  createFileSnapshot,
  buildAttribution,
  calculateAgentContribution,
  findSessionLines,
  hashLine,
} from '../src/line-attribution';

describe('attribution e2e', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let testRepoDir: string;

  beforeEach(() => {
    // Set up isolated environment
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-e2e-home-'));
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-e2e-repo-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    // Initialize git repo
    execSync('git init', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: testRepoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Ignore cleanup errors
    }
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('single agent session', () => {
    it('attributes all new lines to the agent session', async () => {
      // Get repo identity
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;

      // Start tracking session
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());

      // Record session start (no files yet)
      recordBoundary(repoId, 'session-1', 'start', testRepoDir, []);

      // Agent creates a file
      const testFile = path.join(testRepoDir, 'component.tsx');
      fs.writeFileSync(
        testFile,
        `import React from 'react';

function Component() {
  return <div>Hello World</div>;
}

export default Component;`
      );

      // Track the file modification
      index = indexFileModification(index, 'session-1', repoId, 'component.tsx');
      saveIndex(index);

      // Record session end
      recordBoundary(repoId, 'session-1', 'end', testRepoDir, ['component.tsx']);
      index = endSession(index, 'session-1', new Date().toISOString());
      saveIndex(index);

      // Calculate what the agent added
      const agentChanges = calculateAgentChanges(repoId, 'session-1');

      expect(agentChanges.has('component.tsx')).toBe(true);
      const changes = agentChanges.get('component.tsx')!;

      // All lines are additions (new file)
      expect(changes.added.size).toBeGreaterThan(0);

      // Build attribution
      const fileContent = fs.readFileSync(testFile, 'utf-8');
      const snapshot = createFileSnapshot('component.tsx', fileContent);

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: new Date().toISOString(),
          addedHashes: changes.added,
        },
      ];

      const attribution = buildAttribution(snapshot, history);

      // All lines should be attributed to the agent
      const contribution = calculateAgentContribution(attribution);
      expect(contribution.agentPercentage).toBe(100);
    });
  });

  describe('agent then human edits', () => {
    it('correctly attributes interleaved changes', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;
      const testFile = path.join(testRepoDir, 'utils.ts');

      // === Session 1: Agent creates file ===
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, 'session-1', 'start', testRepoDir, []);

      fs.writeFileSync(
        testFile,
        `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}`
      );

      index = indexFileModification(index, 'session-1', repoId, 'utils.ts');
      recordBoundary(repoId, 'session-1', 'end', testRepoDir, ['utils.ts']);
      index = endSession(index, 'session-1', new Date().toISOString());
      saveIndex(index);

      const session1Changes = calculateAgentChanges(repoId, 'session-1');

      // === Human edits: adds multiply function ===
      fs.writeFileSync(
        testFile,
        `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}`
      );

      // Calculate human changes before next session
      const humanChanges = calculateHumanChanges(repoId, testRepoDir, ['utils.ts']);
      expect(humanChanges.has('utils.ts')).toBe(true);

      // === Build final attribution ===
      const finalContent = fs.readFileSync(testFile, 'utf-8');
      const finalSnapshot = createFileSnapshot('utils.ts', finalContent);

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: new Date(Date.now() - 1000).toISOString(),
          addedHashes: session1Changes.get('utils.ts')?.added || new Set(),
        },
        {
          source: 'human' as const,
          timestamp: new Date().toISOString(),
          addedHashes: humanChanges.get('utils.ts')?.added || new Set(),
        },
      ];

      const attribution = buildAttribution(finalSnapshot, history);

      // Find lines attributed to each source
      const agentLines = attribution.filter((a) => a.source === 'agent');
      const humanLines = attribution.filter((a) => a.source === 'human');

      // Agent wrote add and subtract functions
      // Human wrote multiply function
      expect(agentLines.length).toBeGreaterThan(0);
      expect(humanLines.length).toBeGreaterThan(0);

      // The multiply function lines should be human
      const multiplyLineNumbers = humanLines.map((l) => l.lineNumber);
      const multiplyLines = finalContent.split('\n').filter((_, i) =>
        multiplyLineNumbers.includes(i + 1)
      );
      expect(multiplyLines.some((l) => l.includes('multiply'))).toBe(true);
    });
  });

  describe('multiple agent sessions', () => {
    it('attributes to correct sessions', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;
      const testFile = path.join(testRepoDir, 'api.ts');

      // === Session 1: Agent creates initial API ===
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, 'session-1', 'start', testRepoDir, []);

      fs.writeFileSync(
        testFile,
        `export async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}`
      );

      index = indexFileModification(index, 'session-1', repoId, 'api.ts');
      recordBoundary(repoId, 'session-1', 'end', testRepoDir, ['api.ts']);
      index = endSession(index, 'session-1', new Date().toISOString());
      saveIndex(index);

      const session1Changes = calculateAgentChanges(repoId, 'session-1');

      // === Session 2: Agent adds another function ===
      index = indexSession(index, 'session-2', repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, 'session-2', 'start', testRepoDir, ['api.ts']);

      fs.writeFileSync(
        testFile,
        `export async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}

export async function fetchPosts(userId: string) {
  const response = await fetch(\`/api/users/\${userId}/posts\`);
  return response.json();
}`
      );

      index = indexFileModification(index, 'session-2', repoId, 'api.ts');
      recordBoundary(repoId, 'session-2', 'end', testRepoDir, ['api.ts']);
      index = endSession(index, 'session-2', new Date().toISOString());
      saveIndex(index);

      const session2Changes = calculateAgentChanges(repoId, 'session-2');

      // === Build attribution ===
      const finalContent = fs.readFileSync(testFile, 'utf-8');
      const finalSnapshot = createFileSnapshot('api.ts', finalContent);

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: new Date(Date.now() - 2000).toISOString(),
          addedHashes: session1Changes.get('api.ts')?.added || new Set(),
        },
        {
          source: 'agent' as const,
          sessionId: 'session-2',
          timestamp: new Date(Date.now() - 1000).toISOString(),
          addedHashes: session2Changes.get('api.ts')?.added || new Set(),
        },
      ];

      const attribution = buildAttribution(finalSnapshot, history);

      // Find lines for each session
      const session1Lines = findSessionLines(attribution, 'session-1');
      const session2Lines = findSessionLines(attribution, 'session-2');

      // Both sessions contributed
      expect(session1Lines.length).toBeGreaterThan(0);
      expect(session2Lines.length).toBeGreaterThan(0);

      // Session 2 should include the fetchPosts function
      const session2Content = finalContent.split('\n').filter((_, i) =>
        session2Lines.includes(i + 1)
      );
      expect(session2Content.some((l) => l.includes('fetchPosts'))).toBe(true);
    });
  });

  describe('pre-commit hook simulation', () => {
    it('finds relevant sessions for staged files', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;

      // Create multiple files in different sessions
      let index = createEmptyIndex();

      // Session 1 modifies file A
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());
      fs.writeFileSync(path.join(testRepoDir, 'fileA.ts'), 'content A');
      index = indexFileModification(index, 'session-1', repoId, 'fileA.ts');
      index = endSession(index, 'session-1', new Date().toISOString());

      // Session 2 modifies file B
      index = indexSession(index, 'session-2', repoId, testRepoDir, new Date().toISOString());
      fs.writeFileSync(path.join(testRepoDir, 'fileB.ts'), 'content B');
      index = indexFileModification(index, 'session-2', repoId, 'fileB.ts');
      index = endSession(index, 'session-2', new Date().toISOString());

      // Session 3 modifies both files
      index = indexSession(index, 'session-3', repoId, testRepoDir, new Date().toISOString());
      fs.appendFileSync(path.join(testRepoDir, 'fileA.ts'), '\nmore content A');
      fs.appendFileSync(path.join(testRepoDir, 'fileB.ts'), '\nmore content B');
      index = indexFileModification(index, 'session-3', repoId, 'fileA.ts');
      index = indexFileModification(index, 'session-3', repoId, 'fileB.ts');
      index = endSession(index, 'session-3', new Date().toISOString());

      saveIndex(index);

      // Simulate pre-commit: find sessions for staged files
      const stagedFiles = ['fileA.ts']; // Only A is staged
      const relevantSessions = findSessionsForFiles(index, repoId, stagedFiles);

      // Should find sessions 1 and 3 (both touched fileA)
      expect(relevantSessions).toContain('session-1');
      expect(relevantSessions).toContain('session-3');
      expect(relevantSessions).not.toContain('session-2');
    });
  });

  describe('rebase survival', () => {
    it('maintains attribution after content moves', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;
      const testFile = path.join(testRepoDir, 'functions.ts');

      // Agent creates functions
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, 'session-1', 'start', testRepoDir, []);

      const originalContent = `function alpha() {
  return 'a';
}

function beta() {
  return 'b';
}

function gamma() {
  return 'c';
}`;

      fs.writeFileSync(testFile, originalContent);
      recordBoundary(repoId, 'session-1', 'end', testRepoDir, ['functions.ts']);

      const session1Changes = calculateAgentChanges(repoId, 'session-1');

      // Simulate rebase: functions reordered
      const reorderedContent = `function gamma() {
  return 'c';
}

function alpha() {
  return 'a';
}

function beta() {
  return 'b';
}`;

      fs.writeFileSync(testFile, reorderedContent);

      // Build attribution with reordered content
      const reorderedSnapshot = createFileSnapshot('functions.ts', reorderedContent);

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: new Date().toISOString(),
          addedHashes: session1Changes.get('functions.ts')?.added || new Set(),
        },
      ];

      const attribution = buildAttribution(reorderedSnapshot, history);

      // All lines should still be attributed to the agent
      // because we hash content, not line positions
      const contribution = calculateAgentContribution(attribution);

      // Most lines should still be attributed (content-based matching)
      // Some empty lines might not match exactly
      expect(contribution.agentPercentage).toBeGreaterThan(80);
    });
  });

  describe('agent changes reverted', () => {
    it('removes attribution when agent changes are reverted', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;
      const testFile = path.join(testRepoDir, 'config.ts');

      // Initial content
      const initialContent = 'export const DEBUG = false;';
      fs.writeFileSync(testFile, initialContent);

      // Commit initial state
      execSync('git add .', { cwd: testRepoDir, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: testRepoDir, stdio: 'pipe' });

      // Agent session changes DEBUG to true
      let index = createEmptyIndex();
      index = indexSession(index, 'session-1', repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, 'session-1', 'start', testRepoDir, ['config.ts']);

      fs.writeFileSync(testFile, 'export const DEBUG = true;');
      index = indexFileModification(index, 'session-1', repoId, 'config.ts');
      recordBoundary(repoId, 'session-1', 'end', testRepoDir, ['config.ts']);
      index = endSession(index, 'session-1', new Date().toISOString());
      saveIndex(index);

      const agentChanges = calculateAgentChanges(repoId, 'session-1');
      expect(agentChanges.get('config.ts')?.added.size).toBeGreaterThan(0);

      // Human reverts the change
      fs.writeFileSync(testFile, initialContent);

      // Check current state - human changes show the revert
      const humanChanges = calculateHumanChanges(repoId, testRepoDir, ['config.ts']);
      expect(humanChanges.size).toBeGreaterThan(0);

      // Build attribution on final state
      const finalSnapshot = createFileSnapshot('config.ts', fs.readFileSync(testFile, 'utf-8'));

      const history = [
        {
          source: 'agent' as const,
          sessionId: 'session-1',
          timestamp: new Date(Date.now() - 1000).toISOString(),
          addedHashes: agentChanges.get('config.ts')?.added || new Set(),
        },
        {
          source: 'human' as const,
          timestamp: new Date().toISOString(),
          addedHashes: humanChanges.get('config.ts')?.added || new Set(),
        },
      ];

      const attribution = buildAttribution(finalSnapshot, history);

      // The reverted content should be attributed to human (they restored it)
      // or unknown if the hash matches neither
      const contribution = calculateAgentContribution(attribution);
      expect(contribution.agentPercentage).toBe(0); // Agent's changes are gone
    });
  });

  describe('prompt-to-line association', () => {
    it('can trace a line back to the prompt that created it', async () => {
      const repoInfo = getOrCreateRepoId(testRepoDir)!;
      const { repoId } = repoInfo;
      const testFile = path.join(testRepoDir, 'feature.ts');

      // Simulate session with turn tracking
      let index = createEmptyIndex();
      const sessionId = 'session-1';
      const turnId = 'turn-abc123';

      index = indexSession(index, sessionId, repoId, testRepoDir, new Date().toISOString());
      recordBoundary(repoId, sessionId, 'start', testRepoDir, []);

      // Agent creates feature based on prompt
      // In real usage, the prompt would be stored in the session JSONL
      fs.writeFileSync(
        testFile,
        `// Feature: User authentication
export function login(username: string, password: string) {
  // TODO: implement
}`
      );

      index = indexFileModification(index, sessionId, repoId, 'feature.ts');
      recordBoundary(repoId, sessionId, 'end', testRepoDir, ['feature.ts']);
      index = endSession(index, sessionId, new Date().toISOString());
      saveIndex(index);

      const agentChanges = calculateAgentChanges(repoId, sessionId);

      // Build attribution with turn ID
      const snapshot = createFileSnapshot('feature.ts', fs.readFileSync(testFile, 'utf-8'));
      const history = [
        {
          source: 'agent' as const,
          sessionId,
          turnId, // This links to the specific prompt
          timestamp: new Date().toISOString(),
          addedHashes: agentChanges.get('feature.ts')?.added || new Set(),
        },
      ];

      const attribution = buildAttribution(snapshot, history);

      // Find a specific line
      const loginLine = attribution.find((a) =>
        snapshot.lines[a.lineNumber - 1]?.content.includes('login')
      );

      expect(loginLine).toBeDefined();
      expect(loginLine?.sessionId).toBe(sessionId);
      expect(loginLine?.turnId).toBe(turnId);

      // With turnId, we can look up the prompt in the session JSONL:
      // 1. Find session-1.jsonl in .assert/sessions/
      // 2. Find human_turn event with turnId === 'turn-abc123'
      // 3. That event contains the prompt that led to this line
    });
  });
});
