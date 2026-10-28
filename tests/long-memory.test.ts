import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import { collectMemory, formatMemory, memoryId, parseMemory } from "../src/core/long-memory";
import { userMsg, assistantText } from "./fixtures";

describe("persistent long-term memory", () => {
  it("retains critical Chinese constraints and blockers for 100 compactions", () => {
    let summary = compile({ messages: [
      userMsg("项目中不要修改 generated/ 文件"),
      userMsg("数据库连接仍然失败，需要继续排查"),
    ] });
    for (let i = 0; i < 100; i++) {
      summary = compile({ messages: [userMsg("继续处理普通任务 " + i)], previousSummary: summary });
    }
    const facts = parseMemory(summary);
    expect(facts.some(f => f.text.includes("不要修改 generated/"))).toBe(true);
    expect(facts.some(f => f.text.includes("数据库连接仍然失败"))).toBe(true);
  });
  it("retires a blocker only upon explicit user confirmation by stable ID", () => {
    const issue = "数据库连接仍然失败，需要继续排查";
    const id = memoryId("blocker", issue);
    const first = compile({ messages: [userMsg(issue)] });
    const second = compile({ messages: [assistantText("数据库问题已修复")], previousSummary: first });
    expect(parseMemory(second).some(f => f.id === id)).toBe(true);
    const third = compile({ messages: [userMsg("已解决：" + id)], previousSummary: second });
    expect(parseMemory(third).some(f => f.id === id)).toBe(false);
  });
  it("excludes questions and code from memory candidates", () => {
    const facts = collectMemory([
      { kind: "user", text: "不要修改配置吗？" },
      { kind: "assistant", text: "const reason = \"数据库失败\"" },
      { kind: "user", text: "请不要删除重要数据库表" },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("constraint");
    expect(formatMemory(facts)).toContain("[Long-term Memory]");
  });
  it("caps facts and pins earliest and newest constraints", () => {
    const facts = collectMemory(Array.from({ length: 40 }, (_, i) => ({ kind: "user" as const, text: "永远不要删除数据库表 " + i })));
    const selected = parseMemory(formatMemory(facts));
    expect(selected).toHaveLength(8);
    expect(selected.some(f => f.text.endsWith("表 0"))).toBe(true);
    expect(selected.some(f => f.text.endsWith("表 39"))).toBe(true);
  });
});
