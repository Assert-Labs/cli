/**
 * Content Hash for Attribution
 *
 * Creates content-based signatures that survive git rebases.
 * Instead of relying on commit SHAs (which change on rebase),
 * we hash the content itself to track attribution.
 */

import * as crypto from 'crypto';
import type { ContentSignature } from './schema';

/**
 * Normalize content for hashing
 * - Trims whitespace from each line
 * - Removes empty lines
 * - Collapses multiple spaces
 * This makes the hash stable across minor formatting changes
 */
export function normalizeContent(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Create a SHA-256 hash of content
 */
export function hashContent(content: string): string {
  const normalized = normalizeContent(content);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Create a short hash (first 12 characters)
 */
export function shortHash(content: string): string {
  return hashContent(content).substring(0, 12);
}

/**
 * Create a full content signature with preview
 */
export function createContentSignature(content: string): ContentSignature {
  const normalized = normalizeContent(content);
  const preview = normalized.substring(0, 50);

  return {
    hash: hashContent(content),
    preview: preview + (normalized.length > 50 ? '...' : ''),
    length: content.length,
  };
}

/**
 * Compare two content signatures for equality
 */
export function signaturesMatch(a: ContentSignature, b: ContentSignature): boolean {
  return a.hash === b.hash;
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses a simple character-based approach
 */
export function calculateSimilarity(a: string, b: string): number {
  const normalizedA = normalizeContent(a);
  const normalizedB = normalizeContent(b);

  // Both empty means no content to compare
  if (normalizedA.length === 0 && normalizedB.length === 0) return 0;
  // One empty means no overlap
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;
  // Identical non-empty content
  if (normalizedA === normalizedB) return 1;

  // Use Levenshtein-like approach but just count matching chars
  const longer = normalizedA.length > normalizedB.length ? normalizedA : normalizedB;
  const shorter = normalizedA.length > normalizedB.length ? normalizedB : normalizedA;

  // Simple containment check
  if (longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  // Character frequency comparison
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();

  for (const char of normalizedA) {
    freqA.set(char, (freqA.get(char) || 0) + 1);
  }
  for (const char of normalizedB) {
    freqB.set(char, (freqB.get(char) || 0) + 1);
  }

  let matches = 0;
  let total = 0;

  for (const [char, count] of freqA) {
    const countB = freqB.get(char) || 0;
    matches += Math.min(count, countB);
    total += count;
  }
  for (const [, count] of freqB) {
    total += count;
  }

  return total > 0 ? (matches * 2) / total : 0;
}

/**
 * Find content in a file that matches a signature
 * Returns line numbers where the content appears
 */
export function findContentInFile(
  fileContent: string,
  targetHash: string,
  windowSize: number = 10
): Array<{ startLine: number; endLine: number; similarity: number }> {
  const lines = fileContent.split('\n');
  const results: Array<{ startLine: number; endLine: number; similarity: number }> = [];

  // Sliding window approach
  for (let start = 0; start < lines.length; start++) {
    for (let end = start + 1; end <= Math.min(start + windowSize, lines.length); end++) {
      const windowContent = lines.slice(start, end).join('\n');
      const windowHash = hashContent(windowContent);

      if (windowHash === targetHash) {
        results.push({
          startLine: start + 1, // 1-indexed
          endLine: end, // 1-indexed, inclusive
          similarity: 1,
        });
      }
    }
  }

  return results;
}

/**
 * Create a fingerprint for a code block
 * Extracts key structural elements that are unlikely to change
 */
export function createCodeFingerprint(code: string): string {
  // Extract function/class names and signatures
  const patterns = [
    /function\s+(\w+)/g,
    /class\s+(\w+)/g,
    /const\s+(\w+)\s*=/g,
    /let\s+(\w+)\s*=/g,
    /def\s+(\w+)/g,
    /async\s+function\s+(\w+)/g,
  ];

  const identifiers: string[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      identifiers.push(match[1]);
    }
  }

  // Create fingerprint from identifiers
  const fingerprint = identifiers.sort().join('|');
  return hashContent(fingerprint);
}
