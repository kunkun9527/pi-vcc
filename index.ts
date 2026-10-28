import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerJevMemoryRanker } from "./src/hooks/jev-memory";
import { registerProactiveThresholdHook } from "./src/hooks/proactive-threshold";
import { ProactiveState } from "./src/core/proactive-state";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerConfigPanel } from "./src/commands/pi-vcc-config";
import { registerJevStatsCommand } from "./src/commands/pi-vcc-jev-stats";
import { registerRecallTool } from "./src/tools/recall";
import { registerInvisibleContinue } from "./src/core/invisible-continue";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerInvisibleContinue(pi);
  const getMemoryScores = registerJevMemoryRanker(pi);
  const proactive = new ProactiveState();
  registerBeforeCompactHook(pi, getMemoryScores, proactive);
  registerProactiveThresholdHook(pi, proactive);
  registerPiVccCommand(pi);
  registerConfigPanel(pi);
  registerJevStatsCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
