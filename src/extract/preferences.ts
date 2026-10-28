import type { NormalizedBlock } from "../types";
import { clip, nonEmptyLines } from "../core/content";

// Tightened patterns: require a clear preference construction, not bare keywords.
const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
  /(?:以后|今后|始终|总是|一直|默认|每次|务必).{0,40}(?:使用|采用|保持|回答|输出|不要|避免|优先|只用|用)/u,
  /(?:不要|别再|请勿|禁止|避免|必须|优先使用|只使用|只用).{1,60}/u,
];

export const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
  const prefs: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (trimmed.length > 200) continue;
      // Reject questions.
      if (/[?？]$/.test(trimmed) || trimmed.includes("?...")) continue;
      if (!PREF_PATTERNS.some((p) => p.test(trimmed))) continue;

      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(clipped);

      // Cap per user block to avoid pasting long rule lists as many prefs.
      if (++perBlock >= 1) break;
    }
  }

  return prefs.slice(0, 10);
};

/**
 * Remove preferences that duplicate goals (case-insensitive, trimmed).
 * Called by `buildSections` so that the two sections do not overlap.
 */
export const dedupPreferencesAgainstGoals = (
  prefs: string[],
  goals: string[],
): string[] => {
  const norm = (s: string) => s.trim().toLowerCase();
  const goalSet = new Set(goals.map(norm));
  return prefs.filter((p) => !goalSet.has(norm(p)));
};
