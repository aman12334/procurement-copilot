/** The standard scenario set generated for every event (definitions only – the engine computes results). */
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { runScenario } from "./engine";
import { emptyConstraints, type Scenario, type ScenarioConstraints, type ScenarioSpec } from "./types";

const c = (o: Partial<ScenarioConstraints>): ScenarioConstraints => ({ ...emptyConstraints(), ...o });

export function standardSpecs(includeUnfinalized = false): ScenarioSpec[] {
  const base = { include_unfinalized: includeUnfinalized || null };
  return [
    { scenario_id: "SCN-001", name: "Best single-source award", kind: "standard", constraints: c({ ...base, max_suppliers: 1, require_full_coverage: true }) },
    { scenario_id: "SCN-002", name: "Cheapest qualified supplier per line", kind: "standard", constraints: c({ ...base }) },
    { scenario_id: "SCN-003", name: "Lowest cost, max 2 suppliers", kind: "standard", constraints: c({ ...base, max_suppliers: 2 }) },
    { scenario_id: "SCN-004", name: "Lowest cost, max 3 suppliers", kind: "standard", constraints: c({ ...base, max_suppliers: 3 }) },
    { scenario_id: "SCN-005", name: "Quality-first (≤5% above cheapest, max 3 suppliers)", kind: "standard", constraints: c({ ...base, objective: "maximize_quality", cost_tolerance_pct: 5, max_suppliers: 3 }) },
    { scenario_id: "SCN-006", name: "Risk-adjusted (no unresolved critical issues, ≥50% coverage)", kind: "standard", constraints: c({ ...base, exclude_unresolved_critical: true, min_line_coverage_pct: 50 }) },
  ];
}

/** Reference only: what the cheapest award would be if technical qualification were ignored (explains "why not the cheapest vendor"). */
export function unconstrainedReferenceSpec(includeUnfinalized = false): ScenarioSpec {
  return { scenario_id: "REF-UNQUALIFIED", name: "Reference: cheapest per line ignoring qualification", kind: "sensitivity",
    constraints: c({ include_unfinalized: includeUnfinalized || null, require_qualified: false, require_mandatory_certifications: false }) };
}

export function runAll(ctx: EventContext, bids: CanonicalBid[], custom: ScenarioSpec[], includeUnfinalized = false): { specs: ScenarioSpec[]; scenarios: Scenario[] } {
  const specs = [...standardSpecs(includeUnfinalized), ...custom.map((s) => ({ ...s, constraints: { ...s.constraints, include_unfinalized: s.constraints.include_unfinalized ?? (includeUnfinalized || null) } }))];
  return { specs, scenarios: specs.map((s) => runScenario(ctx, bids, s, specs)) };
}
