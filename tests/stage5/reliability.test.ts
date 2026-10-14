import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { askAnalyst, unsupportedNumbers, type HistoryTurn, type Plan } from "@/lib/analyst/agent";
import { emptyToolArgs as A } from "@/lib/analyst/tools";
import { ClaudeClient, GeminiClient, ModelUnavailableError, classifyGeminiError } from "@/lib/ai/client";
import { AIConfigError, getAIConfig, type GeminiConfig } from "@/lib/ai/model";
import { applyReviewAction, recompute } from "@/lib/bids/hitl";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { runScenario } from "@/lib/scenarios/engine";
import { emptyConstraints, emptyDecision } from "@/lib/scenarios/types";
import { assertFrozen, EvalConfigError, loadEvalConfig } from "../../eval/config";
import { FakeLLM } from "../fixtures/fake-client";
import { scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const cfg: GeminiConfig = { provider: "gemini", apiKey: "test", model: "pinned-model", temperature: 0.2, thinkingLevel: "LOW", timeoutMs: 1000 };

class ScriptedGemini extends GeminiClient {
  constructor(private errors: unknown[], waits: number[]) { super(cfg, { sleep: async (ms) => { waits.push(ms); } }); }
  protected async callOnce(): Promise<string> { const e = this.errors.shift(); if (e) throw e; return "{}"; }
}

describe("Gemini failure handling", () => {
  it("(9) 503: bounded exponential backoff, max 3 attempts, then a clear overloaded error", async () => {
    const waits: number[] = [];
    const c = new ScriptedGemini([{ status: 503, message: "high demand" }, { status: 503, message: "x" }, { status: 503, message: "x" }, { status: 503 }], waits);
    const err = await c.generateJson({ system: "", prompt: "", jsonSchema: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.kind).toBe("overloaded");
    expect(c.calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
    const ok = new ScriptedGemini([{ status: 503 }], []);
    expect(await ok.generateJson({ system: "", prompt: "", jsonSchema: {} })).toBe("{}");
    expect(ok.retries).toBe(1);
  });

  it("(10) quota exhaustion fails immediately (one call, no retry); timeout is not retried; model is never changed", async () => {
    const quota = { status: 429, message: JSON.stringify({ error: { details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9000s" }] } }) };
    const c = new ScriptedGemini([quota], []);
    const err = await c.generateJson({ system: "", prompt: "", jsonSchema: {} }).catch((e) => e);
    expect(err.kind).toBe("quota_exhausted");
    expect(c.calls).toBe(1);
    expect(c.model).toBe("pinned-model");
    expect(classifyGeminiError({ status: 504 }, "m", 1000)).toMatchObject({ kind: "timeout", retryable: false });
    expect(classifyGeminiError({ status: 429, message: "slow down" }, "m", 1000)).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(err.message).not.toMatch(/another Flash model/);
  });

  it("(13) model cannot silently switch: missing GEMINI_MODEL fails; eval aborts on mismatch", () => {
    expect(() => getAIConfig({ GEMINI_API_KEY: "k" })).toThrow(AIConfigError);
    const frozen = loadEvalConfig();
    const modelVar = `${frozen.provider.toUpperCase()}_MODEL`;
    const envFor = (model: string) => ({ LLM_PRIMARY_PROVIDER: frozen.provider, [modelVar]: model });
    expect(() => assertFrozen(frozen, envFor("some-other-model"), { checkDataset: false })).toThrow(EvalConfigError);
    expect(() => assertFrozen(frozen, { LLM_PRIMARY_PROVIDER: frozen.provider === "gemini" ? "openai" : "gemini", OPENAI_MODEL: frozen.model, GEMINI_MODEL: frozen.model }, { checkDataset: false })).toThrow(/frozen to/);
    expect(() => assertFrozen(frozen, envFor(frozen.model), { checkDataset: false })).not.toThrow();
    expect(() => assertFrozen(frozen, envFor(frozen.model))).not.toThrow(); // dataset hash matches the frozen one
  });

  it("(14) model keys stay server-side", () => {
    const client = ["components/RfxWorkspace.tsx", "components/BidWorkspace.tsx", "components/AnalystWorkspace.tsx", "components/DecisionWorkspace.tsx", "components/CompareWorkspace.tsx", "lib/client/bid-store.ts"];
    for (const f of client) expect(readFileSync(f, "utf8")).not.toMatch(/process\.env|@\/lib\/ai\/(model|client)/);
    expect(readFileSync("lib/ai/model.ts", "utf8")).toMatch(/import "server-only"/);
    expect(readFileSync("lib/ai/client.ts", "utf8")).toMatch(/import "server-only"/);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^GEMINI_API_KEY=$/m);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^GEMINI_MODEL=$/m);
    expect(readFileSync("next.config.ts", "utf8")).not.toMatch(/\benv\s*:/);
    expect(path.basename(ClaudeClient.name)).toBe("ClaudeClient");
  });
});

describe("HITL recomputation reaches scenarios; audit history", () => {
  it("(6,7) a human correction updates the bid, comparison inputs and scenario totals; extraction and audit preserved", () => {
    const bids = scenarioBids(ctx);
    const v1 = recompute({ ...bids[0], finalized_at: null, extraction: { ...bids[0].extraction,
      quotes: bids[0].extraction.quotes.map((q) => (q.rfx_line_id === "CP-001" ? { ...q, ambiguity: "digit unclear", alternative_values: [9.9] } : q)) } }, ctx);
    const item = v1.exceptions.find((e) => e.id === "line:CP-001:ambiguous_text")!;
    expect(item.status).toBe("open");
    const scen = (b: typeof v1) => runScenario(ctx, [b], { scenario_id: "T", name: "T", kind: "custom", constraints: { ...emptyConstraints(), include_unfinalized: true } });
    const before = scen(v1);
    const corrected = applyReviewAction(v1, { review_item_id: item.id, action: "edit", value: 7.0, note: "confirmed" }, ctx, new Date("2026-10-14T11:00:00Z"));
    const line = corrected.line_items.find((l) => l.rfx_line_id === "CP-001")!;
    expect(line).toMatchObject({ normalized_unit_price_inr: 7, evaluation_unit_price_inr: 7, review_status: "human_verified" });
    const after = scen(corrected);
    const qty = ctx.lines.find((l) => l.line_id === "CP-001")!.annual_qty;
    const was = before.allocations.find((a) => a.rfx_line_id === "CP-001")!.evaluated_unit_cost_inr;
    expect(after.total_evaluated_cost).toBe(before.total_evaluated_cost - Math.round((was - 7) * qty));
    expect(corrected.processing_summary.open_review_items).toBe(v1.processing_summary.open_review_items - 1);
    // audit: source text → model value → human correction → final value, original extraction untouched
    expect(corrected.extraction).toEqual(v1.extraction);
    expect(line.evidence[0].source_text).toBeTruthy();
    expect(corrected.audit_log.at(-1)).toMatchObject({ review_item_id: item.id, model_extracted_value: was, human_corrected_value: 7, final_value: 7, resolution: "human_corrected", note: "confirmed", at: "2026-10-14T11:00:00.000Z" });
  });
});

describe("continuous Sourcing Analyst conversation (mocked model)", () => {
  const plan = (o: Partial<Plan>): Plan => ({ resolved_question: "q", intent: "scenario", tool_calls: [], retrieval_queries: [], ...o } as Plan);
  const ans = (t: string, refs = ["T1"]) => ({ answer_markdown: t, table: null, citations: refs, unresolved_issues: [], cannot_compute: null });

  it("(11,12) one thread spans analysis → why-not → quality → two suppliers → cost delta; numbers come from tools", async () => {
    const bids = scenarioBids(ctx);
    let decision = emptyDecision();
    const history: HistoryTurn[] = [];
    const turn = async (q: string, p: Plan, a: ReturnType<typeof ans>) => {
      const llm = new FakeLLM([p, a]);
      const r = await askAnalyst(llm, ctx, bids, q, history, decision);
      if (!r.ok) throw new Error(r.error.message);
      history.push(r.turn);
      decision = { ...decision, custom_scenarios: [...decision.custom_scenarios, ...r.new_scenarios] };
      return { r, llm };
    };
    await turn("Which qualified vendor is cheapest?", plan({ tool_calls: [{ tool: "get_scenarios", args: A(), purpose: "scenarios" }] }), ans("Vendor 2 leads the split [T1]."));
    await turn("Why not Vendor 4?", plan({ tool_calls: [{ tool: "explain_vendor_exclusion", args: A({ vendor_id: "VND-1004", scenario_id: "SCN-002" }), purpose: "why" }] }), ans("Vendor 4 failed mandatory Q01 [T1]."));
    const q = await turn("What if quality matters more than price?", plan({ tool_calls: [{ tool: "run_sourcing_scenario", args: A({ constraints: { ...emptyConstraints(), objective: "maximize_quality", cost_tolerance_pct: 5, name: "Quality +5%" } }), purpose: "quality" }] }), ans("Quality-first created [T1]."));
    expect(q.r.new_scenarios[0].scenario_id).toBe("SCN-C001");
    const two = await turn("Now restrict it to two suppliers.", plan({ tool_calls: [{ tool: "run_sourcing_scenario", args: A({ constraints: { ...emptyConstraints(), base_scenario_id: "SCN-C001", max_suppliers: 2 } }), purpose: "cap" }] }), ans("Two-supplier version [T1]."));
    expect(two.llm.calls[0].prompt).toContain("Current scenario in focus: SCN-C001");
    expect(two.llm.calls[0].prompt).toContain("Buyer: Why not Vendor 4?"); // whole thread is in context
    const cmp = await turn("How much more does that cost?", plan({ tool_calls: [{ tool: "compare_scenarios", args: A({ scenario_ids: ["SCN-002", "SCN-C002"] }), purpose: "delta" }] }), ans("It costs more than the split [T1]."));
    const res = cmp.r.tool_results[0].result as { scenarios: { scenario_id: string; total_evaluated_cost_inr: number; cost_delta_vs_baseline_inr: number }[] };
    const engine = runScenario(ctx, bids, { scenario_id: "SCN-C002", name: "x", kind: "custom", constraints: decision.custom_scenarios[1].constraints }, [
      ...decision.custom_scenarios, { scenario_id: "SCN-002", name: "s", kind: "standard", constraints: emptyConstraints() }]);
    expect(res.scenarios[1].total_evaluated_cost_inr).toBe(engine.total_evaluated_cost); // deterministic tool value
    expect(res.scenarios[1].cost_delta_vs_baseline_inr).toBe(res.scenarios[1].total_evaluated_cost_inr - res.scenarios[0].total_evaluated_cost_inr);
    expect(history).toHaveLength(5);
    expect(cmp.r.unsupported_numbers).toEqual([]);
  });

  it("flags figures in an answer that no tool produced", () => {
    expect(unsupportedNumbers("Total is ₹1,17,74,450 for CP-011 and it saves 99.5%", '{"total":11774450}')).toEqual(["99.5"]);
  });
});
