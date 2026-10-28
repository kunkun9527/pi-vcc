import { describe, it, expect } from "bun:test";
import { estimateTextTokens } from "../src/core/cjk";

describe("mixed Chinese and English token estimates", () => {
  it("does not underestimate Han by dividing character count by four", () => {
    expect(estimateTextTokens("汉".repeat(80))).toBe(80);
    expect(estimateTextTokens("abcd".repeat(20))).toBe(20);
  });
  it("estimates Japanese and emoji more conservatively than ASCII", () => {
    expect(estimateTextTokens("こんにちは")).toBe(5);
    expect(estimateTextTokens("🏃".repeat(3))).toBe(6);
  });
  it("is monotonic for mixed scripts", () => {
    const base = "Fix the database error";
    expect(estimateTextTokens(base + "连接失败")).toBeGreaterThan(estimateTextTokens(base));
  });
});
