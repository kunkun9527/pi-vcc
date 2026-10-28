import type { MemoryFact } from "./long-memory";

/** Optional hosted Jev adapter. Never invoked unless the user sets both
 * PI_VCC_JEV_ENABLED=1 and JEVMODEL_API_KEY. It only advises decision ordering.
 * No API response can erase protected constraints or unresolved blockers.
 */
import { requestJevScores, type JevScoreOptions } from "./jev-client";
export type { JevScoreOptions } from "./jev-client";

import { loadSettings } from "./settings";

export const jevEnabled = (): boolean => {
  if (!process.env.JEVMODEL_API_KEY) return false;
  // Environment variable has precedence to preserve existing deployments.
  if (process.env.PI_VCC_JEV_ENABLED === "1") return true;
  if (process.env.PI_VCC_JEV_ENABLED === "0") return false;
  return loadSettings().jevEnabled === true;
};

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
  if (!items.length) return scores;
  const values = await requestJevScores({
    name: "importance",
    state: { type: "historical project decision" },
    instructions: "How important is preserving this decision for the ongoing software project over many future compactions? Score consequences, not verbosity.",
    criteria: ["incidental", "minor", "relevant", "critical"],
  }, items.map(fact => redactMemoryForJev(fact.text)), options, 1800);
  if (!values) return scores;
  items.forEach((fact, i) => { scores[fact.id] = values[i]; });
  return scores;
}
