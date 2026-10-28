import type { NormalizedBlock } from "../types";
import { extractMemoryFiles, trackCodeMemory, type CodeChangeSnapshot, type FreshnessState } from "./memory-freshness";

export type FactKind = "constraint" | "blocker" | "decision";
export interface MemoryFact {
  kind: FactKind;
  id: string;
  text: string;
  /** Exact Pi session entry ID. Omitted for legacy summaries. */
  sourceId?: string;
  status?: "confirmed" | "proposed";
  relatedFiles?: string[];
  baselineCommit?: string;
  freshness?: FreshnessState;
}
const HEADER = "[Long-term Memory]";
const GUARD = /(?:不要|请勿|禁止|必须|务必|始终|永远|不可|只能|只允许|\bnever\b|\balways\b|\bmust\b|\bdo not\b)/iu;
const ISSUE = /(?:仍然失败|尚未解决|未解决|阻塞|卡住|无法|报错|失败|\bblocked\b|\bunresolved\b|\bcannot\b)/iu;
const CHOICE = /(?:决定|已确定|确认采用|选择了|改用|已采用|\bdecided\b|\bchose\b)/iu;
const CLOSED = /(?:已解决|已关闭|resolved|closed)\s*[:：#]\s*([0-9a-f]{8})/giu;

function hash(value: string): string {
  let n = 2166136261;
  for (const char of value.toLowerCase()) n = Math.imul(n ^ char.codePointAt(0)!, 16777619) >>> 0;
  return n.toString(16).padStart(8, "0");
}
export const memoryId = (kind: FactKind, text: string): string => hash(kind + ":" + text.replace(/\s+/g, " ").trim());

export function collectMemory(blocks: NormalizedBlock[], sourceEntryIds: string[] = []): MemoryFact[] {
  const result: MemoryFact[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "user" && block.kind !== "assistant") continue;
    for (const line of block.text.split("\n").slice(0, 20)) {
      const text = line.replace(/\s+/g, " ").trim();
      if (text.length < 6 || text.length > 200 || /[?？]$/.test(text) || /^\s*(?:```|import |export |const |function |class )/.test(text)) continue;
      const kind: FactKind | null = block.kind === "user" && GUARD.test(text) ? "constraint"
        : ISSUE.test(text) && !/(?:已解决|已修复|修复完成|问题解决|resolved|fixed)/iu.test(text) ? "blocker"
        : CHOICE.test(text) ? "decision" : null;
      if (!kind) continue;
      // Keep each record on one terminal-width line: the next compaction
      // must be able to parse its ID and complete text unchanged.
      let clipped = "";
      let width = 0;
      for (const char of text) {
        const cells = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\p{Extended_Pictographic}]/u.test(char) ? 2 : 1;
        if (width + cells > 90) break;
        clipped += char;
        width += cells;
      }
      const id = memoryId(kind, clipped);
      if (!seen.has(id)) {
        seen.add(id);
        const source = block.sourceIndex === undefined ? undefined : sourceEntryIds[block.sourceIndex];
        const sourceId = source && /^[A-Za-z0-9_-]{1,80}$/.test(source) ? source : undefined;
        result.push({ kind, id, text: clipped, ...(sourceId ? { sourceId } : {}),
          status: block.kind === "user" ? "confirmed" : "proposed" });
      }
    }
  }
  return result;
}

export function resolvedMemoryIds(blocks: NormalizedBlock[]): Set<string> {
  const resolved = new Set<string>();
  for (const block of blocks) if (block.kind === "user") {
    for (const match of block.text.matchAll(CLOSED)) resolved.add(match[1].toLowerCase());
  }
  return resolved;
}

/** Explicit retirement, supersession and expiry markers from a real user turn.
 * Never treat a quoted file or assistant claim as a memory deletion instruction.
 */
export function retiredMemoryIds(blocks: NormalizedBlock[]): Set<string> {
  const ids = resolvedMemoryIds(blocks);
  const re = /(?:废弃|替代|过期|撤销|superseded|expired|retracted)\s*[:：#]\s*([0-9a-f]{8})/giu;
  for (const block of blocks) if (block.kind === "user") {
    for (const m of block.text.matchAll(re)) ids.add(m[1].toLowerCase());
  }
  return ids;
}

const LINE = /^- \[(constraint|blocker|decision):([0-9a-f]{8})\] (.+)$/u;
const SOURCE = /^  @source:([A-Za-z0-9_-]{1,80}) status:(confirmed|proposed)$/u;
const FILE_LINE = /^  @file:([a-zA-Z0-9_./-]{1,36}) baseline:([0-9a-f]{8,40}) state:(tracked|needs-review|unknown)$/u;
export function parseMemory(section: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const seen = new Set<string>();
  // Metadata belongs only to the immediately preceding *valid* fact.
  // Never attach an invalid, duplicate, or foreign record's provenance
  // to an earlier valid fact.
  let current: MemoryFact | undefined;
  for (const line of section.split("\n")) {
    const m = LINE.exec(line);
    if (m) {
      const kind = m[1] as FactKind, id = m[2], text = m[3];
      if (memoryId(kind, text) !== id || seen.has(id)) {
        current = undefined;
        continue;
      }
      const fact: MemoryFact = { kind, id, text };
      seen.add(id); facts.push(fact);
      current = fact;
      continue;
    }
    // Even an invalid memory line must end the previous record.
    if (/^- \[(?:constraint|blocker|decision):/u.test(line)) {
      current = undefined;
      continue;
    }
    const src = SOURCE.exec(line);
    if (src && current) {
      if (!current.sourceId) {
        current.sourceId = src[1];
        current.status = src[2] as "confirmed" | "proposed";
      }
      continue;
    }
    const fileMeta = FILE_LINE.exec(line);
    if (fileMeta && current) {
      if (!current.relatedFiles) current.relatedFiles = [];
      if (current.relatedFiles.length < 2 && extractMemoryFiles(fileMeta[1]).includes(fileMeta[1])) {
        current.relatedFiles.push(fileMeta[1]);
        current.baselineCommit = fileMeta[2];
        current.freshness = fileMeta[3] as FreshnessState;
      }
      continue;
    }
    // Headers, other sections, malformed metadata and text break adjacency.
    current = undefined;
  }
  return facts;
}
export function selectMemory(facts: MemoryFact[], scores: Record<string, number> = {}): MemoryFact[] {
  const unique = [...new Map(facts.map(f => [f.id, f])).values()];
  const chosen: MemoryFact[] = [];
  for (const kind of ["constraint", "blocker", "decision"] as FactKind[]) {
    const candidates = unique.filter(f => f.kind === kind);
    if (kind === "decision") {
      chosen.push(...candidates.map((fact, index) => ({ fact, index }))
        .sort((a, b) => (scores[b.fact.id] ?? 0) - (scores[a.fact.id] ?? 0) || b.index - a.index)
        .slice(0, 8).sort((a, b) => a.index - b.index).map(x => x.fact));
    } else chosen.push(...(candidates.length <= 8 ? candidates : [...candidates.slice(0, 4), ...candidates.slice(-4)]));
  }
  return chosen;
}
export function formatMemory(facts: MemoryFact[], scores?: Record<string, number>): string {
  const selected = selectMemory(facts, scores);
  return selected.length ? HEADER + "\n" + selected.map(f =>
    `- [${f.kind}:${f.id}] ${f.text}` +
    (f.sourceId ? `\n  @source:${f.sourceId} status:${f.status ?? "proposed"}` : "") +
    (f.baselineCommit && f.relatedFiles?.length
      ? f.relatedFiles.filter(p => p.length <= 36).map(path => `\n  @file:${path} baseline:${f.baselineCommit!.slice(0, 12)} state:${f.freshness ?? "unknown"}`).join("")
      : "")
  ).join("\n") : "";
}
export function mergeMemory(
  prev: string, fresh: string, scores?: Record<string, number>,
  retired: Set<string> = new Set(), activeSourceIds?: Set<string>,
  codeSnapshot?: CodeChangeSnapshot,
): string {
  const facts = [...parseMemory(prev), ...parseMemory(fresh)].filter(f =>
    !retired.has(f.id) && (!activeSourceIds || !f.sourceId || activeSourceIds.has(f.sourceId))
  );
  return formatMemory(trackCodeMemory(facts, codeSnapshot), scores);
}
