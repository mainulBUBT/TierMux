// In-memory advisory registry of files being mutated by in-flight agent runs, keyed by
// requestId. When two concurrent runs target the SAME file, the second sees a conflict and
// defers — a cheap guard against two agents clobbering each other's edit to the same file.
//
// Advisory only: it never blocks the first writer and holds no real OS file lock, so it
// cannot deadlock. A run that forgets to release simply leaves stale entries, which at worst
// makes another run unnecessarily defer once (the worst case is a false conflict, never a
// silent clobber). Calls with no requestId (non-session callers like inline chat) are no-ops.
const holders = new Map<string, Set<string>>(); // normalized path -> requestIds editing it

/** Normalize a workspace path so "src/a.ts", "./src/a.ts", "/src/a.ts" all collide. */
function norm(p: string): string {
  return (p || '').replace(/^\.?\//, '').replace(/\/+/g, '/').toLowerCase();
}

/** Claim a file (or files) for a run. Idempotent per requestId. */
export function markEditing(requestId: string | undefined, paths: string[]): void {
  if (!requestId) return;
  for (const raw of paths) {
    const p = norm(raw);
    if (!p) continue;
    let set = holders.get(p);
    if (!set) { set = new Set(); holders.set(p, set); }
    set.add(requestId);
  }
}

/** Release every file a run claimed. Call on run end (success, cancel, or error). */
export function unmarkEditing(requestId: string | undefined): void {
  if (!requestId) return;
  for (const [path, set] of holders) {
    set.delete(requestId);
    if (set.size === 0) holders.delete(path);
  }
}

/**
 * Return the paths in `paths` currently held by a DIFFERENT run — i.e. an active collision.
 * Empty (and the write may proceed) when the file is free or this is the only/same run.
 */
export function editConflicts(requestId: string | undefined, paths: string[]): string[] {
  if (!requestId) return [];
  const out: string[] = [];
  for (const raw of paths) {
    const p = norm(raw);
    const set = holders.get(p);
    if (set && [...set].some((id) => id !== requestId)) out.push(raw);
  }
  return out;
}
