import type { MemoryFact } from "./long-memory";

/** Optional hosted Jev adapter. Never invoked unless the user sets both
 * PI_VCC_JEV_ENABLED=1 and JEVMODEL_API_KEY. It only advises decision ordering.
 * No API response can erase protected constraints or unresolved blockers.
 */
export interface JevScoreOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  maxCandidates?: number;
  fetchImpl?: typeof fetch;
}

export const jevEnabled = (): boolean =>
  process.env.PI_VCC_JEV_ENABLED === "1" && Boolean(process.env.JEVMODEL_API_KEY);

export function redactMemoryForJev(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/giu, "[credential]")
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/giu, "[credential]")
    .replace(/https?:\/\/[^\s]+/giu, "[url]")
    .replace(/(?:^|\s)(?:\/home\/|\/Users\/|[A-Za-z]:\\)[^\s]+/gu, " [path]")
    .slice(0, 160);
}

export async function scoreMemoryDecisions(
  facts: MemoryFact[], options: JevScoreOptions,
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  if (!options.apiKey) return scores;
  const items = facts.filter(f => f.kind === "decision")
    .slice(-Math.max(0, Math.min(4, options.maxCandidates ?? 4)));
  const endpoint = options.endpoint ?? "https://jevmodel.org/v1/systemone";
  // Never allow arbitrary remote endpoints from untrusted summary content.
  if (!/^https:\/\//u.test(endpoint)) return scores;
  const request = options.fetchImpl ?? fetch;
  for (const fact of items) {
    try {
      const response = await request(endpoint, {
        method: "POST",
        headers: { "Authorization": `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(Math.min(5000, Math.max(100, options.timeoutMs ?? 1800))),
        body: JSON.stringify({
          model: "jev-latest",
          state: { candidate: redactMemoryForJev(fact.text), type: "historical project decision" },
          questions: { importance: {
            type: "score",
            instructions: "How important is preserving this decision for the ongoing software project over many future compactions? Score consequences, not verbosity.",
            criteria: ["incidental", "minor", "relevant", "critical"],
          } },
        }),
      });
      if (!response.ok) break; // fallback; never retry inside an active session
      const answer = (await response.json() as any)?.answers?.importance;
      if (typeof answer?.score === "number" && Number.isFinite(answer.score)
          && answer.score >= 0 && answer.score <= 3
          && typeof answer.confidence === "number" && answer.confidence >= 0.55) {
        scores[fact.id] = answer.score;
      }
    } catch {
      break; // timeouts, network errors and malformed responses are nonfatal
    }
  }
  return scores;
}
