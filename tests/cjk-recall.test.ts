import { describe, it, expect } from "bun:test";
import { searchTerms, searchDocumentLength } from "../src/core/cjk";
import { searchEntries } from "../src/core/search-entries";

describe("Chinese recall", () => {
  it("splits unspaced Han phrases into overlapping character bigrams", () => {
    expect(searchTerms("数据库连接失败")).toEqual(["数据", "据库", "库连", "连接", "接失", "失败"]);
    expect(searchTerms("数据库 auth.ts 登录")).toEqual(["数据", "据库", "auth.ts", "登录"]);
    expect(searchTerms("数据库连接，失败")).toEqual(["数据", "据库", "库连", "连接", "失败"]);
    expect(searchDocumentLength("数据库连接失败")).toBeGreaterThan(1);
  });

  it("finds a Chinese event when query word order is slightly different", () => {
    const messages = [
      { role: "user", content: "数据库连接时发生失败，需要重试" },
      { role: "user", content: "请修改登录页面按钮" },
    ] as any;
    const entries = messages.map((m: any, i: number) => ({ index: i, role: "user", summary: m.content }));
    const found = searchEntries(entries, messages, "数据库连接失败");
    expect(found[0].index).toBe(0);
    expect(found.some((e) => e.index === 1)).toBe(false);
  });  it("rejects weak overlaps from generic Chinese terms", () => {
    const messages = [
      { role: "user", content: "数据库连接时发生失败，需要重试" },
      { role: "user", content: "数据库配置成功，登录验证失败" },
      { role: "user", content: "登录页面的按钮颜色错误" },
    ] as any;
    const entries = messages.map((m: any, i: number) => ({ index: i, role: "user", summary: m.content }));
    const hits = searchEntries(entries, messages, "数据库连接失败");
    expect(hits[0].index).toBe(0);
    expect(hits.some(e => e.index === 2)).toBe(false);
  });
  it("ignores standalone question filler and caps huge queries", () => {
    expect(searchTerms("如何修复数据库错误")).not.toContain("如何");
    expect(searchEntries([], [], "为什么")).toEqual([]);
    expect(searchTerms("数".repeat(200)).length).toBeLessThanOrEqual(48);
  });

});
