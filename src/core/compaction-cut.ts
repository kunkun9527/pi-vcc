import { estimateTextTokens } from "./cjk";

/**
 * Compute the entry-ID range for summarized messages.
 *
 * Uses entry IDs instead of numeric indices so that vcc_recall can correctly
 * resolve the range against the full session file (not just the active branch,
 * where numeric indices would be branch-relative and wrong).
 *
 * Returns [firstSummarizedEntryId, lastSummarizedEntryId] or undefined.
 */
export const computeMessageRange = (
  branchEntries: any[],
  firstKeptEntryId: string,
): [string, string] | undefined => {
  const messages = branchEntries.filter((e: any) =>
    e.type === "message" && e.message && typeof e.id === "string",
  );
  if (messages.length === 0) return undefined;
  // Empty string is a valid compact-all sentinel, not an absent range.
  if (firstKeptEntryId === "") return [messages[0].id, messages[messages.length - 1].id];
  const firstKeptIndex = messages.findIndex((e: any) => e.id === firstKeptEntryId);
  // The stored range is inclusive. Never include the first KEPT message,
  // which belongs to the live tail rather than the summarized history.
  if (firstKeptIndex <= 0) return undefined;
  return [messages[0].id, messages[firstKeptIndex - 1].id];
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

const isHiddenEmptyCustomMessage = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    role?: unknown;
    content?: unknown;
    display?: unknown;
  };
  if (candidate.role !== "custom" || candidate.display !== false) return false;
  return candidate.content === "" || (
    Array.isArray(candidate.content) && candidate.content.length === 0
  );
};

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

/**
 * Find a completed tool-call cycle boundary in the first half of the
 * live messages. Used when there's only a single user message and we
 * can't cut at a task boundary.
 *
 * Scans for completed assistant→toolResult cycles and returns the index
 * of the last toolResult in the cycle nearest the midpoint.
 */
const findMidCycleBoundary = (liveMessages: EntryWithMessage[]): number => {
  const cycles: number[] = []; // end indices (toolResult) of completed cycles
  let currentAssistantIdx = -1;
  const pendingCalls = new Set<string>();

  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i].message;
    if (msg.role === "user") continue;
    if (msg.role === "assistant") {
      currentAssistantIdx = i;
      pendingCalls.clear();
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall" && part.id) pendingCalls.add(part.id);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const callId = (msg as any).toolCallId as string | undefined;
      if (callId) pendingCalls.delete(callId);
      if (pendingCalls.size === 0 && currentAssistantIdx >= 0) {
        cycles.push(i);
        currentAssistantIdx = -1;
      }
    }
  }

  if (cycles.length === 0) return -1;

  // Pick the cycle nearest the midpoint of the first half
  const targetIdx = Math.floor(liveMessages.length / 2);
  let best = cycles[0];
  let bestDist = Math.abs(cycles[0] - targetIdx);
  for (let i = 1; i < cycles.length; i++) {
    const dist = Math.abs(cycles[i] - targetIdx);
    if (dist < bestDist) {
      best = cycles[i];
      bestDist = dist;
    }
  }
  return best;
};

/** Conservative estimate for a mixed Han/Latin live message. */
export function estimateMessageTokens(message: { content: unknown }): number {
  const c = message.content;
  const pieces: string[] = [];
  if (typeof c === "string") {
    pieces.push(c);
  } else if (Array.isArray(c)) {
    for (const part of c as any[]) {
      if (part.text) pieces.push(part.text);
      else if (part.type === "toolCall") {
        const args = part.arguments ?? part.input;
        pieces.push(part.name ?? "", typeof args === "string" ? args : JSON.stringify(args ?? ""));
      } else if (part.type === "toolResult") {
        pieces.push(typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? ""));
      } else if (part.type === "thinking") {
        pieces.push(part.thinking ?? "");
      }
    }
  }
  return estimateTextTokens(pieces.join(" "));
}

/** Find a completed tool-cycle boundary within `suffix` such that the kept
 * tail (suffix[boundary+1 .. end]) fits within `budgetTokens`, keeping as
 * much recent context as possible. Returns the index of the first message to
 * KEEP, or -1 when the suffix can't be split to fit (single oversized cycle,
 * or no completed cycles). */
const findSuffixSplitPoint = (
  suffix: EntryWithMessage[],
  budgetTokens: number,
): number => {
  if (suffix.length <= 2) return -1;

  // Completed-cycle end-indices (toolResult closing a cycle). Same detection
  // as findMidCycleBoundary.
  const cycleEnds: number[] = [];
  let currentAssistantIdx = -1;
  const pendingCalls = new Set<string>();
  for (let i = 0; i < suffix.length; i++) {
    const msg = suffix[i].message;
    if (msg.role === "user") { currentAssistantIdx = -1; pendingCalls.clear(); continue; }
    if (msg.role === "assistant") {
      currentAssistantIdx = i;
      pendingCalls.clear();
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall" && part.id) pendingCalls.add(part.id);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const callId = (msg as any).toolCallId as string | undefined;
      if (callId) pendingCalls.delete(callId);
      if (pendingCalls.size === 0 && currentAssistantIdx >= 0) {
        cycleEnds.push(i);
        currentAssistantIdx = -1;
      }
    }
  }
  if (cycleEnds.length === 0) return -1;

  // tailTokens[i] = tokens of suffix[i .. end].
  const tailTokens: number[] = new Array(suffix.length + 1).fill(0);
  for (let i = suffix.length - 1; i >= 0; i--) {
    tailTokens[i] = tailTokens[i + 1] + estimateMessageTokens(suffix[i].message);
  }
  // Earliest cycle boundary whose kept tail fits — keeps the most recent
  // context while staying under budget. boundary+1 must be < length so the
  // kept tail is non-empty.
  for (const boundary of cycleEnds) {
    if (boundary + 1 < suffix.length && tailTokens[boundary + 1] <= budgetTokens) {
      return boundary + 1;
    }
  }
  return -1;
};

export function buildOwnCut(branchEntries: any[], options?: { maxKeptTokens?: number }): OwnCutResult {
  const maxKeptTokens = options?.maxKeptTokens ?? 0;
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (
        e.type === "message" &&
        e.message &&
        !isHiddenEmptyCustomMessage(e.message)
      ) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (
        e.type === "message" &&
        e.message &&
        !isHiddenEmptyCustomMessage(e.message)
      ) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // Task-boundary-aware cut: find the last user message whose response cycle
  // is complete (no unmatched tool calls). If the turn is mid-flight, push the
  // cut back to the previous user message to keep the entire in-progress turn
  // in the tail.
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  // Check if the turn following the last user message is "in progress"
  // (has an unmatched toolCall — assistant started but didn't finish)
  if (cutIdx > 0) {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (let i = cutIdx + 1; i < liveMessages.length; i++) {
      const msg = liveMessages[i].message;
      if (msg.role === "user") break; // next turn starts
      // toolResult messages carry toolCallId at the message level, not in content parts
      if (msg.role === "toolResult" && (msg as any).toolCallId) {
        toolResultIds.add((msg as any).toolCallId);
        continue;
      }
      const content = msg.content;
      if (typeof content === "string" || !Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "toolCall" && part.id) toolCallIds.add(part.id);
        if (part.type === "toolResult" && part.toolCallId) toolResultIds.add(part.toolCallId);
      }
    }
    const hasUnmatchedToolCall = [...toolCallIds].some(id => !toolResultIds.has(id));
    if (hasUnmatchedToolCall) {
      // Push cut back to the previous user message
      for (let i = cutIdx - 1; i > 0; i--) {
        if (liveMessages[i].message.role === "user") {
          cutIdx = i;
          break;
        }
      }
    }
  }

  // Oversized-turn guard (opt-in via options.maxKeptTokens > 0). When the
  // kept suffix — the most recent turn from the last user message — exceeds
  // the budget, keeping it whole would re-overflow on the compaction retry.
  // Split the turn at a completed tool-cycle boundary so the oversized early
  // part (typically a giant tool result) is summarized and only recent cycles
  // that fit are kept. If a single cycle is itself oversized (or there are no
  // completed cycles to split at), fall back to compact-all — safe because
  // pi-vcc compiles summaries statically (no LLM call that could overflow).
  if (cutIdx > 0 && maxKeptTokens > 0) {
    const suffix = liveMessages.slice(cutIdx);
    let suffixTokens = 0;
    for (const e of suffix) suffixTokens += estimateMessageTokens(e.message);
    if (suffixTokens > maxKeptTokens) {
      const splitIdx = findSuffixSplitPoint(suffix, maxKeptTokens);
      if (splitIdx >= 0) {
        const globalIdx = cutIdx + splitIdx;
        return {
          ok: true,
          messages: liveMessages.slice(0, globalIdx).map((e) => e.message),
          firstKeptEntryId: liveMessages[globalIdx].entry.id,
          compactAll: false,
        };
      }
      return {
        ok: true,
        messages: liveMessages.map((e) => e.message),
        firstKeptEntryId: "",
        compactAll: true,
      };
    }
  }

  if (cutIdx <= 0) {
    // Single user prompt (or no user at all) with a long agentic chain.
    // Instead of compact-all (which destroys the tail), find a completed
    // tool-call cycle boundary in the first half and cut there. This
    // preserves the later part of the session while summarizing the earlier
    // tool-call cycles.
    const cycleEndIdx = findMidCycleBoundary(liveMessages);
    if (cycleEndIdx > 0 && cycleEndIdx < liveMessages.length - 1) {
      return {
        ok: true,
        messages: liveMessages.slice(0, cycleEndIdx + 1).map((e) => e.message),
        firstKeptEntryId: liveMessages[cycleEndIdx + 1].entry.id,
        compactAll: false,
      };
    }
    // No completed cycle boundary found — fall back to compact-all as last resort.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

