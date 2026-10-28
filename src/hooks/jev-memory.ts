import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { normalize } from "../core/normalize";
import { collectMemory } from "../core/long-memory";
import { jevMode, scoreMemoryDecisions } from "../core/jev-scorer";

/** Each registered extension instance gets an isolated Jev score cache. */
export function registerJevMemoryRanker(pi: ExtensionAPI): () => Record<string, number> {
  let sessionFile: string | undefined;
  let cached: Record<string, number> = {};
  const tried = new Set<string>();
  let generation = 0;
  let lastMode = jevMode();
  const syncMode = () => {
    const next = jevMode();
    if (next !== lastMode) {
      lastMode = next;
      cached = {};
      tried.clear();
      generation++;
    }
    return next;
  };
  // Config changes take effect at compaction time even without agent_end.
  const getScores = () => syncMode() === "active" ? { ...cached } : {};
  pi.on("session_start", () => {
    sessionFile = undefined;
    cached = {};
    tried.clear();
    generation++;
    lastMode = jevMode();
  });
  pi.on("agent_end", async (_event, ctx) => {
    const mode = syncMode();
    if (mode === "off") return;
    try {
      const current = ctx.sessionManager.getSessionFile() ?? undefined;
      if (current !== sessionFile) {
        sessionFile = current;
        cached = {};
        tried.clear();
        generation++;
      }
      const entries = ctx.sessionManager.getBranch() as any[];
      const messages = entries.filter(e => e.type === "message" && e.message)
        .slice(-40).map(e => e.message as Message);
      const facts = collectMemory(normalize(messages))
        .filter(f => f.kind === "decision" && !tried.has(f.id));
      // At most four calls per completed turn; never send full transcript.
      const batch = facts.slice(-4);
      for (const fact of batch) tried.add(fact.id);
      if (!batch.length) return;
      const started = generation;
      const scores = await scoreMemoryDecisions(batch, {
        apiKey: process.env.JEVMODEL_API_KEY ?? "",
        maxCandidates: 4,
        mode, log: true,
      });
      // In-flight scoring may outlive a TUI switch or credential change.
      if (started === generation && syncMode() === "active" && mode === "active") {
        Object.assign(cached, scores);
      }
    } catch {
      // Deterministic pi-vcc remains usable on all adapter errors.
    }
  });
  return getScores;
}
