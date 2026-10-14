import { beforeAll, describe, expect, it } from "vitest";
import { askAnalyst, type Plan } from "@/lib/analyst/agent";
import { AnalystTools, emptyToolArgs as A } from "@/lib/analyst/tools";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { buildAwardSummary, renderAwardPdf } from "@/lib/scenarios/export";
import { recommend, RECOMMENDATION_POLICY } from "@/lib/scenarios/recommend";
import { runSensitivity, standardWhatIfs } from "@/lib/scenarios/sensitivity";
import { runAll } from "@/lib/scenarios/standard";
import { emptyConstraints, emptyDecision, type DecisionState } from "@/lib/scenarios/types";
import { FakeLLM } from "../fixtures/fake-client";
import { scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
let bids: CanonicalBid[];
beforeAll(async () => { ctx = await loadEventContext(); bids = scenarioBids(ctx); });

describe("recommendation properties", () => {
  it("never recommends a scenario that awards a technically failed vendor", () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
    expect(rec.status).toBe("recommended");
    expect(chosen.suppliers.some((s) => s.vendor_id === "VND-1004")).toBe(false);
    expect(chosen.status).toBe("complete");
  });

  it("recommendation totals, savings and alternative delta match the scenario engine", () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
    const alt = scenarios.find((s) => s.scenario_id === rec.alternative_scenario_id)!;
    expect(rec.cost_delta_to_alternative).toBe(alt.total_evaluated_cost - chosen.total_evaluated_cost);
    expect(rec.key_reasons[0]).toContain(`₹${chosen.total_evaluated_cost.toLocaleString("en-IN")}`);
    expect(rec.key_reasons[1]).toContain(`₹${chosen.savings_vs_historical.toLocaleString("en-IN")}`);
    expect(rec.decision_log.map((d) => d.rule)).toEqual(["R1 coverage", "R2 qualification", "R3 lowest cost", "R4 unresolved critical", "R5 consolidation", "R6 concentration"]);
  });

  it("consolidation rule: fewer suppliers preferred only within the stated tolerance", () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
    const cheapest = Math.min(...scenarios.filter((s) => s.status === "complete").map((s) => s.total_evaluated_cost));
    expect(chosen.total_evaluated_cost).toBeLessThanOrEqual(cheapest * (1 + RECOMMENDATION_POLICY.consolidation_tolerance_pct / 100) + 1);
  });

  it("unresolved critical dependencies on awarded lines push the recommendation to a clean scenario", () => {
    // Make V5's critical duplicate sit on a line V5 would win: drop V3 so CP-025 has no other cheap source.
    const { scenarios } = runAll(ctx, bids, [{ scenario_id: "SCN-C001", name: "dirty", kind: "custom", constraints: { ...emptyConstraints(), include_unfinalized: true } }]);
    const rec = recommend(ctx, bids, scenarios);
    const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
    expect(chosen.unresolved_dependencies.filter((d) => d.severity === "critical")).toHaveLength(0);
  });

  it("explains why the cheapest (unqualified) vendor is not recommended", () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    expect(rec.key_reasons.join(" ")).toMatch(/Excluded on qualification: Vendor 4 \(Fixture 4\)/);
    expect(rec.trade_offs.join(" ")).toMatch(/Ignoring qualification would cost .* less\).*Vendor 4.*not permitted because qualification is mandatory/);
  });

  it("sensitivity: treating the failed vendor as qualified changes the recommendation; reports cost delta", () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const res = runSensitivity(ctx, bids, [], false, standardWhatIfs(scenarios, rec, bids, ctx), { scenarios, rec });
    const v4 = res.find((r) => r.label.includes("Vendor 4"))!;
    expect(v4.recommendation_changes).toBe(true);
    expect(v4.cost_delta!).toBeLessThan(0);
    const up = res.find((r) => r.label.includes("prices rise 5%"))!;
    expect(up.cost_after).not.toBeNull();
  });
});

describe("analyst scenario tools (deterministic)", () => {
  it("run_sourcing_scenario creates a custom scenario on a base and compares it", () => {
    const t = new AnalystTools(ctx, bids, emptyDecision());
    const r = t.run("run_sourcing_scenario", A({ constraints: { ...emptyConstraints(), base_scenario_id: "SCN-002", max_suppliers: 2, name: "Per line, max 2" } })) as { created: { scenario_id: string; supplier_count: number }; vs: { scenario_id: string; cost_delta_inr: number } };
    expect(r.created).toMatchObject({ scenario_id: "SCN-C001", supplier_count: 2 });
    expect(r.vs.scenario_id).toBe("SCN-002");
    expect(r.vs.cost_delta_inr).toBeGreaterThanOrEqual(0);
    const cmp = t.run("compare_scenarios", A({ scenario_ids: ["SCN-002", "SCN-C001"] })) as { scenarios: { cost_delta_vs_baseline_inr: number }[] };
    expect(cmp.scenarios[1].cost_delta_vs_baseline_inr).toBe(r.vs.cost_delta_inr);
    expect(t.created).toHaveLength(1);
  });

  it("explain_vendor_exclusion, next-best, savings and award share", () => {
    const t = new AnalystTools(ctx, bids, emptyDecision());
    const ex = t.run("explain_vendor_exclusion", A({ vendor_id: "Vendor 4", scenario_id: "SCN-002" })) as { status: string; exclusion_reasons: string[]; lines_where_vendor_is_cheaper_than_award: string[] };
    expect(ex.status).toBe("excluded");
    expect(ex.exclusion_reasons[0]).toMatch(/failed technical qualification/);
    expect(ex.lines_where_vendor_is_cheaper_than_award.length).toBe(30);
    const nb = t.run("get_next_best_vendor", A({ rfx_line_id: "CP-001", scenario_id: "SCN-002" })) as { award: { next_best_vendor: string } };
    expect(nb.award.next_best_vendor).toMatch(/Vendor 3/);
    const sv = t.run("calculate_savings", A({ scenario_id: "SCN-001", group_by: "vendor" })) as { savings_inr: number; breakdown: { savings_inr: number }[] };
    expect(sv.breakdown[0].savings_inr).toBe(sv.savings_inr);
    const sh = t.run("get_supplier_award_share", A({ scenario_id: "SCN-002" })) as { supplier_count: number };
    expect(sh.supplier_count).toBe(3);
  });
});

describe("conversational decision layer (mocked model)", () => {
  const plan = (o: Partial<Plan>): Plan => ({ resolved_question: "q", intent: "scenario", tool_calls: [], retrieval_queries: [], ...o } as Plan);

  it("'Restrict it to two suppliers' uses the scenario in focus and returns the new scenario for persistence", async () => {
    const llm = new FakeLLM([
      plan({ resolved_question: "Restrict SCN-002 to at most two suppliers and compare", tool_calls: [
        { tool: "run_sourcing_scenario", args: A({ constraints: { ...emptyConstraints(), base_scenario_id: "SCN-002", max_suppliers: 2 } }), purpose: "modify" },
        { tool: "compare_scenarios", args: A({ scenario_ids: ["SCN-002", "SCN-NEW"] }), purpose: "delta" },
      ] }),
      { answer_markdown: "Limiting to two suppliers costs more [T1][T2].", table: null, citations: ["T1", "T2"], unresolved_issues: [], cannot_compute: null },
    ]);
    const history = [{ question: "What if we split to the cheapest qualified vendor per line?", resolved_question: "Per-line split", answer_summary: "SCN-002 …", scenario_ids: ["SCN-002"] }];
    const r = await askAnalyst(llm, ctx, bids, "Restrict it to a maximum of two suppliers.", history, emptyDecision());
    expect(llm.calls[0].prompt).toContain("Current scenario in focus: SCN-002");
    expect(llm.calls[0].prompt).toMatch(/SCN-00\d .* ← RECOMMENDED/);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.new_scenarios.map((s) => s.scenario_id)).toEqual(["SCN-C001"]);
    expect(r.tool_results[1]).toMatchObject({ ok: true, args: { scenario_ids: ["SCN-002", "SCN-C001"] } });
    expect(r.turn.scenario_ids).toEqual(expect.arrayContaining(["SCN-002", "SCN-C001"]));
  });

  it("persisted custom scenarios are recomputed on later turns ('how much more would that cost?')", async () => {
    const decision: DecisionState = { ...emptyDecision(), custom_scenarios: [{ scenario_id: "SCN-C001", name: "Quality 5%", kind: "custom", constraints: { ...emptyConstraints(), objective: "maximize_quality", cost_tolerance_pct: 5 } }] };
    const llm = new FakeLLM([
      plan({ tool_calls: [{ tool: "compare_scenarios", args: A({ scenario_ids: ["SCN-002", "SCN-C001"] }), purpose: "delta" }] }),
      { answer_markdown: "It costs more [T1].", table: null, citations: ["T1"], unresolved_issues: [], cannot_compute: null },
    ]);
    const r = await askAnalyst(llm, ctx, bids, "How much more would that cost?", [{ question: "Prioritise quality, +5%", resolved_question: "quality", answer_summary: "SCN-C001", scenario_ids: ["SCN-C001"] }], decision);
    expect(r.ok && r.tool_results[0].ok).toBe(true);
    expect(llm.calls[0].prompt).toContain("SCN-C001 Quality 5%");
    expect(llm.calls[1].prompt).toContain("cost_delta_vs_baseline_inr");
  });
});

describe("export", () => {
  it("JSON summary has the required fields and no internals; PDF renders", async () => {
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const decision: DecisionState = { ...emptyDecision(), selected_scenario_id: rec.recommended_scenario_id, status: "approved",
      audit: [{ at: "2026-10-14T10:00:00Z", type: "recommendation_approved", scenario_id: rec.recommended_scenario_id, detail: "approved" }] };
    const s = buildAwardSummary(ctx, bids, scenarios, rec, decision, new Date("2026-10-14T10:05:00Z"));
    expect(s.rfx).toMatchObject({ rfx_id: ctx.rfx_id, title: ctx.title });
    expect(s.evaluated_vendors).toHaveLength(5);
    expect(s.recommendation.scenario!.total_evaluated_cost_inr).toBe(scenarios.find((x) => x.scenario_id === rec.recommended_scenario_id)!.total_evaluated_cost);
    expect(s.buyer_decision).toMatchObject({ status: "approved", decided_at: "2026-10-14T10:00:00Z" });
    const json = JSON.stringify(s);
    for (const forbidden of ["extraction", "\"trace\"", "chunks", "ground_truth", "source_text", "raw_price_text"]) expect(json).not.toContain(forbidden);
    const pdf = await renderAwardPdf(s);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });
});
