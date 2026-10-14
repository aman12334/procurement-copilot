"use client";
/** Stage 4 – side-by-side vendor comparison with SKU-level drill-down (reads the canonical bids; no model calls). */
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadBids, postJson } from "@/lib/client/bid-store";
import { technicalScoreChart, vendorValueChart } from "@/lib/analyst/charts";
import Chart from "./Chart";

const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));

function vendorStats(b: CanonicalBid) {
  let v = 0, h = 0;
  for (const l of b.line_items) if (l.comparable && l.evaluation_unit_price_inr !== null && l.historical_price_inr) { v += l.evaluation_unit_price_inr * l.annual_qty; h += l.historical_price_inr * l.annual_qty; }
  const leads = b.line_items.map((l) => l.lead_time_days).filter((x): x is number => x !== null).sort((a, c) => a - c);
  return {
    variance: h ? Math.round(((v - h) / h) * 1000) / 10 : null,
    lead: leads.length ? (leads[0] === leads[leads.length - 1] ? `${leads[0]} d` : `${leads[0]}–${leads[leads.length - 1]} d`) : "—",
  };
}

export default function CompareWorkspace() {
  const [bids, setBids] = useState<CanonicalBid[]>([]);
  const [line, setLine] = useState<string | null>(null);
  const [registered, setRegistered] = useState<Record<string, string[]>>({});
  const [minScore, setMinScore] = useState<number | null>(null);
  useEffect(() => {
    setBids(Object.values(loadBids()).sort((a, b) => (a.vendor.vendor_no ?? 0) - (b.vendor.vendor_no ?? 0)));
    // Which response files the server can open per vendor (uploads and email bodies stay text-only).
    postJson<{ qualification: { min_total_score: number }; vendors: { vendor_id: string; response_files: string[]; alternate_files: string[] }[] }>("/api/event", {})
      .then(({ data }) => (setMinScore(data.qualification?.min_total_score ?? null), setRegistered(Object.fromEntries(data.vendors.map((v) => [v.vendor_id, [...v.response_files, ...v.alternate_files]]))))).catch(() => {});
  }, []);

  const lineIds = useMemo(() => [...new Set(bids.flatMap((b) => b.line_items.map((l) => l.rfx_line_id)).concat(bids.flatMap((b) => b.missing_rfx_lines)))].sort(), [bids]);

  if (!bids.length) return <div className="content"><div className="empty">No processed bids yet. <Link href="/bids">Process vendor responses →</Link></div></div>;

  return (
    <div className="content" style={{ flex: 1 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Vendor comparison</h2>
      <p className="hint">Evaluated cost = landed price where freight is known, otherwise normalized price + the RFx freight loading. Values come from the canonical bids; open review items are shown so nothing unresolved is hidden.</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Vendor</th><th>Bid state</th><th>Technical</th><th>Qualification</th><th>Lines quoted</th><th>Annual evaluated value</th><th>vs historical</th><th>Open / unresolved items</th><th>Payment</th><th>Freight</th><th>Lead time</th><th>Price validity</th></tr></thead>
          <tbody>{bids.map((b) => {
            const s = b.processing_summary, st = vendorStats(b);
            return (
              <tr key={b.vendor.vendor_id}>
                <td><strong>Vendor {b.vendor.vendor_no}</strong><div className="hint">{b.vendor.vendor_name}</div></td>
                <td><span className={`chip ${b.review_state}`}>{b.review_state.replace(/_/g, " ")}</span></td>
                <td>{s.technical_score}/{s.technical_max}</td>
                <td style={{ color: s.qualification_status === "QUALIFIED" ? "var(--ok)" : "var(--err)", fontWeight: 600 }}>{s.qualification_status}{s.mandatory_failures.length ? <div className="hint">fails {s.mandatory_failures.join(", ")}</div> : null}</td>
                <td>{s.quoted_lines}/{s.rfx_lines}</td>
                <td>{s.annual_value_evaluated_inr ? `₹${(s.annual_value_evaluated_inr / 1e7).toFixed(2)} Cr` : "—"}<div className="hint">{s.annual_value_lines_counted} lines</div></td>
                <td>{st.variance === null ? "—" : `${st.variance > 0 ? "+" : ""}${st.variance}%`}</td>
                <td>{s.open_review_items} / {s.unresolved_review_items}</td>
                <td className="hint">{b.commercial_terms.payment_terms ?? "—"}</td>
                <td className="hint">{[...new Set(b.line_items.map((l) => l.freight.basis.replace(/_/g, " ")))].join(", ")}</td>
                <td>{st.lead}</td>
                <td>{b.commercial_terms.price_validity_until ?? "—"}{b.commercial_terms.price_validity_statements.length > 1 && <div className="hint" style={{ color: "var(--err)" }}>conflicting</div>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>

      <div className="cols2" style={{ marginTop: 14 }}>
        <Chart c={vendorValueChart(bids, "Annual evaluated value by vendor")} />
        <Chart c={technicalScoreChart(bids, "Technical score vs qualification threshold", minScore)} />
      </div>

      <QuestionnaireMatrix bids={bids} registered={registered} />

      <h3 style={{ fontSize: 15, marginTop: 20 }}>SKU-level comparison <span className="hint">(evaluated ₹/unit; lowest comparable price in green; click a line for detail)</span></h3>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Line</th><th>Historical</th>{bids.map((b) => <th key={b.vendor.vendor_id}>V{b.vendor.vendor_no}{b.processing_summary.qualification_status !== "QUALIFIED" ? " ✗" : ""}</th>)}</tr></thead>
          <tbody>{lineIds.map((id) => {
            const cells = bids.map((b) => b.line_items.find((l) => l.rfx_line_id === id));
            const prices = cells.map((l) => (l?.comparable ? l.evaluation_unit_price_inr : null)).filter((p): p is number => p !== null);
            const min = prices.length ? Math.min(...prices) : null;
            const hist = cells.find((l) => l)?.historical_price_inr ?? null;
            return (
              <Fragment key={id}>
                <tr className="scn-row" onClick={() => setLine(line === id ? null : id)}>
                  <td><strong>{id}</strong></td><td>{inr(hist)}</td>
                  {cells.map((l, i) => (
                    <td key={i} className={l?.comparable && l.evaluation_unit_price_inr === min ? "min" : ""}>
                      {!l ? <span className="hint">not quoted</span> : l.candidate_quotes.length > 1 ? <span className="badge high">duplicate</span> : inr(l.evaluation_unit_price_inr)}
                      {l && l.review_status !== "accepted" && l.review_status !== "human_verified" && <div className={`st ${l.review_status}`}>{l.review_status.replace("_", " ")}</div>}
                    </td>
                  ))}
                </tr>
                {line === id && (
                  <tr><td colSpan={bids.length + 2}>
                    {cells.map((l, i) => l && (
                      <div key={i} className="evidence">
                        <strong>Vendor {bids[i].vendor.vendor_no}</strong>: {l.raw_price_text} ({l.raw_uom}) → ₹{inr(l.normalized_unit_price_inr)}/unit; {l.normalization_method}; freight {l.freight.basis.replace(/_/g, " ")}; MOQ {l.moq ?? "—"}; lead {l.lead_time_days ?? "—"} d; {l.review_status}{l.review_reasons.length ? ` (${l.review_reasons.join(", ")})` : ""}
                        <div className="loc">{l.evidence[0]?.source_file} · {l.evidence[0]?.location}: “{l.evidence[0]?.source_text}”</div>
                      </div>
                    ))}
                  </td></tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

const COMPLIANCE_CLASS: Record<string, string> = { full: "finalized", partial: "processed_with_exceptions", none: "error", unanswered: "not_processed" };
const fileHref = (vendorId: string, name: string) => `/api/event/file?vendor_id=${encodeURIComponent(vendorId)}&name=${encodeURIComponent(name)}`;

/** Questionnaire answers and source documents side by side with the numbers (from the canonical bids; no model calls). */
function QuestionnaireMatrix({ bids, registered }: { bids: CanonicalBid[]; registered: Record<string, string[]> }) {
  const [showText, setShowText] = useState(true);
  const [onlyMandatory, setOnlyMandatory] = useState(false);
  const questions = useMemo(() => {
    const m = new Map<string, { qid: string; topic: string; mandatory: boolean; max_points: number }>();
    for (const b of bids) for (const q of b.questionnaire_answers) if (!m.has(q.qid)) m.set(q.qid, { qid: q.qid, topic: q.topic, mandatory: q.mandatory, max_points: q.max_points });
    return [...m.values()].sort((a, b) => a.qid.localeCompare(b.qid, undefined, { numeric: true }));
  }, [bids]);
  const rows = onlyMandatory ? questions.filter((q) => q.mandatory) : questions;
  return (
    <>
      <h3 style={{ fontSize: 15, marginTop: 20, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        Questionnaire & documents <span className="hint">(each vendor's answer, compliance and points; hover for the source)</span>
        <span style={{ flex: 1 }} />
        <label className="hint"><input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /> answer text</label>
        <label className="hint"><input type="checkbox" checked={onlyMandatory} onChange={(e) => setOnlyMandatory(e.target.checked)} /> mandatory only</label>
      </h3>
      <div className="tbl-wrap">
        <table className="tbl qmatrix">
          <thead><tr><th>Question</th>{bids.map((b) => <th key={b.vendor.vendor_id}>V{b.vendor.vendor_no} <span className="hint">{b.processing_summary.technical_score}/{b.processing_summary.technical_max}</span></th>)}</tr></thead>
          <tbody>
            <tr>
              <td><strong>Response documents</strong><div className="hint">what each vendor sent</div></td>
              {bids.map((b) => (
                <td key={b.vendor.vendor_id}>
                  {b.response_metadata.source_files.map((f) => registered[b.vendor.vendor_id]?.includes(f)
                    ? <div key={f}><a href={fileHref(b.vendor.vendor_id, f)} target="_blank" rel="noreferrer">{f}</a></div>
                    : <div key={f} className="hint" title="Uploaded or email body – text was extracted; the original stays with the buyer">{f}</div>)}
                  <div className="hint">{b.response_metadata.source_type.toUpperCase()}</div>
                </td>
              ))}
            </tr>
            {rows.map((q) => (
              <tr key={q.qid}>
                <td><strong>{q.qid}</strong> {q.topic}<div className="hint">{q.mandatory ? "mandatory · " : ""}{q.max_points} pts</div></td>
                {bids.map((b) => {
                  const a = b.questionnaire_answers.find((x) => x.qid === q.qid);
                  if (!a) return <td key={b.vendor.vendor_id} className="hint">—</td>;
                  const fail = a.mandatory && !a.mandatory_pass;
                  return (
                    <td key={b.vendor.vendor_id} title={a.evidence ? `${a.evidence.source_file} · ${a.evidence.location}: “${a.evidence.source_text}”` : a.rationale}
                      style={fail ? { boxShadow: "inset 3px 0 0 var(--err)" } : undefined}>
                      <span className={`chip ${COMPLIANCE_CLASS[a.compliance] ?? ""}`}>{a.compliance}</span> <strong>{a.points}</strong><span className="hint">/{a.max_points}</span>
                      {fail && <div className="hint" style={{ color: "var(--err)" }}>mandatory not met</div>}
                      {showText && a.answer_text && <div className="qtext">{a.answer_text.length > 160 ? `${a.answer_text.slice(0, 160)}…` : a.answer_text}</div>}
                      {a.evidence && <div className="hint">{a.evidence.source_file}{a.evidence.location ? ` · ${a.evidence.location}` : ""}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
