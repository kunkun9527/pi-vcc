/**
 * Shared stop words and key refinement for causal breadcrumb extraction.
 *
 * Used by both brief.ts (turn summary key generation) and summarize.ts
 * (breadcrumb extraction from capped lines) to ensure consistent key output.
 */

// Stop words filtered out when building breadcrumb keys.
// These carry no causal signal and would bloat the key.
export const KEY_STOPS = new Set([
  // Articles, pronouns, demonstratives
  "the", "a", "an", "this", "that", "these", "those", "it", "its",
  // Be-verbs, auxiliaries
  "is", "was", "are", "were", "been", "being",
  "has", "have", "had", "does", "do", "did",
  "will", "would", "could", "should", "may", "might", "shall", "can",
  // Prepositions
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "before", "after", "above", "below",
  // Conjunctions, adverbs
  "and", "but", "or", "not", "so", "yet",
  "before", "after", "when", "where", "while", "during",
  // Contextual filler that doesn't carry causal signal
  "against", "into", "around", "before", "all",
  // Marker remnant words: verbs from resolution markers that survive
  // the extraction because the fragment starts right after the marker.
  // E.g. "added session check" → we want "session-check", not "added-session-check".
  "added", "adding", "created", "creating",
  "applied", "applying", "inserted", "inserting",
  "implemented", "implementing", "introduced", "introducing",
  "using", "swapped", "swapping", "split", "splitting",
  "migrated", "migrating", "isolated", "isolating",
  "removed", "removing", "extracted", "extracting",
  "replaced", "replacing", "refactored", "refactoring",
  "wrapped", "wrapping", "guarded", "guarding",
  "moved", "moving", "updated", "configured",
  "enabled", "switched",
]);

/** Maximum content words in a breadcrumb key. */
const KEY_MAX_WORDS = 3;

/**
 * Build a compact breadcrumb key from a raw fragment.
 * Takes up to KEY_MAX_WORDS content words (skipping stop words), joined with "-".
 */
export const refineBreadcrumbKey = (fragment: string, maxChars = 40): string => {
  if (/\p{Script=Han}/u.test(fragment)) {
    const cleaned = fragment.trim()
      .replace(/^(?:已经|目前|由于|因为|因此|所以|需要|我们|可以|应该|必须)/u, "")
      .replace(/[。！？；，,:].*$/u, "")
      .trim();
    // Chinese phrases have no whitespace: keep a bounded readable prefix,
    // not an entire sentence masquerading as one English "word".
    const key = Array.from(cleaned).slice(0, Math.min(18, maxChars)).join("")
      .replace(/[的了和与是把将]+$/u, "");
    return key || Array.from(fragment).slice(0, Math.min(18, maxChars)).join("");
  }
  const words = fragment.split(/\s+/);
  const content: string[] = [];
  for (const w of words) {
    if (KEY_STOPS.has(w.toLowerCase())) continue;
    content.push(w);
    if (content.length >= KEY_MAX_WORDS) break;
  }
  return content.join("-") || fragment.slice(0, maxChars);
};
