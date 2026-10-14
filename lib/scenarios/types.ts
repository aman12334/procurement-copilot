/** Stage 4 scenario / recommendation / decision types. Constraints are the only thing persisted – results are recomputed. */
import { z } from "zod";

export const ScenarioConstraintsSchema = z.object({
  name: z.string().nullable().describe("Short scenario name"),
  base_scenario_id: z.string().nullable().describe("Start from this scenario's constraints and override only the fields set here"),
  objective: z.enum(["minimize_cost", "maximize_quality"]).nullable(),
  max_suppliers: z.number().int().nullable().describe("Maximum number of awarded suppliers; null = no limit"),
  require_full_coverage: z.boolean().nullable().describe("Every required line must be covered by the awarded supplier set (single-source style)"),
  minimum_technical_score: z.number().nullable(),
  require_qualified: z.boolean().nullable().describe("Exclude vendors whose technical qualification failed (default true)"),
  require_mandatory_certifications: z.boolean().nullable().describe("Exclude vendors failing any mandatory questionnaire item (default true)"),
  exclude_unresolved_critical: z.boolean().nullable().describe("Exclude vendors with open or unresolved critical review items"),
  exclude_lines_under_review: z.boolean().nullable().describe("Ignore individual quotes still needing review"),
  min_line_coverage_pct: z.number().nullable().describe("Exclude vendors quoting fewer than this % of RFx lines"),
  include_freight: z.boolean().nullable().describe("true = landed / RFx freight-loading evaluation price (default); false = pre-freight normalized price"),
  freight_assumption_pct: z.number().nullable().describe("Buyer-provided freight assumption (% of price) for lines where freight is not quoted; replaces the RFx loading"),
  cost_tolerance_pct: z.number().nullable().describe("For maximize_quality: accept up to this % above the cheapest scenario with the same supplier limit"),
  allowed_vendors: z.array(z.string()).nullable(),
  excluded_vendors: z.array(z.string()).nullable(),
  treat_as_qualified: z.array(z.string()).nullable().describe("What-if: treat these vendors as technically qualified"),
  price_adjustments: z.array(z.object({ vendor_id: z.string(), pct: z.number() })).nullable().describe("What-if: change a vendor's prices by pct (+5 = 5% higher)"),
  fx_usd_inr: z.number().nullable().describe("What-if: USD→INR rate for USD-quoted lines"),
  include_unfinalized: z.boolean().nullable().describe("Also use processed bids that are not finalized (preview only)"),
});
export type ScenarioConstraints = z.infer<typeof ScenarioConstraintsSchema>;

export const emptyConstraints = (): ScenarioConstraints => ({
  name: null, base_scenario_id: null, objective: null, max_suppliers: null, require_full_coverage: null, minimum_technical_score: null,
  require_qualified: null, require_mandatory_certifications: null, exclude_unresolved_critical: null, exclude_lines_under_review: null,
  min_line_coverage_pct: null, include_freight: null, freight_assumption_pct: null, cost_tolerance_pct: null, allowed_vendors: null,
  excluded_vendors: null, treat_as_qualified: null, price_adjustments: null, fx_usd_inr: null, include_unfinalized: null,
});

/** Fully-resolved constraints after defaults and base-scenario merge. */
export interface ResolvedConstraints {
  objective: "minimize_cost" | "maximize_quality";
  max_suppliers: number | null;
  require_full_coverage: boolean;
  minimum_technical_score: number | null;
  require_qualified: boolean;
  require_mandatory_certifications: boolean;
  exclude_unresolved_critical: boolean;
  exclude_lines_under_review: boolean;
  min_line_coverage_pct: number | null;
  include_freight: boolean;
  freight_assumption_pct: number | null;
  cost_tolerance_pct: number;
  allowed_vendors: string[];
  excluded_vendors: string[];
  treat_as_qualified: string[];
  price_adjustments: { vendor_id: string; pct: number }[];
  fx_usd_inr: number | null;
  include_unfinalized: boolean;
}

export interface ScenarioSpec { scenario_id: string; name: string; kind: "standard" | "custom" | "sensitivity"; constraints: ScenarioConstraints }

export interface Allocation {
  rfx_line_id: string;
  sku: string;
  description: string;
  delivery_plant: string;
  awarded_vendor_id: string;
  awarded_vendor: string;
  evaluated_unit_cost_inr: number;
  annual_qty: number;
  annual_evaluated_spend_inr: number;
  historical_unit_cost_inr: number | null;
  qualification_status: "QUALIFIED" | "NOT QUALIFIED" | "TREATED AS QUALIFIED";
  freight_basis: "landed" | "rfx_loading" | "buyer_assumption" | "pre_freight";
  reason_selected: string;
  next_best_vendor: string | null;
  next_best_unit_cost_inr: number | null;
  delta_vs_next_best_inr: number | null;
  unresolved_issue: string | null;
}

export interface ExcludedVendor { vendor_id: string; vendor: string; reasons: string[] }

export interface ScenarioRisk { severity: "high" | "medium" | "low"; code: string; message: string; vendor_id: string | null; rfx_line_ids: string[] }

export interface UnresolvedDependency { vendor_id: string; review_item_id: string; reason: string; severity: string; status: string; rfx_line_id: string | null; message: string }

export interface SupplierShare { vendor_id: string; vendor: string; lines: number; lines_pct: number; spend_inr: number; spend_pct: number; technical_score: number }

export interface Scenario {
  scenario_id: string;
  name: string;
  kind: ScenarioSpec["kind"];
  objective: ResolvedConstraints["objective"];
  constraints: ResolvedConstraints;
  requested: ScenarioConstraints;
  status: "complete" | "incomplete_coverage" | "no_full_coverage" | "no_eligible_vendors";
  status_message: string;
  currency: "INR";
  required_lines: number;
  covered_lines: number;
  uncovered_lines: string[];
  total_evaluated_cost: number;
  historical_cost: number;
  savings_vs_historical: number;
  savings_percent: number | null;
  supplier_count: number;
  suppliers: SupplierShare[];
  largest_supplier_exposure_pct: number;
  weighted_technical_score: number | null;
  allocations: Allocation[];
  eligible_vendors: string[];
  excluded_vendors: ExcludedVendor[];
  qualification_constraints: string[];
  assumptions: string[];
  freight: { landed_lines: number; loading_lines: number; assumption_lines: number; pre_freight_lines: number; landed_cost_complete: boolean; note: string };
  risks: ScenarioRisk[];
  unresolved_dependencies: UnresolvedDependency[];
  bids_used: { vendor_id: string; review_state: string }[];
}

export interface Recommendation {
  recommended_scenario_id: string | null;
  recommended_name: string | null;
  policy: Record<string, number | boolean>;
  decision_log: { rule: string; outcome: string }[];
  key_reasons: string[];
  trade_offs: string[];
  risks: ScenarioRisk[];
  unresolved_dependencies: UnresolvedDependency[];
  alternative_scenario_id: string | null;
  alternative_name: string | null;
  cost_delta_to_alternative: number | null;
  status: "recommended" | "no_viable_scenario";
}

export const AUDIT_TYPES = ["scenarios_generated", "recommendation_generated", "scenario_created", "scenario_modified", "buyer_question",
  "scenario_selected", "scenario_preferred", "recommendation_approved", "recommendation_rejected", "exported"] as const;

export interface DecisionAuditEvent {
  at: string;
  type: (typeof AUDIT_TYPES)[number];
  scenario_id?: string | null;
  detail: string;
  data?: Record<string, unknown>;
}

export interface DecisionState {
  custom_scenarios: ScenarioSpec[];
  preferred_scenario_id: string | null;
  selected_scenario_id: string | null;
  status: "open" | "buyer_selected" | "approved" | "rejected";
  include_unfinalized: boolean;
  audit: DecisionAuditEvent[];
}

export const DecisionStateSchema = z.object({
  custom_scenarios: z.array(z.object({ scenario_id: z.string(), name: z.string(), kind: z.enum(["standard", "custom", "sensitivity"]), constraints: ScenarioConstraintsSchema })).max(50),
  preferred_scenario_id: z.string().nullable(),
  selected_scenario_id: z.string().nullable(),
  status: z.enum(["open", "buyer_selected", "approved", "rejected"]),
  include_unfinalized: z.boolean(),
  audit: z.array(z.object({ at: z.string(), type: z.enum(AUDIT_TYPES), scenario_id: z.string().nullable().optional(), detail: z.string(), data: z.record(z.string(), z.unknown()).optional() })).max(500),
});

export const emptyDecision = (): DecisionState => ({
  custom_scenarios: [], preferred_scenario_id: null, selected_scenario_id: null, status: "open", include_unfinalized: false, audit: [],
});
