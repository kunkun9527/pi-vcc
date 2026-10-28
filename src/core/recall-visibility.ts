import type { Message } from "@earendil-works/pi-ai";
import { searchEntries, type SearchHit } from "./search-entries";
import type { RenderedEntry } from "./render-entries";

interface BranchItem {
  id?: string;
  type?: string;
  message?: unknown;
  firstKeptEntryId?: string | null;
}

/** Return IDs that were actually outside the latest compacted live tail.
 * Undefined means the host did not supply a reliable compaction boundary,
 * so callers must preserve the old full-lineage search semantics.
 */
export function archivedMessageIds(branch: readonly BranchItem[]): Set<string> | undefined {
  let latestCompaction = -1;
  for (let i = 0; i < branch.length; i++) {
    if (branch[i].type === "compaction") latestCompaction = i;
  }
  if (latestCompaction < 0) return undefined;
  const marker = branch[latestCompaction];
  let boundary = latestCompaction;
  if (typeof marker.firstKeptEntryId === "string" && marker.firstKeptEntryId.length) {
    const firstKept = branch.findIndex(e => e.id === marker.firstKeptEntryId);
    if (firstKept < 0 || firstKept > latestCompaction) return undefined;
    boundary = firstKept;
  }
  return new Set(branch.slice(0, boundary).filter(e =>
    e.type === "message" && e.message && typeof e.id === "string",
  ).map(e => e.id as string));
}

/** Archived-first lexical retrieval avoids re-surfacing text already visible
 * to the model. A missing archived match falls back to the entire allowed
 * lineage so old query behavior remains available for live-only answers.
 * Explicit evidence IDs, expansions and scope:'all' bypass this helper.
 */
export function searchArchivedFirst(
  rendered: RenderedEntry[], raw: Message[], entryIds: string[],
  query: string, archived: ReadonlySet<string> | undefined,
): SearchHit[] {
  if (!archived || archived.size === 0) return searchEntries(rendered, raw, query);
  const historicRendered: RenderedEntry[] = [];
  const historicRaw: Message[] = [];
  for (let i = 0; i < rendered.length; i++) {
    if (!archived.has(entryIds[i])) continue;
    historicRendered.push(rendered[i]);
    historicRaw.push(raw[i]);
  }
  if (!historicRendered.length) return searchEntries(rendered, raw, query);
  const matches = searchEntries(historicRendered, historicRaw, query);
  return matches.length ? matches : searchEntries(rendered, raw, query);
}

/** Best-effort boundary detection; never expands scope on failure. */
export function archivedIdsFromManager(manager: {getBranch?: () => BranchItem[]}): Set<string> | undefined {
  try { return archivedMessageIds(manager.getBranch?.() ?? []); }
  catch { return undefined; }
}
