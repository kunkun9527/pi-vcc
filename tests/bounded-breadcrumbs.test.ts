import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import { userMsg } from "./fixtures";
describe("bounded summary breadcrumbs", () => {
  it("stays bounded after hundreds of distinct old recall hints", () => {
    let summary = "[Session Goal]\n- Goal initial\n\n---\n\n[user]\nstart";
    for (let round = 0; round < 150; round++) {
      const goals = Array.from({ length: 10 }, (_, i) =>
        `- Feature ${round}-${i} on unique${round}_${i}.ts`).join("\n");
      summary = compile({ messages: [userMsg("continue")],
        previousSummary: summary.replace("[Session Goal]", "[Session Goal]\n" + goals) });
    }
    const goalPart = summary.split("[Session Goal]")[1]?.split(/\n\n\[/)[0] ?? "";
    const breadcrumbs = goalPart.split("\n").filter(line => line.startsWith("- ...recall:"));
    expect(breadcrumbs.length).toBeLessThanOrEqual(12);
    expect(breadcrumbs.every(line => line.length <= 240)).toBe(true);
    expect(summary.length).toBeLessThan(30000);
  });
  it("caps path breadcrumb count but preserves the most useful initial hints", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `src/mod${i}.ts`).join(", ");
    const summary = compile({ messages: [userMsg("continue")], previousSummary:
      "[Files And Changes]\n- Read: " + paths + "\n\n---\n\n[user]\nprevious" });
    expect(summary).toContain("src/mod0.ts");
    expect(summary).toContain("src/mod10.ts");
    expect(summary.length).toBeLessThan(5000);
  });
});
