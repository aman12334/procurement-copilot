/**
 * Deterministic sourcing scenario engine. Operates on canonical bids (finalized by default) and buyer constraints.
 * No model calls. Supplier caps are solved exactly by enumerating supplier subsets (small n), so results are
 * reproducible and auditable.
 */
import type { CanonicalBid, CanonicalLineItem } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import type {
  Allocation, ExcludedVendor, ResolvedConstraints, Scenario, ScenarioConstraints, ScenarioRisk, ScenarioSpec, SupplierShare, UnresolvedDependency,
} from "./types";

export const ENGINE_POLICY = {
  default_quality_tolerance_pct: 5,
  concentration_risk_pct: 80,
  max_subset_vendors: 14,
} as const;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const UNDER_REVIEW = new Set(["needs_review", "blocked", "unresolved"]);

export const vendorLabel = (b: CanonicalBid) => `Vendor ${b.vendor.vendor_no ?? "?"} (${b.vendor.vendor_name})`;

/** Merge base scenario constraints (if any) and apply defaults. */
export function resolveConstraints(c: ScenarioConstraints, specs: ScenarioSpec[] = [], depth = 0): { resolved: ResolvedConstraints; merged: ScenarioConstraints } {
  let merged = { ...c };
  if (c.base_scenario_id && depth < 5) {
    const base = specs.find((s) => s.scenario_id === c.base_scenario_id);
    if (base) {
      const b = resolveConstraints(base.constraints, specs, depth + 1).merged;
      merged = Object.fromEntries(Object.keys(c).map((k) => {
        const own = (c as Record<string, unknown>)[k];
        return [k, own === null || own === undefined ? (b as Record<string, unknown>)[k] ?? null : own];
      })) as ScenarioConstraints;
      merged.base_scenario_id = c.base_scenario_id;
    }
  }
  const objective = merged.objective ?? "minimize_cost";
  return {
    merged,
    resolved: {
      objective,
      max_suppliers: merged.max_suppliers && merged.max_suppliers > 0 ? merged.max_suppliers : null,
      require_full_coverage: merged.require_full_coverage ?? false,
      minimum_technical_score: merged.minimum_technical_score ?? null,
      require_qualified: merged.require_qualified ?? true,
      require_mandatory_certifications: merged.require_mandatory_certifications ?? true,
      exclude_unresolved_critical: merged.exclude_unresolved_critical ?? false,
      exclude_lines_under_review: merged.exclude_lines_under_review ?? false,
      min_line_coverage_pct: merged.min_line_coverage_pct ?? null,
      include_freight: merged.include_freight ?? true,
      freight_assumption_pct: merged.freight_assumption_pct ?? null,
      cost_tolerance_pct: merged.cost_tolerance_pct ?? (objective === "maximize_quality" ? ENGINE_POLICY.default_quality_tolerance_pct : 0),
      allowed_vendors: merged.allowed_vendors ?? [],
      excluded_vendors: merged.excluded_vendors ?? [],
      treat_as_qualified: merged.treat_as_qualified ?? [],
      price_adjustments: merged.price_adjustments ?? [],
      fx_usd_inr: merged.fx_usd_inr ?? null,
      include_unfinalized: merged.include_unfinalized ?? false,
    },
  };
}

/** Accepts "VND-1002", "2", "Vendor 2" or a name fragment. */
export function matchVendor(bids: CanonicalBid[], ref: string): CanonicalBid | undefined {
  const t = ref.trim().toLowerCase();
  return bids.find((b) => b.vendor.vendor_id.toLowerCase() === t || String(b.vendor.vendor_no) === t.replace(/^vendor\s*/, "") ||
    (t.length > 3 && b.vendor.vendor_name.toLowerCase().includes(t)));
}

interface Priced { price: number; basis: Allocation["freight_basis"]; line: CanonicalLineItem }

export function priceLine(l: CanonicalLineItem, b: CanonicalBid, c: ResolvedConstraints, ctx: EventContext): Priced | null {
  if (!l.comparable || l.normalized_unit_price_inr === null) return null;
  if (c.exclude_lines_under_review && UNDER_REVIEW.has(l.review_status)) return null;
  let price: number, basis: Allocation["freight_basis"];
  if (!c.include_freight) { price = l.normalized_unit_price_inr; basis = "pre_freight"; }
  else if (l.landed_unit_price_inr !== null) { price = l.landed_unit_price_inr; basis = "landed"; }
  else if (c.freight_assumption_pct !== null) { price = l.normalized_unit_price_inr * (1 + c.freight_assumption_pct / 100); basis = "buyer_assumption"; }
  else { price = l.evaluation_unit_price_inr ?? l.normalized_unit_price_inr * (1 + ctx.evaluation.freight_loading_pct / 100); basis = "rfx_loading"; }
  if (c.fx_usd_inr && l.raw_currency === "USD" && l.fx_rate_to_inr) price = price * (c.fx_usd_inr / l.fx_rate_to_inr);
  const adj = c.price_adjustments.find((a) => matchVendor([b], a.vendor_id));
  if (adj) price = price * (1 + adj.pct / 100);
  return { price: r2(price), basis, line: l };
}

function isQualified(b: CanonicalBid, c: ResolvedConstraints) {
  return b.processing_summary.qualification_status === "QUALIFIED" || c.treat_as_qualified.some((t) => matchVendor([b], t));
}

export function vendorEligibility(b: CanonicalBid, c: ResolvedConstraints, ctx: EventContext): string[] {
  const reasons: string[] = [];
  const s = b.processing_summary;
  const treated = c.treat_as_qualified.some((t) => matchVendor([b], t));
  if (c.allowed_vendors.length && !c.allowed_vendors.some((v) => matchVendor([b], v))) reasons.push("not in the allowed vendor list for this scenario");
  if (c.excluded_vendors.some((v) => matchVendor([b], v))) reasons.push("excluded by the buyer for this scenario");
  if (b.review_state !== "finalized" && !c.include_unfinalized) reasons.push(`bid not finalized (state: ${b.review_state.replace(/_/g, " ")}); scenarios use trusted bids only`);
  if (c.require_qualified && s.qualification_status !== "QUALIFIED" && !treated)
    reasons.push(`failed technical qualification (score ${s.technical_score}/${s.technical_max}, threshold ${ctx.qualification.min_total_score}${s.mandatory_failures.length ? `; mandatory failures ${s.mandatory_failures.join(", ")}` : ""})`);
  else if (c.require_mandatory_certifications && s.mandatory_failures.length && !treated)
    reasons.push(`mandatory questionnaire items not met: ${s.mandatory_failures.join(", ")}`);
  if (c.minimum_technical_score !== null && s.technical_score < c.minimum_technical_score)
    reasons.push(`technical score ${s.technical_score} below the scenario minimum ${c.minimum_technical_score}`);
  if (c.exclude_unresolved_critical) {
    const crit = b.exceptions.filter((e) => e.severity === "critical" && e.status !== "resolved");
    if (crit.length) reasons.push(`unresolved critical review items: ${crit.map((e) => e.id).join(", ")}`);
  }
  if (c.min_line_coverage_pct !== null) {
    const cov = (s.quoted_lines / s.rfx_lines) * 100;
    if (cov < c.min_line_coverage_pct) reasons.push(`quotes ${s.quoted_lines}/${s.rfx_lines} lines (${r1(cov)}%), below the ${c.min_line_coverage_pct}% coverage minimum`);
  }
  return reasons;
}

interface Solution { vendors: string[]; assign: Map<string, { vendor_id: string; p: Priced }>; cost: number; covered: number }

function solve(subset: string[], lines: string[], prices: Map<string, Map<string, Priced>>): Solution {
  const assign = new Map<string, { vendor_id: string; p: Priced }>();
  let cost = 0;
  for (const id of lines) {
    let best: { vendor_id: string; p: Priced } | null = null;
    for (const v of subset) {
      const p = prices.get(v)?.get(id);
      if (p && (!best || p.price < best.p.price || (p.price === best.p.price && v < best.vendor_id))) best = { vendor_id: v, p };
    }
    if (best) { assign.set(id, best); cost += best.p.price * best.p.line.annual_qty; }
  }
  const used = [...new Set([...assign.values()].map((a) => a.vendor_id))].sort();
  return { vendors: used, assign, cost, covered: assign.size };
}

function weightedTech(s: Solution, techOf: (v: string) => number) {
  return s.cost ? [...s.assign.values()].reduce((a, x) => a + techOf(x.vendor_id) * x.p.price * x.p.line.annual_qty, 0) / s.cost : 0;
}

/**
 * Deterministic greedy quality upgrade within a supplier set: repeatedly move the line whose switch to a
 * higher-scoring supplier in the set gives the best technical-points gain per extra rupee, while total cost stays
 * under the ceiling.
 */
function upgradeForQuality(start: Solution, ceiling: number, prices: Map<string, Map<string, Priced>>, techOf: (v: string) => number): Solution {
  const assign = new Map(start.assign);
  let cost = start.cost;
  const subset = start.vendors;
  for (let guard = 0; guard < 500; guard++) {
    let pick: { id: string; to: string; p: Priced; extra: number; ratio: number } | null = null;
    for (const [id, cur] of assign) {
      for (const v of subset) {
        const p = prices.get(v)?.get(id);
        if (!p || techOf(v) <= techOf(cur.vendor_id)) continue;
        const extra = (p.price - cur.p.price) * p.line.annual_qty;
        if (cost + extra > ceiling + 0.005) continue;
        const gain = (techOf(v) - techOf(cur.vendor_id)) * p.price * p.line.annual_qty;
        const ratio = extra <= 0 ? Infinity : gain / extra;
        if (!pick || ratio > pick.ratio || (ratio === pick.ratio && id < pick.id)) pick = { id, to: v, p, extra, ratio };
      }
    }
    if (!pick) break;
    assign.set(pick.id, { vendor_id: pick.to, p: pick.p });
    cost += pick.extra;
  }
  const used = [...new Set([...assign.values()].map((a) => a.vendor_id))].sort();
  return { vendors: used, assign, cost, covered: assign.size };
}

function* subsets<T>(items: T[], maxSize: number): Generator<T[]> {
  const n = items.length;
  const rec = function* (start: number, cur: T[]): Generator<T[]> {
    if (cur.length) yield [...cur];
    if (cur.length === maxSize) return;
    for (let i = start; i < n; i++) { cur.push(items[i]); yield* rec(i + 1, cur); cur.pop(); }
  };
  yield* rec(0, []);
}

const better = (a: Solution, b: Solution | null) => !b || a.covered > b.covered || (a.covered === b.covered && (a.cost < b.cost - 0.005 || (Math.abs(a.cost - b.cost) <= 0.005 && a.vendors.length < b.vendors.length)));

export function runScenario(ctx: EventContext, bids: CanonicalBid[], spec: ScenarioSpec, allSpecs: ScenarioSpec[] = []): Scenario {
  const { resolved: c, merged } = resolveConstraints(spec.constraints, allSpecs);
  const required = ctx.lines.map((l) => l.line_id);
  const excluded: ExcludedVendor[] = [];
  const eligible: CanonicalBid[] = [];
  for (const b of bids) {
    const reasons = vendorEligibility(b, c, ctx);
    if (reasons.length) excluded.push({ vendor_id: b.vendor.vendor_id, vendor: vendorLabel(b), reasons });
    else eligible.push(b);
  }
  const byId = new Map(bids.map((b) => [b.vendor.vendor_id, b]));
  const prices = new Map<string, Map<string, Priced>>();
  for (const b of eligible) {
    const m = new Map<string, Priced>();
    for (const l of b.line_items) { const p = priceLine(l, b, c, ctx); if (p) m.set(l.rfx_line_id, p); }
    prices.set(b.vendor.vendor_id, m);
  }
  const vendorIds = eligible.map((b) => b.vendor.vendor_id).slice(0, ENGINE_POLICY.max_subset_vendors);
  const techOf = (v: string) => byId.get(v)!.processing_summary.technical_score;

  // ---- optimise
  let chosen: Solution | null = null;
  let statusMsg = "";
  if (!vendorIds.length) {
    statusMsg = "No vendor satisfies the scenario constraints.";
  } else {
    const cap = c.max_suppliers ?? vendorIds.length;
    const candidates: Solution[] = [];
    for (const sub of subsets(vendorIds, cap)) {
      const s = solve(sub, required, prices);
      if (c.require_full_coverage && s.covered < required.length) continue;
      candidates.push(s);
    }
    let cheapest: Solution | null = null;
    for (const s of candidates) if (better(s, cheapest)) cheapest = s;
    chosen = cheapest;
    if (cheapest && c.objective === "maximize_quality") {
      const ceiling = cheapest.cost * (1 + c.cost_tolerance_pct / 100);
      let best: Solution = cheapest, bestScore = weightedTech(cheapest, techOf);
      for (const s of candidates) {
        if (s.covered !== cheapest.covered) continue;
        const up = upgradeForQuality(s, ceiling, prices, techOf);
        const sc = weightedTech(up, techOf);
        if (sc > bestScore + 1e-9 || (Math.abs(sc - bestScore) <= 1e-9 && up.cost < best.cost)) { best = up; bestScore = sc; }
      }
      chosen = best;
      statusMsg = `Quality-first: highest spend-weighted technical score within ${c.cost_tolerance_pct}% of the cheapest option with the same supplier limit (${Math.round(cheapest.cost).toLocaleString("en-IN")} INR; ceiling ${Math.round(ceiling).toLocaleString("en-IN")} INR).`;
    }
    if (!chosen) statusMsg = c.require_full_coverage
      ? `No ${c.max_suppliers === 1 ? "single supplier" : `set of ≤${cap} suppliers`} covers all ${required.length} lines. Best single-vendor coverage: ${eligible.map((b) => `${vendorLabel(b)} ${prices.get(b.vendor.vendor_id)!.size}`).join(", ")}.`
      : "No eligible quotes.";
  }

  // ---- allocations
  const allocations: Allocation[] = [];
  if (chosen) {
    for (const rl of ctx.lines) {
      const a = chosen.assign.get(rl.line_id);
      if (!a) continue;
      const b = byId.get(a.vendor_id)!;
      const alts = vendorIds.filter((v) => v !== a.vendor_id).map((v) => ({ v, p: prices.get(v)!.get(rl.line_id) })).filter((x) => x.p)
        .sort((x, y) => x.p!.price - y.p!.price);
      const nb = alts[0];
      const inSubsetAlt = chosen.vendors.filter((v) => v !== a.vendor_id && prices.get(v)!.get(rl.line_id)).length;
      const l = a.p.line;
      allocations.push({
        rfx_line_id: rl.line_id, sku: rl.line_id, description: rl.item_description, delivery_plant: rl.delivery_plant,
        awarded_vendor_id: a.vendor_id, awarded_vendor: vendorLabel(b), evaluated_unit_cost_inr: a.p.price, annual_qty: rl.annual_qty,
        annual_evaluated_spend_inr: Math.round(a.p.price * rl.annual_qty), historical_unit_cost_inr: ctx.historical[rl.line_id]?.price_inr ?? null,
        qualification_status: b.processing_summary.qualification_status === "QUALIFIED" ? "QUALIFIED" : "TREATED AS QUALIFIED",
        freight_basis: a.p.basis,
        reason_selected: chosen.vendors.length === 1 ? "single-source award" : inSubsetAlt ? "lowest evaluated cost among the awarded suppliers" : "only awarded supplier quoting this line",
        next_best_vendor: nb ? vendorLabel(byId.get(nb.v)!) : null, next_best_unit_cost_inr: nb?.p?.price ?? null,
        delta_vs_next_best_inr: nb?.p ? r2(nb.p.price - a.p.price) : null,
        unresolved_issue: UNDER_REVIEW.has(l.review_status) ? `${l.review_status.replace("_", " ")}: ${l.review_reasons.join(", ")}` : null,
      });
    }
  }

  // ---- metrics
  const total = allocations.reduce((s, a) => s + a.evaluated_unit_cost_inr * a.annual_qty, 0);
  const hist = allocations.reduce((s, a) => s + (a.historical_unit_cost_inr ?? 0) * a.annual_qty, 0);
  const suppliers: SupplierShare[] = (chosen?.vendors ?? []).map((v) => {
    const mine = allocations.filter((a) => a.awarded_vendor_id === v);
    const spend = mine.reduce((s, a) => s + a.evaluated_unit_cost_inr * a.annual_qty, 0);
    return { vendor_id: v, vendor: vendorLabel(byId.get(v)!), lines: mine.length, lines_pct: r1((mine.length / Math.max(1, allocations.length)) * 100),
      spend_inr: Math.round(spend), spend_pct: r1((spend / Math.max(1, total)) * 100), technical_score: techOf(v) };
  }).sort((a, b) => b.spend_inr - a.spend_inr);
  const covered = allocations.length;
  const uncovered = required.filter((id) => !allocations.some((a) => a.rfx_line_id === id));
  const wTech = total ? r1(allocations.reduce((s, a) => s + techOf(a.awarded_vendor_id) * a.evaluated_unit_cost_inr * a.annual_qty, 0) / total) : null;
  const fr = { landed: 0, rfx_loading: 0, buyer_assumption: 0, pre_freight: 0 };
  for (const a of allocations) fr[a.freight_basis]++;

  const status: Scenario["status"] = !vendorIds.length ? "no_eligible_vendors" : !chosen ? "no_full_coverage" : uncovered.length ? "incomplete_coverage" : "complete";
  if (status === "incomplete_coverage") statusMsg = `${uncovered.length} line(s) have no eligible quote: ${uncovered.join(", ")}. ${statusMsg}`.trim();
  if (status === "complete" && !statusMsg) statusMsg = `All ${required.length} lines awarded to ${suppliers.length} supplier(s).`;

  // ---- assumptions, risks, dependencies
  const assumptions: string[] = [
    c.include_freight
      ? `Evaluated cost = landed price where freight is quoted or included; otherwise ${c.freight_assumption_pct !== null ? `buyer-provided freight assumption of ${c.freight_assumption_pct}%` : `RFx evaluation loading of ${ctx.evaluation.freight_loading_pct}% (${ctx.evaluation.freight_loading_source})`}.`
      : "Evaluated cost excludes freight (pre-freight normalized prices).",
    `USD quotes converted at ${c.fx_usd_inr ?? ctx.evaluation.usd_inr} INR/USD (${c.fx_usd_inr ? "scenario what-if" : ctx.evaluation.fx_source}).`,
    "Conditional discounts and rebates are not applied; GST excluded; one-time tooling not amortised.",
    "Historical benchmark = FY25-26 delivered price × annual quantity for the same awarded lines.",
  ];
  if (c.price_adjustments.length) assumptions.push(`What-if price changes: ${c.price_adjustments.map((p) => `${p.vendor_id} ${p.pct > 0 ? "+" : ""}${p.pct}%`).join(", ")}.`);
  if (c.treat_as_qualified.length) assumptions.push(`What-if: treating ${c.treat_as_qualified.join(", ")} as technically qualified.`);
  if (c.include_unfinalized) assumptions.push("Includes bids that are not yet finalized (preview).");

  const quals = [
    c.require_qualified ? `Technical qualification required (≥${ctx.qualification.min_total_score} and all mandatory items)` : "Technical qualification NOT required",
    ...(c.minimum_technical_score !== null ? [`Minimum technical score ${c.minimum_technical_score}`] : []),
    ...(c.exclude_unresolved_critical ? ["Vendors with unresolved critical review items excluded"] : []),
    ...(c.exclude_lines_under_review ? ["Quotes still under review excluded"] : []),
    ...(c.min_line_coverage_pct !== null ? [`Minimum vendor line coverage ${c.min_line_coverage_pct}%`] : []),
    ...(c.max_suppliers ? [`At most ${c.max_suppliers} supplier(s)`] : []),
    ...(c.require_full_coverage ? ["Awarded suppliers must cover every line"] : []),
  ];

  const risks: ScenarioRisk[] = [];
  const deps: UnresolvedDependency[] = [];
  for (const s of suppliers) {
    const b = byId.get(s.vendor_id)!;
    const awardedLines = new Set(allocations.filter((a) => a.awarded_vendor_id === s.vendor_id).map((a) => a.rfx_line_id));
    for (const e of b.exceptions) {
      if (e.status === "resolved") continue;
      if (e.rfx_line_id && !awardedLines.has(e.rfx_line_id)) continue;
      deps.push({ vendor_id: s.vendor_id, review_item_id: e.id, reason: e.reason, severity: e.severity, status: e.status, rfx_line_id: e.rfx_line_id, message: e.message });
    }
    if (b.review_state !== "finalized") risks.push({ severity: "high", code: "unfinalized_bid", message: `${s.vendor} bid is not finalized – figures may change after review.`, vendor_id: s.vendor_id, rfx_line_ids: [] });
    const until = b.commercial_terms.price_validity_until;
    if (until && ctx.contract_end && until < ctx.contract_end)
      risks.push({ severity: "low", code: "price_validity", message: `${s.vendor} prices valid until ${until}, before contract end ${ctx.contract_end} – re-pricing likely during the contract.`, vendor_id: s.vendor_id, rfx_line_ids: [] });
    const moq = allocations.filter((a) => a.awarded_vendor_id === s.vendor_id && b.line_items.find((l) => l.rfx_line_id === a.rfx_line_id)?.moq_exceeds_monthly_calloff);
    if (moq.length) risks.push({ severity: "low", code: "moq", message: `${s.vendor} MOQ exceeds monthly call-off on ${moq.map((m) => m.rfx_line_id).join(", ")}.`, vendor_id: s.vendor_id, rfx_line_ids: moq.map((m) => m.rfx_line_id) });
  }
  const crit = deps.filter((d) => d.severity === "critical");
  if (crit.length) risks.push({ severity: "high", code: "unresolved_critical", message: `${crit.length} unresolved critical review item(s) affect awarded lines: ${crit.map((d) => d.review_item_id).join(", ")}.`, vendor_id: null, rfx_line_ids: crit.map((d) => d.rfx_line_id).filter((x): x is string => !!x) });
  const reviewLines = allocations.filter((a) => a.unresolved_issue);
  if (reviewLines.length) risks.push({ severity: "medium", code: "lines_under_review", message: `${reviewLines.length} awarded line(s) still carry review issues: ${reviewLines.map((a) => a.rfx_line_id).join(", ")}.`, vendor_id: null, rfx_line_ids: reviewLines.map((a) => a.rfx_line_id) });
  const estimated = allocations.filter((a) => a.freight_basis === "rfx_loading" || a.freight_basis === "buyer_assumption");
  if (estimated.length) risks.push({ severity: "medium", code: "freight_estimated", message: `Landed cost incomplete: ${estimated.length} awarded line(s) (${Math.round(estimated.reduce((s, a) => s + a.annual_evaluated_spend_inr, 0)).toLocaleString("en-IN")} INR) use an estimated freight ${estimated[0].freight_basis === "buyer_assumption" ? "assumption" : "loading"}; vendors quoted freight extra / at actuals.`, vendor_id: null, rfx_line_ids: estimated.map((a) => a.rfx_line_id) });
  if (suppliers[0] && suppliers[0].spend_pct > ENGINE_POLICY.concentration_risk_pct)
    risks.push({ severity: suppliers.length === 1 ? "medium" : "low", code: "concentration", message: `${suppliers[0].vendor} holds ${suppliers[0].spend_pct}% of spend${suppliers.length === 1 ? " (single source – no supply back-up)" : ""}.`, vendor_id: suppliers[0].vendor_id, rfx_line_ids: [] });
  if (uncovered.length) risks.push({ severity: "high", code: "coverage", message: `${uncovered.length} line(s) not covered: ${uncovered.join(", ")}.`, vendor_id: null, rfx_line_ids: uncovered });
  if (status !== "complete" && !uncovered.length && status !== "no_full_coverage") risks.push({ severity: "high", code: "no_solution", message: statusMsg, vendor_id: null, rfx_line_ids: [] });

  return {
    scenario_id: spec.scenario_id, name: spec.name, kind: spec.kind, objective: c.objective, constraints: c, requested: merged,
    status, status_message: statusMsg, currency: "INR", required_lines: required.length, covered_lines: covered, uncovered_lines: uncovered,
    total_evaluated_cost: Math.round(total), historical_cost: Math.round(hist), savings_vs_historical: Math.round(hist - total),
    savings_percent: hist ? r1(((hist - total) / hist) * 100) : null,
    supplier_count: suppliers.length, suppliers, largest_supplier_exposure_pct: suppliers[0]?.spend_pct ?? 0, weighted_technical_score: wTech,
    allocations, eligible_vendors: eligible.map((b) => b.vendor.vendor_id), excluded_vendors: excluded, qualification_constraints: quals, assumptions,
    freight: {
      landed_lines: fr.landed, loading_lines: fr.rfx_loading, assumption_lines: fr.buyer_assumption, pre_freight_lines: fr.pre_freight,
      landed_cost_complete: fr.rfx_loading + fr.buyer_assumption === 0 && fr.pre_freight === 0,
      note: fr.pre_freight ? "Pre-freight comparison: freight excluded." : fr.rfx_loading + fr.buyer_assumption ? `${fr.rfx_loading + fr.buyer_assumption} line(s) use estimated freight.` : "Landed cost complete.",
    },
    risks, unresolved_dependencies: deps,
    bids_used: bids.map((b) => ({ vendor_id: b.vendor.vendor_id, review_state: b.review_state })),
  };
}

/** Savings breakdown by total / vendor / sku / category (RFx price category from the line description). */
export function savingsBreakdown(s: Scenario, ctx: EventContext, by: "total" | "vendor" | "sku" | "category") {
  const key = (a: Allocation) => by === "vendor" ? a.awarded_vendor : by === "sku" ? a.rfx_line_id : by === "category" ? categoryOf(ctx, a.rfx_line_id) : "Total";
  const groups = new Map<string, { evaluated: number; historical: number; lines: number }>();
  for (const a of s.allocations) {
    const g = groups.get(key(a)) ?? { evaluated: 0, historical: 0, lines: 0 };
    g.evaluated += a.evaluated_unit_cost_inr * a.annual_qty;
    g.historical += (a.historical_unit_cost_inr ?? 0) * a.annual_qty;
    g.lines++;
    groups.set(key(a), g);
  }
  return [...groups.entries()].map(([k, g]) => ({
    group: k, lines: g.lines, evaluated_inr: Math.round(g.evaluated), historical_inr: Math.round(g.historical),
    savings_inr: Math.round(g.historical - g.evaluated), savings_pct: g.historical ? r1(((g.historical - g.evaluated) / g.historical) * 100) : null,
  })).sort((a, b) => b.savings_inr - a.savings_inr);
}

export function categoryOf(ctx: EventContext, lineId: string): string {
  const l = ctx.lines.find((x) => x.line_id === lineId);
  if (!l) return "Other";
  const style = (l.style ?? "").toLowerCase();
  if (style.includes("partition")) return "Partitions";
  if (style.includes("pad")) return "Layer pads";
  if (style.includes("die-cut") || style.includes("sleeve")) return "Die-cut, trays & sleeves";
  if (style.includes("export")) return "Export cartons";
  return `${l.ply}-ply cartons`;
}
