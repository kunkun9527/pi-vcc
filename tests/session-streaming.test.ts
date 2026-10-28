import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionEntries, readSessionEntryById, invalidateSessionEntries } from "../src/core/session-jsonl";
import { loadAllMessages } from "../src/core/load-messages";

describe("streaming JSONL with oversized entries", () => {
  it("keeps ordinal and IDs for 2MiB image lines while allowing exact evidence expansion", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcc-stream-"));
    const path = join(dir, "session.jsonl");
    try {
      const giant = "z".repeat(2 * 1024 * 1024);
      const entries = [
        { type: "session", id: "s1" },
        { type: "message", id: "first", message: { role: "user", content: "开头" } },
        { type: "message", id: "giant", message: { role: "user", content: giant } },
        { type: "message", id: "after", message: { role: "user", content: "最后一条" } },
      ];
      writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
      const compact = readSessionEntries(path);
      expect(compact.map(e => e.id)).toEqual(["s1", "first", "giant", "after"]);
      expect(compact[2].vccOmittedBytes).toBeGreaterThan(1024 * 1024);
      expect(JSON.stringify(compact).length).toBeLessThan(4096);
      const normal = loadAllMessages(path, false);
      expect(normal.rendered.map(x => x.index)).toEqual([0,1,2]);
      const expanded = loadAllMessages(path, true, new Set(["giant"]));
      expect(expanded.entryIds).toEqual(["giant"]);
      expect(expanded.rawMessages[0].content).toBe(giant);
      expect(readSessionEntryById(path, "after")?.message?.content).toBe("最后一条");
    } finally { invalidateSessionEntries(); rmSync(dir, { recursive:true, force:true }); }
  });
  it("preserves UTF-8 across buffer boundaries and skips malformed lines without index shifts", () => {
    const dir = mkdtempSync(join(tmpdir(),"vcc-stream-"));
    const file = join(dir,"s.jsonl");
    try {
      const chinese = "文".repeat(23000);
      writeFileSync(file, [
        JSON.stringify({type:"message",id:"a",message:{role:"user",content:chinese}}),
        "{bad json",
        JSON.stringify({type:"message",id:"b",message:{role:"user",content:"结束"}}),
      ].join("\n"));
      expect(readSessionEntries(file).filter(x=>x.type==="message").map(x=>x.id)).toEqual(["a","b"]);
      expect(readSessionEntryById(file,"a")?.message?.content).toBe(chinese);
    } finally { invalidateSessionEntries();rmSync(dir,{recursive:true,force:true}); }
  });
});
