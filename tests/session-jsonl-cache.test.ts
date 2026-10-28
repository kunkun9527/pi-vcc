import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionEntries, invalidateSessionEntries } from "../src/core/session-jsonl";

describe("shared bounded session reader", () => {
  it("reuses an unchanged snapshot and invalidates on append", () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-reader-"));
    const path=join(dir,"session.jsonl");
    try {
      writeFileSync(path, JSON.stringify({ type:"message",id:"a" }) + "\n");
      const first=readSessionEntries(path);
      expect(readSessionEntries(path)).toBe(first);
      appendFileSync(path, JSON.stringify({ type:"message",id:"b" }) + "\n");
      const second=readSessionEntries(path);
      expect(second).not.toBe(first);
      expect(second.map(e=>e.id)).toEqual(["a","b"]);
      invalidateSessionEntries(path);
      expect(readSessionEntries(path)).not.toBe(second);
    } finally {invalidateSessionEntries();rmSync(dir,{recursive:true,force:true});}
  });
  it("skips malformed JSONL lines without losing subsequent entries", () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-reader-"));
    const path=join(dir,"session.jsonl");
    try {
      writeFileSync(path, "{broken\n"+JSON.stringify({id:"ok"})+"\n");
      expect(readSessionEntries(path).map(e=>e.id)).toEqual(["ok"]);
    } finally {invalidateSessionEntries();rmSync(dir,{recursive:true,force:true});}
  });
});
