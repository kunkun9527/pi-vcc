import { describe, it, expect } from "bun:test";
import { jevEnabled, redactMemoryForJev, scoreMemoryDecisions } from "../src/core/jev-scorer";
import { memoryId, selectMemory, type MemoryFact } from "../src/core/long-memory";

const decisions: MemoryFact[] = ["我们决定采用 SQLite 作为本地会话存储", "决定使用文本日志作为默认输出格式"]
  .map(text => ({ kind: "decision", id: memoryId("decision", text), text }));

describe("optional Jev scoring", () => {
  it("never enables network calls by default", async () => {
    const calls: string[] = [];
    const scores = await scoreMemoryDecisions(decisions, { apiKey: "", fetchImpl: (async (url: any) => { calls.push(String(url)); throw new Error("unexpected network"); }) as typeof fetch });
    expect(scores).toEqual({});
    expect(calls).toHaveLength(0);
  });
  it("sends only bounded and redacted candidate state", async () => {
    let requests = 0;
    const mock = async (_url: any, init: any): Promise<any> => {
      requests++;
      const body = JSON.parse(init.body);
      expect(body.model).toBe("jev-latest");
      expect(body.questions.importance.type).toBe("score");
      expect(body.state.candidate).not.toContain("sk-1234567890abcdef");
      return { ok: true, json: async () => ({ answers: { importance: { score: requests, confidence: 0.95 } } }) };
    };
    const input = [{ ...decisions[0], text: "决定使用 token=sk-1234567890abcdef 作为错误示例" }];
    const scores = await scoreMemoryDecisions(input, { apiKey: "test-only", fetchImpl: mock as typeof fetch });
    expect(Object.keys(scores)).toEqual([decisions[0].id]);
    expect(requests).toBe(1);
    expect(redactMemoryForJev("Email me at a@b.com, token=sk-1234567890abcdef")).not.toContain("a@b.com");
  });
  it("falls back to deterministic decisions on timeout or malformed data", async () => {
    const mock = async () => { throw new Error("timeout"); };
    const result = await scoreMemoryDecisions(decisions, { apiKey: "test", fetchImpl: mock as typeof fetch });
    expect(result).toEqual({});
    expect(selectMemory(decisions)).toEqual(selectMemory(decisions, result));
  });
  it("does not use low confidence or invalid scoring responses", async () => {
    const mock = async () => ({ok:true,json:async()=>({answers:{importance:{score:3,confidence:0.1}}})});
    expect(await scoreMemoryDecisions(decisions,{apiKey:"test",fetchImpl:mock as typeof fetch})).toEqual({});
  });
  it("scores four candidate decisions in a single bounded System One call", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      kind: "decision" as const, id: "id_" + i, text: "决定使用策略 " + i,
    }));
    let calls = 0;
    const fetchImpl = async (_url: any, init: any) => {
      calls++;
      const body = JSON.parse(init.body);
      expect(Object.keys(body.questions)).toEqual(["importance_1","importance_2","importance_3","importance_4"]);
      expect(body.state.candidate_4).toContain("策略 3");
      return {ok:true,json:async()=>({answers:Object.fromEntries(
        [1,2,3,0].map((score,i)=>["importance_"+(i+1),{score,confidence:0.9}]),
      )})};
    };
    expect(await scoreMemoryDecisions(many,{apiKey:"test",fetchImpl:fetchImpl as typeof fetch}))
      .toEqual({id_0:1,id_1:2,id_2:3,id_3:0});
    expect(calls).toBe(1);
  });
  it("rejects partial multi-answer responses without using biased partial scores", async () => {
    const fetchImpl = async () => ({ok:true,json:async()=>({answers:{
      importance_1:{score:3,confidence:0.99},
    }})});
    expect(await scoreMemoryDecisions(decisions,{apiKey:"test",fetchImpl:fetchImpl as typeof fetch}))
      .toEqual({});
  });

});
