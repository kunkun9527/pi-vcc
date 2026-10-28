import { describe, it, expect } from "bun:test";
import { planContextBudget, overflowLimit, ContextWindowLearner } from "../src/core/context-budget";

describe("adaptive compaction budget", () => {
  it("does not reserve output on Anthropic messages API", () => {
    const a=planContextBudget({api:"anthropic-messages",contextWindow:200000,maxTokens:64000});
    const o=planContextBudget({api:"openai-responses",contextWindow:200000,maxTokens:64000});
    expect(a.outputReserve).toBe(0);
    expect(o.outputReserve).toBe(50000);
    expect(a.maxKeptTokens).toBeGreaterThan(o.maxKeptTokens);
  });
  it("caps huge output reservations and keeps tiny context windows safe", () => {
    const a=planContextBudget({api:"openai-responses",contextWindow:8192,maxTokens:131072});
    expect(a.outputReserve).toBe(2048);
    const tiny=planContextBudget({contextWindow:1024,maxTokens:64000});
    expect(tiny.maxKeptTokens).toBeGreaterThan(0);
    expect(tiny.maxKeptTokens).toBeLessThan(1024);
    expect(planContextBudget(undefined,8000).maxKeptTokens).toBe(8000);
  });
  it("learns actual limits from provider errors and isolates sessions/models", () => {
    expect(overflowLimit("prompt is too long: 150000 tokens > 128,000 maximum")).toBe(128000);
    expect(overflowLimit("maximum context length is 64,000 tokens")).toBe(64000);
    expect(overflowLimit("429 rate limit")).toBeUndefined();
    const learner=new ContextWindowLearner();
    const model={provider:"openai",id:"test",contextWindow:200000,maxTokens:10000};
    expect(learner.observe("session-a",model,"maximum context length is 128000 tokens")).toBe(128000);
    expect(learner.get("session-b",model)).toBeUndefined();
    expect(learner.get("session-a",{...model,id:"other"})).toBeUndefined();
    const plan=planContextBudget(model,20000,learner.get("session-a",model));
    expect(plan.learned).toBe(true);
    expect(plan.contextWindow).toBe(128000);
    learner.forget("session-a");
    expect(learner.get("session-a",model)).toBeUndefined();
  });
});
