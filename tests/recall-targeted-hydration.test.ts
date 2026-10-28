import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionEntries, readSessionEntryById, invalidateSessionEntries } from "../src/core/session-jsonl";
import { loadSelectedMessages } from "../src/core/load-messages";
import { registerRecallTool } from "../src/tools/recall";

describe("scoped and targeted giant JSONL restoration", () => {
  it("preserves offsets, selects only authorized IDs and original global indexes", async () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-target-evidence-")), file=join(dir,"session.jsonl");
    try {
      const a="A".repeat(2*1024*1024), b="B".repeat(2*1024*1024);
      const messages=[
        {type:"message",id:"first",message:{role:"user",content:"normal before"}},
        {type:"message",id:"giant-A",message:{role:"user",content:a}},
        {type:"message",id:"giant-B",message:{role:"user",content:b}},
        {type:"message",id:"last",message:{role:"user",content:"normal after"}},
      ];
      writeFileSync(file,messages.map(e=>JSON.stringify(e)).join("\n")+"\n");
      const entries=readSessionEntries(file);
      expect(entries[1].vccOmittedOffset).toBeGreaterThan(0);
      expect(entries[2].vccOmittedOffset).toBeGreaterThan(entries[1].vccOmittedOffset);
      expect(readSessionEntryById(file,"giant-B")?.message.content).toBe(b);
      const onlyA=loadSelectedMessages(file,{ids:new Set(["giant-A","giant-B"])},new Set(["giant-A"]));
      expect(onlyA.entryIds).toEqual(["giant-A"]);
      expect(onlyA.rendered.map(e=>e.index)).toEqual([1]);
      expect(onlyA.rawMessages[0].content).toBe(a);
      const onlyLast=loadSelectedMessages(file,{indices:new Set([3])},new Set(["last"]));
      expect(onlyLast.rendered.map(e=>e.index)).toEqual([3]);
      let tool:any;registerRecallTool({registerTool:(t:any)=>tool=t} as any);
      const manager={getSessionFile:()=>file,getBranch:()=>messages.filter(e=>e.id!=="giant-B"),
        getEntries:()=>messages};
      const call=async(params:any)=>(await tool.execute("id",params,undefined,undefined,{sessionManager:manager})).content[0].text as string;
      expect(await call({evidenceId:"giant-B"})).toContain("not found");
      const exact=await call({evidenceId:"giant-A"});
      expect(exact).toContain(a.slice(0,200));
      expect(exact).not.toContain(b.slice(0,200));
      const invalid=await call({expand:[2]});
      expect(invalid).toContain("outside");
      const selected=await call({expand:[1]});
      expect(selected).toContain(a.slice(0,200));
    } finally {invalidateSessionEntries();rmSync(dir,{recursive:true,force:true});}
  });
});
