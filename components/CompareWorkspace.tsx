"use client";
/** Stage 4 – side-by-side vendor comparison with SKU-level drill-down (reads the canonical bids; no model calls). */
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadBids } from "@/lib/client/bid-store";

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
  useEffect(() => { setBids(Object.values(loadBids()).sort((a, b) => (a.vendor.vendor_no ?? 0) - (b.vendor.vendor_no ?? 0))); }, []);

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
