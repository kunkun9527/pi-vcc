import { readFileSync, statSync } from "node:fs";

/** Read-once JSONL snapshot shared by history search, expansion and compaction
 * range resolution. Only unchanged small/medium sessions are cached;
 * large sessions are parsed afresh to cap process memory use.
 */
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_CACHED_FILES = 2;
interface Snapshot { size: number; mtimeMs: number; ino: number; entries: any[] }
const cache = new Map<string, Snapshot>();

export function readSessionEntries(file: string): any[] {
  const stat = statSync(file);
  const prior = cache.get(file);
  if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && prior.ino === stat.ino) {
    cache.delete(file); cache.set(file, prior);
    return prior.entries;
  }
  const entries: any[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* tolerate truncated tails */ }
  }
  cache.delete(file);
  if (stat.size <= MAX_FILE_BYTES) {
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, entries });
    while (cache.size > MAX_CACHED_FILES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return entries;
}

/** Explicitly invalidate a session after an external rewrite if needed. */
export function invalidateSessionEntries(file?: string): void {
  if (file) cache.delete(file); else cache.clear();
}
