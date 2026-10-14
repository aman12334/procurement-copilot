/**
 * Deterministic Sourcing Analyst tools. The model chooses tools and arguments; these functions compute
 * every number. Prices use evaluation_unit_price_inr (landed when freight is known, else normalized + the
 * RFx freight-loading rule) unless price_basis says otherwise.
 */
import { z } from "zod";
import type { CanonicalBid, CanonicalLineItem } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { matchVendor, runScenario, savingsBreakdown } from "@/lib/scenarios/engine";
import { recommend } from "@/lib/scenarios/recommend";
import { runSensitivity, standardWhatIfs } from "@/lib/scenarios/sensitivity";
import { runAll } from "@/lib/scenarios/standard";
import { ScenarioConstraintsSchema, emptyDecision, type DecisionState, type Recommendation, type Scenario, type ScenarioSpec } from "@/lib/scenarios/types";

export const TOOL_NAMES = [
  "list_vendors", "get_vendor_bid", "get_line_item_comparison", "get_missing_lines", "get_qualification_status",
  "get_review_items", "get_vendor_commercial_summary", "get_common_quoted_lines", "calculate_total_for_vendor",
  "calculate_lowest_qualified_supplier_by_line", "compare_vendors", "get_historical_variance", "run_scenario",
  "get_scenarios", "run_sourcing_scenario", "compare_scenarios", "get_recommended_scenario", "get_scenario_allocation",
  "get_supplier_award_share", "calculate_savings", "get_scenario_risks", "explain_vendor_exclusion", "get_next_best_vendor", "run_sensitivity",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const ToolArgsSchema = z.object({
  vendor_id: z.string().nullable(),
  vendor_ids: z.array(z.string()).nullable(),
  rfx_line_id: z.string().nullable(),
  line_scope: z.enum(["all_quoted", "common", "listed"]).nullable(),
  line_ids: z.array(z.string()).nullable(),
  price_basis: z.enum(["evaluation", "normalized", "landed"]).nullable(),
  exclude_under_review: z.boolean().nullable(),
  qualified_only: z.boolean().nullable(),
  only_fully_quoted_lines: z.boolean().nullable(),
  exclude_vendors_with_open_critical: z.boolean().nullable(),
  min_technical_score: z.number().nullable(),
  metrics: z.array(z.enum(["price", "lead_time", "technical_score", "coverage", "payment", "validity", "review_items", "variance", "qualification"])).nullable(),
  status: z.enum(["open", "unresolved", "resolved", "all"]).nullable(),
  scenario_id: z.string().nullable(),
  scenario_ids: z.array(z.string()).nullable(),
  constraints: ScenarioConstraintsSchema.nullable().describe("For run_sourcing_scenario: structured constraints translated from the buyer's words"),
  group_by: z.enum(["total", "vendor", "sku", "category"]).nullable(),
  what_if: z.object({
    label: z.string(),
    price_adjustments: z.array(z.object({ vendor_id: z.string(), pct: z.number() })).nullable(),
    fx_usd_inr: z.number().nullable(),
    treat_as_qualified: z.array(z.string()).nullable(),
    excluded_vendors: z.array(z.string()).nullable(),
    freight_assumption_pct: z.number().nullable(),
  }).nullable().describe("For run_sensitivity: one what-if change; null = run the standard what-if set"),
});
export type ToolArgs = z.infer<typeof ToolArgsSchema>;

/** Accepts tool args with omitted keys (some providers drop nulls in non-strict JSON mode) and fills them with null. */
export const ToolArgsInputSchema = z.object(Object.fromEntries(Object.entries(ToolArgsSchema.shape).map(([k, v]) => [k, (v as z.ZodType).optional()])) as {
  [K in keyof typeof ToolArgsSchema.shape]: z.ZodOptional<(typeof ToolArgsSchema.shape)[K]>;
}).transform((a): ToolArgs => emptyToolArgs(Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Partial<ToolArgs>));

export const emptyToolArgs = (o: Partial<ToolArgs> = {}): ToolArgs => ({
  vendor_id: null, vendor_ids: null, rfx_line_id: null, line_scope: null, line_ids: null, price_basis: null, exclude_under_review: null,
  qualified_only: null, only_fully_quoted_lines: null, exclude_vendors_with_open_critical: null, min_technical_score: null, metrics: null,
  status: null, scenario_id: null, scenario_ids: null, constraints: null, group_by: null, what_if: null, ...o,
});

export const TOOL_CATALOG: Record<ToolName, string> = {
  list_vendors: "All vendors with coverage, technical score, qualification, open review items and review state. No args.",
  get_vendor_bid: "One vendor's processed bid: summary, terms and every quoted line (prices, status, reasons). Args: vendor_id.",
  get_line_item_comparison: "All vendors' prices for one RFx line, with lowest overall and lowest qualified. Args: rfx_line_id, exclude_under_review?.",
  get_missing_lines: "RFx lines a vendor did not quote (and which were explicitly declined). Args: vendor_id.",
  get_qualification_status: "Technical score, qualification and mandatory failures with the vendor's answers and evidence. Args: vendor_id? (omit for all).",
  get_review_items: "Exceptions / human-review items with status, reason and evidence. Args: vendor_id?, status? (open|unresolved|resolved|all; default open).",
  get_vendor_commercial_summary: "Payment, validity (incl. conflicts), freight statements, tax, discounts, tooling, MOQ/lead-time terms with evidence. Args: vendor_id.",
  get_common_quoted_lines: "Lines quoted (comparably) by every listed vendor. Args: vendor_ids? (default all), exclude_under_review?, qualified_only?.",
  calculate_total_for_vendor: "Annual value = Σ price × annual qty for a vendor. Args: vendor_id, line_scope (all_quoted|common|listed), line_ids?, price_basis?, exclude_under_review?.",
  calculate_lowest_qualified_supplier_by_line: "Per RFx line, the cheapest supplier and the basket total. Args: qualified_only? (default true), exclude_under_review?, exclude_vendors_with_open_critical?.",
  compare_vendors: "Side-by-side metrics on the lines all compared vendors quote. Args: vendor_ids, metrics?, exclude_under_review?.",
  get_historical_variance: "Weighted variance vs historical prices per vendor, plus the largest line variances. Args: vendor_id? .",
  run_scenario: "Basket comparison on common lines only (not an award): which vendor is cheapest under filters. Args: qualified_only?, exclude_under_review?, only_fully_quoted_lines?, min_technical_score?, exclude_vendors_with_open_critical?, vendor_ids?.",
  get_scenarios: "All award scenarios (standard SCN-001..006 + buyer-created) with cost, savings, suppliers, status, plus the recommended scenario id. No args.",
  run_sourcing_scenario: "Create and compute a NEW award scenario from structured constraints (objective, max_suppliers, require_full_coverage, minimum_technical_score, exclude_unresolved_critical, exclude_lines_under_review, include_freight, freight_assumption_pct, cost_tolerance_pct, allowed/excluded_vendors, treat_as_qualified, price_adjustments, fx_usd_inr). Set constraints.base_scenario_id to modify an existing scenario (follow-ups like 'now restrict that to two vendors'). Args: constraints.",
  compare_scenarios: "Side-by-side metrics and cost/score deltas for scenarios. Args: scenario_ids (first = baseline).",
  get_recommended_scenario: "The recommendation: chosen scenario, explicit decision rules applied, reasons, trade-offs, risks, unresolved dependencies, alternative and cost delta. No args.",
  get_scenario_allocation: "Line-by-line award for a scenario with unit cost, spend, next-best vendor and delta, unresolved issues. Args: scenario_id, rfx_line_id? (one line), vendor_id? (one vendor).",
  get_supplier_award_share: "Spend share, line share and largest-supplier exposure for a scenario. Args: scenario_id.",
  calculate_savings: "Evaluated vs historical spend and savings for a scenario, grouped by total|vendor|sku|category. Args: scenario_id, group_by.",
  get_scenario_risks: "Risks, assumptions, freight completeness and unresolved dependencies for a scenario. Args: scenario_id.",
  explain_vendor_exclusion: "Why a vendor is excluded from (or receives little of) a scenario, with the rule that applied and what it would take to include it. Args: vendor_id, scenario_id.",
  get_next_best_vendor: "For one RFx line in a scenario: awarded vendor, next-best alternative and delta, and all eligible offers. Args: rfx_line_id, scenario_id.",
  run_sensitivity: "What-if analysis on the recommendation: does it change, and by how much, if prices/FX/qualification/freight/supplier set change. Args: what_if (one change) or null for the standard set.",
};

export class ToolError extends Error {}

const UNDER_REVIEW = new Set(["needs_review", "blocked", "unresolved"]);

export function vendorLabel(b: CanonicalBid) {
  return `Vendor ${b.vendor.vendor_no ?? "?"} (${b.vendor.vendor_name}, ${b.vendor.vendor_id})`;
}

function priceOf(l: CanonicalLineItem, basis: ToolArgs["price_basis"]): number | null {
  if (!l.comparable) return null;
  return basis === "normalized" ? l.normalized_unit_price_inr : basis === "landed" ? l.landed_unit_price_inr : l.evaluation_unit_price_inr;
}

const usable = (l: CanonicalLineItem, excludeReview: boolean | null) => l.comparable && !(excludeReview && UNDER_REVIEW.has(l.review_status));
const crore = (n: number) => Math.round(n);

export class AnalystTools {
  readonly created: ScenarioSpec[] = [];
  private specs: ScenarioSpec[] = [];
  private scenarios: Scenario[] = [];
  private rec: Recommendation | null = null;
  readonly touchedScenarios: string[] = [];

  constructor(private ctx: EventContext, private bids: CanonicalBid[], private decision: DecisionState = emptyDecision()) {}

  private ensureScenarios() {
    if (this.rec) return;
    const r = runAll(this.ctx, this.bids, [...this.decision.custom_scenarios, ...this.created], this.decision.include_unfinalized);
    this.specs = r.specs;
    this.scenarios = r.scenarios;
    this.rec = recommend(this.ctx, this.bids, r.scenarios, this.decision.include_unfinalized);
  }

  scenario(id: string | null): Scenario {
    this.ensureScenarios();
    const want = (id ?? this.rec?.recommended_scenario_id ?? "").trim().toUpperCase();
    const sc = this.scenarios.find((x) => x.scenario_id.toUpperCase() === want);
    if (!sc) throw new ToolError(`Unknown scenario "${id}". Available: ${this.scenarios.map((x) => x.scenario_id).join(", ")}`);
    if (!this.touchedScenarios.includes(sc.scenario_id)) this.touchedScenarios.push(sc.scenario_id);
    return sc;
  }

  vendor(idOrNo: string | null): CanonicalBid {
    if (!idOrNo) throw new ToolError("vendor_id is required");
    const b = matchVendor(this.bids, idOrNo);
    if (!b) throw new ToolError(`No processed bid for vendor "${idOrNo}". Available: ${this.bids.map((x) => x.vendor.vendor_id).join(", ")}`);
    return b;
  }

  private vendors(ids: string[] | null): CanonicalBid[] {
    return ids?.length ? ids.map((i) => this.vendor(i)) : this.bids;
  }

  private qualified(b: CanonicalBid) { return b.processing_summary.qualification_status === "QUALIFIED"; }
  private openCritical(b: CanonicalBid) { return b.exceptions.some((e) => e.status === "open" && e.severity === "critical"); }

  run(tool: ToolName, a: ToolArgs): unknown {
    switch (tool) {
      case "list_vendors": return this.listVendors();
      case "get_vendor_bid": return this.getVendorBid(a);
      case "get_line_item_comparison": return this.lineComparison(a);
      case "get_missing_lines": return this.missingLines(a);
      case "get_qualification_status": return this.qualification(a);
      case "get_review_items": return this.reviewItems(a);
      case "get_vendor_commercial_summary": return this.commercial(a);
      case "get_common_quoted_lines": return this.commonLines(a);
      case "calculate_total_for_vendor": return this.totalForVendor(a);
      case "calculate_lowest_qualified_supplier_by_line": return this.lowestByLine(a);
      case "compare_vendors": return this.compare(a);
      case "get_historical_variance": return this.variance(a);
      case "run_scenario": return this.basketScenario(a);
      case "get_scenarios": return this.getScenarios();
      case "run_sourcing_scenario": return this.runSourcingScenario(a);
      case "compare_scenarios": return this.compareScenarios(a);
      case "get_recommended_scenario": return this.getRecommended();
      case "get_scenario_allocation": return this.allocation(a);
      case "get_supplier_award_share": return this.awardShare(a);
      case "calculate_savings": return this.savings(a);
      case "get_scenario_risks": return this.risks(a);
      case "explain_vendor_exclusion": return this.explainExclusion(a);
      case "get_next_best_vendor": return this.nextBest(a);
      case "run_sensitivity": return this.sensitivity(a);
    }
  }

  // ------------------------------------------------------------------ Stage 4 scenario tools
  private brief(s: Scenario) {
    return {
      scenario_id: s.scenario_id, name: s.name, kind: s.kind, status: s.status, status_message: s.status_message,
      total_evaluated_cost_inr: s.total_evaluated_cost, historical_cost_inr: s.historical_cost, savings_vs_historical_inr: s.savings_vs_historical,
      savings_percent: s.savings_percent, supplier_count: s.supplier_count, suppliers: s.suppliers.map((x) => `${x.vendor} ${x.spend_pct}% spend / ${x.lines} lines`),
      weighted_technical_score: s.weighted_technical_score, largest_supplier_share_pct: s.largest_supplier_exposure_pct,
      covered_lines: `${s.covered_lines}/${s.required_lines}`, constraints: s.qualification_constraints,
      excluded_vendors: s.excluded_vendors.map((v) => `${v.vendor}: ${v.reasons.join("; ")}`),
      landed_cost_complete: s.freight.landed_cost_complete, unresolved_dependencies: s.unresolved_dependencies.length,
    };
  }

  getScenarios() {
    this.ensureScenarios();
    return { recommended_scenario_id: this.rec!.recommended_scenario_id, scenarios: this.scenarios.map((s) => this.brief(s)) };
  }

  runSourcingScenario(a: ToolArgs) {
    if (!a.constraints) throw new ToolError("run_sourcing_scenario needs constraints");
    this.ensureScenarios();
    const used = [...this.decision.custom_scenarios, ...this.created].map((x) => Number(x.scenario_id.replace(/\D/g, "")) || 0);
    const id = `SCN-C${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
    const c = { ...a.constraints };
    if (c.base_scenario_id && !this.specs.some((x) => x.scenario_id === c.base_scenario_id)) throw new ToolError(`Unknown base scenario ${c.base_scenario_id}`);
    const spec: ScenarioSpec = { scenario_id: id, name: c.name ?? `Buyer scenario ${id}`, kind: "custom", constraints: c };
    this.created.push(spec);
    this.specs = [...this.specs, spec];
    const sc = runScenario(this.ctx, this.bids, spec, this.specs);
    this.scenarios = [...this.scenarios, sc];
    this.touchedScenarios.push(id);
    const base = c.base_scenario_id ? this.scenarios.find((x) => x.scenario_id === c.base_scenario_id) : this.scenarios.find((x) => x.scenario_id === this.rec!.recommended_scenario_id);
    return {
      created: this.brief(sc), resolved_constraints: sc.constraints, requested_constraints: sc.requested,
      risks: sc.risks.map((r) => `[${r.severity}] ${r.message}`),
      vs: base ? { scenario_id: base.scenario_id, name: base.name, cost_delta_inr: sc.total_evaluated_cost - base.total_evaluated_cost,
        cost_delta_pct: base.total_evaluated_cost ? Math.round(((sc.total_evaluated_cost - base.total_evaluated_cost) / base.total_evaluated_cost) * 1000) / 10 : null,
        technical_score_delta: sc.weighted_technical_score !== null && base.weighted_technical_score !== null ? Math.round((sc.weighted_technical_score - base.weighted_technical_score) * 10) / 10 : null } : null,
    };
  }

  compareScenarios(a: ToolArgs) {
    const ids = a.scenario_ids?.length ? a.scenario_ids : a.scenario_id ? [a.scenario_id] : [];
    if (ids.length < 2) throw new ToolError("compare_scenarios needs at least two scenario_ids");
    const list = ids.map((i) => this.scenario(i));
    const base = list[0];
    return {
      baseline: base.scenario_id,
      scenarios: list.map((s) => ({ ...this.brief(s),
        cost_delta_vs_baseline_inr: s.total_evaluated_cost - base.total_evaluated_cost,
        cost_delta_vs_baseline_pct: base.total_evaluated_cost ? Math.round(((s.total_evaluated_cost - base.total_evaluated_cost) / base.total_evaluated_cost) * 1000) / 10 : null,
        technical_score_delta: s.weighted_technical_score !== null && base.weighted_technical_score !== null ? Math.round((s.weighted_technical_score - base.weighted_technical_score) * 10) / 10 : null,
        lines_moved_vs_baseline: s.allocations.filter((x) => base.allocations.find((y) => y.rfx_line_id === x.rfx_line_id)?.awarded_vendor_id !== x.awarded_vendor_id).map((x) => x.rfx_line_id),
      })),
    };
  }

  getRecommended() {
    this.ensureScenarios();
    const r = this.rec!;
    const chosen = r.recommended_scenario_id ? this.scenario(r.recommended_scenario_id) : null;
    return { ...r, recommended: chosen ? this.brief(chosen) : null,
      risks: r.risks.map((x) => `[${x.severity}] ${x.message}`),
      unresolved_dependencies: r.unresolved_dependencies.map((d) => `${d.review_item_id} (${d.severity}, ${d.status}): ${d.message}`) };
  }

  allocation(a: ToolArgs) {
    const sc = this.scenario(a.scenario_id);
    let rows = sc.allocations;
    if (a.rfx_line_id) rows = rows.filter((x) => x.rfx_line_id === a.rfx_line_id!.toUpperCase());
    if (a.vendor_id) { const b = this.vendor(a.vendor_id); rows = rows.filter((x) => x.awarded_vendor_id === b.vendor.vendor_id); }
    return { scenario_id: sc.scenario_id, name: sc.name, lines: rows.length, allocations: rows };
  }

  awardShare(a: ToolArgs) {
    const sc = this.scenario(a.scenario_id);
    return { scenario_id: sc.scenario_id, supplier_count: sc.supplier_count, largest_supplier_share_pct: sc.largest_supplier_exposure_pct, suppliers: sc.suppliers };
  }

  savings(a: ToolArgs) {
    const sc = this.scenario(a.scenario_id);
    return { scenario_id: sc.scenario_id, name: sc.name, total_evaluated_inr: sc.total_evaluated_cost, historical_inr: sc.historical_cost,
      savings_inr: sc.savings_vs_historical, savings_pct: sc.savings_percent, basis: "FY25-26 delivered price × annual qty for the same lines",
      breakdown: savingsBreakdown(sc, this.ctx, a.group_by ?? "total") };
  }

  risks(a: ToolArgs) {
    const sc = this.scenario(a.scenario_id);
    return { scenario_id: sc.scenario_id, risks: sc.risks, assumptions: sc.assumptions, freight: sc.freight, unresolved_dependencies: sc.unresolved_dependencies };
  }

  explainExclusion(a: ToolArgs) {
    const b = this.vendor(a.vendor_id);
    const sc = this.scenario(a.scenario_id);
    const ex = sc.excluded_vendors.find((v) => v.vendor_id === b.vendor.vendor_id);
    const share = sc.suppliers.find((x) => x.vendor_id === b.vendor.vendor_id);
    const cheaperLines = sc.allocations.filter((al) => {
      const l = b.line_items.find((x) => x.rfx_line_id === al.rfx_line_id);
      return l?.evaluation_unit_price_inr !== null && l?.evaluation_unit_price_inr !== undefined && l.evaluation_unit_price_inr < al.evaluated_unit_cost_inr;
    }).map((al) => al.rfx_line_id);
    return {
      vendor: vendorLabel(b), scenario_id: sc.scenario_id, scenario: sc.name,
      status: ex ? "excluded" : share ? "awarded" : "eligible_not_awarded",
      exclusion_reasons: ex?.reasons ?? [], award_share: share ?? null,
      qualification: { score: b.processing_summary.technical_score, status: b.processing_summary.qualification_status, mandatory_failures: b.processing_summary.mandatory_failures },
      coverage: `${b.processing_summary.quoted_lines}/${b.processing_summary.rfx_lines}`, open_critical_items: b.exceptions.filter((e) => e.severity === "critical" && e.status !== "resolved").map((e) => e.id),
      lines_where_vendor_is_cheaper_than_award: cheaperLines,
      not_awarded_because: !ex && !share ? (sc.constraints.max_suppliers ? `Supplier limit of ${sc.constraints.max_suppliers}: other suppliers give a lower total` : "Another eligible supplier is cheaper on every line it quotes") : null,
      to_include: ex ? `Run a scenario with treat_as_qualified/excluded_vendors adjusted, or resolve: ${ex.reasons.join("; ")}` : null,
    };
  }

  nextBest(a: ToolArgs) {
    const sc = this.scenario(a.scenario_id);
    const id = a.rfx_line_id?.toUpperCase();
    const al = sc.allocations.find((x) => x.rfx_line_id === id);
    if (!id || !this.ctx.lines.some((l) => l.line_id === id)) throw new ToolError(`Unknown RFx line "${a.rfx_line_id}"`);
    const offers = this.bids.flatMap((b) => {
      const l = b.line_items.find((x) => x.rfx_line_id === id);
      return l ? [{ vendor: vendorLabel(b), eligible: sc.eligible_vendors.includes(b.vendor.vendor_id), evaluation_inr: l.evaluation_unit_price_inr, status: l.review_status }] : [];
    }).sort((x, y) => (x.evaluation_inr ?? 1e12) - (y.evaluation_inr ?? 1e12));
    return { scenario_id: sc.scenario_id, rfx_line_id: id, award: al ?? null, all_offers: offers };
  }

  sensitivity(a: ToolArgs) {
    this.ensureScenarios();
    const w = a.what_if;
    const list = w ? [{ label: w.label, change: Object.fromEntries(Object.entries({
      price_adjustments: w.price_adjustments ?? undefined, fx_usd_inr: w.fx_usd_inr ?? undefined, treat_as_qualified: w.treat_as_qualified ?? undefined,
      excluded_vendors: w.excluded_vendors ?? undefined, freight_assumption_pct: w.freight_assumption_pct ?? undefined,
    }).filter(([, v]) => v !== undefined)) }] : standardWhatIfs(this.scenarios, this.rec!, this.bids, this.ctx);
    return { recommended_scenario_id: this.rec!.recommended_scenario_id,
      results: runSensitivity(this.ctx, this.bids, [...this.decision.custom_scenarios, ...this.created], this.decision.include_unfinalized, list, { scenarios: this.scenarios, rec: this.rec! }) };
  }

  listVendors() {
    return this.bids.map((b) => ({
      vendor: vendorLabel(b), vendor_id: b.vendor.vendor_id, source_type: b.response_metadata.source_type, review_state: b.review_state,
      quoted_lines: b.processing_summary.quoted_lines, rfx_lines: b.processing_summary.rfx_lines, missing_lines: b.processing_summary.missing_lines,
      technical_score: b.processing_summary.technical_score, qualification: b.processing_summary.qualification_status,
      open_review_items: b.processing_summary.open_review_items, unresolved_review_items: b.processing_summary.unresolved_review_items,
    }));
  }

  getVendorBid(a: ToolArgs) {
    const b = this.vendor(a.vendor_id);
    return {
      vendor: vendorLabel(b), review_state: b.review_state, summary: b.processing_summary, source_files: b.response_metadata.source_files,
      lines: b.line_items.map((l) => ({
        rfx_line_id: l.rfx_line_id, raw: `${l.raw_price_text} ${l.raw_uom}`, normalized_inr: l.normalized_unit_price_inr,
        evaluation_inr: l.evaluation_unit_price_inr, freight: l.freight.basis, moq: l.moq, lead_time_days: l.lead_time_days,
        status: l.review_status, reasons: l.review_reasons, evidence: l.evidence[0]?.location,
      })),
    };
  }

  lineComparison(a: ToolArgs) {
    const id = a.rfx_line_id?.toUpperCase();
    const rl = this.ctx.lines.find((l) => l.line_id === id);
    if (!rl) throw new ToolError(`Unknown RFx line "${a.rfx_line_id}"`);
    const rows = this.bids.map((b) => {
      const l = b.line_items.find((x) => x.rfx_line_id === id);
      return {
        vendor: vendorLabel(b), vendor_id: b.vendor.vendor_id, qualified: this.qualified(b),
        quoted: !!l, evaluation_inr: l && usable(l, a.exclude_under_review) ? l.evaluation_unit_price_inr : null,
        normalized_inr: l?.normalized_unit_price_inr ?? null, status: l?.review_status ?? "not_quoted", reasons: l?.review_reasons ?? [],
        raw: l ? `${l.raw_price_text} (${l.raw_uom})` : null, evidence: l?.evidence[0] ?? null,
      };
    });
    const priced = rows.filter((r) => r.evaluation_inr !== null);
    const min = (rs: typeof rows) => rs.length ? rs.reduce((m, r) => (r.evaluation_inr! < m.evaluation_inr! ? r : m)) : null;
    return {
      rfx_line_id: id, description: rl.item_description, plant: rl.delivery_plant, annual_qty: rl.annual_qty,
      historical_inr: this.ctx.historical[rl.line_id]?.price_inr ?? null, vendors: rows,
      lowest: min(priced)?.vendor ?? null, lowest_qualified: min(priced.filter((r) => r.qualified))?.vendor ?? null,
    };
  }

  missingLines(a: ToolArgs) {
    const b = this.vendor(a.vendor_id);
    return {
      vendor: vendorLabel(b), missing_count: b.missing_rfx_lines.length,
      missing: b.missing_rfx_lines.map((id) => {
        const d = b.declined_rfx_lines.find((x) => x.rfx_line_id === id);
        return { rfx_line_id: id, description: this.ctx.lines.find((l) => l.line_id === id)?.item_description, declined_statement: d?.statement ?? null, evidence: d?.evidence ?? null };
      }),
    };
  }

  qualification(a: ToolArgs) {
    const list = a.vendor_id ? [this.vendor(a.vendor_id)] : this.bids;
    return {
      rule: this.ctx.qualification.rule,
      vendors: list.map((b) => ({
        vendor: vendorLabel(b), technical_score: b.processing_summary.technical_score, max: b.processing_summary.technical_max,
        qualification: b.processing_summary.qualification_status, mandatory_failures: b.processing_summary.mandatory_failures,
        answers: b.questionnaire_answers.map((q) => ({
          qid: q.qid, topic: q.topic, mandatory: q.mandatory, compliance: q.compliance, points: q.points, max_points: q.max_points,
          answer: q.answer_text, evidence: q.evidence,
        })).filter((q) => (a.vendor_id ? true : q.mandatory)),
      })),
    };
  }

  reviewItems(a: ToolArgs) {
    const status = a.status ?? "open";
    const list = a.vendor_id ? [this.vendor(a.vendor_id)] : this.bids;
    const items = list.flatMap((b) => b.exceptions.filter((e) => status === "all" || e.status === status).map((e) => ({
      vendor: vendorLabel(b), id: e.id, status: e.status, severity: e.severity, reason: e.reason, rfx_line_id: e.rfx_line_id,
      message: e.message, resolution: e.resolution?.resolution ?? null, evidence: e.evidence.slice(0, 2),
    })));
    return { status_filter: status, count: items.length, items };
  }

  commercial(a: ToolArgs) {
    const b = this.vendor(a.vendor_id);
    const t = b.commercial_terms;
    const ev = (x: { evidence: unknown }) => x.evidence;
    return {
      vendor: vendorLabel(b), quote_date: b.response_metadata.quote_date, currency: t.currency, payment_terms: t.payment_terms, payment_days: t.payment_days,
      price_validity_until: t.price_validity_until, validity_statements: t.price_validity_statements,
      validity_conflict: b.exceptions.find((e) => e.id === "terms:validity:conflicting_values") ?? null,
      freight: t.freight_statements.map((f) => ({ statement: f.statement, basis: f.freight_basis, plants: f.freight_plants, evidence: ev(f) })),
      freight_by_line_basis: countBy(b.line_items.map((l) => l.freight.basis)),
      tax: t.tax, discounts: t.discounts.map((d) => ({ statement: d.statement, pct: d.percentage, conditional: d.is_conditional, condition: d.condition, evidence: ev(d) })),
      tooling: t.tooling.map((d) => ({ statement: d.statement, amount: d.amount, evidence: ev(d) })),
      other_terms: t.other_terms.map((d) => ({ topic: d.topic, statement: d.statement, applies_to: d.applies_to, evidence: ev(d) })),
      annual_value_evaluated_inr: b.processing_summary.annual_value_evaluated_inr, lines_counted: b.processing_summary.annual_value_lines_counted,
    };
  }

  commonLineIds(bids: CanonicalBid[], excludeReview: boolean | null): string[] {
    return this.ctx.lines.map((l) => l.line_id).filter((id) => bids.every((b) => {
      const l = b.line_items.find((x) => x.rfx_line_id === id);
      return !!l && usable(l, excludeReview);
    }));
  }

  commonLines(a: ToolArgs) {
    let bids = this.vendors(a.vendor_ids);
    if (a.qualified_only) bids = bids.filter((b) => this.qualified(b));
    const ids = this.commonLineIds(bids, a.exclude_under_review);
    return { vendors: bids.map(vendorLabel), common_line_count: ids.length, common_lines: ids };
  }

  totalForVendor(a: ToolArgs) {
    const b = this.vendor(a.vendor_id);
    const scope = a.line_scope ?? "all_quoted";
    const ids = scope === "common" ? this.commonLineIds(this.bids, a.exclude_under_review)
      : scope === "listed" ? (a.line_ids ?? []).map((x) => x.toUpperCase()) : b.line_items.map((l) => l.rfx_line_id);
    let total = 0;
    const counted: string[] = [], skipped: { rfx_line_id: string; why: string }[] = [];
    for (const id of ids) {
      const l = b.line_items.find((x) => x.rfx_line_id === id);
      const p = l && usable(l, a.exclude_under_review) ? priceOf(l, a.price_basis) : null;
      if (!l) skipped.push({ rfx_line_id: id, why: "not quoted" });
      else if (p === null) skipped.push({ rfx_line_id: id, why: !l.comparable ? `not comparable (${l.review_status})` : a.exclude_under_review && UNDER_REVIEW.has(l.review_status) ? "under review" : "price basis unavailable" });
      else { total += p * l.annual_qty; counted.push(id); }
    }
    return { vendor: vendorLabel(b), line_scope: scope, price_basis: a.price_basis ?? "evaluation", lines_counted: counted.length, annual_value_inr: crore(total), skipped };
  }

  lowestByLine(a: ToolArgs) {
    const qualifiedOnly = a.qualified_only ?? true;
    let bids = this.bids;
    if (qualifiedOnly) bids = bids.filter((b) => this.qualified(b));
    if (a.exclude_vendors_with_open_critical) bids = bids.filter((b) => !this.openCritical(b));
    const lines = this.ctx.lines.map((rl) => {
      const offers = bids.flatMap((b) => {
        const l = b.line_items.find((x) => x.rfx_line_id === rl.line_id);
        const p = l && usable(l, a.exclude_under_review) ? l.evaluation_unit_price_inr : null;
        return p === null ? [] : [{ vendor_id: b.vendor.vendor_id, vendor: vendorLabel(b), price: p }];
      }).sort((x, y) => x.price - y.price);
      const best = offers[0];
      return { rfx_line_id: rl.line_id, annual_qty: rl.annual_qty, lowest_vendor: best?.vendor ?? null, lowest_price_inr: best?.price ?? null, runner_up: offers[1]?.vendor ?? null, offers: offers.length };
    });
    const covered = lines.filter((l) => l.lowest_price_inr !== null);
    const wins = countBy(covered.map((l) => l.lowest_vendor!));
    return {
      filters: { qualified_only: qualifiedOnly, exclude_under_review: !!a.exclude_under_review, exclude_vendors_with_open_critical: !!a.exclude_vendors_with_open_critical },
      vendors_considered: bids.map(vendorLabel), lines_with_offer: covered.length, lines_without_offer: lines.filter((l) => l.lowest_price_inr === null).map((l) => l.rfx_line_id),
      basket_annual_value_inr: crore(covered.reduce((s, l) => s + l.lowest_price_inr! * l.annual_qty, 0)), line_wins_by_vendor: wins, lines,
    };
  }

  compare(a: ToolArgs) {
    const bids = this.vendors(a.vendor_ids);
    if (bids.length < 2) throw new ToolError("compare_vendors needs at least two vendor_ids");
    const metrics = a.metrics?.length ? a.metrics : ["price", "lead_time", "technical_score", "coverage", "qualification"];
    const common = this.commonLineIds(bids, a.exclude_under_review);
    return {
      common_line_count: common.length, exclude_under_review: !!a.exclude_under_review,
      vendors: bids.map((b) => {
        const row: Record<string, unknown> = { vendor: vendorLabel(b) };
        if (metrics.includes("price")) row.common_lines_annual_value_inr = crore(common.reduce((s, id) => s + (b.line_items.find((l) => l.rfx_line_id === id)!.evaluation_unit_price_inr ?? 0) * this.ctx.lines.find((l) => l.line_id === id)!.annual_qty, 0));
        if (metrics.includes("lead_time")) row.lead_time_days = summarizeNums(b.line_items.map((l) => l.lead_time_days));
        if (metrics.includes("technical_score")) row.technical_score = b.processing_summary.technical_score;
        if (metrics.includes("qualification")) row.qualification = b.processing_summary.qualification_status;
        if (metrics.includes("coverage")) row.quoted_lines = `${b.processing_summary.quoted_lines}/${b.processing_summary.rfx_lines}`;
        if (metrics.includes("payment")) row.payment = b.commercial_terms.payment_terms;
        if (metrics.includes("validity")) row.validity_until = b.commercial_terms.price_validity_until;
        if (metrics.includes("review_items")) row.open_review_items = b.processing_summary.open_review_items;
        if (metrics.includes("variance")) row.weighted_variance_vs_historical_pct = this.weightedVariance(b, common);
        return row;
      }),
    };
  }

  private weightedVariance(b: CanonicalBid, ids?: string[]): number | null {
    let v = 0, h = 0;
    for (const l of b.line_items) {
      if (ids && !ids.includes(l.rfx_line_id)) continue;
      if (!l.comparable || l.evaluation_unit_price_inr === null || l.historical_price_inr === null) continue;
      v += l.evaluation_unit_price_inr * l.annual_qty;
      h += l.historical_price_inr * l.annual_qty;
    }
    return h ? Math.round(((v - h) / h) * 1000) / 10 : null;
  }

  variance(a: ToolArgs) {
    const list = a.vendor_id ? [this.vendor(a.vendor_id)] : this.bids;
    const lines = list.flatMap((b) => b.line_items.filter((l) => l.comparable && l.variance_vs_historical_pct !== null)
      .map((l) => ({ vendor: vendorLabel(b), rfx_line_id: l.rfx_line_id, variance_pct: l.variance_vs_historical_pct!, evaluation_inr: l.evaluation_unit_price_inr, historical_inr: l.historical_price_inr, status: l.review_status })));
    return {
      basis: "evaluation price vs FY25-26 delivered price, weighted by annual quantity",
      by_vendor: list.map((b) => ({ vendor: vendorLabel(b), weighted_variance_pct: this.weightedVariance(b), lines: b.line_items.filter((l) => l.variance_vs_historical_pct !== null).length })),
      largest_line_variances: [...lines].sort((x, y) => Math.abs(y.variance_pct) - Math.abs(x.variance_pct)).slice(0, 8),
    };
  }

  basketScenario(a: ToolArgs) {
    let bids = this.vendors(a.vendor_ids);
    const excluded: { vendor: string; why: string }[] = [];
    bids = bids.filter((b) => {
      if (a.qualified_only && !this.qualified(b)) { excluded.push({ vendor: vendorLabel(b), why: "not qualified" }); return false; }
      if (a.min_technical_score !== null && a.min_technical_score !== undefined && b.processing_summary.technical_score < a.min_technical_score) { excluded.push({ vendor: vendorLabel(b), why: `technical score ${b.processing_summary.technical_score} < ${a.min_technical_score}` }); return false; }
      if (a.exclude_vendors_with_open_critical && this.openCritical(b)) { excluded.push({ vendor: vendorLabel(b), why: "open critical review items" }); return false; }
      return true;
    });
    let ids = this.commonLineIds(bids, a.exclude_under_review);
    if (a.only_fully_quoted_lines) ids = ids.filter((id) => this.bids.every((b) => b.line_items.some((l) => l.rfx_line_id === id)));
    const totals = bids.map((b) => ({
      vendor: vendorLabel(b), annual_value_inr: crore(ids.reduce((s, id) => s + (b.line_items.find((l) => l.rfx_line_id === id)!.evaluation_unit_price_inr ?? 0) * this.ctx.lines.find((l) => l.line_id === id)!.annual_qty, 0)),
      technical_score: b.processing_summary.technical_score, qualification: b.processing_summary.qualification_status,
    })).sort((x, y) => x.annual_value_inr - y.annual_value_inr);
    const hist = crore(ids.reduce((s, id) => s + (this.ctx.historical[id]?.price_inr ?? 0) * this.ctx.lines.find((l) => l.line_id === id)!.annual_qty, 0));
    return { filters: a, excluded_vendors: excluded, basket_line_count: ids.length, basket_lines: ids, historical_value_inr: hist, ranking: totals, cheapest: totals[0]?.vendor ?? null };
  }
}

function countBy(xs: string[]): Record<string, number> {
  return xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}

function summarizeNums(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => x !== null);
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v), typical: v.sort((a, b) => a - b)[Math.floor(v.length / 2)] };
}
