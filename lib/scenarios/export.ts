/** Award recommendation export: JSON summary + human-readable PDF. No raw extractions, traces or evaluation data. */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import type { DecisionState, Recommendation, Scenario } from "./types";

export function buildAwardSummary(ctx: EventContext, bids: CanonicalBid[], scenarios: Scenario[], rec: Recommendation, decision: DecisionState, now = new Date()) {
  const find = (id: string | null) => scenarios.find((s) => s.scenario_id === id) ?? null;
  const recommended = find(rec.recommended_scenario_id);
  const selected = find(decision.selected_scenario_id);
  const slim = (s: Scenario | null) => s && {
    scenario_id: s.scenario_id, name: s.name, status: s.status, objective: s.objective, constraints: s.qualification_constraints,
    total_evaluated_cost_inr: s.total_evaluated_cost, historical_cost_inr: s.historical_cost, savings_vs_historical_inr: s.savings_vs_historical,
    savings_percent: s.savings_percent, supplier_count: s.supplier_count, suppliers: s.suppliers, weighted_technical_score: s.weighted_technical_score,
    allocations: s.allocations.map((a) => ({ rfx_line_id: a.rfx_line_id, description: a.description, plant: a.delivery_plant, vendor: a.awarded_vendor,
      unit_cost_inr: a.evaluated_unit_cost_inr, annual_qty: a.annual_qty, annual_spend_inr: a.annual_evaluated_spend_inr, freight_basis: a.freight_basis,
      next_best: a.next_best_vendor, delta_vs_next_best_inr: a.delta_vs_next_best_inr, unresolved_issue: a.unresolved_issue })),
    excluded_vendors: s.excluded_vendors, risks: s.risks, assumptions: s.assumptions, freight: s.freight,
    unresolved_issues: s.unresolved_dependencies.map((d) => ({ vendor_id: d.vendor_id, item: d.review_item_id, severity: d.severity, status: d.status, message: d.message })),
  };
  return {
    document: "Award recommendation (decision support – not a purchase order or supplier award)",
    generated_at: now.toISOString(),
    rfx: { rfx_id: ctx.rfx_id, title: ctx.title, buyer: ctx.buyer_name, lines: ctx.lines.length, contract_period: { start: ctx.contract_start, end: ctx.contract_end } },
    evaluated_vendors: bids.map((b) => ({
      vendor_id: b.vendor.vendor_id, vendor: `Vendor ${b.vendor.vendor_no} (${b.vendor.vendor_name})`, bid_state: b.review_state,
      technical_score: b.processing_summary.technical_score, qualification: b.processing_summary.qualification_status, mandatory_failures: b.processing_summary.mandatory_failures,
      quoted_lines: b.processing_summary.quoted_lines, open_review_items: b.processing_summary.open_review_items, unresolved_review_items: b.processing_summary.unresolved_review_items,
      payment_terms: b.commercial_terms.payment_terms, price_validity_until: b.commercial_terms.price_validity_until,
    })),
    recommendation: {
      status: rec.status, scenario: slim(recommended), key_reasons: rec.key_reasons, trade_offs: rec.trade_offs, decision_log: rec.decision_log, policy: rec.policy,
      alternative: rec.alternative_scenario_id ? { scenario_id: rec.alternative_scenario_id, name: rec.alternative_name, cost_delta_inr: rec.cost_delta_to_alternative } : null,
    },
    buyer_decision: {
      status: decision.status, selected_scenario: slim(selected), preferred_scenario_id: decision.preferred_scenario_id,
      decided_at: [...decision.audit].reverse().find((e) => ["recommendation_approved", "recommendation_rejected", "scenario_selected"].includes(e.type))?.at ?? null,
    },
    scenario_comparison: scenarios.filter((s) => s.kind !== "sensitivity").map((s) => ({ scenario_id: s.scenario_id, name: s.name, status: s.status,
      total_evaluated_cost_inr: s.total_evaluated_cost, savings_percent: s.savings_percent, suppliers: s.supplier_count, weighted_technical_score: s.weighted_technical_score,
      largest_supplier_share_pct: s.largest_supplier_exposure_pct })),
    audit_trail: decision.audit,
  };
}

export type AwardSummary = ReturnType<typeof buildAwardSummary>;

// ------------------------------------------------------------------ PDF
const INR = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `INR ${Math.round(n).toLocaleString("en-IN")}`);
const ascii = (s: string) => s.replace(/₹/g, "INR ").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/×/g, "x").replace(/…/g, "...").replace(/[^\x20-\x7E]/g, "");

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) { this.newPage(); }
  newPage() { this.page = this.doc.addPage([595, 842]); this.y = 800; }
  ensure(h: number) { if (this.y - h < 50) this.newPage(); }
  text(t: string, o: { size?: number; bold?: boolean; indent?: number; color?: [number, number, number] } = {}) {
    const size = o.size ?? 9.5, f = o.bold ? this.bold : this.font, x = 45 + (o.indent ?? 0), max = 595 - x - 45;
    for (const para of ascii(t).split("\n")) {
      let line = "";
      for (const w of para.split(" ")) {
        const trial = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(trial, size) > max && line) { this.line(line, x, size, f, o.color); line = w; } else line = trial;
      }
      this.line(line, x, size, f, o.color);
    }
  }
  private line(t: string, x: number, size: number, f: PDFFont, c?: [number, number, number]) {
    this.ensure(size + 4);
    this.page.drawText(t, { x, y: this.y, size, font: f, color: c ? rgb(...c) : rgb(0.1, 0.12, 0.16) });
    this.y -= size + 4;
  }
  gap(h = 6) { this.y -= h; }
  h(t: string) { this.gap(6); this.text(t, { size: 12, bold: true, color: [0.12, 0.37, 0.75] }); this.gap(2); }
  row(cols: string[], widths: number[], bold = false) {
    this.ensure(14);
    let x = 45;
    cols.forEach((c, i) => {
      let s = ascii(c);
      const f = bold ? this.bold : this.font;
      while (s && f.widthOfTextAtSize(s, 8) > widths[i] - 4) s = s.slice(0, -1);
      this.page.drawText(s, { x, y: this.y, size: 8, font: f, color: rgb(0.1, 0.12, 0.16) });
      x += widths[i];
    });
    this.y -= 12;
  }
}

export async function renderAwardPdf(s: AwardSummary): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Award recommendation – ${s.rfx.rfx_id}`);
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const rec = s.recommendation.scenario;
  const sel = s.buyer_decision.selected_scenario;
  w.text("Award Recommendation", { size: 18, bold: true });
  w.text(`${s.rfx.title}`, { size: 11 });
  w.text(`Event ${s.rfx.rfx_id} | ${s.rfx.buyer} | ${s.rfx.lines} RFx lines | generated ${s.generated_at.slice(0, 16).replace("T", " ")} UTC`, { size: 8.5, color: [0.4, 0.44, 0.5] });
  w.text("Decision support only. This document does not award business or create a purchase order.", { size: 8.5, color: [0.6, 0.2, 0.2] });

  w.h("Buyer decision");
  w.text(`Status: ${s.buyer_decision.status.replace(/_/g, " ").toUpperCase()}${s.buyer_decision.decided_at ? ` (${s.buyer_decision.decided_at.slice(0, 16).replace("T", " ")} UTC)` : ""}`, { bold: true });
  w.text(sel ? `Buyer-selected scenario: ${sel.scenario_id} ${sel.name} - ${INR(sel.total_evaluated_cost_inr)}` : "No scenario selected by the buyer yet.");

  w.h("Recommended scenario");
  if (rec) {
    w.text(`${rec.scenario_id} ${rec.name}`, { bold: true, size: 11 });
    w.text(`Total evaluated cost ${INR(rec.total_evaluated_cost_inr)} | historical ${INR(rec.historical_cost_inr)} | savings ${INR(rec.savings_vs_historical_inr)} (${rec.savings_percent}%) | ${rec.supplier_count} supplier(s) | technical score ${rec.weighted_technical_score}`);
    w.gap(2);
    w.text("Why", { bold: true });
    s.recommendation.key_reasons.forEach((r) => w.text(`- ${r}`, { indent: 8 }));
    w.text("Trade-offs", { bold: true });
    s.recommendation.trade_offs.forEach((r) => w.text(`- ${r}`, { indent: 8 }));
    if (s.recommendation.alternative) w.text(`Alternative: ${s.recommendation.alternative.scenario_id} ${s.recommendation.alternative.name} (${s.recommendation.alternative.cost_delta_inr! >= 0 ? "+" : ""}${INR(s.recommendation.alternative.cost_delta_inr)})`);
    w.text("Decision rules applied", { bold: true });
    s.recommendation.decision_log.forEach((d) => w.text(`${d.rule}: ${d.outcome}`, { indent: 8, size: 8.5 }));
  } else w.text("No viable scenario could be recommended.");

  const award = sel ?? rec;
  if (award) {
    w.h(`Supplier allocation - ${award.scenario_id}`);
    award.suppliers.forEach((x) => w.text(`${x.vendor}: ${x.lines} lines (${x.lines_pct}%), ${INR(x.spend_inr)} (${x.spend_pct}% of spend), technical ${x.technical_score}`));
    w.gap(4);
    const W = [46, 150, 30, 120, 52, 52, 55];
    w.row(["Line", "Description", "Plant", "Vendor", "Unit INR", "Annual qty", "Spend INR"], W, true);
    award.allocations.forEach((a) => w.row([a.rfx_line_id, a.description, a.plant, a.vendor.replace(/ \(.*/, ""), String(a.unit_cost_inr), a.annual_qty.toLocaleString("en-IN"), Math.round(a.annual_spend_inr).toLocaleString("en-IN")], W));
    w.h("Risks");
    (award.risks.length ? award.risks : [{ severity: "low", message: "None identified" }]).forEach((r) => w.text(`[${r.severity}] ${r.message}`));
    w.h("Assumptions");
    award.assumptions.forEach((a) => w.text(`- ${a}`));
    w.h("Unresolved issues");
    (award.unresolved_issues.length ? award.unresolved_issues : [{ item: "-", message: "None", severity: "", status: "" }]).forEach((u) => w.text(`- ${u.message}${u.severity ? ` (${u.severity}, ${u.status})` : ""}`));
    w.h("Excluded vendors");
    (award.excluded_vendors.length ? award.excluded_vendors : [{ vendor: "-", reasons: ["None"] }]).forEach((v) => w.text(`- ${v.vendor}: ${v.reasons.join("; ")}`));
  }

  w.h("Evaluated vendors");
  const VW = [150, 50, 80, 50, 60, 105];
  w.row(["Vendor", "Score", "Qualification", "Lines", "Open items", "Validity"], VW, true);
  s.evaluated_vendors.forEach((v) => w.row([v.vendor, String(v.technical_score), v.qualification, String(v.quoted_lines), String(v.open_review_items), v.price_validity_until ?? "-"], VW));

  w.h("Scenario comparison");
  const SW = [55, 190, 95, 50, 45, 55];
  w.row(["ID", "Scenario", "Cost", "Savings", "Suppl.", "Tech"], SW, true);
  s.scenario_comparison.forEach((c) => w.row([c.scenario_id, c.name, INR(c.total_evaluated_cost_inr), `${c.savings_percent ?? "-"}%`, String(c.suppliers), String(c.weighted_technical_score ?? "-")], SW));

  w.h("Decision audit trail");
  s.audit_trail.slice(-40).forEach((e) => w.text(`${e.at.slice(0, 19).replace("T", " ")} ${e.type}${e.scenario_id ? ` ${e.scenario_id}` : ""}: ${e.detail}`, { size: 8 }));
  return doc.save();
}
