/** Character-aware helpers for deterministic CJK compaction.
 * Uses script-specific budgets and punctuation, following TextFold's
 * multilingual design without importing its Python runtime.
 */
const HAN = /\p{Script=Han}/u;
const HAN_RUNS = /\p{Script=Han}+|[^\p{Script=Han}\s]+/gu;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Expand contiguous Han text to bigrams; retain literal Latin/file terms.
 * Substring matches are lexical, not semantic or synonym-aware.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(HAN_RUNS)) {
    const part = match[0];
    if (!HAN.test(part)) {
      for (const term of part.match(/[\p{L}\p{N}_./-]+/gu) ?? []) terms.push(term);
      continue;
    }
    const chars = Array.from(part);
    if (chars.length < 3) { terms.push(part); continue; }
    for (let i = 0; i + 1 < chars.length; i++) {
      terms.push(chars[i] + chars[i + 1]);
    }
  }
  return [...new Set(terms)];
}

/** Search document length with unspaced Han runs instead of whitespace only. */
export function searchDocumentLength(text: string): number {
  const hanCount = Array.from(text.matchAll(/\p{Script=Han}/gu)).length;
  const other = text.replace(/\p{Script=Han}/gu, " ").trim();
  const otherWords = other ? other.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(hanCount / 2) + otherWords);
}

/** Approximate tokens only; model tokenizers remain authoritative. */
export function estimateTextTokens(text: string): number {
  let han = 0;
  let other = 0;
  for (const char of text) {
    if (HAN.test(char)) han++;
    else other += char.length;
  }
  return Math.ceil(han + other / 4);
}

/** Approximate terminal-cell width: CJK letters occupy two cells. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

/** Safe UTF-16 split point at or below a display-cell budget. */
export function wrapBoundary(text: string, budget: number): number {
  let width = 0;
  let end = 0;
  let boundary = 0;
  for (const char of text) {
    const next = width + (WIDE.test(char) ? 2 : 1);
    if (next > budget) break;
    width = next;
    end += char.length;
    if (/\s|[，。！？；、]/u.test(char)) boundary = end;
  }
  if (end === 0 && text.length > 0) return Array.from(text)[0].length;
  return boundary >= end * 0.55 ? boundary : end;
}
