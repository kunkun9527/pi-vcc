import { describe, test, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import { collectMemory, memoryId, parseMemory, selectMemory } from "../src/core/long-memory";
import { userMsg, assistantText } from "./fixtures";

describe("Chinese long-session retention", () => {
  test("150 successive compactions preserve critical rules and an open issue", () => {
    const rule = "永远不要删除 generated/ 目录";
    const rule2 = "项目输出必须始终使用简体中文";
    const blocker = "支付回调仍然失败，需要继续检查重试逻辑";
    const ruleId = memoryId("constraint", rule);
    const rule2Id = memoryId("constraint", rule2);
    const blockerId = memoryId("blocker", blocker);
    let current = compile({ messages: [userMsg(rule), userMsg(rule2), userMsg(blocker)] });
    let preserved = 0;
    let maxSummaryChars = current.length;
    for (let round = 0; round < 150; round++) {
      const messages = [
        userMsg("继续实现第" + round + "个模块，检查兼容性"),
        assistantText("决定采用第" + round + "版接口协议并保留测试"),
      ];
      current = compile({ messages, previousSummary: current });
      const facts = parseMemory(current);
      if ([ruleId, rule2Id, blockerId].every(id => facts.some(f => f.id === id))) preserved++;
      expect(facts.filter(f => f.kind === "decision").length).toBeLessThanOrEqual(8);
      expect(facts.length).toBeLessThanOrEqual(24);
      maxSummaryChars = Math.max(maxSummaryChars, current.length);
    }
    expect(preserved).toBe(150);
    expect(maxSummaryChars).toBeLessThan(30000);
    console.log("CJK memory: 150 rounds, 3 critical facts preserved for " + preserved + "/150 rounds, peak chars " + maxSummaryChars);
    const cleared = compile({ messages: [userMsg("已解决：" + blockerId)], previousSummary: current });
    expect(parseMemory(cleared).some(f => f.id === blockerId)).toBe(false);
    expect(parseMemory(cleared).some(f => f.id === ruleId)).toBe(true);
  });
  test("Jev scores do not evict protected old Chinese constraints", () => {
    const facts = collectMemory([
      ...Array.from({ length: 25 }, (_, i) => ({ kind: "user" as const, text: "必须保护原始工程配置 " + i })),
      ...Array.from({ length: 14 }, (_, i) => ({ kind: "assistant" as const, text: "决定采用新的缓存策略 " + i })),
    ]);
    const scores = Object.fromEntries(facts.map(f => [f.id, f.kind === "decision" ? 3 : -100]));
    const chosen = selectMemory(facts, scores);
    expect(chosen.filter(f => f.kind === "constraint").length).toBe(8);
    expect(chosen.some(f => f.text.endsWith("配置 0"))).toBe(true);
    expect(chosen.filter(f => f.kind === "decision").length).toBe(8);
  });
});
