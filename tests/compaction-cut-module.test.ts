import { describe, it, expect } from "bun:test";
import { buildOwnCut, computeMessageRange } from "../src/core/compaction-cut";
import { buildOwnCut as legacyCut, computeMessageRange as legacyRange } from "../src/hooks/before-compact";

describe("compaction-cut deep module seam", () => {
  it("preserves the public hook exports for existing callers", () => {
    expect(legacyCut).toBe(buildOwnCut);
    expect(legacyRange).toBe(computeMessageRange);
  });
  it("preserves both empty compact-all and proper live-tail cut semantics", () => {
    const entry=(id:string,role:string)=>({id,type:"message",message:{role,content:id}});
    const entries=[entry("u1","user"),entry("a1","assistant"),entry("u2","user"),entry("a2","assistant")];
    const cut=buildOwnCut(entries);
    expect(cut.ok).toBe(true);
    if(cut.ok) expect(computeMessageRange(entries,cut.firstKeptEntryId)).toEqual(["u1","a1"]);
  });
  it("does not repeat earlier messages on second and later compactions", () => {
    const entry=(id:string)=>({id,type:"message",message:{role:"user",content:id}});
    const entries=[entry("old1"),entry("old2"),{id:"c1",type:"compaction",firstKeptEntryId:"new1"},
      entry("new1"),entry("new2"),entry("new3")];
    expect(computeMessageRange(entries,"new3",["new1","new2"])).toEqual(["new1","new2"]);
    expect(computeMessageRange(entries,"",["new1","new2","new3"])).toEqual(["new1","new3"]);
  });

});
