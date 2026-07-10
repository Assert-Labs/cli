/** Test helpers for reading the repo-local session dir layout (`.sessions/<dir>/`). */
import * as fs from 'fs';
import * as path from 'path';

/** Repo-local session dir for `id` under `<repoRoot>/.sessions/`, or null. */
export function repoSessionDir(repoRoot: string, id: string): string | null {
  const base = path.join(repoRoot, '.sessions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, e.name, 'meta.json'), 'utf-8'));
      if (meta.sessionId === id) return path.join(base, e.name);
    } catch {
      /* not a session dir */
    }
  }
  return null;
}

export function repoHasSession(repoRoot: string, id: string): boolean {
  return repoSessionDir(repoRoot, id) !== null;
}

/** All events for `id` from the repo-local session dir, in turn order.
 * Returns `any[]` (like a raw JSONL read) so tests can access event fields freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readRepoEvents(repoRoot: string, id: string): any[] {
  const dir = repoSessionDir(repoRoot, id);
  if (!dir) throw new Error(`no session dir for ${id} in ${repoRoot}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8').split('\n'))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
