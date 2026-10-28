import { describe, it, expect } from "bun:test";
import { rerankRecallHits } from "../src/core/jev-recall";

const hits = [
  { index: 1, summary: "数据库连接成功，用户列表展示正常" },
  { index: 2, summary: "数据库连接失败，根因是重试超时，已经修复" },
  { index: 3, summary: "登录页面按钮修改" },
];
describe("optional Jev recall rerank", () => {
  it("keeps lexical order without a key or with network failure", async () => {
    expect(await rerankRecallHits(hits, "数据库失败", { apiKey: "" })).toBe(hits);
    const fail = async () => { throw new Error("offline"); };
    expect(await rerankRecallHits(hits, "数据库失败", { apiKey: "test", fetchImpl: fail as typeof fetch })).toBe(hits);
  });
  it("ranks only matching candidates and preserves original indices", async () => {
    let n = 0;
    const mock = async (_url: any, init: any): Promise<any> => {
      n++;
      const body = JSON.parse(init.body);
      expect(body.state.query).toContain("数据库失败");
      return {ok:true,json:async()=>({ answers: { relevance: {score: [1, 3, 0][n-1],confidence:0.98} } })};
    };
    const ranked = await rerankRecallHits(hits, "数据库失败", { apiKey:"test", maxCandidates:3, fetchImpl:mock as typeof fetch });
    expect(ranked.map(h => h.index)).toEqual([2,1,3]);
    expect(hits.map(h => h.index)).toEqual([1,2,3]);
  });
  it("does not reorder on malformed low-confidence answer", async () => {
    const mock = async () => ({ok:true,json:async()=>({answers:{relevance:{score:3,confidence:0.2}}})});
    expect(await rerankRecallHits(hits, "失败", {apiKey:"test",fetchImpl:mock as typeof fetch})).toBe(hits);
  });
});
