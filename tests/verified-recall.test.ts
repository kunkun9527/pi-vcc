import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall";
import { loadAllMessages } from "../src/core/load-messages";
import { auditMemoryCompaction, verifiedFact } from "../src/core/memory-integrity";
import { compile } from "../src/core/summarize";
import { parseMemory } from "../src/core/long-memory";
import { userMsg } from "./fixtures";

describe("verified recall and compaction integrity", () => {
  it("returns exact evidence without lexical matching but respects lineage", async () => {
    const dir=mkdtempSync(join(tmpdir(),"pi-vcc-evidence-"));
    try {
      const file=join(dir,"session.jsonl");
      const entries=[
        {type:"message",id:"entry-A",message:{role:"user",content:"必须保护数据，禁止删除表"}},
        {type:"message",id:"off-branch",message:{role:"user",content:"旧分支密钥内容"}},
      ];
      writeFileSync(file,entries.map(x=>JSON.stringify(x)).join("\n")+"\n");
      expect(loadAllMessages(file,false).entryIds).toEqual(["entry-A","off-branch"]);
      let tool:any;
      registerRecallTool({registerTool:(t:any)=>tool=t} as any);
      const ctx={sessionManager:{getSessionFile:()=>file,getBranch:()=>[{id:"entry-A"}],getEntries:()=>entries}};
      const call=async(args:any)=>(await tool.execute("id",args,undefined,undefined,ctx)).content[0].text as string;
      expect(await call({evidenceId:"entry-A"})).toContain("必须保护数据");
      expect(await call({evidenceId:"off-branch"})).toContain("not found");
      expect(await call({evidenceId:"off-branch",scope:"all"})).toContain("旧分支密钥内容");
      expect(await call({evidenceId:"missing"})).toContain("not found");
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("spots missing or fabricated protected facts and validates source IDs", () => {
    const text="项目必须一直使用简体中文";
    const previous=compile({messages:[userMsg(text)],sourceEntryIds:["entry-A"]});
    const fact=parseMemory(previous)[0];
    expect(verifiedFact(fact,new Set(["entry-A"]))).toBe(true);
    expect(verifiedFact(fact,new Set(["entry-B"]))).toBe(false);
    const lost=auditMemoryCompaction(previous,"[Long-term Memory]",new Set(),new Set(["entry-A"]));
    expect(lost.missingProtected).toContain(fact.id);
    const kept=auditMemoryCompaction(previous,previous,new Set(),new Set(["entry-A"]));
    expect(kept.missingProtected).toEqual([]);
    expect(kept.missingEvidence).toEqual([]);
    const intentionallyRetired=auditMemoryCompaction(previous,"",new Set([fact.id]),new Set(["entry-A"]));
    expect(intentionallyRetired.missingProtected).toEqual([]);
  });
});
