/**
 * Analyst charts. The model only picks a chart kind and its subject (scenario / lines / vendors); every plotted
 * value is computed here from the canonical bids and the deterministic scenario engine – never taken from the model.
 */
import { z } from "zod";
import type { CanonicalBid } from "@/lib/bids/schema";
import type { AnalystTools } from "./tools";

export const CHART_KINDS = ["vendor_evaluated_value", "technical_scores", "scenario_costs", "award_split", "line_prices", "savings_by_scenario"] as const;

export const ChartRequestSchema = z.object({
  kind: z.enum(CHART_KINDS).describe(
    "vendor_evaluated_value: each vendor's annual evaluated value; technical_scores: score vs qualification threshold; " +
    "scenario_costs: total evaluated cost per scenario; award_split: supplier spend share in one scenario; " +
    "line_prices: evaluated ₹/unit per vendor for specific lines (+ historical); savings_by_scenario: savings vs historical per scenario"),
  title: z.string(),
  scenario_ids: z.array(z.string()).describe("scenario_costs / savings_by_scenario: subset (empty = all); award_split: one id (empty = recommended)"),
  line_ids: z.array(z.string()).describe("line_prices: up to 6 RFx line ids"),
  vendor_ids: z.array(z.string()).describe("Optional vendor filter (empty = all vendors)"),
});
export type ChartRequest = z.infer<typeof ChartRequestSchema>;

export interface ChartBar { label: string; value: number | null; note?: string; highlight?: boolean; muted?: boolean }
export interface ChartGroup { label: string; bars: ChartBar[] }
export interface ChartData {
  kind: ChartRequest["kind"];
  title: string;
  unit: "inr" | "inr_per_unit" | "points" | "percent";
  groups: ChartGroup[];
  /** Reference line (e.g. qualification threshold). */
  threshold?: { value: number; label: string };
  source: string;
}

const vlabel = (no: number | null | undefined, id: string) => (no ? `V${no}` : id);
const isQualified = (b: CanonicalBid) => b.processing_summary.qualification_status === "QUALIFIED";

/** Bid-only charts (also used client-side on the comparison page). */
export function vendorValueChart(bids: CanonicalBid[], title: string): ChartData {
  return { kind: "vendor_evaluated_value", title, unit: "inr", source: "canonical bids (annual evaluated value)",
    groups: [{ label: "", bars: bids.map((b) => ({ label: vlabel(b.vendor.vendor_no, b.vendor.vendor_id), value: b.processing_summary.annual_value_evaluated_inr,
      note: `${b.processing_summary.annual_value_lines_counted} lines${isQualified(b) ? "" : " · not qualified"}`, muted: !isQualified(b) })) }] };
}

export function technicalScoreChart(bids: CanonicalBid[], title: string, minScore: number | null): ChartData {
  return { kind: "technical_scores", title, unit: "points", source: "canonical bids (questionnaire scoring)",
    ...(minScore !== null ? { threshold: { value: minScore, label: `qualify ≥ ${minScore}` } } : {}),
    groups: [{ label: "", bars: bids.map((b) => ({ label: vlabel(b.vendor.vendor_no, b.vendor.vendor_id), value: b.processing_summary.technical_score,
      note: isQualified(b) ? "qualified" : b.processing_summary.mandatory_failures.length ? `fails ${b.processing_summary.mandatory_failures.join(", ")}` : "below threshold",
      muted: !isQualified(b) })) }] };
}

export function buildChart(req: ChartRequest, tools: AnalystTools, ctx: { min_total_score: number }): ChartData {
  const bids = tools.allBids().filter((b) => !req.vendor_ids.length || req.vendor_ids.some((v) => v === b.vendor.vendor_id || v === `V${b.vendor.vendor_no}` || v === String(b.vendor.vendor_no)))
    .sort((a, b) => (a.vendor.vendor_no ?? 0) - (b.vendor.vendor_no ?? 0));
  const qualified = (q: string) => q === "QUALIFIED";
  switch (req.kind) {
    case "vendor_evaluated_value":
      return vendorValueChart(bids, req.title);
    case "technical_scores":
      return technicalScoreChart(bids, req.title, ctx.min_total_score);
    case "scenario_costs":
    case "savings_by_scenario": {
      const { scenarios, rec } = tools.allScenarios();
      const pick = scenarios.filter((s) => !req.scenario_ids.length || req.scenario_ids.some((id) => id.toUpperCase() === s.scenario_id.toUpperCase()))
        .filter((s) => s.status !== "no_full_coverage" && s.status !== "no_eligible_vendors");
      return { kind: req.kind, title: req.title, unit: req.kind === "scenario_costs" ? "inr" : "percent", source: "scenario engine",
        groups: [{ label: "", bars: pick.map((s) => ({ label: s.scenario_id, value: req.kind === "scenario_costs" ? s.total_evaluated_cost : s.savings_percent,
          note: `${s.name} · ${s.supplier_count} supplier(s)`, highlight: s.scenario_id === rec.recommended_scenario_id })) }] };
    }
    case "award_split": {
      const { scenarios, rec } = tools.allScenarios();
      const id = (req.scenario_ids[0] ?? rec.recommended_scenario_id ?? "").toUpperCase();
      const s = scenarios.find((x) => x.scenario_id.toUpperCase() === id);
      if (!s) throw new Error(`Unknown scenario ${id || "(none recommended)"}`);
      return { kind: req.kind, title: req.title, unit: "inr", source: `scenario engine (${s.scenario_id} allocation)`,
        groups: [{ label: `${s.scenario_id} ${s.name}`, bars: s.suppliers.map((x) => ({ label: x.vendor.replace(/\s*\(.*\)$/, ""), value: x.spend_inr, note: `${x.lines} lines · ${x.spend_pct}%` })) }] };
    }
    case "line_prices": {
      const lines = (req.line_ids.length ? req.line_ids : [...new Set(bids.flatMap((b) => b.line_items.map((l) => l.rfx_line_id)))].sort().slice(0, 6))
        .map((x) => x.trim().toUpperCase()).slice(0, 6);
      return { kind: req.kind, title: req.title, unit: "inr_per_unit", source: "canonical bids (evaluation ₹/unit) and FY25-26 historical prices",
        groups: lines.map((lid) => {
          const hist = bids.flatMap((b) => b.line_items).find((l) => l.rfx_line_id === lid)?.historical_price_inr ?? null;
          const bars: ChartBar[] = bids.map((b) => {
            const l = b.line_items.find((x) => x.rfx_line_id === lid);
            return { label: vlabel(b.vendor.vendor_no, b.vendor.vendor_id), value: l?.comparable ? l.evaluation_unit_price_inr : null,
              note: !l ? "not quoted" : !l.comparable ? l.review_status : undefined, muted: !qualified(b.processing_summary.qualification_status) };
          });
          const vals = bars.map((x) => x.value).filter((v): v is number => v !== null);
          const min = vals.length ? Math.min(...vals) : null;
          return { label: lid, bars: [...bars.map((x) => ({ ...x, highlight: x.value !== null && x.value === min })), { label: "Hist.", value: hist, note: "FY25-26" }] };
        }) };
    }
  }
}
