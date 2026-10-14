/** Simple what-if sensitivity: re-run the standard set + recommendation with one change and report the effect. */
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { runScenario } from "./engine";
import { recommend } from "./recommend";
import { runAll } from "./standard";
import type { Recommendation, Scenario, ScenarioConstraints, ScenarioSpec } from "./types";

export interface WhatIf {
  label: string;
  change: Partial<Pick<ScenarioConstraints, "price_adjustments" | "fx_usd_inr" | "treat_as_qualified" | "excluded_vendors" | "freight_assumption_pct" | "minimum_technical_score">>;
}

export interface SensitivityResult {
  label: string;
  change: WhatIf["change"];
  recommended_before: string | null;
  recommended_after: string | null;
  recommendation_changes: boolean;
  suppliers_before: string[];
  suppliers_after: string[];
  cost_before: number | null;
  cost_after: number | null;
  cost_delta: number | null;
}

function apply(specs: ScenarioSpec[], change: WhatIf["change"]): ScenarioSpec[] {
  return specs.map((s) => ({ ...s, constraints: {
    ...s.constraints,
    ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
    price_adjustments: [...(s.constraints.price_adjustments ?? []), ...(change.price_adjustments ?? [])],
    excluded_vendors: [...(s.constraints.excluded_vendors ?? []), ...(change.excluded_vendors ?? [])],
    treat_as_qualified: [...(s.constraints.treat_as_qualified ?? []), ...(change.treat_as_qualified ?? [])],
  } }));
}

export function runSensitivity(ctx: EventContext, bids: CanonicalBid[], custom: ScenarioSpec[], includeUnfinalized: boolean, whatIfs: WhatIf[],
  base?: { scenarios: Scenario[]; rec: Recommendation }): SensitivityResult[] {
  const b = base ?? (() => { const r = runAll(ctx, bids, custom, includeUnfinalized); return { scenarios: r.scenarios, rec: recommend(ctx, bids, r.scenarios, includeUnfinalized) }; })();
  const before = b.scenarios.find((s) => s.scenario_id === b.rec.recommended_scenario_id) ?? null;
  const baseSpecs = runAll(ctx, bids, custom, includeUnfinalized).specs;
  return whatIfs.map((w) => {
    const specs = apply(baseSpecs, w.change);
    const scenarios = specs.map((s) => runScenario(ctx, bids, s, specs));
    const rec = recommend(ctx, bids, scenarios, includeUnfinalized);
    const after = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id) ?? null;
    const sup = (s: Scenario | null) => s?.suppliers.map((x) => x.vendor_id) ?? [];
    return {
      label: w.label, change: w.change,
      recommended_before: before ? `${before.scenario_id} ${before.name}` : null, recommended_after: after ? `${after.scenario_id} ${after.name}` : null,
      recommendation_changes: (before?.scenario_id ?? null) !== (after?.scenario_id ?? null) || sup(before).join() !== sup(after).join(),
      suppliers_before: before?.suppliers.map((s) => s.vendor) ?? [], suppliers_after: after?.suppliers.map((s) => s.vendor) ?? [],
      cost_before: before?.total_evaluated_cost ?? null, cost_after: after?.total_evaluated_cost ?? null,
      cost_delta: before && after ? after.total_evaluated_cost - before.total_evaluated_cost : null,
    };
  });
}

/** Standard high-value what-ifs derived from the current data (no hardcoded vendors). */
export function standardWhatIfs(scenarios: Scenario[], rec: Recommendation, bids: CanonicalBid[], ctx: EventContext): WhatIf[] {
  const chosen = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id);
  const out: WhatIf[] = [];
  const top = chosen?.suppliers[0];
  if (top) {
    out.push({ label: `${top.vendor} prices rise 5%`, change: { price_adjustments: [{ vendor_id: top.vendor_id, pct: 5 }] } });
    out.push({ label: `Remove ${top.vendor}`, change: { excluded_vendors: [top.vendor_id] } });
  }
  if (bids.some((b) => b.line_items.some((l) => l.raw_currency === "USD")))
    out.push({ label: `USD strengthens 5% (₹${Math.round(ctx.evaluation.usd_inr * 1.05 * 100) / 100})`, change: { fx_usd_inr: Math.round(ctx.evaluation.usd_inr * 1.05 * 100) / 100 } });
  for (const b of bids.filter((x) => x.processing_summary.qualification_status !== "QUALIFIED"))
    out.push({ label: `Vendor ${b.vendor.vendor_no} (${b.vendor.vendor_name}) becomes technically qualified`, change: { treat_as_qualified: [b.vendor.vendor_id] } });
  if (chosen && chosen.freight.loading_lines > 0)
    out.push({ label: "Freight for 'extra/at actuals' lines assumed at 8% instead of the RFx 5% loading", change: { freight_assumption_pct: 8 } });
  return out;
}
