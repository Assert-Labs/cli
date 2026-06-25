/**
 * Pre-commit hook installation tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

describe('pre-commit hook', () => {
  let testDir: string;
  let gitRoot: string;

  beforeEach(() => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-hook-test-')));
    gitRoot = path.join(testDir, 'repo');
    fs.mkdirSync(gitRoot);
    execSync('git init', { cwd: gitRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function ensurePreCommitHook(root: string): void {
    const hooksDir = path.join(root, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-commit');
    const hookMarker = 'Assert: attach session data';

    const safeHookCommand = `
# Assert: attach session data to commits (never blocks)
if [ -x "$HOME/.assert/bin/assert" ]; then
  "$HOME/.assert/bin/assert" pre-commit 2>/dev/null || true
fi`;

    try {
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      if (fs.existsSync(hookPath) && fs.lstatSync(hookPath).isSymbolicLink()) {
        return;
      }

      if (fs.existsSync(hookPath)) {
        const content = fs.readFileSync(hookPath, 'utf-8');
        if (content.includes(hookMarker)) {
          return;
        }
        fs.appendFileSync(hookPath, safeHookCommand + '\n');
      } else {
        const hookContent = `#!/bin/sh${safeHookCommand}
`;
        fs.writeFileSync(hookPath, hookContent);
        fs.chmodSync(hookPath, 0o755);
      }
    } catch {
      // Silent failure
    }
  }

  it('creates pre-commit hook if none exists', () => {
    const hookPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');

    expect(fs.existsSync(hookPath)).toBe(false);

    ensurePreCommitHook(gitRoot);

    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('pre-commit');
    expect(content).toContain('.assert');
    expect(content).toContain('#!/bin/sh');
  });

  it('makes hook executable', () => {
    ensurePreCommitHook(gitRoot);

    const hookPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');
    const stats = fs.statSync(hookPath);

    // Check executable bit is set
    expect(stats.mode & 0o111).toBeGreaterThan(0);
  });

  it('appends to existing hook without overwriting', () => {
    const hooksDir = path.join(gitRoot, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-commit');

    // Create existing hook
    fs.mkdirSync(hooksDir, { recursive: true });
    const existingContent = `#!/bin/sh
# Existing hook
npm test
`;
    fs.writeFileSync(hookPath, existingContent);

    ensurePreCommitHook(gitRoot);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('npm test'); // Original preserved
    expect(content).toContain('pre-commit'); // Our hook added
    expect(content).toContain('.assert'); // Our hook added
  });

  it('is idempotent - does not duplicate hook', () => {
    ensurePreCommitHook(gitRoot);
    ensurePreCommitHook(gitRoot);
    ensurePreCommitHook(gitRoot);

    const hookPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hookPath, 'utf-8');

    // Should only have one occurrence of our hook marker
    const matches = content.match(/Assert: attach session data/g);
    expect(matches).toHaveLength(1);
  });

  it('works when hooks directory does not exist', () => {
    const hooksDir = path.join(gitRoot, '.git', 'hooks');

    // Remove hooks directory if it exists
    if (fs.existsSync(hooksDir)) {
      fs.rmSync(hooksDir, { recursive: true });
    }

    expect(fs.existsSync(hooksDir)).toBe(false);

    ensurePreCommitHook(gitRoot);

    expect(fs.existsSync(hooksDir)).toBe(true);
    const hookPath = path.join(hooksDir, 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it('does not modify symlinked hooks', () => {
    const hooksDir = path.join(gitRoot, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-commit');
    const targetPath = path.join(testDir, 'external-hook');

    // Create external hook file
    fs.writeFileSync(targetPath, '#!/bin/sh\necho "external hook"\n');

    // Create symlink to it
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.symlinkSync(targetPath, hookPath);

    ensurePreCommitHook(gitRoot);

    // Should still be a symlink
    expect(fs.lstatSync(hookPath).isSymbolicLink()).toBe(true);

    // Content should be unchanged
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).not.toContain('assert pre-commit');
    expect(content).toContain('external hook');
  });

  it('uses safe hook format with || true', () => {
    ensurePreCommitHook(gitRoot);

    const hookPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hookPath, 'utf-8');

    // Should have failure protection
    expect(content).toContain('|| true');
    expect(content).toContain('2>/dev/null');
    expect(content).toContain('-x "$HOME/.assert/bin/assert"');
  });
});
