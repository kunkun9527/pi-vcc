import { redactMemoryForJev, type JevScoreOptions } from "./jev-scorer";
import { requestJevScore } from "./jev-client";

/** Optional reranking of the first few lexical recall candidates.
 * It never creates hits, hides the rest of history, or mutates raw messages.
 */
export async function rerankRecallHits<T extends { index: number; summary: string }>(
  hits: T[], query: string, options: JevScoreOptions,
): Promise<T[]> {
  if (!options.apiKey || hits.length < 2 || !query.trim()) return hits;
  const n = Math.min(hits.length, Math.max(0, Math.min(options.maxCandidates ?? 4, 5)));
  if (n < 2) return hits;
  const scored: Array<{ hit: T; score: number; order: number }> = [];
  for (let i = 0; i < n; i++) {
    const score = await requestJevScore({
      name: "relevance",
      state: { query: redactMemoryForJev(query).slice(0, 120), candidate: redactMemoryForJev(hits[i].summary).slice(0, 160) },
      instructions: "How strongly does the retrieved historical text answer the specific search query? Prefer direct evidence over keyword overlap.",
      criteria: ["unrelated", "weak match", "related evidence", "direct answer"],
    }, options, 1600);
    if (score === undefined) return hits;
    scored.push({ hit: hits[i], score, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return [...scored.map(x => x.hit), ...hits.slice(n)];
}
