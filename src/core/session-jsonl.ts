import { openSync, readSync, closeSync, statSync } from "node:fs";

/** Shared per-session snapshot. Small sessions are cached; large sessions are
 * streamed 64 KiB at a time. Oversized individual JSONL lines become ordinal-
 * preserving metadata stubs for search. Explicit evidence retrieval re-reads
 * the full original line by ID and never returns the stub as an exact quote.
 */
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_CACHED_FILES = 2;
interface Snapshot { size: number; mtimeMs: number; ino: number; entries: any[] }
const cache = new Map<string, Snapshot>();

/** Each yield is a whole (possibly oversized) JSONL line. Only the current
 * line is buffered; a large paste or inline image cannot allocate the whole
 * session as a UTF-16 string.
 */
function* jsonlLines(file: string, maxLineBytes = MAX_LINE_BYTES): Generator<{ line: string; bytes: number; oversized: boolean; offset: number }> {
  const fd = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let pieces: Buffer[] = [];
  let currentBytes = 0;
  let chunkOffset = 0, lineOffset = 0;
  let head = Buffer.alloc(0), tail = Buffer.alloc(0);
  const append = (part: Buffer) => {
    if (!part.length) return;
    currentBytes += part.length;
    if (head.length < HEAD_BYTES) head = Buffer.concat([head, part.subarray(0, HEAD_BYTES - head.length)]);
    tail = Buffer.concat([tail, part]).subarray(Math.max(0, tail.length + part.length - TAIL_BYTES));
    if (currentBytes <= maxLineBytes) pieces.push(Buffer.from(part));
    else pieces = []; // never retain an oversized complete line
  };
  const emit = () => {
    const oversized = currentBytes > maxLineBytes;
    const line = oversized ? head.toString("utf8") + "\n" + tail.toString("utf8")
      : Buffer.concat(pieces).toString("utf8");
    const result = { line, bytes: currentBytes, oversized, offset: lineOffset };
    pieces = []; currentBytes = 0; head = Buffer.alloc(0); tail = Buffer.alloc(0);
    return result;
  };
  try {
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== 10) continue;
        append(chunk.subarray(start, i));
        yield emit();
        lineOffset = chunkOffset + i + 1;
        start = i + 1;
      }
      append(chunk.subarray(start, n));
      chunkOffset += n;
    }
    if (currentBytes) yield emit();
  } finally {
    closeSync(fd);
  }
}

function stubOversized(line: string, bytes: number, offset: number): any | undefined {
  const type = /"type"\s*:\s*"([^"\\]+)"/u.exec(line)?.[1];
  if (!type) return undefined;
  const beforeMessage = line.split(/"message"\s*:/u, 1)[0];
  const id = /"id"\s*:\s*"([^"\\]+)"/u.exec(beforeMessage)?.[1];
  const parentId = /"parentId"\s*:\s*"([^"\\]+)"/u.exec(beforeMessage)?.[1];
  const entry: any = { type, ...(id ? { id } : {}), ...(parentId ? { parentId } : {}), vccOmittedBytes: bytes, vccOmittedOffset: offset };
  if (type === "message") {
    const role = /"message"\s*:\s*\{\s*"role"\s*:\s*"([^"\\]+)"/u.exec(line)?.[1];
    if (!role) return undefined;
    const toolCallId = /"toolCallId"\s*:\s*"([^"\\]+)"/u.exec(line)?.[1];
    const toolName = /"toolName"\s*:\s*"([^"\\]+)"/u.exec(line)?.[1];
    entry.message = { role, content: [{ type: "text", text: "[oversized session message omitted from search; retrieve by evidenceId]" }], ...(toolCallId ? { toolCallId } : {}), ...(toolName ? { toolName } : {}) };
  }
  return entry;
}

export function readSessionEntries(file: string): any[] {
  const stat = statSync(file);
  const prior = cache.get(file);
  if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && prior.ino === stat.ino) {
    cache.delete(file); cache.set(file, prior);
    return prior.entries;
  }
  const entries: any[] = [];
  for (const { line, bytes, offset, oversized } of jsonlLines(file)) {
    if (!line.trim()) continue;
    if (oversized) {
      const stub = stubOversized(line, bytes, offset);
      if (stub) entries.push(stub);
      continue;
    }
    try { entries.push(JSON.parse(line)); } catch { /* tolerate incomplete JSONL tails */ }
  }
  cache.delete(file);
  if (stat.size <= MAX_FILE_BYTES) {
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, entries });
    while (cache.size > MAX_CACHED_FILES) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }
  return entries;
}

/** Explicit evidence lookup is allowed to decode one entire oversized line.
 * It is not called from ordinary search or compaction enumeration.
 */
/** Hydrate one oversized stub at its known byte offset. Only requested
 * evidence is decoded; unrelated giant records remain lightweight.
 */
export function hydrateSessionEntry(file: string, entry: any): any | undefined {
  if (typeof entry?.vccOmittedOffset !== "number" ||
      !Number.isSafeInteger(entry.vccOmittedOffset) || entry.vccOmittedOffset < 0 ||
      !Number.isSafeInteger(entry.vccOmittedBytes) || entry.vccOmittedBytes <= 0 ||
      typeof entry.id !== "string") return entry;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(entry.vccOmittedBytes);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, entry.vccOmittedOffset + read);
      if (!n) return undefined;
      read += n;
    }
    const original: any = JSON.parse(buffer.toString("utf8"));
    // Stale snapshot or rewritten file: never silently return wrong evidence.
    return original?.id === entry.id && original?.type === entry.type ? original : undefined;
  } catch { return undefined; }
  finally { closeSync(fd); }
}

/** Resolve a stable entry ID from one already-enumerated snapshot, then
 * hydrate only that entry. No repeated full-file rescans per message.
 */
export function readSessionEntryById(file: string, sourceId: string): any | undefined {
  if (!sourceId) return undefined;
  const entry = readSessionEntries(file).find(item => item.id === sourceId);
  if (!entry) return undefined;
  return entry.vccOmittedBytes ? hydrateSessionEntry(file, entry) : entry;
}

export function invalidateSessionEntries(file?: string): void {
  if (file) cache.delete(file); else cache.clear();
}
