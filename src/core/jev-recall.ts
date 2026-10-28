import { redactMemoryForJev, type JevScoreOptions } from "./jev-scorer";
import { requestJevScores } from "./jev-client";
import { recordJevEvaluation } from "./jev-ledger";

/** Optional reranking of the first few lexical recall candidates.
 * It never creates hits, hides the rest of history, or mutates raw messages.
 */
export async function rerankRecallHits<T extends { index: number; summary: string }>(
  hits: T[], query: string, options: JevScoreOptions,
): Promise<T[]> {
  if (!options.apiKey || hits.length < 2 || !query.trim()) return hits;
  const n = Math.min(hits.length, Math.max(0, Math.min(options.maxCandidates ?? 4, 5)));
  if (n < 2) return hits;
  if (options.mode === "off") return hits;
  const started = Date.now();
  const values = await requestJevScores({
    name: "relevance",
    state: { query: redactMemoryForJev(query).slice(0, 120) },
    instructions: "How strongly does this candidate answer the query? Prefer direct evidence over keyword overlap.",
    criteria: ["unrelated", "weak match", "related evidence", "direct answer"],
  }, hits.slice(0, n).map(hit => redactMemoryForJev(hit.summary).slice(0, 160)), options, 1600);
  const scored = values
    ? hits.slice(0, n).map((hit, order) => ({ hit, score: values[order], order }))
    : [];
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const changed = scored.some((item, i) => item.order !== i);
  if (options.log) recordJevEvaluation({
    operation: "recall", mode: options.mode === "shadow" ? "shadow" : "active",
    source: values ? "judge" : "fallback", count: n, changed,
    applied: Boolean(values) && options.mode !== "shadow" && changed,
    latencyMs: Date.now() - started,
  });
  if (!values || options.mode === "shadow") return hits;
  return [...scored.map(x => x.hit), ...hits.slice(n)];
}
