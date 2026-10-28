import { parseMemory, type MemoryFact } from "./long-memory";

/** Audit protected memory IDs after a compaction. Does not trust model claims.
 * "Protected" means the four oldest constraints/blockers in each category;
 * additional records are subject to the documented bounded memory policy.
 */
export function auditMemoryCompaction(
  before: string, after: string, retired = new Set<string>(), activeSourceIds?: Set<string>,
): { missingProtected: string[]; missingEvidence: string[]; suspiciousUnicodeEscapes: boolean } {
  const previous = parseMemory(before);
  const current = new Map(parseMemory(after).map(f => [f.id, f]));
  const missingProtected: string[] = [];
  const missingEvidence: string[] = [];
  for (const kind of ["constraint", "blocker"] as const) {
    const eligible = previous.filter(f => f.kind === kind && !retired.has(f.id)
      && (!activeSourceIds || !f.sourceId || activeSourceIds.has(f.sourceId)));
    for (const fact of eligible.slice(0, 4)) {
      const now = current.get(fact.id);
      if (!now) missingProtected.push(fact.id);
      else if (fact.sourceId && now.sourceId !== fact.sourceId) missingEvidence.push(fact.id);
    }
  }
  // 20+ literal Unicode escapes generally indicate a double-escaped CJK
  // serialization defect. Report rather than mutate legitimate source code.
  const suspiciousUnicodeEscapes = (after.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length > 20;
  return { missingProtected, missingEvidence, suspiciousUnicodeEscapes };
}

/** Optional read-side verification without forcing ungrounded user quotes.
 * Only claims with an exact original session entry ID can be considered sourced.
 */
export function verifiedFact(fact: MemoryFact, availableEntryIds: Set<string>): boolean {
  return Boolean(fact.sourceId && availableEntryIds.has(fact.sourceId));
}
