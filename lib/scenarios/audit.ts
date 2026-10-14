/**
 * Decision audit for engine output: "scenarios_generated" / "recommendation_generated" are logged when the
 * deterministic result changes (new bids, HITL edits, custom scenarios, preview toggle) – not on every render.
 */
import type { DecisionAuditEvent, DecisionState, Recommendation, Scenario } from "./types";

const lastOf = (d: DecisionState, type: DecisionAuditEvent["type"]) => [...d.audit].reverse().find((e) => e.type === type);

export function scenarioSignature(scenarios: Scenario[]): string {
  return scenarios.map((s) => `${s.scenario_id}:${s.total_evaluated_cost === null ? "-" : Math.round(s.total_evaluated_cost)}:${s.suppliers.map((x) => x.vendor_id).join("+")}`).join("|");
}

export function recommendationSignature(r: Recommendation): string {
  return `${r.status}:${r.recommended_scenario_id ?? "-"}:${r.alternative_scenario_id ?? "-"}`;
}

export function auditGenerated(d: DecisionState, scenarios: Scenario[], rec: Recommendation, ctx: { finalized_bids: number; total_bids: number }, now = new Date()): DecisionState {
  const at = now.toISOString();
  const events: DecisionAuditEvent[] = [];
  const sSig = scenarioSignature(scenarios);
  if (lastOf(d, "scenarios_generated")?.data?.signature !== sSig) {
    events.push({ at, type: "scenarios_generated", scenario_id: null,
      detail: `${scenarios.length} scenario(s) computed from ${ctx.finalized_bids}/${ctx.total_bids} finalized bid(s)${d.include_unfinalized ? " (preview incl. unfinalized)" : ""}`,
      data: { signature: sSig, scenario_ids: scenarios.map((s) => s.scenario_id) } });
  }
  const rSig = recommendationSignature(rec);
  if (lastOf(d, "recommendation_generated")?.data?.signature !== rSig) {
    const best = scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id);
    events.push({ at, type: "recommendation_generated", scenario_id: rec.recommended_scenario_id,
      detail: best ? `Engine recommends ${best.name} (${best.scenario_id})${rec.alternative_scenario_id ? `; alternative ${rec.alternative_scenario_id}` : ""}` : "No viable scenario",
      data: { signature: rSig, total_evaluated_cost: best?.total_evaluated_cost ?? null, alternative: rec.alternative_scenario_id } });
  }
  return events.length ? { ...d, audit: [...d.audit, ...events].slice(-500) } : d;
}
