import { redactMemoryForJev, type JevScoreOptions } from "./jev-scorer";

/** Optional reranking of the first few lexical recall candidates.
 * It never creates hits, hides the rest of history, or mutates raw messages.
 */
export async function rerankRecallHits<T extends { index: number; summary: string }>(
  hits: T[], query: string, options: JevScoreOptions,
): Promise<T[]> {
  if (!options.apiKey || hits.length < 2 || !query.trim()) return hits;
  const n = Math.min(hits.length, Math.max(0, Math.min(options.maxCandidates ?? 4, 5)));
  if (n < 2) return hits;
  const endpoint = options.endpoint ?? "https://jevmodel.org/v1/systemone";
  if (!/^https:\/\//u.test(endpoint)) return hits;
  const request = options.fetchImpl ?? fetch;
  const scored: Array<{ hit: T; score: number; order: number }> = [];
  for (let i = 0; i < n; i++) {
    try {
      const response = await request(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(Math.min(5000, Math.max(100, options.timeoutMs ?? 1600))),
        body: JSON.stringify({
          model: "jev-latest",
          state: { query: redactMemoryForJev(query).slice(0, 120), candidate: redactMemoryForJev(hits[i].summary).slice(0, 160) },
          questions: { relevance: {
            type: "score",
            instructions: "How strongly does the retrieved historical text answer the specific search query? Prefer direct evidence over keyword overlap.",
            criteria: ["unrelated", "weak match", "related evidence", "direct answer"],
          } },
        }),
      });
      if (!response.ok) return hits; // all-or-nothing local fallback
      const answer = (await response.json() as any)?.answers?.relevance;
      if (typeof answer?.score !== "number" || !Number.isFinite(answer.score) ||
          answer.score < 0 || answer.score > 3 ||
          typeof answer.confidence !== "number" || answer.confidence < 0.55) return hits;
      scored.push({ hit: hits[i], score: answer.score, order: i });
    } catch {
      return hits; // never delay/reorder results on failed external scoring
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return [...scored.map(x => x.hit), ...hits.slice(n)];
}
