import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivedMessageIds } from "../src/core/recall-visibility";
import { registerRecallTool } from "../src/tools/recall";
import { registerVccRecallCommand } from "../src/commands/vcc-recall";

const entries = [
  { type: "message", id: "old", message: {role:"user",content:"auth archived decision"} },
  { type: "message", id: "live1", message: {role:"user",content:"auth live visible context"} },
  { type: "compaction", id: "c1", firstKeptEntryId:"live1",details:{compactor:"pi-vcc"} },
  { type: "message", id: "live2", message: {role:"user",content:"newfeature live visible context"} },
];
describe("archived-first search", () => {
  it("identifies the archived prefix without treating live messages as archived", () => {
    expect([...archivedMessageIds(entries)!]).toEqual(["old"]);
    expect(archivedMessageIds(entries.filter(e=>e.type==="message"))).toBeUndefined();
    const bad = entries.map(e => ({ ...e }));
    (bad[2] as any).firstKeptEntryId = "missing";
    expect(archivedMessageIds(bad)).toBeUndefined();
    const allCompact = entries.map(e => ({ ...e }));
    (allCompact[2] as any).firstKeptEntryId = "";
    expect([...archivedMessageIds(allCompact)!]).toEqual(["old","live1"]);
  });
  it("searches archived history first, falls back to live only for missing old hits, and honors explicit scope", async () => {
    const dir = mkdtempSync(join(tmpdir(),"vcc-archive-"));
    const file = join(dir,"session.jsonl");
    try {
      writeFileSync(file,entries.map(e=>JSON.stringify(e)).join("\n")+"\n");
      const sessionManager = {getSessionFile:()=>file,getBranch:()=>entries,getEntries:()=>entries};
      let tool:any;
      registerRecallTool({registerTool:(x:any)=>tool=x} as any);
      const call=async(params:any)=>(await tool.execute("id",params,undefined,undefined,{sessionManager})).content[0].text as string;
      const historical=await call({query:"auth"});
      expect(historical).toContain("archived decision");
      expect(historical).not.toContain("live visible");
      const fallback=await call({query:"newfeature"});
      expect(fallback).toContain("newfeature live");
      const forced=await call({query:"auth",scope:"all"});
      expect(forced).toContain("auth live visible");
      const evidence=await call({evidenceId:"live1"});
      expect(evidence).toContain("auth live visible");
      let command:any, sent="";
      registerVccRecallCommand({registerCommand:(_name:string,x:any)=>command=x,
        sendMessage:(value:any)=>{sent=value.content;}} as any);
      await command.handler("auth",{sessionManager,ui:{notify(){}}} as any);
      expect(sent).toContain("archived decision");
      expect(sent).not.toContain("live visible");
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
