import { describe, it, expect } from "bun:test";
import { refineBreadcrumbKey } from "../src/core/causal-keys";
import { clipSentence } from "../src/core/content";
import { buildCompactReport } from "../src/core/report";

describe("CJK compaction safety", () => {
  it("keeps causal breadcrumbs bounded for unspaced Chinese", () => {
    const fragment = "因此修复数据库连接失败的问题并增加重试机制以避免再次超时";
    const key = refineBreadcrumbKey(fragment);
    expect(key.length).toBeLessThanOrEqual(18);
    expect(key.startsWith("修复数据库")).toBe(true);
    expect(refineBreadcrumbKey("add client-side token refresh")).toContain("client-side");
  });
  it("never cuts within code or file paths when clipping sentences", () => {
    const inline = "开始 `内部。代码` 然后继续说明。继续。";
    expect(clipSentence(inline, 8)).toBe("开始 ");
    const path = "查看 /home/user/中文/文件.ts 之后继续工作，确认修复。";
    expect(clipSentence(path, 14).trim()).toBe("查看");
  });
  it("uses Chinese lexical probes in compaction diagnostics", () => {
    const report = buildCompactReport({
      messages: [{ role: "user", content: "请修复数据库连接失败的问题" } as any],
    });
    const query = report.recall.probes.find(p => p.label === "goal")?.query ?? "";
    expect(query).toContain("数据");
    expect(query.length).toBeLessThan(55);
  });
});
