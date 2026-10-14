"use client";
/** Stage 4 – scenarios, recommendation, sensitivity, buyer decision and export. All numbers come from /api/decision. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanonicalBid } from "@/lib/bids/schema";
import { bidEnvelope, loadActiveEvent, loadBids, loadDecision, loadRfqs, postJson, saveDecision, updateRfqs, withAudit } from "@/lib/client/bid-store";
import { AllocationError, awardFromScenario, recordAllocation, type RfqEntry } from "@/lib/rfq/registry";
import { auditGenerated } from "@/lib/scenarios/audit";
import type { SensitivityResult } from "@/lib/scenarios/sensitivity";
import { emptyConstraints, type DecisionState, type Recommendation, type Scenario, type ScenarioConstraints } from "@/lib/scenarios/types";

const cr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${(n / 1e7).toFixed(2)} Cr`);
const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);
const signed = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n >= 0 ? "+" : "−"}${inr(Math.abs(n))}`);

interface DecisionResponse { ok: true; scenarios: Scenario[]; recommendation: Recommendation; sensitivity: SensitivityResult[]; finalized_bids: number; total_bids: number }

export default function DecisionWorkspace() {
  const [bids, setBids] = useState<CanonicalBid[]>([]);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [data, setData] = useState<DecisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [eventInfo, setEventInfo] = useState<{ rfx_id: string; title: string } | null>(null);
  const [allocated, setAllocated] = useState<RfqEntry | null>(null);
  useEffect(() => {
    setBids(Object.values(loadBids())); setDecision(loadDecision());
    postJson<{ rfx_id: string; title: string }>("/api/event", {}).then(({ data: e }) => {
      setEventInfo({ rfx_id: e.rfx_id, title: e.title });
      setAllocated(loadRfqs().find((r) => r.rfx_id === e.rfx_id && r.status === "awarded") ?? null);
    }).catch(() => {});
  }, []);

  /** After approval: record the order allocation for this RFQ in the register (no PO is sent to suppliers). */
  function allocate() {
    if (!decision || !eventInfo || decision.status !== "approved" || !decision.selected_scenario_id) return;
    const s = byId.get(decision.selected_scenario_id);
    if (!s) return;
    const lines = s.suppliers.map((x) => `• ${x.vendor}: ${x.lines} line(s), ${inr(x.spend_inr)} (${x.spend_pct}%)`).join("\n");
    if (!window.confirm(`Allocate ${eventInfo.rfx_id} to:\n${lines}\n\nTotal ${inr(s.total_evaluated_cost)} (${s.scenario_id} ${s.name}).\nThis records the award in the RFQ register; no PO or email is sent.`)) return;
    const approvedAt = [...decision.audit].reverse().find((a) => a.type === "recommendation_approved")?.at ?? null;
    try {
      const list = updateRfqs((l) => recordAllocation(l, eventInfo, awardFromScenario(s, approvedAt)));
      setAllocated(list.find((r) => r.rfx_id === eventInfo.rfx_id && r.status === "awarded") ?? null);
      update(withAudit(decision, { type: "order_allocated", scenario_id: s.scenario_id, detail: `Order for ${eventInfo.rfx_id} allocated: ${s.suppliers.map((x) => `${x.vendor} ${x.spend_pct}%`).join(", ")}`,
        data: { rfx_id: eventInfo.rfx_id, total_value_inr: s.total_evaluated_cost, suppliers: s.suppliers.map((x) => x.vendor_id) } }));
    } catch (e) {
      if (e instanceof AllocationError) setError(e.message); else throw e;
    }
  }

  const update = useCallback((d: DecisionState) => { setDecision(d); saveDecision(d); }, []);

  useEffect(() => {
    if (!decision || !bids.length) return;
    setBusy(true);
    postJson<DecisionResponse | { ok: false; error?: { message?: string } }>("/api/decision", { bids: bids.map(bidEnvelope), decision })
      .then(({ data: j }) => {
        if (!j.ok) { setError(j.error?.message ?? "Failed"); return; }
        setData(j); setError(null);
        // Audit engine output only when it changed (audit-only updates don't retrigger this effect).
        setDecision((prev) => { if (!prev) return prev; const next = auditGenerated(prev, j.scenarios, j.recommendation, j); if (next !== prev) saveDecision(next); return next; });
      })
      .catch((e) => setError(String(e))).finally(() => setBusy(false));
  }, [bids, decision?.custom_scenarios, decision?.include_unfinalized]); // eslint-disable-line react-hooks/exhaustive-deps

  const rec = data?.recommendation;
  const byId = useMemo(() => new Map((data?.scenarios ?? []).map((s) => [s.scenario_id, s])), [data]);
  const recommended = rec?.recommended_scenario_id ? byId.get(rec.recommended_scenario_id) : undefined;
  const alternative = rec?.alternative_scenario_id ? byId.get(rec.alternative_scenario_id) : undefined;
  const shown = byId.get(focus ?? decision?.selected_scenario_id ?? rec?.recommended_scenario_id ?? "") ?? recommended;

  function act(type: "scenario_preferred" | "scenario_selected" | "recommendation_approved" | "recommendation_rejected", id: string | null) {
    if (!decision) return;
    let d = decision;
    if (type === "scenario_preferred") d = { ...d, preferred_scenario_id: id };
    if (type === "scenario_selected") d = { ...d, selected_scenario_id: id, status: "buyer_selected" };
    if (type === "recommendation_approved") d = { ...d, selected_scenario_id: id, status: "approved" };
    if (type === "recommendation_rejected") d = { ...d, status: "rejected" };
    const s = id ? byId.get(id) : undefined;
    update(withAudit(d, { type, scenario_id: id, detail: s ? `${s.name} – ${inr(s.total_evaluated_cost)}, ${s.supplier_count} supplier(s)` : "Recommendation rejected by buyer",
      data: s ? { total_evaluated_cost: s.total_evaluated_cost, suppliers: s.suppliers.map((x) => x.vendor_id), recommended: rec?.recommended_scenario_id } : undefined }));
  }

  async function exportAs(format: "json" | "pdf") {
    if (!decision) return;
    const d = withAudit(decision, { type: "exported", scenario_id: decision.selected_scenario_id, detail: `Exported award recommendation as ${format.toUpperCase()}` });
    update(d);
    const event = loadActiveEvent();
    const res = await fetch("/api/decision/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bids: bids.map(bidEnvelope), decision: d, format, ...(event ? { event } : {}) }) });
    if (!res.ok) { setError(`Export failed (${res.status})`); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `award.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!decision) return null;
  if (!bids.length) return <div className="content"><div className="empty">No processed bids yet. <Link href="/bids">Process and review vendor responses →</Link></div></div>;

  return (
    <div className="content" style={{ flex: 1 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Sourcing decision</h2>
        <span className={`chip ${decision.status === "approved" ? "finalized" : decision.status === "rejected" ? "error" : decision.status === "buyer_selected" ? "processed_with_exceptions" : "not_processed"}`}>
          {decision.status.replace("_", " ")}</span>
        {busy && <span className="hint">recomputing…</span>}
        <span style={{ flex: 1 }} />
        <label className="hint"><input type="checkbox" checked={decision.include_unfinalized}
          onChange={(e) => update(withAudit({ ...decision, include_unfinalized: e.target.checked }, { type: "scenario_modified", detail: `Preview with unfinalized bids ${e.target.checked ? "on" : "off"}` }))} /> Include unfinalized bids (preview)</label>
        <button className="btn small" onClick={() => exportAs("json")}>Export JSON</button>
        <button className="btn small primary" onClick={() => exportAs("pdf")}>Export PDF</button>
      </div>
      {decision.status === "approved" && decision.selected_scenario_id && (
        <div className="evidence" style={{ borderLeftColor: "var(--ok)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>Approved: <strong>{decision.selected_scenario_id} {byId.get(decision.selected_scenario_id)?.name ?? ""}</strong>
            {allocated?.award ? <> · allocated {new Date(allocated.award.allocated_at).toLocaleString()} to {allocated.award.suppliers.map((x) => x.vendor).join(", ")} ({inr(allocated.award.total_value_inr)})</> : " · order not allocated yet"}</span>
          <button className="btn small primary" disabled={!eventInfo || !byId.get(decision.selected_scenario_id)} onClick={allocate}>{allocated?.award ? "Re-allocate order" : "Allocate order to vendor(s)"}</button>
          <Link className="btn small" href="/rfqs">RFQ register →</Link>
        </div>
      )}
      {data && <p className="hint">Scenarios use {decision.include_unfinalized ? `all ${data.total_bids} processed bids (preview – includes unfinalized data)` : `${data.finalized_bids} of ${data.total_bids} bids that are finalized (trusted)`}. {data.finalized_bids === 0 && !decision.include_unfinalized && <strong style={{ color: "var(--err)" }}>No bids are finalized yet – finalize them in <Link href="/bids">Bid processing</Link> or enable the preview.</strong>}</p>}
      {error && <div className="issues has-err">{error}</div>}

      {rec && (
        <div className="reccard">
          {rec.status === "recommended" && recommended ? (
            <>
              <div className="hint">RECOMMENDED SCENARIO · {recommended.scenario_id}</div>
              <h2>{recommended.name}</h2>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "6px 0" }}>
                <div><div className="big">{cr(recommended.total_evaluated_cost)}</div><div className="hint">total evaluated cost</div></div>
                <div><div className="big" style={{ color: recommended.savings_vs_historical >= 0 ? "var(--ok)" : "var(--err)" }}>{signed(recommended.savings_vs_historical)} ({recommended.savings_percent}%)</div><div className="hint">{recommended.savings_vs_historical >= 0 ? "savings" : "cost increase"} vs FY25-26 ({cr(recommended.historical_cost)})</div></div>
                <div><div className="big">{recommended.supplier_count}</div><div className="hint">suppliers · tech {recommended.weighted_technical_score}</div></div>
              </div>
              <div className="hint">{recommended.suppliers.map((s) => `${s.vendor}: ${s.lines} lines, ${s.spend_pct}% of spend`).join(" · ")}</div>
              <div className="cols2" style={{ marginTop: 8 }}>
                <div><strong>Why this is recommended</strong><ul>{rec.key_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  <strong>Main trade-offs</strong><ul>{rec.trade_offs.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
                <div><strong>Risks</strong><ul>{rec.risks.length ? rec.risks.map((r, i) => <li key={i}><span className={`badge ${r.severity === "high" ? "high" : r.severity === "medium" ? "medium" : "low"}`}>{r.severity}</span> {r.message}</li>) : <li>None identified</li>}</ul>
                  <strong>Open assumptions</strong><ul>{recommended.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  <strong>Unresolved issues ({rec.unresolved_dependencies.length})</strong><ul>{rec.unresolved_dependencies.slice(0, 8).map((d, i) => <li key={i}>{d.message} <span className="hint">({d.severity}, {d.status})</span></li>)}{!rec.unresolved_dependencies.length && <li>None</li>}</ul></div>
              </div>
              {alternative && <div className="evidence">Alternative: <strong>{alternative.scenario_id} {alternative.name}</strong> – {cr(alternative.total_evaluated_cost)} ({signed(rec.cost_delta_to_alternative)} vs recommended), {alternative.supplier_count} supplier(s), tech {alternative.weighted_technical_score}</div>}
              <details><summary className="hint">Decision rules applied</summary>{rec.decision_log.map((d, i) => <div key={i} className="hint"><strong>{d.rule}</strong>: {d.outcome}</div>)}</details>
              <div className="row" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => act("recommendation_approved", recommended.scenario_id)}>Approve recommendation</button>
                <button className="btn danger" onClick={() => act("recommendation_rejected", null)}>Reject recommendation</button>
                <Link className="btn" href="/analyst">Challenge it in the Sourcing Analyst →</Link>
                <span className="hint">Approve first, then allocate the order below. Allocation is recorded in the RFQ register – no PO or email is sent.</span>
              </div>
            </>
          ) : <div><h2>No viable scenario</h2><ul>{rec.key_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
        </div>
      )}

      {data && (
        <section className="section">
          <header><h2>Scenarios</h2><span className="count">click a row for detail</span></header>
          <div className="body tbl-wrap">
            <table className="tbl">
              <thead><tr><th>ID</th><th>Scenario</th><th>Status</th><th>Evaluated cost</th><th>vs recommended</th><th>Savings vs hist.</th><th>Suppliers</th><th>Largest share</th><th>Tech</th><th>Landed cost</th><th>Open deps</th><th /></tr></thead>
              <tbody>{data.scenarios.map((s) => (
                <tr key={s.scenario_id} className={`scn-row ${shown?.scenario_id === s.scenario_id ? "sel" : ""}`} onClick={() => setFocus(s.scenario_id)}>
                  <td>{s.scenario_id}{s.scenario_id === rec?.recommended_scenario_id && <span className="tag">REC</span>}{s.scenario_id === decision.preferred_scenario_id && <span className="tag pref">PREF</span>}{s.scenario_id === decision.selected_scenario_id && <span className="tag sel2">{decision.status === "approved" ? "APPROVED" : "SELECTED"}</span>}</td>
                  <td>{s.name}</td><td className="hint">{s.status.replace(/_/g, " ")}</td>
                  <td>{s.status === "no_full_coverage" || s.status === "no_eligible_vendors" ? "—" : cr(s.total_evaluated_cost)}</td>
                  <td>{recommended && s.covered_lines === recommended.covered_lines ? signed(s.total_evaluated_cost - recommended.total_evaluated_cost) : "—"}</td>
                  <td>{s.savings_percent === null ? "—" : `${s.savings_percent}%`}</td><td>{s.supplier_count}</td><td>{s.largest_supplier_exposure_pct}%</td>
                  <td>{s.weighted_technical_score ?? "—"}</td><td>{s.freight.landed_cost_complete ? "complete" : "estimated"}</td><td>{s.unresolved_dependencies.length}</td>
                  <td>{s.kind === "custom" && <button className="btn small danger" onClick={(e) => { e.stopPropagation(); update(withAudit({ ...decision, custom_scenarios: decision.custom_scenarios.filter((x) => x.scenario_id !== s.scenario_id) }, { type: "scenario_modified", scenario_id: s.scenario_id, detail: "Custom scenario removed" })); }}>✕</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {shown && <ScenarioDetail s={shown} decision={decision} onAct={act} />}

      <ConstraintForm bids={bids} base={shown} onCreate={(name, c) => {
        const used = decision.custom_scenarios.map((x) => Number(x.scenario_id.replace(/\D/g, "")) || 0);
        const id = `SCN-C${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
        update(withAudit({ ...decision, custom_scenarios: [...decision.custom_scenarios, { scenario_id: id, name, kind: "custom", constraints: c }] },
          { type: "scenario_created", scenario_id: id, detail: `Buyer created "${name}"`, data: { constraints: c } }));
        setFocus(id);
      }} />

      {data && data.sensitivity.length > 0 && (
        <section className="section">
          <header><h2>Sensitivity – would the recommendation change?</h2></header>
          <div className="body tbl-wrap">
            <table className="tbl">
              <thead><tr><th>What if…</th><th>Recommended after</th><th>Suppliers after</th><th>Cost change</th><th>Changes?</th></tr></thead>
              <tbody>{data.sensitivity.map((x, i) => (
                <tr key={i}><td>{x.label}</td><td>{x.recommended_after ?? "no viable scenario"}</td><td className="hint">{x.suppliers_after.join(", ")}</td>
                  <td>{signed(x.cost_delta)}</td><td style={{ fontWeight: 700, color: x.recommendation_changes ? "var(--warn)" : "var(--ok)" }}>{x.recommendation_changes ? "yes" : "no"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="section">
        <header><h2>Decision audit trail ({decision.audit.length})</h2></header>
        <div className="body">
          {decision.audit.length === 0 && <span className="hint">No decisions recorded yet.</span>}
          {[...decision.audit].reverse().slice(0, 60).map((e, i) => (
            <div key={i} className="hint"><code>{e.at.slice(0, 19).replace("T", " ")}</code> <strong>{e.type.replace(/_/g, " ")}</strong>{e.scenario_id ? ` ${e.scenario_id}` : ""} – {e.detail}</div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ScenarioDetail({ s, decision, onAct }: { s: Scenario; decision: DecisionState; onAct: (t: "scenario_preferred" | "scenario_selected" | "recommendation_approved", id: string) => void }) {
  return (
    <section className="section">
      <header>
        <h2>{s.scenario_id} · {s.name}</h2><span className="count">{s.status_message}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small" onClick={() => onAct("scenario_preferred", s.scenario_id)}>Mark preferred</button>
        <button className="btn small" onClick={() => onAct("scenario_selected", s.scenario_id)}>Select scenario</button>
        <button className="btn small primary" onClick={() => onAct("recommendation_approved", s.scenario_id)}>Approve this scenario</button>
      </header>
      <div className="body">
        <div className="stats">
          <div className="stat"><div className="v">{cr(s.total_evaluated_cost)}</div><div className="k">evaluated cost ({s.covered_lines}/{s.required_lines} lines)</div></div>
          <div className="stat"><div className="v">{inr(s.savings_vs_historical)}</div><div className="k">savings vs historical ({s.savings_percent ?? "—"}%)</div></div>
          <div className="stat"><div className="v">{s.supplier_count}</div><div className="k">suppliers · largest {s.largest_supplier_exposure_pct}%</div></div>
          <div className="stat"><div className="v">{s.weighted_technical_score ?? "—"}</div><div className="k">spend-weighted technical score</div></div>
          <div className="stat"><div className="v" style={{ fontSize: 14 }}>{s.freight.note}</div><div className="k">freight</div></div>
        </div>
        <div className="cols2" style={{ marginTop: 10 }}>
          <div>
            <strong>Award share</strong>
            <table className="tbl"><thead><tr><th>Supplier</th><th>Lines</th><th>Spend</th><th>Share</th><th>Tech</th></tr></thead>
              <tbody>{s.suppliers.map((x) => <tr key={x.vendor_id}><td>{x.vendor}</td><td>{x.lines} ({x.lines_pct}%)</td><td>{cr(x.spend_inr)}</td><td>{x.spend_pct}%</td><td>{x.technical_score}</td></tr>)}</tbody></table>
            <strong>Constraints</strong><ul className="hint">{s.qualification_constraints.map((q, i) => <li key={i}>{q}</li>)}</ul>
          </div>
          <div>
            <strong>Excluded vendors</strong><ul className="hint">{s.excluded_vendors.length ? s.excluded_vendors.map((v) => <li key={v.vendor_id}><strong>{v.vendor}</strong>: {v.reasons.join("; ")}</li>) : <li>None</li>}</ul>
            <strong>Risks</strong><ul className="hint">{s.risks.length ? s.risks.map((r, i) => <li key={i}>[{r.severity}] {r.message}</li>) : <li>None</li>}</ul>
            <strong>Unresolved dependencies ({s.unresolved_dependencies.length})</strong><ul className="hint">{s.unresolved_dependencies.slice(0, 10).map((d, i) => <li key={i}>{d.review_item_id}: {d.message} ({d.severity}, {d.status})</li>)}</ul>
          </div>
        </div>
        <details open={s.allocations.length <= 30}>
          <summary><strong>Line allocation ({s.allocations.length})</strong></summary>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Line</th><th>Description</th><th>Plant</th><th>Awarded</th><th>₹/unit</th><th>Annual qty</th><th>Annual spend</th><th>Freight basis</th><th>Next best</th><th>Δ next best</th><th>Issue</th></tr></thead>
            <tbody>{s.allocations.map((a) => (
              <tr key={a.rfx_line_id}><td>{a.rfx_line_id}</td><td className="wide">{a.description}</td><td>{a.delivery_plant}</td><td>{a.awarded_vendor.replace(/ \(.*/, "")}</td>
                <td>{a.evaluated_unit_cost_inr}</td><td>{a.annual_qty.toLocaleString("en-IN")}</td><td>{inr(a.annual_evaluated_spend_inr)}</td><td className="hint">{a.freight_basis.replace(/_/g, " ")}</td>
                <td className="hint">{a.next_best_vendor?.replace(/ \(.*/, "") ?? "—"}</td><td>{a.delta_vs_next_best_inr ?? "—"}</td><td className="hint" style={{ color: a.unresolved_issue ? "var(--warn)" : undefined }}>{a.unresolved_issue ?? ""}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
        {decision.selected_scenario_id === s.scenario_id && <p className="hint">This scenario is the buyer's {decision.status === "approved" ? "approved" : "selected"} choice.</p>}
      </div>
    </section>
  );
}

function ConstraintForm({ bids, base, onCreate }: { bids: CanonicalBid[]; base?: Scenario; onCreate: (name: string, c: ScenarioConstraints) => void }) {
  const [c, setC] = useState<ScenarioConstraints>(emptyConstraints());
  const [name, setName] = useState("");
  const [fromBase, setFromBase] = useState(true);
  const set = <K extends keyof ScenarioConstraints>(k: K, v: ScenarioConstraints[K]) => setC((x) => ({ ...x, [k]: v }));
  const toggle = (k: "excluded_vendors" | "treat_as_qualified", id: string) => setC((x) => {
    const cur = x[k] ?? [];
    return { ...x, [k]: cur.includes(id) ? cur.filter((v) => v !== id) : [...cur, id] };
  });
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <section className="section">
      <header><h2>Modify constraints / new scenario</h2></header>
      <div className="body">
        <div className="form-grid">
          <label>Name<input className="fld" value={name} placeholder="e.g. Max 2, quality ≥ 80" onChange={(e) => setName(e.target.value)} /></label>
          <label>Objective<select className="sel" value={c.objective ?? ""} onChange={(e) => set("objective", (e.target.value || null) as ScenarioConstraints["objective"])}>
            <option value="">(default: minimize cost)</option><option value="minimize_cost">Minimize cost</option><option value="maximize_quality">Maximize quality within tolerance</option></select></label>
          <label>Max suppliers<input className="fld" type="number" min={1} value={c.max_suppliers ?? ""} onChange={(e) => set("max_suppliers", num(e.target.value))} /></label>
          <label>Cost tolerance % (quality)<input className="fld" type="number" value={c.cost_tolerance_pct ?? ""} onChange={(e) => set("cost_tolerance_pct", num(e.target.value))} /></label>
          <label>Minimum technical score<input className="fld" type="number" value={c.minimum_technical_score ?? ""} onChange={(e) => set("minimum_technical_score", num(e.target.value))} /></label>
          <label>Freight assumption % (unquoted lines)<input className="fld" type="number" value={c.freight_assumption_pct ?? ""} onChange={(e) => set("freight_assumption_pct", num(e.target.value))} /></label>
          <label><span><input type="checkbox" checked={!!c.require_full_coverage} onChange={(e) => set("require_full_coverage", e.target.checked || null)} /> Suppliers must cover all lines</span></label>
          <label><span><input type="checkbox" checked={!!c.exclude_unresolved_critical} onChange={(e) => set("exclude_unresolved_critical", e.target.checked || null)} /> Exclude unresolved critical</span></label>
          <label><span><input type="checkbox" checked={!!c.exclude_lines_under_review} onChange={(e) => set("exclude_lines_under_review", e.target.checked || null)} /> Exclude quotes under review</span></label>
          <label><span><input type="checkbox" checked={c.include_freight === false} onChange={(e) => set("include_freight", e.target.checked ? false : null)} /> Pre-freight comparison</span></label>
        </div>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="hint">Exclude vendors: {bids.map((b) => <label key={b.vendor.vendor_id} style={{ display: "inline", marginRight: 8 }}><input type="checkbox" checked={(c.excluded_vendors ?? []).includes(b.vendor.vendor_id)} onChange={() => toggle("excluded_vendors", b.vendor.vendor_id)} /> V{b.vendor.vendor_no}</label>)}</div>
          <div className="hint">What-if treat as qualified: {bids.filter((b) => b.processing_summary.qualification_status !== "QUALIFIED").map((b) => <label key={b.vendor.vendor_id} style={{ display: "inline", marginRight: 8 }}><input type="checkbox" checked={(c.treat_as_qualified ?? []).includes(b.vendor.vendor_id)} onChange={() => toggle("treat_as_qualified", b.vendor.vendor_id)} /> V{b.vendor.vendor_no}</label>)}</div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          {base && <label className="hint"><input type="checkbox" checked={fromBase} onChange={(e) => setFromBase(e.target.checked)} /> Start from {base.scenario_id} (override only the fields set here)</label>}
          <button className="btn primary" onClick={() => {
            const constraints = { ...c, base_scenario_id: fromBase && base ? base.scenario_id : null, name: name || null };
            onCreate(name || `Custom${fromBase && base ? ` from ${base.scenario_id}` : ""}`, constraints);
            setC(emptyConstraints()); setName("");
          }}>Run scenario</button>
        </div>
      </div>
    </section>
  );
}
