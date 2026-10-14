/**
 * Recommendation engine: explicit, ordered decision rules over deterministic scenarios (no opaque score).
 * Every rule application is logged with the numbers that drove it.
 */
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { runScenario } from "./engine";
import { unconstrainedReferenceSpec } from "./standard";
import type { Recommendation, Scenario } from "./types";

export const RECOMMENDATION_POLICY = {
  /** Prefer fewer suppliers when the cost penalty is at most this % (simpler supplier management). */
  consolidation_tolerance_pct: 1.0,
  /** A single supplier above this spend share is a concentration risk; prefer a split if within the consolidation tolerance. */
  max_supplier_share_pct: 80,
  /** Scenarios whose awarded lines carry unresolved critical review items are not recommended while a clean alternative exists. */
  block_unresolved_critical: true,
  /** Only scenarios covering every RFx line can be recommended. */
  require_full_coverage: true,
} as const;

const fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);

export function recommend(ctx: EventContext, bids: CanonicalBid[], scenarios: Scenario[], includeUnfinalized = false): Recommendation {
  const P = RECOMMENDATION_POLICY;
  const log: Recommendation["decision_log"] = [];
  const pool = scenarios.filter((s) => s.kind !== "sensitivity");
  const complete = pool.filter((s) => s.status === "complete");
  log.push({ rule: "R1 coverage", outcome: `${complete.length}/${pool.length} scenarios cover all ${ctx.lines.length} lines; incomplete: ${pool.filter((s) => s.status !== "complete").map((s) => `${s.scenario_id} (${s.status.replace(/_/g, " ")})`).join(", ") || "none"}.` });
  const qualifiedOnly = complete.filter((s) => s.constraints.require_qualified);
  const whatIf = qualifiedOnly.some((s) => s.constraints.treat_as_qualified.length);
  log.push({ rule: "R2 qualification", outcome: `${qualifiedOnly.length} complete scenarios award only technically qualified vendors (mandatory requirements enforced)${whatIf ? " – includes a what-if treating some vendors as qualified" : ""}.` });
  if (!qualifiedOnly.length) {
    return { recommended_scenario_id: null, recommended_name: null, policy: { ...P }, decision_log: log, key_reasons: ["No scenario covers every line using only qualified vendors."],
      trade_offs: [], risks: [], unresolved_dependencies: [], alternative_scenario_id: null, alternative_name: null, cost_delta_to_alternative: null, status: "no_viable_scenario" };
  }
  const byCost = [...qualifiedOnly].sort((a, b) => a.total_evaluated_cost - b.total_evaluated_cost || a.supplier_count - b.supplier_count);
  let chosen = byCost[0];
  log.push({ rule: "R3 lowest cost", outcome: `Lowest-cost qualified complete scenario: ${chosen.scenario_id} ${chosen.name} at ${fmt(chosen.total_evaluated_cost)}.` });

  const critical = (s: Scenario) => s.unresolved_dependencies.filter((d) => d.severity === "critical");
  if (P.block_unresolved_critical && critical(chosen).length) {
    const clean = byCost.find((s) => !critical(s).length);
    if (clean) {
      log.push({ rule: "R4 unresolved critical", outcome: `${chosen.scenario_id} depends on ${critical(chosen).map((d) => d.review_item_id).join(", ")}; switching to ${clean.scenario_id} (${fmt(clean.total_evaluated_cost)}, +${pct(clean.total_evaluated_cost, chosen.total_evaluated_cost)}%).` });
      chosen = clean;
    } else log.push({ rule: "R4 unresolved critical", outcome: `Every complete scenario depends on unresolved critical items; kept ${chosen.scenario_id} and listed them as dependencies.` });
  } else log.push({ rule: "R4 unresolved critical", outcome: `${chosen.scenario_id} has no unresolved critical dependencies.` });

  const consolidated = byCost.filter((s) => s.supplier_count < chosen.supplier_count && !critical(s).length &&
    s.total_evaluated_cost <= chosen.total_evaluated_cost * (1 + P.consolidation_tolerance_pct / 100))
    .sort((a, b) => a.supplier_count - b.supplier_count || a.total_evaluated_cost - b.total_evaluated_cost)[0];
  if (consolidated) {
    log.push({ rule: "R5 consolidation", outcome: `${consolidated.scenario_id} uses ${consolidated.supplier_count} supplier(s) instead of ${chosen.supplier_count} for +${pct(consolidated.total_evaluated_cost, chosen.total_evaluated_cost)}% (≤${P.consolidation_tolerance_pct}%) – preferred.` });
    chosen = consolidated;
  } else log.push({ rule: "R5 consolidation", outcome: `No scenario with fewer suppliers is within ${P.consolidation_tolerance_pct}% of ${chosen.scenario_id}.` });

  if (chosen.largest_supplier_exposure_pct > P.max_supplier_share_pct) {
    const split = byCost.find((s) => s.largest_supplier_exposure_pct <= P.max_supplier_share_pct && !critical(s).length &&
      s.total_evaluated_cost <= chosen.total_evaluated_cost * (1 + P.consolidation_tolerance_pct / 100));
    if (split) {
      log.push({ rule: "R6 concentration", outcome: `${chosen.scenario_id} puts ${chosen.largest_supplier_exposure_pct}% of spend on one supplier (> ${P.max_supplier_share_pct}%); ${split.scenario_id} keeps it at ${split.largest_supplier_exposure_pct}% for +${pct(split.total_evaluated_cost, chosen.total_evaluated_cost)}%.` });
      chosen = split;
    } else log.push({ rule: "R6 concentration", outcome: `${chosen.scenario_id} concentration ${chosen.largest_supplier_exposure_pct}% exceeds ${P.max_supplier_share_pct}% but no lower-concentration option is within ${P.consolidation_tolerance_pct}% – flagged as a risk.` });
  } else log.push({ rule: "R6 concentration", outcome: `Largest supplier share ${chosen.largest_supplier_exposure_pct}% is within the ${P.max_supplier_share_pct}% limit.` });

  // Alternative: the quality-first scenario if it differs, else the next-cheapest distinct allocation.
  const sameAlloc = (a: Scenario, b: Scenario) => a.total_evaluated_cost === b.total_evaluated_cost && a.suppliers.map((s) => s.vendor_id).join() === b.suppliers.map((s) => s.vendor_id).join();
  const alt = qualifiedOnly.find((s) => s.objective === "maximize_quality" && !sameAlloc(s, chosen)) ?? byCost.find((s) => !sameAlloc(s, chosen)) ?? null;
  const delta = alt ? alt.total_evaluated_cost - chosen.total_evaluated_cost : null;

  const ref = runScenario(ctx, bids, unconstrainedReferenceSpec(includeUnfinalized));
  const excludedQual = chosen.excluded_vendors.filter((v) => v.reasons.some((r) => r.includes("qualification") || r.includes("mandatory")));
  const reasons = [
    `${chosen.name}: total evaluated cost ${fmt(chosen.total_evaluated_cost)} across all ${chosen.covered_lines} lines with ${chosen.supplier_count} supplier(s) (${chosen.suppliers.map((s) => `${s.vendor} ${s.spend_pct}%`).join(", ")}).`,
    chosen.savings_vs_historical >= 0
      ? `Saves ${fmt(chosen.savings_vs_historical)} (${chosen.savings_percent}%) versus the FY25-26 historical benchmark of ${fmt(chosen.historical_cost)}.`
      : `Costs ${fmt(-chosen.savings_vs_historical)} (${Math.abs(chosen.savings_percent ?? 0)}%) MORE than the FY25-26 historical benchmark of ${fmt(chosen.historical_cost)} – no saving.`,
    `Only technically qualified vendors are awarded; spend-weighted technical score ${chosen.weighted_technical_score}.`,
    ...(excludedQual.length ? [`Excluded on qualification: ${excludedQual.map((v) => `${v.vendor} – ${v.reasons.join("; ")}`).join(" | ")}.`] : []),
  ];
  const trade = [
    ...(alt ? [`Alternative ${alt.name}: ${fmt(alt.total_evaluated_cost)} (${delta! >= 0 ? "+" : ""}${fmt(delta!)}, ${pct(alt.total_evaluated_cost, chosen.total_evaluated_cost)}%), ${alt.supplier_count} supplier(s), technical score ${alt.weighted_technical_score} vs ${chosen.weighted_technical_score}.`] : []),
    ...(ref.status !== "no_eligible_vendors" && ref.total_evaluated_cost < chosen.total_evaluated_cost && ref.covered_lines >= chosen.covered_lines
      ? [`Ignoring qualification would cost ${fmt(ref.total_evaluated_cost)} (${fmt(chosen.total_evaluated_cost - ref.total_evaluated_cost)} less) by awarding ${ref.suppliers.filter((s) => !chosen.suppliers.some((c) => c.vendor_id === s.vendor_id)).map((s) => s.vendor).join(", ") || "other vendors"} – not permitted because qualification is mandatory.`] : []),
    ...(chosen.supplier_count > 1 ? [`Split award: ${chosen.supplier_count} suppliers to manage versus a single source.`] : []),
  ];
  return {
    recommended_scenario_id: chosen.scenario_id, recommended_name: chosen.name, policy: { ...P }, decision_log: log, key_reasons: reasons, trade_offs: trade,
    risks: chosen.risks, unresolved_dependencies: chosen.unresolved_dependencies,
    alternative_scenario_id: alt?.scenario_id ?? null, alternative_name: alt?.name ?? null, cost_delta_to_alternative: delta, status: "recommended",
  };
}
