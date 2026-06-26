/**
 * Build an agent-trace TraceRecord (https://agent-trace.dev) from Assert's
 * attribution events + the file state at a revision. Pure: no fs/git/clock — the
 * caller supplies file content, the revision, and the wrapper id/timestamp. This
 * lets the CLI, the monorepo, or CI reconstruct identical records on demand.
 */

import { hashLine } from './line-attribution';
import { type AttributionEvent } from './schema';

export interface TraceContributor {
  type: 'human' | 'ai' | 'mixed' | 'unknown';
  model_id?: string;
}
export interface TraceRange {
  start_line: number;
  end_line: number;
  content_hash?: string;
  contributor?: TraceContributor;
}
export interface TraceConversation {
  url?: string;
  contributor?: TraceContributor;
  ranges: TraceRange[];
  related?: Array<{ type: string; url: string }>;
}
export interface TraceFile {
  path: string;
  conversations: TraceConversation[];
}
export interface TraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs?: { type: string; revision: string };
  tool?: { name: string; version: string };
  files: TraceFile[];
  metadata?: Record<string, unknown>;
}

const SPEC_VERSION = '0.1.0';

export interface BuildTraceOptions {
  toolVersion: string;
  id: string;
  timestamp: string;
}

export function buildTrace(
  fragments: AttributionEvent[],
  readFileAtRevision: (path: string) => string | null,
  revision: string,
  opts: BuildTraceOptions,
): TraceRecord {
  // Per file: line content-hash -> model that produced it (first fragment wins).
  const byFile = new Map<string, Map<string, string | undefined>>();
  for (const fr of fragments) {
    if (fr.contributor?.type !== 'ai') continue;
    let m = byFile.get(fr.filePath);
    if (!m) {
      m = new Map();
      byFile.set(fr.filePath, m);
    }
    for (const h of fr.lineHashes) if (!m.has(h)) m.set(h, fr.contributor.modelId);
  }

  const files: TraceFile[] = [];
  for (const [filePath, hashes] of byFile) {
    const content = readFileAtRevision(filePath);
    if (content === null) continue;

    // Tag each line as ai (matched a captured hash) or unknown.
    const lines = content.split('\n').map((text, i) => {
      const h = hashLine(text);
      const ai = hashes.has(h);
      return { n: i + 1, text, type: ai ? ('ai' as const) : ('unknown' as const), model: ai ? hashes.get(h) : undefined };
    });

    // Coalesce consecutive lines with the same contributor into ranges.
    const conversations = new Map<string, TraceConversation>();
    for (let i = 0; i < lines.length; ) {
      const start = lines[i];
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].type === start.type && lines[j + 1].model === start.model) j++;
      const span = lines.slice(i, j + 1);
      const range: TraceRange = {
        start_line: span[0].n,
        end_line: span[span.length - 1].n,
        content_hash: hashLine(span.map((l) => l.text).join('\n')),
      };
      const key = `${start.type}:${start.model ?? ''}`;
      let conv = conversations.get(key);
      if (!conv) {
        conv = { contributor: { type: start.type, model_id: start.model }, ranges: [] };
        conversations.set(key, conv);
      }
      conv.ranges.push(range);
      i = j + 1;
    }

    files.push({ path: filePath, conversations: [...conversations.values()] });
  }

  return {
    version: SPEC_VERSION,
    id: opts.id,
    timestamp: opts.timestamp,
    vcs: { type: 'git', revision },
    tool: { name: 'assert', version: opts.toolVersion },
    files,
  };
}
