import { describe, it, expect } from "bun:test";
import { extractGoals } from "../src/extract/goals";
import { extractPreferences } from "../src/extract/preferences";
import { extractCausalChain } from "../src/core/brief";
import { buildSections } from "../src/core/build-sections";

describe("Chinese goal, preference and cause extraction", () => {
  it("recognizes a changed task in Chinese", () => {
    const goals = extractGoals([
      { kind: "user", text: "请修复登录错误" },
      { kind: "user", text: "改为使用 SQLite 数据库存储会话" },
    ]);
    expect(goals).toContain("[Scope change]");
    expect(goals).toContain("改为使用 SQLite 数据库存储会话");
  });
  it("preserves durable Chinese preferences but not questions", () => {
    expect(extractPreferences([{ kind: "user", text: "以后都用简体中文回答" }])).toEqual(["以后都用简体中文回答"]);
    expect(extractPreferences([{ kind: "user", text: "以后都用中文回答？" }])).toEqual([]);
  });
  it("extracts Chinese causes and resolutions", () => {
    const c = extractCausalChain("原因是数据库连接超时。解决办法是增加重试机制。");
    expect(c.cause).toContain("数据库连接超时");
    expect(c.resolution).toContain("增加重试机制");
  });
  it("keeps an outstanding Chinese blocker", () => {
    const s = buildSections({ blocks: [{ kind: "user", text: "数据库连接失败，仍然无法写入会话。" }] });
    expect(s.outstandingContext.some(x => x.includes("数据库连接失败"))).toBe(true);
  });  it("keeps short Chinese task commands, but still ignores acknowledgements", () => {
    expect(extractGoals([{ kind: "user", text: "修复登录" }])).toEqual(["修复登录"]);
    expect(extractGoals([{ kind: "user", text: "好" }])).toEqual([]);
    expect(extractGoals([{ kind: "user", text: "修复登录" }, { kind: "user", text: "改用SQLite" }])).toContain("改用SQLite");
  });
  it("does not treat a bare 通过测试 as a resolution", () => {
    expect(extractCausalChain("通过测试并检查日志。").resolution).toBeNull();
  });

});
