import { beforeAll, describe, expect, it } from "vitest";
import { askAnalyst } from "@/lib/analyst/agent";
import { buildChart, technicalScoreChart, vendorValueChart, type ChartRequest } from "@/lib/analyst/charts";
import { AnalystTools, emptyToolArgs as A } from "@/lib/analyst/tools";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { recommend } from "@/lib/scenarios/recommend";
import { runAll } from "@/lib/scenarios/standard";
import { emptyDecision } from "@/lib/scenarios/types";
import { FakeLLM } from "../fixtures/fake-client";
import { scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
let bids: CanonicalBid[];
beforeAll(async () => { ctx = await loadEventContext(); bids = scenarioBids(ctx); });
const req = (o: Partial<ChartRequest>): ChartRequest => ({ kind: "scenario_costs", title: "t", scenario_ids: [], line_ids: [], vendor_ids: [], ...o });

describe("analyst charts: values computed by code, never by the model", () => {
  it("scenario costs and award split match the scenario engine exactly", () => {
    const tools = new AnalystTools(ctx, bids, emptyDecision());
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const costs = buildChart(req({ kind: "scenario_costs" }), tools, { min_total_score: 70 });
    const viable = scenarios.filter((s) => s.status !== "no_full_coverage" && s.status !== "no_eligible_vendors");
    expect(costs.groups[0].bars.map((b) => [b.label, b.value])).toEqual(viable.map((s) => [s.scenario_id, s.total_evaluated_cost]));
    expect(costs.groups[0].bars.find((b) => b.highlight)?.label).toBe(rec.recommended_scenario_id);
    const split = buildChart(req({ kind: "award_split" }), tools, { min_total_score: 70 });
    const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
    expect(split.groups[0].bars.map((b) => b.value)).toEqual(chosen.suppliers.map((s) => s.spend_inr));
    expect(() => buildChart(req({ kind: "award_split", scenario_ids: ["SCN-999"] }), tools, { min_total_score: 70 })).toThrow(/Unknown scenario/);
  });

  it("line prices come from the bids, lowest highlighted, historical shown; vendor and threshold charts", () => {
    const tools = new AnalystTools(ctx, bids, emptyDecision());
    const c = buildChart(req({ kind: "line_prices", line_ids: ["cp-001", "CP-002"] }), tools, { min_total_score: 70 });
    expect(c.groups.map((g) => g.label)).toEqual(["CP-001", "CP-002"]);
    const v1 = bids.find((b) => b.vendor.vendor_no === 1)!.line_items.find((l) => l.rfx_line_id === "CP-001")!;
    expect(c.groups[0].bars.find((b) => b.label === "V1")?.value).toBe(v1.comparable ? v1.evaluation_unit_price_inr : null);
    expect(c.groups[0].bars.at(-1)).toMatchObject({ label: "Hist.", value: ctx.historical["CP-001"].price_inr });
    expect(c.groups[0].bars.filter((b) => b.highlight).length).toBeGreaterThanOrEqual(1);
    expect(technicalScoreChart(bids, "t", 70).threshold?.value).toBe(70);
    expect(vendorValueChart(bids, "t").groups[0].bars).toHaveLength(bids.length);
  });

  it("askAnalyst returns built charts; an impossible chart is reported, not invented", async () => {
    const llm = new FakeLLM([
      { resolved_question: "costs", intent: "scenario", tool_calls: [{ tool: "get_scenarios", args: A(), purpose: "p" }], retrieval_queries: [] },
      { answer_markdown: "Scenario costs [T1].", table: null, citations: ["T1"], unresolved_issues: [], cannot_compute: null,
        charts: [req({ kind: "scenario_costs", title: "Cost by scenario" }), req({ kind: "award_split", title: "Split", scenario_ids: ["SCN-404"] })] },
    ]);
    const r = await askAnalyst(llm, ctx, bids, "Compare scenario costs", [], emptyDecision());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.charts.map((c) => c.title)).toEqual(["Cost by scenario"]);
    expect(r.chart_errors[0]).toMatch(/award_split: Unknown scenario/);
  });
});
