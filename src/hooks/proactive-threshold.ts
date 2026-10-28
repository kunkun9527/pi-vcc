import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION,
  CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION,
  isCodexContextOverflowError,
  isCodexOutputLimitError,
  markCodexContextOverflowPending as legacyMarkOverflow,
  clearCodexContextOverflowPending as legacyClearOverflow,
} from "../core/codex-output-limit";
import { loadSettings, getModelThreshold, isPiCoreCompactionEnabled, resolveTriggerTokens } from "../core/settings";
import { ProactiveState } from "../core/proactive-state";
export { ProactiveState } from "../core/proactive-state";

type ProactiveContext = {
  model?: any;
  getContextUsage?: () => any;
  compact?: (options?: any) => void;
  ui?: any;
  sessionManager?: { getCwd?: () => string };
};

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// Compatibility helpers for tests and older importers. Runtime callers
// use an explicit instance instead of sharing module-level trigger state.
let legacyState: ProactiveState | undefined;
export const isProactiveTriggerActive = () => legacyState?.isTriggered() ?? false;
export const resetProactiveState = () => { legacyState?.reset(); legacyClearOverflow(); };

/**
 * Check if a configured threshold has been crossed and trigger compaction
 * if so. Safe to call from multiple event handlers — cooldown prevents
 * double-triggering.
 */
const checkAndTrigger = (ctx: ProactiveContext, source: string, state: ProactiveState) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  // No threshold → nothing to do (pi-core's global threshold owns it)
  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  const effectiveThreshold = resolveTriggerTokens(threshold, contextWindow);
  if (effectiveThreshold == null) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (state.isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      `pi-vcc: [${source}] Context at ${pct}% exceeds threshold (${formatTokens(effectiveThreshold)} tok). Compacting...`,
      "info",
    );
  } catch {}

  // Set cooldown IMMEDIATELY (before ctx.compact() runs) to prevent
  // pi-core's own _checkCompaction from also triggering compaction
  // on the same turn.
  state.initiate();

  // The state belongs to this Pi instance; only its before_compact hook
  // sees this self-initiated trigger.

  ctx.compact?.();
};

/** Force compaction for Codex responses that report an output limit as an error. */
const triggerCodexOutputLimitCompaction = (ctx: ProactiveContext, state: ProactiveState) => {
  if (state.isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex reached its maximum output token limit. Compacting...",
      "info",
    );
  } catch {}

  state.initiate();
  ctx.compact?.({ customInstructions: CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION });
};

/** Force compaction when Codex omits the model identity from an overflow error. */
const triggerCodexContextOverflowCompaction = (ctx: ProactiveContext, state: ProactiveState) => {
  if (state.isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex input exceeded the context window. Compacting...",
      "info",
    );
  } catch {}

  state.initiate();
  ctx.compact?.({ customInstructions: CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION });
};

const hasCurrentModelIdentity = (message: unknown, model: any): boolean => {
  if (!message || typeof message !== "object" || !model) return false;
  const candidate = message as { model?: unknown; provider?: unknown };
  return candidate.model === model.id && candidate.provider === model.provider;
};

const lastAssistantMessage = (event: unknown): unknown => {
  const messages = (event as any)?.messages;
  if (!Array.isArray(messages)) return undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
};

/**
 * Registers proactive configured compaction thresholds.
 *
 * Three triggers:
 *
 * 1. `agent_end` — after each agent run completes, check if context
 *    exceeds the active configured threshold. If that threshold is lower
 *    than pi-core's global threshold (meaning this config wants to compact
 *    earlier), pi-core won't trigger compaction — so we do.
 *
 * 2. `model_select` — when switching models, the new model may have a
 *    different threshold. Check immediately in case current context exceeds
 *    the new threshold.
 *
 * 3. `session_compact` — cooldown tracking + clear proactiveTriggerActive.
 *    After any compaction completes, we set a cooldown to prevent
 *    double-triggering and clear the self-initiated flag.
 *
 * `session_before_compact` reads `isProactiveTriggerActive()` to decide
 * whether to cancel. When our proactive trigger fires, ctx.compact() is
 * queued but hasn't run yet. By the time session_before_compact actually
 * fires, tokensBefore may differ from the getContextUsage() snapshot
 * that triggered the compact. Without the flag, the threshold guard would
 * cancel the compaction we ourselves requested — producing confusing
 * "Compacting..." then "Skipped compaction" notifications.
 */
export const registerProactiveThresholdHook = (pi: ExtensionAPI, providedState?: ProactiveState): ProactiveState => {
  const state = providedState ?? new ProactiveState();
  const legacy = providedState === undefined;
  legacyState = state;
  // Codex reports output-limit responses as errors instead of the standard
  // "length" stop reason. Those errors have no usable context usage, so
  // pi-core cannot discover the need to compact from its normal checks.
  // Context-window errors are tracked separately because pi-core already
  // recognizes and compacts those.
  pi.on("agent_end", (event, ctx) => {
    const lastMessage = lastAssistantMessage(event);
    if (isCodexOutputLimitError(lastMessage)) {
      triggerCodexOutputLimitCompaction(ctx, state);
      return;
    }
    if (isCodexContextOverflowError(lastMessage)) {
      state.markOverflow();
      if (legacy) legacyMarkOverflow();
      // pi-core's overflow compaction only fires when compaction is enabled AND
      // the assistant message carries the current model identity. If either
      // is missing pi-core bails (or its LLM compaction would re-overflow), so
      // pi-vcc must drive the recovery compaction itself via ctx.compact(),
      // whose manual path skips the `enabled` gate and uses pi-vcc's static
      // summary. When pi-core will handle it, defer to avoid a racing second
      // compaction that would abort pi-core's own retry.
      const piCoreWillHandle =
        hasCurrentModelIdentity(lastMessage, ctx.model) &&
        isPiCoreCompactionEnabled(ctx.sessionManager?.getCwd?.());
      if (!piCoreWillHandle) {
        triggerCodexContextOverflowCompaction(ctx, state);
      }
      return;
    }
    checkAndTrigger(ctx, "auto", state);
  });

  // Proactive compaction on model switch
  pi.on("model_select", (_event, ctx) => {
    checkAndTrigger(ctx, "model-switch", state);
  });

  // Track compaction completion: set cooldown and clear self-initiated flag
  pi.on("session_compact", () => {
    state.complete();
    if (legacy) legacyClearOverflow();
  });

  // Reset state on session start so state doesn't leak between sessions
  pi.on("session_start", () => {
    state.reset();
    if (legacy) legacyClearOverflow();
  });
  return state;
};
