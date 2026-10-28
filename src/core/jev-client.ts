/** The single seam for optional Jev HTTP scoring.
 * Both decision ranking and recall use identical response validation.
 */
export interface JevScoreOptions {
  apiKey: string; endpoint?: string; timeoutMs?: number;
  maxCandidates?: number; fetchImpl?: typeof fetch;
}
export interface JevQuestion {
  name: "importance" | "relevance";
  state: Record<string, string>;
  instructions: string;
  criteria: [string, string, string, string];
}
export async function requestJevScore(
  question: JevQuestion, options: JevScoreOptions, defaultTimeoutMs: number,
): Promise<number | undefined> {
  if (!options.apiKey) return undefined;
  const endpoint = options.endpoint ?? "https://jevmodel.org/v1/systemone";
  if (!/^https:\/\//u.test(endpoint)) return undefined;
  try {
    const request = options.fetchImpl ?? fetch;
    const response = await request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Math.min(5000, Math.max(100, options.timeoutMs ?? defaultTimeoutMs))),
      body: JSON.stringify({
        model: "jev-latest",
        state: question.state,
        questions: { [question.name]: {
          type: "score", instructions: question.instructions, criteria: question.criteria,
        } },
      }),
    });
    if (!response.ok) return undefined;
    const answer = (await response.json() as any)?.answers?.[question.name];
    return typeof answer?.score === "number" && Number.isFinite(answer.score)
      && answer.score >= 0 && answer.score <= 3
      && typeof answer.confidence === "number" && answer.confidence >= 0.55
      ? answer.score : undefined;
  } catch {
    return undefined; // Invalid responses, timeouts and outages never block compaction.
  }
}
