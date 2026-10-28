import { describe, it, expect } from "bun:test";
import { memoryId, parseMemory, formatMemory } from "../src/core/long-memory";
import { registerJevMemoryRanker } from "../src/hooks/jev-memory";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory parser provenance", () => {
  it("refuses to attach an invalid or duplicate fact's source to a prior record", () => {
    const text = "项目必须使用简体中文";
    const id = memoryId("constraint", text);
    const valid = `- [constraint:${id}] ${text}`;
    const duplicate = `- [constraint:${id}] ${text}`;
    const corrupt = "- [decision:deadbeef] 决定使用新的方案";
    const source = "  @source:wrong-entry status:confirmed";
    const prev = parseMemory(`[Long-term Memory]\n${valid}\n  @source:good-entry status:confirmed\n${corrupt}\n${source}\n${duplicate}\n${source}`);
    expect(prev).toHaveLength(1);
    expect(prev[0].sourceId).toBe("good-entry");
    expect(prev[0].status).toBe("confirmed");
  });
  it("does not accept metadata after a foreign section or malformed metadata", () => {
    const text = "数据库连接仍然失败";
    const id = memoryId("blocker", text);
    expect(parseMemory(`- [blocker:${id}] ${text}\n[Earlier Turns]\n  @source:wrong status:confirmed`)[0].sourceId).toBeUndefined();
    expect(parseMemory(`- [blocker:${id}] ${text}\n  @source:bad value\n  @source:wrong status:confirmed`)[0].sourceId).toBeUndefined();
    const original = formatMemory([{kind:"blocker",id,text,sourceId:"first",status:"confirmed"}]);
    expect(parseMemory(original)[0].sourceId).toBe("first");
  });
});

describe("Jev mode transitions at compaction boundary", () => {
  it("drops an active cache immediately when switched to shadow/off; late results are discarded", async () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-jev-mode-"));
    const env={PI_VCC_CONFIG_PATH:process.env.PI_VCC_CONFIG_PATH, PI_VCC_JEV_MODE:process.env.PI_VCC_JEV_MODE,
      JEVMODEL_API_KEY:process.env.JEVMODEL_API_KEY,PI_VCC_JEV_ENABLED:process.env.PI_VCC_JEV_ENABLED};
    process.env.PI_VCC_CONFIG_PATH=join(dir,"config.json");
    process.env.JEVMODEL_API_KEY="test-key";
    delete process.env.PI_VCC_JEV_ENABLED;
    process.env.PI_VCC_JEV_MODE="active";
    const events: Record<string,(e:any,ctx:any)=>any>={};
    try {
      let release: ((scores: Record<string, number>) => void) | undefined;
      const fakeScorer = () => new Promise<Record<string,number>>(resolve => { release = resolve; });
      const getScores=registerJevMemoryRanker({on:(n:string,cb:any)=>{events[n]=cb;}} as any, fakeScorer as any);
      const message={role:"assistant",content:[{type:"text",text:"决定采用 PostgreSQL 数据库"}]};
      const ctx={sessionManager:{getSessionFile:()=>"session-a",getBranch:()=>[{type:"message",message}]}};
      const active = events.agent_end({},ctx);
      expect(release).toBeDefined();
      release!({decision001:3});
      await active;
      expect(getScores()).toEqual({decision001:3});
      process.env.PI_VCC_JEV_MODE="shadow";
      expect(getScores()).toEqual({});
      process.env.PI_VCC_JEV_MODE="off";
      expect(getScores()).toEqual({});
      process.env.PI_VCC_JEV_MODE="active";
      expect(getScores()).toEqual({});
      // A late response from an old generation cannot restore stale scores.
      const pending = events.agent_end({},ctx);
      if (release) {
        process.env.PI_VCC_JEV_MODE="shadow";
        expect(getScores()).toEqual({});
        release({decision002:3});
        await pending;
      }
      process.env.PI_VCC_JEV_MODE="active";
      expect(getScores()).toEqual({});

    } finally {
      for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
      rmSync(dir,{recursive:true,force:true});
    }
  });
});
