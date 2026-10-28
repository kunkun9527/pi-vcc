import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/core/summarize";
import { parseMemory } from "../src/core/long-memory";
import { captureCodeChangeSnapshot, extractMemoryFiles, trackCodeMemory } from "../src/core/memory-freshness";
import { userMsg } from "./fixtures";

describe("Git-aware code memory freshness", () => {
  it("extracts two explicit code files without inventing associations", () => {
    expect(extractMemoryFiles("决定把 src/auth.ts 和 src/db/schema.sql 作为来源")).toEqual(["src/auth.ts", "src/db/schema.sql"]);
    expect(extractMemoryFiles("我们决定未来维护用户体验")).toEqual([]);
  });
  it("marks code claims for review after committed or uncommitted file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcc-freshness-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).trim();
    try {
      run("init", "-q");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir,"src/auth.ts"), "export const method = 'jwt';\n");
      run("add", ".");
      run("-c", "user.name=Test", "-c", "user.email=tests@example.org", "commit", "-qm", "start");
      const original = captureCodeChangeSnapshot(dir)!;
      const text = "决定使用 src/auth.ts 的 JWT 认证";
      const summary = compile({ messages: [userMsg(text)], sourceEntryIds:["msg-1"], codeSnapshot: original });
      expect(summary).toContain("state:tracked");
      const item = parseMemory(summary).find(f => f.text === text)!;
      expect(item.relatedFiles).toEqual(["src/auth.ts"]);
      const stable = compile({messages:[userMsg("继续修复测试")],previousSummary:summary,
        codeSnapshot:captureCodeChangeSnapshot(dir)});
      expect(stable).toContain("state:tracked");
      writeFileSync(join(dir,"src/auth.ts"), "export const method = 'session';\n");
      const dirty = compile({ messages: [userMsg("继续修复测试")], previousSummary:stable,
        codeSnapshot: captureCodeChangeSnapshot(dir) });
      expect(dirty).toContain("state:needs-review");
      run("add",".");
      run("-c","user.name=Test","-c","user.email=tests@example.org","commit","-qm","switch auth");
      const committed = compile({ messages: [userMsg("继续执行任务")], previousSummary:dirty,
        codeSnapshot: captureCodeChangeSnapshot(dir) });
      expect(committed).toContain("state:needs-review");
      const verifiedAgain = compile({ messages:[userMsg(text)], previousSummary: committed,
        codeSnapshot: captureCodeChangeSnapshot(dir) });
      expect(verifiedAgain).toContain("state:tracked");
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it("never upgrades unknown or old review flags without a matching source snapshot", () => {
    const item = { kind:"decision" as const,id:"12345678",text:"决定维护 src/auth.ts", relatedFiles:["src/auth.ts"],baselineCommit:"ffffffffffff" };
    expect(trackCodeMemory([item])[0].freshness).toBe("unknown");
    const snapshot = {head:"a".repeat(40),dirtyPaths:new Set<string>(),changedSince:()=>undefined};
    expect(trackCodeMemory([item],snapshot)[0].freshness).toBe("needs-review");
    expect(trackCodeMemory([{...item,freshness:"needs-review"}],{
      ...snapshot,changedSince:()=>new Set<string>(),
    })[0].freshness).toBe("needs-review");
  });
});
