/**
 * Line Attribution
 *
 * Line-level attribution: hash each line's normalized content and align two file
 * versions with an LCS diff (order-sensitive, like git blame).
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

/** LCS line diff between two snapshots: unchanged lines are the LCS; the rest are additions/removals. */
export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): LineDiff[] {
  const a = before.lines;
  const b = after.lines;
  const diffs: LineDiff[] = [];

  const unchanged = (bl: LineHash, al: LineHash): void => {
    diffs.push({
      type: 'unchanged',
      lineNumber: al.lineNumber,
      hash: al.hash,
      content: al.content,
      oldLineNumber: bl.lineNumber,
    });
  };
  const added = (al: LineHash): void => {
    diffs.push({ type: 'added', lineNumber: al.lineNumber, hash: al.hash, content: al.content });
  };
  const removed = (bl: LineHash): void => {
    diffs.push({ type: 'removed', lineNumber: bl.lineNumber, hash: bl.hash, content: bl.content });
  };

  // Trim common prefix/suffix so the LCS table stays small.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo].hash === b[lo].hash) {
    unchanged(a[lo], b[lo]);
    lo++;
  }
  let aHi = a.length;
  let bHi = b.length;
  const suffix: LineDiff[] = [];
  while (aHi > lo && bHi > lo && a[aHi - 1].hash === b[bHi - 1].hash) {
    aHi--;
    bHi--;
    suffix.push({
      type: 'unchanged',
      lineNumber: b[bHi].lineNumber,
      hash: b[bHi].hash,
      content: b[bHi].content,
      oldLineNumber: a[aHi].lineNumber,
    });
  }

  // LCS over the differing middle: a[lo..aHi) vs b[lo..bHi).
  const n = aHi - lo;
  const m = bHi - lo;
  if (n > 0 && m > 0) {
    // dp[i][j] = LCS length of a[lo+i..aHi) and b[lo+j..bHi).
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          a[lo + i].hash === b[lo + j].hash
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[lo + i].hash === b[lo + j].hash) {
        unchanged(a[lo + i], b[lo + j]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        removed(a[lo + i]);
        i++;
      } else {
        added(b[lo + j]);
        j++;
      }
    }
    while (i < n) removed(a[lo + i++]);
    while (j < m) added(b[lo + j++]);
  } else {
    // One side of the middle is empty: pure removals or pure additions.
    for (let i = lo; i < aHi; i++) removed(a[i]);
    for (let j = lo; j < bHi; j++) added(b[j]);
  }

  // The common suffix was collected back-to-front.
  for (let k = suffix.length - 1; k >= 0; k--) diffs.push(suffix[k]);

  // Sort by line number (additions/unchanged by new position, removals at end).
  return diffs.sort((x, y) => {
    if (x.type === 'removed' && y.type !== 'removed') return 1;
    if (x.type !== 'removed' && y.type === 'removed') return -1;
    return x.lineNumber - y.lineNumber;
  });
}

/** Who authored the inserted lines of an edit. */
export interface EditSource {
  source: 'agent' | 'human';
  sessionId?: string;
  timestamp: string;
}

/** An edit ending at `after`, tagged with its author. */
export interface AttributionStep extends EditSource {
  after: FileSnapshot;
}

/**
 * Carry per-line sources across one edit (`before` -> `after`, `beforeAttr`
 * aligned 1:1 with `before.lines`): retained lines keep their source, inserted
 * lines get `edit`. Alignment is the LCS diff, so blanks/dupes anchor correctly.
 */
export function carryAttribution(
  before: FileSnapshot,
  beforeAttr: AttributionRecord[],
  after: FileSnapshot,
  edit: EditSource,
): AttributionRecord[] {
  const byOldLine = new Map(beforeAttr.map((a) => [a.lineNumber, a]));
  const carriedFrom = new Map<number, number>();
  for (const d of diffSnapshots(before, after)) {
    if (d.type === 'unchanged' && d.oldLineNumber != null) {
      carriedFrom.set(d.lineNumber, d.oldLineNumber);
    }
  }
  return after.lines.map((line) => {
    const prev = byOldLine.get(carriedFrom.get(line.lineNumber) ?? -1);
    return prev
      ? { ...prev, lineNumber: line.lineNumber, hash: line.hash }
      : {
          lineNumber: line.lineNumber,
          hash: line.hash,
          source: edit.source,
          sessionId: edit.sessionId,
          timestamp: edit.timestamp,
        };
  });
}

/**
 * Thread per-line sources across an ordered sequence of edits, starting from
 * `initial` (all 'unknown'). Returns the attribution of the final snapshot.
 */
export function threadAttribution(
  initial: FileSnapshot,
  steps: AttributionStep[],
): AttributionRecord[] {
  let before = initial;
  let attr: AttributionRecord[] = initial.lines.map((l) => ({
    lineNumber: l.lineNumber,
    hash: l.hash,
    source: 'unknown',
    timestamp: '',
  }));
  for (const step of steps) {
    attr = carryAttribution(before, attr, step.after, step);
    before = step.after;
  }
  return attr;
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

  const total = agentLines + humanLines + unknownLines;
  const agentPercentage = total > 0 ? (agentLines / total) * 100 : 0;

  return { agentLines, humanLines, unknownLines, agentPercentage };
}
