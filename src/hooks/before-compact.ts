import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compile, type CompileInput } from "../core/summarize";
import { buildOwnCut, computeMessageRange, estimateMessageTokens, type OwnCutCancelReason } from "../core/compaction-cut";
export { buildOwnCut, computeMessageRange } from "../core/compaction-cut";
export type { OwnCutResult } from "../core/compaction-cut";
import { auditMemoryCompaction } from "../core/memory-integrity";
import { normalize } from "../core/normalize";
import { filterNoise } from "../core/filter-noise";
import { retiredMemoryIds } from "../core/long-memory";
import { contextWindowLearner, planContextBudget } from "../core/context-budget";
import {
  CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION,
  CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION,
  clearCodexContextOverflowPending,
  isCodexContextOverflowError,
  isCodexContextOverflowPending,
  isCodexOutputLimitError,
} from "../core/codex-output-limit";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { triggerInvisibleContinue } from "../core/invisible-continue";
import { isProactiveTriggerActive } from "./proactive-threshold";
import { countPiVccCompactionsFromSession, ordinalSuffix } from "../core/compaction-count";
import type { PiVccCompactionDetails } from "../details";

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

interface CompactionStats {
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let lastCompactWasCodexRecovery = false;
let lastCompactWasProactive = false;
let lastCompactHandledByVcc = false;
let lastCompactDeferredToFabric = false;
let hasNotifiedFabricDeferral = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

export const shouldResumeAfterCompaction = (
  lastMsg: unknown,
  allowCodexRecovery = false,
): boolean => {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const message = lastMsg as { role?: unknown; stopReason?: unknown };
  if (message.role !== "assistant") return false;
  if (message.stopReason === "stop" || message.stopReason === "aborted") return false;
  if (message.stopReason === "error") {
    return allowCodexRecovery && (
      isCodexOutputLimitError(lastMsg) ||
      isCodexContextOverflowError(lastMsg)
    );
  }
  return true;
};

export type CompactionCompletionMetadata = {
  reason?: "manual" | "threshold" | "overflow";
  willRetry?: boolean;
};

export function shouldTriggerResumeForCompaction(
  event: CompactionCompletionMetadata,
  sessionIsIdle: boolean,
  wasProactiveCompaction: boolean,
  wasCodexRecoveryCompaction: boolean,
): boolean {
  if (event.willRetry) return true;
  if (wasCodexRecoveryCompaction || wasProactiveCompaction) return true;
  if (event.reason === "manual" || event.reason === "overflow") return false;
  if (event.reason === "threshold") return !sessionIsIdle;

  // Pi before 0.79.10 did not expose compaction reason metadata. Be
  // conservative there: an idle session may be manual or pre-prompt.
  return !sessionIsIdle;
}

export const registerBeforeCompactHook = (pi: ExtensionAPI, getMemoryScores: () => Record<string, number> = () => ({})) => {
  pi.on("session_before_compact", (event, ctx) => {
    // pi-fabric may run before pi-vcc and mark the shared event after claiming it.
    if ((event as any)._fabricCompaction === true) return;

    const { preparation, branchEntries, customInstructions } = event;
    const settings = loadSettings();

    // Per-model threshold guard was previously applied here, cancelling
    // compaction when context was below the per-model threshold. This
    // blocked manual /compact from working because session_before_compact
    // carries no "reason" field — manual and auto compactions are
    // indistinguishable (both have customInstructions: undefined).
    //
    // The per-model threshold is now served entirely by the proactive
    // trigger (in proactive-threshold.ts), which fires on agent_end /
    // model_select when the per-model threshold is crossed. This correctly
    // compacts earlier than pi-core's global threshold without needing to
    // cancel any compaction here.
    //
    // If pi-core's global threshold fires before the per-model threshold
    // is crossed, the compaction proceeds — slightly premature from the
    // per-model threshold's perspective, but this is preferable to blocking
    // an explicit user action (/compact).
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;
    const isCodexOutputLimitCompaction =
      customInstructions === CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION;
    const isCodexContextOverflowMarker =
      customInstructions === CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION;
    const lastBranchAssistant = [...(branchEntries as any[])]
      .reverse()
      .find((entry: any) => entry.type === "message" && entry.message?.role === "assistant")
      ?.message;
    const isCodexContextOverflowCompaction =
      isCodexContextOverflowMarker ||
      (settings.overrideDefaultCompaction &&
        isCodexContextOverflowPending() &&
        isCodexContextOverflowError(lastBranchAssistant));
    const isPiVccHandled =
      isPiVcc || isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;

    // Explicit /pi-vcc takes precedence over the pi-fabric engine. For every
    // other compaction, retain pi-vcc's trigger/recovery bookkeeping but let
    // pi-fabric compile the summary.
    if (!isPiVcc && process.env.PI_FABRIC_COMPACTION_ENGINE === "fabric") {
      if (!isPiVccHandled && !settings.overrideDefaultCompaction) return;
      if (isCodexContextOverflowCompaction) clearCodexContextOverflowPending();

      lastCompactWasPiVcc = false;
      lastCompactWasCodexRecovery =
        isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;
      lastCompactWasProactive = isProactiveTriggerActive();
      lastCompactHandledByVcc = true;
      lastCompactDeferredToFabric = true;

      if (settings.overrideDefaultCompaction && !hasNotifiedFabricDeferral) {
        hasNotifiedFabricDeferral = true;
        try {
          ctx?.ui?.notify?.(
            "pi-vcc: deferring compaction to pi-fabric engine (explicit /pi-vcc still uses pi-vcc)",
            "info",
          );
        } catch {}
      }
      return;
    }

    // Always handle explicit /pi-vcc and Codex recovery markers. Otherwise,
    // only handle when the user opted in via settings.
    if (!isPiVccHandled && !settings.overrideDefaultCompaction) return;
    if (isCodexContextOverflowCompaction) clearCodexContextOverflowPending();

    // Budget the kept tail so that summary + kept + system/tools + the model's
    // OUTPUT budget (maxTokens) all fit in the window. Without reserving
    // maxTokens, the compaction-retry request can be rejected upfront
    // (input + maxTokens > contextWindow) and re-overflow. Falls back to
    // pi-core's keepRecentTokens when the window is unknown.
    const model = (ctx as any)?.model;
    const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
    const learnedWindow = model ? contextWindowLearner.get(sessionId, model) : undefined;
    const budget = planContextBudget(model, (preparation as any)?.settings?.keepRecentTokens ?? 20000, learnedWindow);
    const maxKeptTokens = budget.maxKeptTokens;
    const ownCut = buildOwnCut(branchEntries as any[], { maxKeptTokens });
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = (lastComp as any)?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      dbg(settings, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!(lastComp as any).firstKeptEntryId,
          foundInBranch: (lastComp as any).firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === (lastComp as any).firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = agentMessages;
    // The cut uses original message object references, so map back to the
    // exact session entry IDs without relying on branch-relative indices.
    const entryIdByMessage = new Map<unknown, string>();
    for (const entry of branchEntries as any[]) {
      if (entry.type === "message" && entry.message && typeof entry.id === "string") {
        entryIdByMessage.set(entry.message, entry.id);
      }
    }
    const sourceEntryIds = messages.map((m: unknown) => entryIdByMessage.get(m) ?? "");
    const activeSourceIds = new Set(
      (branchEntries as any[]).filter(e => e.type === "message" && e.message && typeof e.id === "string")
        .map(e => e.id as string),
    );

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptTokens = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageTokens(e.message ?? { content: "" }), 0,
    );
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: keptTokens,
    };

    const config = settings;

    // Compute entry-ID range for compaction-scoped recall
    const messageRange = computeMessageRange(
      branchEntries as any[],
      firstKeptEntryId,
      sourceEntryIds,
    );

    const compileInput: CompileInput = {
      messages,
      previousSummary: preparation.previousSummary,
      memoryScores: getMemoryScores(),
      sourceEntryIds,
      activeSourceIds,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    };

    const summary = compile(compileInput);
    const audit = auditMemoryCompaction(
      preparation.previousSummary ?? "", summary,
      retiredMemoryIds(filterNoise(normalize(messages))), activeSourceIds,
    );
    if (audit.missingProtected.length || audit.missingEvidence.length) {
      // Never silently claim that critical history survived when it did not.
      // The raw JSONL remains recoverable; warn without logging sensitive text.
      try {
        ctx?.ui?.notify?.(
          "pi-vcc: compaction integrity warning (" +
          (audit.missingProtected.length + audit.missingEvidence.length) +
          " protected facts or source references changed). Use vcc_recall to verify.",
          "warning",
        );
      } catch {}
    }

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      messageRange,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections,
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      messageRange,
      compressionRatio: preparation.tokensBefore > 0
        ? Math.round(preparation.tokensBefore / Math.max(1, agentMessages.length))
        : undefined,
      timestamp: new Date().toISOString(),
      tokensBefore: preparation.tokensBefore || undefined,
      keptCount: lastStats?.kept || undefined,
      keptTokensEst: lastStats?.keptTokensEst || undefined,
    };

    lastCompactWasPiVcc = isPiVcc;
    lastCompactWasCodexRecovery =
      isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;
    lastCompactWasProactive = isProactiveTriggerActive();
    lastCompactHandledByVcc = true;
    lastCompactDeferredToFabric = false;

    // Signal to neuralwatt-mcr that pi-vcc is handling compaction
    // so it doesn't cancel the event. Without this flag, neuralwatt-mcr
    // returns { cancel: true } for MCR models and pi-vcc's summary is
    // discarded by the runner's short-circuit.
    (event as any)._piVccOverriding = true;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  pi.on("session_start", () => {
    hasNotifiedFabricDeferral = false;
  });

  // A provider error can reveal a smaller real context window than the
  // model registry advertises. Learn it only for this session + model.
  // Never retry the same overflowing request inside message_end.
  pi.on("message_end", (event, ctx) => {
    const msg = (event as any)?.message;
    if (msg?.role !== "assistant" || msg?.stopReason !== "error") return;
    const detail = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    const sessionId = (ctx as any)?.sessionManager?.getSessionId?.();
    const model = (ctx as any)?.model;
    if (sessionId && model && detail) contextWindowLearner.observe(sessionId, model, detail);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = (ctx as any)?.sessionManager?.getSessionId?.();
    if (sessionId) contextWindowLearner.forget(sessionId);
  });

  // After compaction completes, check if the agent loop stalled and needs
  // an invisible continue to resume.  This handles threshold compaction
  // where willRetry=false — pi-core doesn't auto-retry, and the agent loop
  // exits because hasQueuedMessages() returns false.  If the last message in
  // the rebuilt context is an assistant mid-task (tool_use, length, or error
  // that isn't a clean end_turn), the agent was interrupted and should
  // continue.
  pi.on("session_compact", (event, ctx) => {
    // Act when pi-vcc compiled the summary or tracked a compaction delegated
    // to pi-fabric so proactive and Codex recovery continuation still works.
    if (!lastCompactHandledByVcc) return;
    const wasCodexRecoveryCompaction = lastCompactWasCodexRecovery;
    const wasProactiveCompaction = lastCompactWasProactive;
    const wasDeferredToFabric = lastCompactDeferredToFabric;
    lastCompactHandledByVcc = false;
    lastCompactWasCodexRecovery = false;
    lastCompactWasProactive = false;
    lastCompactDeferredToFabric = false;

    // Fire success toast for pi-vcc's /compact path only (delayed to let UI
    // settle). /pi-vcc has its own callback, and pi-fabric owns delegated UI.
    if (!lastCompactWasPiVcc && !wasDeferredToFabric) {
      const stats = lastStats;
      const count = countPiVccCompactionsFromSession(ctx?.sessionManager as any);
      const compactionLabel = count > 0
        ? ` (${count}${ordinalSuffix(count)} compaction)`
        : "";
      if (stats) {
        setTimeout(() => {
          try {
            ctx?.ui?.notify?.(
              `pi-vcc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).${compactionLabel}`,
              "info",
            );
          } catch {}
        }, 500);
      }
    }

    // Determine if the agent needs to continue after compaction.
    // After rebuildSessionContext, the agent's state.messages are updated.
    // Check the last message: if it's an assistant message that isn't a
    // clean stop, the agent was mid-task and needs to resume.
    //
    // We do NOT continue when:
    // - Last message is user/toolResult (agent can continue naturally)
    // - Last message is assistant with stopReason=stop (task finished)
    // - Last message is assistant with stopReason=aborted (user cancelled)
    // - Last message is assistant with stopReason=error, unless this was
    //   a pi-vcc Codex recovery compaction
    //
    // We DO continue when:
    // - Last message is assistant with stopReason=toolUse (mid-tool cycle)
    // - Last message is assistant with stopReason=length (hit max tokens)
    // - Last message is a known Codex recovery error from the pi-vcc
    //   recovery compaction
    // - Compact-all (firstKeptEntryId="") — context is just the summary,
    //   the agent needs to re-enter the loop to continue the task
    try {
      const entries = ctx.sessionManager.getEntries();
      // Walk backwards to find the last message entry
      let lastMsg: { role: string; stopReason?: string; content?: unknown } | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = (entries as any[])[i];
        if (e.type === "message" && e.message) {
          lastMsg = e.message;
          break;
        }
      }
      // A core-owned retry also gets a marker. Agent.continue() drains the
      // queued marker before checking the assistant-tail role, so no Agent
      // prototype fallback is needed.
      const completion = event as CompactionCompletionMetadata;
      const legacyActiveCompaction =
        completion.reason === undefined &&
        completion.willRetry === undefined &&
        !ctx.isIdle();
      if (
        !completion.willRetry &&
        !legacyActiveCompaction &&
        !shouldResumeAfterCompaction(lastMsg, wasCodexRecoveryCompaction)
      ) return;
      if (!shouldTriggerResumeForCompaction(
        completion,
        ctx.isIdle(),
        wasProactiveCompaction,
        wasCodexRecoveryCompaction,
      )) return;

      // Queue through Pi's native follow-up path so a concurrent user prompt
      // wins cleanly instead of racing a low-level Agent.prompt([]) call.
      triggerInvisibleContinue(pi);
    } catch {
      // Non-critical — if context inspection fails, don't block compaction
    }
  });
};
