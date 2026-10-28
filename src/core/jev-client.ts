/** Shared and strictly bounded Jev System One transport.
 * One state with multiple independent score questions. The entire batch
 * fails closed to deterministic ordering if any answer is missing or invalid.
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
export const MAX_JEV_BATCH = 5;
export const MAX_JEV_STATE_CHARS = 3200;
const validatedScore = (answer: unknown): number | undefined => {
  if (!answer || typeof answer !== "object") return undefined;
  const value = answer as Record<string, unknown>;
  return typeof value.score === "number" && Number.isFinite(value.score)
    && value.score >= 0 && value.score <= 3
    && typeof value.confidence === "number" && Number.isFinite(value.confidence)
    && value.confidence >= 0.55 && value.confidence <= 1
    ? value.score : undefined;
};

/** Batch form: candidate_1..candidate_N, questions importance_1..importance_N.
 * Keeping question IDs separate is required by System One's answer contract.
 * Neither an HTTP error nor a partial response may silently bias the ranking.
 */
export async function requestJevScores(
  question: JevQuestion, candidates: string[], options: JevScoreOptions, defaultTimeoutMs: number,
): Promise<number[] | undefined> {
  if (!options.apiKey || candidates.length < 1 || candidates.length > MAX_JEV_BATCH) return undefined;
  const endpoint = options.endpoint ?? "https://jevmodel.org/v1/systemone";
  if (!/^https:\/\//u.test(endpoint)) return undefined;
  const state: Record<string, string> = { ...question.state };
  const questions: Record<string, { type: "score"; instructions: string; criteria: [string,string,string,string] }> = {};
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates.length === 1 ? question.name : `${question.name}_${i + 1}`;
    const field = candidates.length === 1 ? "candidate" : `candidate_${i + 1}`;
    state[field] = candidates[i];
    questions[key] = { type: "score", instructions: candidates.length === 1 ? question.instructions
      : `${question.instructions} Evaluate \`${field}\` only.`, criteria: question.criteria };
  }
  const payload = JSON.stringify({ model: "jev-latest", state, questions });
  if (payload.length > MAX_JEV_STATE_CHARS + 1800) return undefined;
  try {
    const request = options.fetchImpl ?? fetch;
    const response = await request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Math.min(5000, Math.max(100, options.timeoutMs ?? defaultTimeoutMs))),
      body: payload,
    });
    if (!response.ok) return undefined;
    const result: unknown = await response.json();
    if (!result || typeof result !== "object") return undefined;
    const answers = (result as Record<string, unknown>).answers;
    if (!answers || typeof answers !== "object") return undefined;
    const values: number[] = [];
    for (const id of Object.keys(questions)) {
      const score = validatedScore((answers as Record<string, unknown>)[id]);
      if (score === undefined) return undefined;
      values.push(score);
    }
    return values;
  } catch {
    return undefined;
  }
}
/** Legacy single-item helper kept for callers outside the built-in rankers. */
export async function requestJevScore(
  question: JevQuestion, options: JevScoreOptions, defaultTimeoutMs: number,
): Promise<number | undefined> {
  const candidate = question.state.candidate;
  if (typeof candidate !== "string") return undefined;
  const { candidate: _ignored, ...rest } = question.state;
  return (await requestJevScores({ ...question, state: rest }, [candidate], options, defaultTimeoutMs))?.[0];
}
