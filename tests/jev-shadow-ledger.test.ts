import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevMode, jevEnabled, scoreMemoryDecisions } from "../src/core/jev-scorer";
import { rerankRecallHits } from "../src/core/jev-recall";
import { jevLedgerSummary, readJevLedger } from "../src/core/jev-ledger";
import { applyPanelValue, readPanelValue } from "../src/core/config-panel-model";
import { registerJevStatsCommand } from "../src/commands/pi-vcc-jev-stats";

describe("Jev shadow mode and privacy-safe ledger", () => {
  it("preserves legacy toggle and explicit env precedence without key", () => {
    const root=mkdtempSync(join(tmpdir(),"vcc-shadow-"));
    const env={PI_VCC_CONFIG_PATH:process.env.PI_VCC_CONFIG_PATH,PI_VCC_JEV_MODE:process.env.PI_VCC_JEV_MODE,
      PI_VCC_JEV_ENABLED:process.env.PI_VCC_JEV_ENABLED,JEVMODEL_API_KEY:process.env.JEVMODEL_API_KEY};
    try {
      process.env.PI_VCC_CONFIG_PATH=join(root,"config.json");
      delete process.env.PI_VCC_JEV_MODE;
      delete process.env.PI_VCC_JEV_ENABLED;
      delete process.env.JEVMODEL_API_KEY;
      expect(jevMode()).toBe("off");
      const raw: Record<string, unknown>={overrideDefaultCompaction:true,debug:false};
      applyPanelValue(raw,"jevEnabled","影子",{});
      expect(raw.jevMode).toBe("shadow");
      expect(raw.jevEnabled).toBe(true);
      expect(readPanelValue(raw as any,"jevEnabled",{})).toBe("影子");
      writeFileSync(process.env.PI_VCC_CONFIG_PATH,JSON.stringify(raw));
      expect(jevMode()).toBe("off"); // key required even in shadow
      process.env.JEVMODEL_API_KEY="test-credential";
      expect(jevMode()).toBe("shadow");
      expect(jevEnabled()).toBe(true);
      process.env.PI_VCC_JEV_ENABLED="0";
      expect(jevMode()).toBe("off");
      process.env.PI_VCC_JEV_MODE="active";
      expect(jevMode()).toBe("active");
      process.env.PI_VCC_JEV_MODE="off";
      expect(jevMode()).toBe("off");
      delete process.env.PI_VCC_JEV_MODE;
      process.env.PI_VCC_JEV_ENABLED="1";
      expect(jevMode()).toBe("active");
      applyPanelValue(raw,"jevEnabled","关闭",{});
      expect(raw.jevEnabled).toBe(false);
      expect(raw.jevMode).toBe("off");
    } finally {
      for(const [key,value] of Object.entries(env)) {
        if (value===undefined) delete process.env[key]; else process.env[key]=value;
      }
      rmSync(root,{recursive:true,force:true});
    }
  });
  it("shadow evaluates once, never alters orders, and logs no candidate text", async () => {
    const root=mkdtempSync(join(tmpdir(),"vcc-ledger-"));
    const old=process.env.PI_VCC_JEV_LEDGER_PATH;
    process.env.PI_VCC_JEV_LEDGER_PATH=join(root,"audit.jsonl");
    try {
      const hits=[
        {index:1,summary:"private@domain.test: token=sk-abcdef0123456789"},
        {index:2,summary:"必须修复登录"},
        {index:3,summary:"已解决登录错误"},
      ];
      let requests=0;
      const mock=async(_url:any,init:any):Promise<any>=>{
        requests++;
        const body=JSON.parse(init.body);
        expect(JSON.stringify(body)).not.toContain("sk-abcdef0123456789");
        return {ok:true,json:async()=>({answers:{
          relevance_1:{score:0,confidence:0.9},
          relevance_2:{score:3,confidence:0.9},
          relevance_3:{score:2,confidence:0.9},
        }})};
      };
      const same=await rerankRecallHits(hits,"login",{apiKey:"test-key",mode:"shadow",log:true,fetchImpl:mock as typeof fetch});
      expect(same).toBe(hits);
      expect(requests).toBe(1);
      const records=readJevLedger();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({operation:"recall",mode:"shadow",source:"judge",count:3,changed:true,applied:false});
      const text=readFileSync(process.env.PI_VCC_JEV_LEDGER_PATH!,"utf8");
      expect(text).not.toContain("private@domain.test");
      expect(text).not.toContain("sk-abcdef");
      expect(text).not.toContain("登录");
      expect(text).not.toContain("test-key");
      expect(jevLedgerSummary(records)).toContain("Shadow: 1");
      const active=await rerankRecallHits(hits,"login",{apiKey:"test-key",mode:"active",log:true,fetchImpl:mock as typeof fetch});
      expect(active.map(x=>x.index)).toEqual([2,3,1]);
      expect(readJevLedger()[1].applied).toBe(true);
    } finally {
      if(old===undefined) delete process.env.PI_VCC_JEV_LEDGER_PATH;
      else process.env.PI_VCC_JEV_LEDGER_PATH=old;
      rmSync(root,{recursive:true,force:true});
    }
  });
  it("shadow memory scores never override deterministic selection; failures are counted", async () => {
    const root=mkdtempSync(join(tmpdir(),"vcc-ledger-"));
    const old=process.env.PI_VCC_JEV_LEDGER_PATH;
    process.env.PI_VCC_JEV_LEDGER_PATH=join(root,"audit.jsonl");
    const facts=[{kind:"decision" as const,id:"abc",text:"决定采用方案A"},
      {kind:"decision" as const,id:"def",text:"决定采用方案B"}];
    try {
      const mock=async()=>({ok:true,json:async()=>({answers:{
        importance_1:{score:3,confidence:0.92},importance_2:{score:0,confidence:0.91},
      }})});
      expect(await scoreMemoryDecisions(facts,{apiKey:"key",mode:"shadow",log:true,fetchImpl:mock as typeof fetch})).toEqual({});
      const fail=async()=>{throw new Error("service offline");};
      expect(await scoreMemoryDecisions(facts,{apiKey:"key",mode:"active",log:true,fetchImpl:fail as typeof fetch})).toEqual({});
      expect(readJevLedger().map(row=>row.source)).toEqual(["judge","fallback"]);
      let command:any, summary="";
      registerJevStatsCommand({registerCommand:(_name:string,opts:any)=>{command=opts;}} as any);
      await command.handler("",{ui:{notify:(text:string)=>{summary=text;}}} as any);
      expect(summary).toContain("Valid: 1/2");
      expect(summary).toContain("fallback: 1");
    } finally {
      if(old===undefined) delete process.env.PI_VCC_JEV_LEDGER_PATH;
      else process.env.PI_VCC_JEV_LEDGER_PATH=old;
      rmSync(root,{recursive:true,force:true});
    }
  });
  it("counts a priority change only when Jev differs from newest-first baseline", async () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-jev-priority-"));
    const previous=process.env.PI_VCC_JEV_LEDGER_PATH;
    process.env.PI_VCC_JEV_LEDGER_PATH=join(dir,"audit.jsonl");
    try {
      const facts=[{kind:"decision" as const,id:"old",text:"决定采用旧方案"},
        {kind:"decision" as const,id:"mid",text:"决定采用中间方案"},
        {kind:"decision" as const,id:"new",text:"决定采用新方案"}];
      const judge=(scores:number[])=>async()=>({ok:true,json:async()=>({answers:Object.fromEntries(
        scores.map((score,i)=>["importance_"+(i+1),{score,confidence:0.95}]),
      )})});
      // Scores rise oldest->newest, so they do NOT change deterministic recency.
      await scoreMemoryDecisions(facts,{apiKey:"key",mode:"shadow",log:true,
        fetchImpl:judge([0,1,2]) as unknown as typeof fetch});
      // This genuinely promotes the oldest decision.
      await scoreMemoryDecisions(facts,{apiKey:"key",mode:"shadow",log:true,
        fetchImpl:judge([3,2,1]) as unknown as typeof fetch});
      const rows=readJevLedger();
      expect(rows.map(row=>row.changed)).toEqual([false,true]);
      expect(rows.map(row=>row.applied)).toEqual([false,false]);
      expect(jevLedgerSummary(rows)).toContain("potential priority changes: 1");
    } finally {
      if(previous===undefined) delete process.env.PI_VCC_JEV_LEDGER_PATH;
      else process.env.PI_VCC_JEV_LEDGER_PATH=previous;
      rmSync(dir,{recursive:true,force:true});
    }
  });

});
