import { describe, it, expect } from "bun:test";
import { computeMessageRange } from "../src/hooks/before-compact";

const entry = (id: string) => ({ id, type: "message", message: { role: "user", content: id } });

describe("summarized message ranges", () => {
  it("includes all messages when compact-all sentinel is empty", () => {
    expect(computeMessageRange([entry("a"), entry("b"), entry("c")], "")).toEqual(["a", "c"]);
  });
  it("excludes first kept message from summarized range", () => {
    expect(computeMessageRange([entry("a"), entry("b"), entry("c")], "c")).toEqual(["a", "b"]);
  });
  it("does not record a range if nothing was summarized or there is no valid cut", () => {
    expect(computeMessageRange([entry("a"), entry("b")], "a")).toBeUndefined();
    expect(computeMessageRange([entry("a"), entry("b")], "missing")).toBeUndefined();
    expect(computeMessageRange([], "")).toBeUndefined();
  });
});
