import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readJevLedger, jevLedgerSummary } from "../core/jev-ledger";

/** Read-only statistics; the ledger contains no private question text. */
export function registerJevStatsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pi-vcc-jev-stats", {
    description: "Show metadata-only Jev scoring statistics and shadow comparisons",
    handler: async (_args, ctx) => {
      ctx.ui.notify(jevLedgerSummary(readJevLedger()), "info");
    },
  });
}
