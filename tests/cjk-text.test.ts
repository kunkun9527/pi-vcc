import { describe, it, expect } from "bun:test";
import { clipSentence } from "../src/core/content";
import { compileBrief } from "../src/core/brief";
import { wrapLongLines } from "../src/core/format";
import { displayWidth, wrapBoundary, safeTruncationBoundary } from "../src/core/cjk";

describe("Chinese text boundaries", () => {
  it("clips at full-width sentence punctuation", () => {
    const text = "数据库连接失败。" + "请检查凭据。".repeat(20);
    expect(clipSentence(text, 22)).toBe("数据库连接失败。请检查凭据。请检查凭据。");
  });

  it("does not treat an unspaced Han paragraph as a single word", () => {
    const text = "修复数据库连接失败后重新执行测试。".repeat(40);
    const brief = compileBrief([{ kind: "user", text }]);
    expect(brief).toContain("...(truncated)");
    expect(brief.length).toBeLessThan(text.length);
  });

  it("wraps Chinese at terminal-cell boundaries without dropping characters", () => {
    const text = "修改数据库查询后检查结果。".repeat(12);
    const wrapped = wrapLongLines(text, 30);
    expect(wrapped.split("\n").every(line => displayWidth(line) <= 30)).toBe(true);
    expect(wrapped.replace(/\n/g, "")).toBe(text);
    expect(wrapBoundary("😀".repeat(12), 5) % 2).toBe(0);
    expect(displayWidth("中文，。")).toBe(8);
  });  it("never cuts into inline code, URLs or file paths", () => {
    const markdown = "先执行 `数据库连接错误` 再检查";
    expect(markdown.slice(0, safeTruncationBoundary(markdown, 9))).toBe("先执行 ");
    const url = "查看 https://example.com/路径/说明 继续";
    expect(url.slice(0, safeTruncationBoundary(url, 17)).trim()).toBe("查看");
  });

});
