/** Scenario engine – exact deterministic results on fixture bids with known prices. */
import { beforeAll, describe, expect, it } from "vitest";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { runScenario, savingsBreakdown } from "@/lib/scenarios/engine";
import { runAll, standardSpecs } from "@/lib/scenarios/standard";
import { emptyConstraints, type ScenarioConstraints } from "@/lib/scenarios/types";
import { FACTORS, r2, scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
let bids: CanonicalBid[];
beforeAll(async () => { ctx = await loadEventContext(); bids = scenarioBids(ctx); });

const spec = (o: Partial<ScenarioConstraints>, id = "T") => ({ scenario_id: id, name: id, kind: "custom" as const, constraints: { ...emptyConstraints(), ...o } });
const ids = () => ctx.lines.map((l) => l.line_id);
const qty = (id: string) => ctx.lines.find((l) => l.line_id === id)!.annual_qty;
const plant = (id: string) => ctx.lines.find((l) => l.line_id === id)!.delivery_plant;
const p = (id: string, f: number) => r2(ctx.historical[id].price_inr * f);
const v2 = (id: string) => (plant(id) === "PNQ" ? p(id, FACTORS.V2) : r2(p(id, FACTORS.V2) * 1.05)); // freight at actuals → 5% RFx loading
const total = (lines: string[], price: (id: string) => number) => Math.round(lines.reduce((s, id) => s + price(id) * qty(id), 0));
const hist = (lines: string[]) => Math.round(lines.reduce((s, id) => s + ctx.historical[id].price_inr * qty(id), 0));
const first20 = () => ids().slice(0, 20), last10 = () => ids().slice(20);

describe("scenario engine (exact)", () => {
  it("single-source: cheapest qualified supplier covering every line", () => {
    const s = runScenario(ctx, bids, spec({ max_suppliers: 1, require_full_coverage: true }));
    expect(s.status).toBe("complete");
    expect(s.suppliers.map((x) => x.vendor_id)).toEqual(["VND-1003"]);
    expect(s.total_evaluated_cost).toBe(total(ids(), (id) => p(id, FACTORS.V3)));
  });

  it("single-source states clearly when no qualified supplier covers all lines", () => {
    const s = runScenario(ctx, bids, spec({ max_suppliers: 1, require_full_coverage: true, excluded_vendors: ["VND-1001", "VND-1003"] }));
    expect(s.status).toBe("no_full_coverage");
    expect(s.status_message).toMatch(/No single supplier covers all 30 lines/);
    expect(s.allocations).toHaveLength(0);
  });

  it("cheapest qualified per line: allocation, totals, next-best and blocked duplicate handling", () => {
    const s = runScenario(ctx, bids, spec({}));
    const exp = (id: string) => (ids().indexOf(id) < 20 ? v2(id) : id === "CP-025" ? p(id, FACTORS.V3) : p(id, FACTORS.V5));
    expect(s.total_evaluated_cost).toBe(total(ids(), exp));
    expect(s.suppliers.map((x) => x.vendor_id).sort()).toEqual(["VND-1002", "VND-1003", "VND-1005"]);
    const a1 = s.allocations.find((a) => a.rfx_line_id === "CP-001")!;
    expect(a1).toMatchObject({ awarded_vendor_id: "VND-1002", next_best_unit_cost_inr: p("CP-001", FACTORS.V3), delta_vs_next_best_inr: r2(p("CP-001", FACTORS.V3) - v2("CP-001")) });
    expect(s.allocations.find((a) => a.rfx_line_id === "CP-025")!.awarded_vendor_id).toBe("VND-1003"); // V5 duplicate unresolved → not comparable
    expect(s.excluded_vendors.map((e) => e.vendor_id)).toEqual(["VND-1004"]);
  });

  it("max 2 suppliers: exact search over supplier pairs (best coverage, then lowest cost)", () => {
    const s = runScenario(ctx, bids, spec({ max_suppliers: 2 }));
    const v2v3 = total(first20(), v2) + total(last10(), (id) => p(id, FACTORS.V3));
    const v3v5 = total(first20(), (id) => p(id, FACTORS.V3)) + total(last10(), (id) => (id === "CP-025" ? p(id, FACTORS.V3) : p(id, FACTORS.V5)));
    expect(s.supplier_count).toBe(2);
    expect(s.covered_lines).toBe(30);
    expect(Math.abs(s.total_evaluated_cost - Math.min(v2v3, v3v5))).toBeLessThanOrEqual(1);
  });

  it("max 3 suppliers equals per-line optimum when it needs only 3", () => {
    const [m3, pl] = [runScenario(ctx, bids, spec({ max_suppliers: 3 })), runScenario(ctx, bids, spec({}))];
    expect(m3.total_evaluated_cost).toBe(pl.total_evaluated_cost);
    expect(m3.supplier_count).toBe(3);
  });

  it("quality threshold filters vendors", () => {
    const s = runScenario(ctx, bids, spec({ minimum_technical_score: 92 }));
    expect(s.excluded_vendors.find((e) => e.vendor_id === "VND-1002")!.reasons[0]).toMatch(/technical score 82 below the scenario minimum 92/);
    expect(s.suppliers.map((x) => x.vendor_id).sort()).toEqual(["VND-1003", "VND-1005"]);
  });

  it("qualification exclusion (mandatory failure) and what-if treat-as-qualified", () => {
    const s = runScenario(ctx, bids, spec({}));
    expect(s.excluded_vendors.find((e) => e.vendor_id === "VND-1004")!.reasons[0]).toMatch(/failed technical qualification.*mandatory failures Q01/);
    const w = runScenario(ctx, bids, spec({ treat_as_qualified: ["VND-1004"] }));
    expect(w.suppliers.map((x) => x.vendor_id)).toEqual(["VND-1004"]);
    expect(w.total_evaluated_cost).toBe(total(ids(), (id) => p(id, FACTORS.V4)));
    expect(w.allocations[0].qualification_status).toBe("TREATED AS QUALIFIED");
  });

  it("unresolved-critical exclusion", () => {
    const s = runScenario(ctx, bids, spec({ exclude_unresolved_critical: true }));
    expect(s.excluded_vendors.find((e) => e.vendor_id === "VND-1005")!.reasons[0]).toMatch(/unresolved critical review items: line:CP-025:duplicate_quote/);
    expect(s.suppliers.some((x) => x.vendor_id === "VND-1005")).toBe(false);
  });

  it("savings vs historical, by total / vendor / sku / category", () => {
    const s = runScenario(ctx, bids, spec({ max_suppliers: 1, require_full_coverage: true }));
    expect(s.historical_cost).toBe(hist(ids()));
    expect(s.savings_vs_historical).toBe(hist(ids()) - s.total_evaluated_cost);
    expect(s.savings_percent).toBe(Math.round(((hist(ids()) - s.total_evaluated_cost) / hist(ids())) * 1000) / 10);
    const byVendor = savingsBreakdown(s, ctx, "vendor");
    expect(byVendor).toHaveLength(1);
    expect(byVendor[0].savings_inr).toBe(s.savings_vs_historical);
    const bySku = savingsBreakdown(s, ctx, "sku");
    expect(bySku).toHaveLength(30);
    expect(savingsBreakdown(s, ctx, "category").reduce((a, g) => a + g.lines, 0)).toBe(30);
  });

  it("supplier concentration metrics", () => {
    const s = runScenario(ctx, bids, spec({}));
    expect(Math.round(s.suppliers.reduce((a, x) => a + x.spend_pct, 0))).toBe(100);
    expect(s.suppliers.reduce((a, x) => a + x.lines, 0)).toBe(30);
    expect(s.largest_supplier_exposure_pct).toBe(Math.max(...s.suppliers.map((x) => x.spend_pct)));
    const single = runScenario(ctx, bids, spec({ max_suppliers: 1, require_full_coverage: true }));
    expect(single.risks.some((r) => r.code === "concentration" && /single source/.test(r.message))).toBe(true);
  });

  it("missing freight: never fabricated – RFx loading flagged, buyer assumption visible, pre-freight option", () => {
    const only2 = (o: Partial<ScenarioConstraints> = {}) => runScenario(ctx, bids, spec({ allowed_vendors: ["VND-1002"], ...o }));
    const s = only2();
    expect(s.freight).toMatchObject({ landed_cost_complete: false });
    expect(s.risks.find((r) => r.code === "freight_estimated")?.message).toMatch(/Landed cost incomplete/);
    const blr = ids().slice(0, 20).find((id) => plant(id) !== "PNQ")!;
    expect(s.allocations.find((a) => a.rfx_line_id === blr)).toMatchObject({ freight_basis: "rfx_loading", evaluated_unit_cost_inr: v2(blr) });
    const a = only2({ freight_assumption_pct: 8 });
    expect(a.allocations.find((x) => x.rfx_line_id === blr)).toMatchObject({ freight_basis: "buyer_assumption", evaluated_unit_cost_inr: r2(p(blr, FACTORS.V2) * 1.08) });
    expect(a.assumptions.join(" ")).toMatch(/buyer-provided freight assumption of 8%/);
    const pre = only2({ include_freight: false });
    expect(pre.allocations.find((x) => x.rfx_line_id === blr)!.evaluated_unit_cost_inr).toBe(p(blr, FACTORS.V2));
  });

  it("uses finalized bids only unless the preview flag is set", () => {
    const b2 = scenarioBids(ctx, { v5Finalized: false });
    const s = runScenario(ctx, b2, spec({}));
    expect(s.excluded_vendors.find((e) => e.vendor_id === "VND-1005")!.reasons[0]).toMatch(/bid not finalized/);
    const prev = runScenario(ctx, b2, spec({ include_unfinalized: true }));
    expect(prev.suppliers.some((x) => x.vendor_id === "VND-1005")).toBe(true);
    expect(prev.risks.some((r) => r.code === "unfinalized_bid")).toBe(true);
  });

  it("base-scenario merge: follow-up changes only the overridden fields", () => {
    const { specs } = runAll(ctx, bids, []);
    const s = runScenario(ctx, bids, spec({ base_scenario_id: "SCN-006", max_suppliers: 1 }), specs);
    expect(s.constraints).toMatchObject({ exclude_unresolved_critical: true, min_line_coverage_pct: 50, max_suppliers: 1 });
  });

  it("standard set is deterministic", () => {
    const a = runAll(ctx, bids, []).scenarios.map((s) => s.total_evaluated_cost);
    const b = runAll(ctx, bids, []).scenarios.map((s) => s.total_evaluated_cost);
    expect(a).toEqual(b);
    expect(standardSpecs().map((s) => s.scenario_id)).toEqual(["SCN-001", "SCN-002", "SCN-003", "SCN-004", "SCN-005", "SCN-006"]);
  });

  it("quality-first raises the weighted technical score within the cost tolerance", () => {
    const cheap = runScenario(ctx, bids, spec({ max_suppliers: 3 }));
    const q = runScenario(ctx, bids, spec({ objective: "maximize_quality", cost_tolerance_pct: 5, max_suppliers: 3 }));
    expect(q.total_evaluated_cost).toBeLessThanOrEqual(Math.round(cheap.total_evaluated_cost * 1.05) + 1);
    expect(q.weighted_technical_score!).toBeGreaterThan(cheap.weighted_technical_score!);
  });
});
