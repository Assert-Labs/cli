/**
 * Line Attribution
 *
 * Provides line-level hashing for tracking which agent/human last modified each line.
 * Similar to git blame, but for agent attribution.
 *
 * Key concept: we hash each line's content so attribution survives rebases.
 * A line's identity is its content, not its position.
 */

import * as crypto from 'crypto';

export interface LineHash {
  lineNumber: number; // 1-indexed
  hash: string; // Hash of normalized line content
  content: string; // Original content (for debugging)
}

export interface FileSnapshot {
  filePath: string;
  lines: LineHash[];
  contentHash: string; // Hash of full file for quick comparison
}

export interface LineDiff {
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  lineNumber: number;
  hash: string;
  content: string;
  oldLineNumber?: number; // For modified/removed lines
}

export interface AttributionRecord {
  lineNumber: number;
  hash: string;
  source: 'agent' | 'human' | 'unknown';
  sessionId?: string;
  turnId?: string;
  timestamp: string;
}

/**
 * Normalize a single line for hashing
 * Preserves meaningful content while ignoring trivial whitespace differences
 */
export function normalizeLine(line: string): string {
  return line.trim();
}

/**
 * Hash a single line's content
 */
export function hashLine(line: string): string {
  const normalized = normalizeLine(line);
  return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex').substring(0, 16);
}

/**
 * Create a snapshot of a file's lines
 */
export function createFileSnapshot(filePath: string, content: string): FileSnapshot {
  const rawLines = content.split('\n');
  const lines: LineHash[] = rawLines.map((line, index) => ({
    lineNumber: index + 1,
    hash: hashLine(line),
    content: line,
  }));

  const fullHash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');

  return {
    filePath,
    lines,
    contentHash: fullHash,
  };
}

/**
 * Compare two file snapshots to find what changed
 * Uses content-based matching (like git's patience diff)
 */
export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): LineDiff[] {
  const diffs: LineDiff[] = [];

  // Build hash → line mappings
  const beforeByHash = new Map<string, LineHash[]>();
  for (const line of before.lines) {
    const existing = beforeByHash.get(line.hash) || [];
    existing.push(line);
    beforeByHash.set(line.hash, existing);
  }

  const afterByHash = new Map<string, LineHash[]>();
  for (const line of after.lines) {
    const existing = afterByHash.get(line.hash) || [];
    existing.push(line);
    afterByHash.set(line.hash, existing);
  }

  // Track which lines from 'before' have been matched
  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();

  // First pass: find unchanged lines (exact hash match, same or nearby position)
  for (const afterLine of after.lines) {
    const beforeLines = beforeByHash.get(afterLine.hash);
    if (beforeLines) {
      // Find the closest match by line number
      let bestMatch: LineHash | null = null;
      let bestDist = Infinity;

      for (const beforeLine of beforeLines) {
        if (!matchedBefore.has(beforeLine.lineNumber)) {
          const dist = Math.abs(beforeLine.lineNumber - afterLine.lineNumber);
          if (dist < bestDist) {
            bestDist = dist;
            bestMatch = beforeLine;
          }
        }
      }

      if (bestMatch) {
        matchedBefore.add(bestMatch.lineNumber);
        matchedAfter.add(afterLine.lineNumber);
        diffs.push({
          type: 'unchanged',
          lineNumber: afterLine.lineNumber,
          hash: afterLine.hash,
          content: afterLine.content,
          oldLineNumber: bestMatch.lineNumber,
        });
      }
    }
  }

  // Second pass: remaining 'after' lines are additions
  for (const afterLine of after.lines) {
    if (!matchedAfter.has(afterLine.lineNumber)) {
      diffs.push({
        type: 'added',
        lineNumber: afterLine.lineNumber,
        hash: afterLine.hash,
        content: afterLine.content,
      });
    }
  }

  // Third pass: remaining 'before' lines are removals
  for (const beforeLine of before.lines) {
    if (!matchedBefore.has(beforeLine.lineNumber)) {
      diffs.push({
        type: 'removed',
        lineNumber: beforeLine.lineNumber,
        hash: beforeLine.hash,
        content: beforeLine.content,
      });
    }
  }

  // Sort by line number (additions/unchanged by new position, removals at end)
  return diffs.sort((a, b) => {
    if (a.type === 'removed' && b.type !== 'removed') return 1;
    if (a.type !== 'removed' && b.type === 'removed') return -1;
    return a.lineNumber - b.lineNumber;
  });
}

/**
 * Build attribution for a file by applying a series of diffs
 * Each diff is tagged with its source (agent session or human)
 */
export function buildAttribution(
  currentSnapshot: FileSnapshot,
  history: Array<{
    source: 'agent' | 'human';
    sessionId?: string;
    turnId?: string;
    timestamp: string;
    addedHashes: Set<string>;
  }>
): AttributionRecord[] {
  const attribution: AttributionRecord[] = [];

  for (const line of currentSnapshot.lines) {
    // Find the most recent history entry that introduced this line hash
    let foundSource: AttributionRecord | null = null;

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.addedHashes.has(line.hash)) {
        foundSource = {
          lineNumber: line.lineNumber,
          hash: line.hash,
          source: entry.source,
          sessionId: entry.sessionId,
          turnId: entry.turnId,
          timestamp: entry.timestamp,
        };
        break;
      }
    }

    attribution.push(
      foundSource || {
        lineNumber: line.lineNumber,
        hash: line.hash,
        source: 'unknown',
        timestamp: new Date().toISOString(),
      }
    );
  }

  return attribution;
}

/**
 * Calculate what percentage of a file's lines are attributed to agents
 */
export function calculateAgentContribution(attribution: AttributionRecord[]): {
  agentLines: number;
  humanLines: number;
  unknownLines: number;
  agentPercentage: number;
} {
  let agentLines = 0;
  let humanLines = 0;
  let unknownLines = 0;

  for (const record of attribution) {
    switch (record.source) {
      case 'agent':
        agentLines++;
        break;
      case 'human':
        humanLines++;
        break;
      default:
        unknownLines++;
    }
  }

  const total = attribution.length;
  const agentPercentage = total > 0 ? (agentLines / total) * 100 : 0;

  return { agentLines, humanLines, unknownLines, agentPercentage };
}

/**
 * Find which lines in a file match a specific session's contributions
 */
export function findSessionLines(
  attribution: AttributionRecord[],
  sessionId: string
): number[] {
  return attribution
    .filter((r) => r.sessionId === sessionId)
    .map((r) => r.lineNumber);
}
