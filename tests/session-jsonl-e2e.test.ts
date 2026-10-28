import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compile } from "../src/core/summarize";
import { parseMemory, memoryId } from "../src/core/long-memory";
import { auditMemoryCompaction } from "../src/core/memory-integrity";
import { registerRecallTool } from "../src/tools/recall";
import { userMsg, assistantText } from "./fixtures";

describe("Pi session JSONL and long-term compaction integration", () => {
  test("200 sequential Chinese handoffs recover original evidence by entry ID", async () => {
    const dir=mkdtempSync(join(tmpdir(),"pi-vcc-long-e2e-"));
    try {
      const source="项目必须始终使用中文回复，严禁删除生产数据";
      const blocker="数据库迁移仍然失败，尚未解决";
      const allEntries:any[] = [
        {type:"message",id:"initial-constraint",message:userMsg(source)},
        {type:"message",id:"initial-blocker",message:userMsg(blocker)},
      ];
      const activeIds=new Set<string>(["initial-constraint","initial-blocker"]);
      let summary=compile({messages:[userMsg(source),userMsg(blocker)],
        sourceEntryIds:["initial-constraint","initial-blocker"],activeSourceIds:activeIds});
      const firstId=memoryId("constraint",source), blockerId=memoryId("blocker",blocker);
      let preserved=0, peak=summary.length;
      for(let i=0;i<200;i++){
        const m=userMsg("继续完成第"+i+"轮：编写模块测试");
        const a=assistantText("决定采用接口版本 "+i+"，保持向后兼容");
        const ids=["turn-"+i+"-user","turn-"+i+"-assistant"];
        allEntries.push({type:"message",id:ids[0],message:m},{type:"message",id:ids[1],message:a});
        ids.forEach(id=>activeIds.add(id));
        const before=summary;
        summary=compile({messages:[m,a],previousSummary:summary,sourceEntryIds:ids,activeSourceIds:activeIds});
        const facts=parseMemory(summary);
        if(facts.some(f=>f.id===firstId && f.sourceId==="initial-constraint")
          && facts.some(f=>f.id===blockerId && f.sourceId==="initial-blocker")) preserved++;
        expect(auditMemoryCompaction(before,summary,new Set(),activeIds).missingProtected).toEqual([]);
        peak=Math.max(peak,summary.length);
      }
      expect(preserved).toBe(200);
      expect(peak).toBeLessThan(40000);
      const file=join(dir,"session.jsonl");
      writeFileSync(file,allEntries.map(e=>JSON.stringify(e)).join("\n")+"\n");
      let recall:any;
      registerRecallTool({registerTool:(tool:any)=>recall=tool} as any);
      const context={sessionManager:{getSessionFile:()=>file,getBranch:()=>allEntries,getEntries:()=>allEntries}};
      const result=await recall.execute("call",{evidenceId:"initial-constraint"},undefined,undefined,context);
      expect(result.content[0].text).toContain(source);
      const offBranch={sessionManager:{...context.sessionManager,getBranch:()=>allEntries.slice(2)}};
      const blocked=await recall.execute("call",{evidenceId:"initial-constraint"},undefined,undefined,offBranch);
      expect(blocked.content[0].text).toContain("not found");
      console.log("200-round session integration: 2/2 protected facts, "+preserved+"/200 handoffs, peak "+peak+" chars");
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
