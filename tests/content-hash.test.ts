import { describe, it, expect } from 'vitest';
import {
  normalizeContent,
  hashContent,
  shortHash,
  createContentSignature,
  signaturesMatch,
  calculateSimilarity,
  findContentInFile,
  createCodeFingerprint,
} from '../src/content-hash';

describe('content-hash', () => {
  describe('normalizeContent', () => {
    it('trims whitespace from lines', () => {
      const input = '  hello  \n  world  ';
      const normalized = normalizeContent(input);
      expect(normalized).toBe('hello world');
    });

    it('removes empty lines', () => {
      const input = 'hello\n\n\nworld';
      const normalized = normalizeContent(input);
      expect(normalized).toBe('hello world');
    });

    it('collapses multiple spaces', () => {
      const input = 'hello    world';
      const normalized = normalizeContent(input);
      expect(normalized).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(normalizeContent('')).toBe('');
    });
  });

  describe('hashContent', () => {
    it('produces consistent hashes', () => {
      const content = 'function hello() { return "world"; }';
      const hash1 = hashContent(content);
      const hash2 = hashContent(content);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different content', () => {
      const hash1 = hashContent('hello');
      const hash2 = hashContent('world');
      expect(hash1).not.toBe(hash2);
    });

    it('ignores whitespace differences', () => {
      const hash1 = hashContent('hello world');
      const hash2 = hashContent('  hello   world  ');
      expect(hash1).toBe(hash2);
    });

    it('produces 64-character hex hash', () => {
      const hash = hashContent('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('shortHash', () => {
    it('produces 12-character hash', () => {
      const hash = shortHash('test content');
      expect(hash).toHaveLength(12);
      expect(hash).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe('createContentSignature', () => {
    it('creates signature with hash, preview, and length', () => {
      const content = 'This is a test function that does something useful.';
      const sig = createContentSignature(content);

      expect(sig.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(sig.preview).toContain('This is a test');
      expect(sig.length).toBe(content.length);
    });

    it('truncates preview for long content', () => {
      const content = 'x'.repeat(100);
      const sig = createContentSignature(content);

      expect(sig.preview.length).toBeLessThanOrEqual(53); // 50 + '...'
      expect(sig.preview).toContain('...');
    });
  });

  describe('signaturesMatch', () => {
    it('returns true for matching hashes', () => {
      const sig1 = createContentSignature('test');
      const sig2 = createContentSignature('test');
      expect(signaturesMatch(sig1, sig2)).toBe(true);
    });

    it('returns false for different hashes', () => {
      const sig1 = createContentSignature('test1');
      const sig2 = createContentSignature('test2');
      expect(signaturesMatch(sig1, sig2)).toBe(false);
    });
  });

  describe('calculateSimilarity', () => {
    it('returns 1 for identical content', () => {
      const similarity = calculateSimilarity('hello world', 'hello world');
      expect(similarity).toBe(1);
    });

    it('returns 1 for identical content with different whitespace', () => {
      const similarity = calculateSimilarity('hello world', '  hello   world  ');
      expect(similarity).toBe(1);
    });

    it('returns 0 for empty strings', () => {
      expect(calculateSimilarity('', '')).toBe(0);
      expect(calculateSimilarity('hello', '')).toBe(0);
    });

    it('returns high similarity for similar content', () => {
      const similarity = calculateSimilarity(
        'function hello() { return 1; }',
        'function hello() { return 2; }'
      );
      expect(similarity).toBeGreaterThan(0.8);
    });

    it('returns low similarity for different content', () => {
      const similarity = calculateSimilarity('abc', 'xyz');
      expect(similarity).toBeLessThan(0.5);
    });
  });

  describe('findContentInFile', () => {
    it('finds exact content match', () => {
      const fileContent = `line 1
line 2
target content here
line 4
line 5`;

      const targetHash = hashContent('target content here');
      const results = findContentInFile(fileContent, targetHash);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].startLine).toBe(3);
      expect(results[0].endLine).toBe(3);
      expect(results[0].similarity).toBe(1);
    });

    it('finds multi-line content match', () => {
      const fileContent = `line 1
target line 1
target line 2
line 4`;

      const targetHash = hashContent('target line 1\ntarget line 2');
      const results = findContentInFile(fileContent, targetHash);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].startLine).toBe(2);
      expect(results[0].endLine).toBe(3);
    });

    it('returns empty array when no match', () => {
      const fileContent = 'line 1\nline 2\nline 3';
      const targetHash = hashContent('not in file');
      const results = findContentInFile(fileContent, targetHash);

      expect(results).toEqual([]);
    });
  });

  describe('createCodeFingerprint', () => {
    it('extracts function names', () => {
      const code = `
function hello() {}
function world() {}
`;
      const fingerprint1 = createCodeFingerprint(code);
      const fingerprint2 = createCodeFingerprint('function hello() {}\nfunction world() {}');

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('extracts class names', () => {
      const code = 'class MyClass { constructor() {} }';
      const fingerprint = createCodeFingerprint(code);
      expect(fingerprint).toBeTruthy();
    });

    it('extracts const declarations', () => {
      const code = 'const myVar = 42;';
      const fingerprint = createCodeFingerprint(code);
      expect(fingerprint).toBeTruthy();
    });

    it('produces different fingerprints for different code structures', () => {
      const code1 = 'function foo() {}';
      const code2 = 'function bar() {}';

      const fp1 = createCodeFingerprint(code1);
      const fp2 = createCodeFingerprint(code2);

      expect(fp1).not.toBe(fp2);
    });
  });
});
