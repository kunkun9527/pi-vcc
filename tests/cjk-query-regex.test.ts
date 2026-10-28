import { describe, it, expect } from "bun:test";
import { searchEntries } from "../src/core/search-entries";

describe("mixed CJK and Latin recall queries", () => {
  const messages = [
    { role: "user", content: "数据库连接时发生失败，检查 auth.ts 登录模块" },
    { role: "user", content: "在 auth.ts 处理页面样式" },
  ] as any;
  const entries = messages.map((m: any, index: number) => ({ index, role: "user", summary: m.content }));
  it("does not interpret Chinese questions as regex quantifiers", () => {
    const hits = searchEntries(entries, messages, "数据库连接失败?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].index).toBe(0);
  });
  it("does not treat a dot in auth.ts as explicit regex syntax", () => {
    const hits = searchEntries(entries, messages, "数据库 auth.ts 登录");
    expect(hits[0].index).toBe(0);
  });
  it("still supports explicit regex alternatives written in Chinese", () => {
    expect(searchEntries(entries, messages, "数据库|页面")).toHaveLength(2);
  });
});
