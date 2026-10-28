/** Provider-aware kept-tail budget and model-scoped overflow calibration.
 * The Pi host owns actual token accounting; these values are conservative
 * estimates only, used to decide how much recent context survives compaction.
 */
export interface ModelBudget {
  id?: string; provider?: string; api?: string;
  contextWindow?: number; maxTokens?: number;
}
export interface BudgetResult {
  contextWindow: number;
  outputReserve: number;
  overhead: number;
  maxKeptTokens: number;
  learned: boolean;
}
export function planContextBudget(model: ModelBudget | undefined, fallback = 20000, learnedWindow?: number): BudgetResult {
  const advertised = model?.contextWindow ?? 0;
  const learned = Boolean(learnedWindow && learnedWindow >= 1024 && (!advertised || learnedWindow < advertised));
  const window = learned ? learnedWindow! : advertised;
  if (!Number.isFinite(window) || window <= 0) return { contextWindow: 0, outputReserve: 0, overhead: 0, maxKeptTokens: Math.max(1, fallback), learned: false };
  const rawOutput = Math.max(0, model?.maxTokens ?? 0);
  const separateOutput = model?.api === "anthropic-messages";
  // OpenAI-compatible APIs may count output against the total window.
  // Cap reserved capability at 25% so a huge maxTokens does not waste input.
  const outputReserve = separateOutput ? 0 : Math.min(rawOutput, Math.floor(window * 0.25));
  const overhead = Math.min(32768, Math.max(512, Math.floor(window * 0.12)));
  const safety = Math.min(2048, Math.max(256, Math.floor(window * 0.02)));
  // A budget of zero would disable buildOwnCut's oversized-turn guard.
  return { contextWindow: window, outputReserve, overhead, maxKeptTokens: Math.max(1, Math.floor(window - outputReserve - overhead - safety)), learned };
}

const OVERFLOW = /prompt is too long|maximum context length|maximum context size|context length exceeded|exceeds the context window|model_context_window_exceeded|exceeds the maximum allowed input length|input is too long for requested model/i;
export function overflowLimit(error: string): number | undefined {
  if (!OVERFLOW.test(error)) return undefined;
  const match = error.match(/>\s*([\d,]+)\s*(?:tokens?\s*)?maximum/i)
    ?? error.match(/maximum context (?:length|size) (?:is|of)\s*([\d,]+)/i)
    ?? error.match(/(?:maximum|limit) of\s*([\d,]+)\s*(?:input\s+)?tokens/i)
    ?? error.match(/context window of\s*([\d,]+)\s*tokens/i);
  if (!match) return undefined;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) && n >= 1024 && n <= 10_000_000 ? n : undefined;
}

export class ContextWindowLearner {
  private windows = new Map<string, number>();
  private key(session: string, model: ModelBudget): string {
    return session + "\u0000" + (model.provider ?? "") + "/" + (model.id ?? "unknown");
  }
  get(session: string, model: ModelBudget): number | undefined { return this.windows.get(this.key(session, model)); }
  observe(session: string, model: ModelBudget, error: string): number | undefined {
    const next = overflowLimit(error);
    if (!next || !session) return undefined;
    const key = this.key(session, model), old = this.windows.get(key);
    if (!old || next < old) this.windows.set(key, next);
    return this.windows.get(key);
  }
  forget(session: string): void {
    for (const key of this.windows.keys()) if (key.startsWith(session + "\u0000")) this.windows.delete(key);
  }
}
export const contextWindowLearner = new ContextWindowLearner();
