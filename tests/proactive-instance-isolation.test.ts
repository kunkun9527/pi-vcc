import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProactiveThresholdHook } from "../src/hooks/proactive-threshold";
import { ProactiveState } from "../src/core/proactive-state";

const fakePi = () => {
  const callbacks = new Map<string,((evt:any,ctx:any)=>void)[]>();
  const pi = {on:(name:string,handler:any)=>{
    callbacks.set(name,[...(callbacks.get(name)??[]),handler]);
  }};
  return {pi, emit:(event:string,ctx:any,data:any={})=>{
    for(const fn of callbacks.get(event)??[])fn(data,ctx);
  }};
};
describe("per-instance proactive compaction state", () => {
  it("does not share cooldown, in-flight flag or Codex recovery between Pi instances", () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-proactive-isolation-"));
    const old=process.env.PI_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH=join(dir,"settings.json");
    try {
      writeFileSync(process.env.PI_VCC_CONFIG_PATH,JSON.stringify({
        overrideDefaultCompaction:true,globalThreshold:{compactAtTokens:1000},
      }));
      const a=fakePi(),b=fakePi(),stateA=new ProactiveState(),stateB=new ProactiveState();
      registerProactiveThresholdHook(a.pi as any,stateA);
      registerProactiveThresholdHook(b.pi as any,stateB);
      let callsA=0,callsB=0;
      const ctx=(compact:()=>void)=>({
        model:{provider:"vendor",id:"test",contextWindow:10000},
        getContextUsage:()=>({tokens:9000,contextWindow:10000,percent:90}),
        compact,ui:{notify:()=>{}},
        sessionManager:{getCwd:()=>dir},
      });
      const ctxA=ctx(()=>callsA++),ctxB=ctx(()=>callsB++);
      a.emit("agent_end",ctxA,{messages:[]});
      expect(callsA).toBe(1);
      expect(stateA.isTriggered()).toBe(true);
      expect(stateB.isTriggered()).toBe(false);
      b.emit("agent_end",ctxB,{messages:[]});
      expect(callsB).toBe(1);
      expect(stateB.isTriggered()).toBe(true);
      a.emit("session_compact",ctxA);
      expect(stateA.isTriggered()).toBe(false);
      expect(stateB.isTriggered()).toBe(true);
      a.emit("session_start",ctxA);
      expect(stateB.isTriggered()).toBe(true);
      const overflow = {role:"assistant",api:"openai-codex-responses",provider:"openai-codex",
        stopReason:"error",errorMessage:"request exceeds the context window"};
      a.emit("agent_end",ctxA,{messages:[overflow]});
      expect(stateA.isOverflowPending()).toBe(true);
      expect(stateB.isOverflowPending()).toBe(false);
      a.emit("session_start",ctxA);
      expect(stateA.isOverflowPending()).toBe(false);
      expect(stateB.isTriggered()).toBe(true);
    } finally {
      if(old===undefined)delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH=old;
      rmSync(dir,{recursive:true,force:true});
    }
  });
});
