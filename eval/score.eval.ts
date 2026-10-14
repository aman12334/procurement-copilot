/**
 * OFFLINE EVALUATION (reads stage1/ground_truth – allowed here only).
 * Scores the canonical bids saved by `npm run eval:process` against the golden ground truth, simulates the
 * HITL loop, and writes eval/results/report.{json,md}.  `npm run eval`
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyReviewAction, finalizeBid } from "@/lib/bids/hitl";
import type { CanonicalBid, CanonicalLineItem } from "@/lib/bids/schema";
import { loadEventContext } from "@/lib/event/context";

const GT_DIR = "stage1/ground_truth";
const BIDS = "eval/results/bids";

interface GtLine {
  vendor_id: string; line_id: string; quote_status: string; quoted_price: number | null; quoted_currency: string | null;
  quoted_uom: string | null; pieces_per_quoted_unit: number | null; normalized_unit_price_inr: number | null;
  freight_treatment: string | null; landed_unit_price_inr: number | null; hitl_required: boolean; candidate_prices?: number[];
  moq: number | null; lead_time_days: number | null;
}

const gt = JSON.parse(readFileSync(`${GT_DIR}/canonical_vendor_bids.json`, "utf8"));
const gtQual = JSON.parse(readFileSync(`${GT_DIR}/vendor_qualification.json`, "utf8"));
const manifest = JSON.parse(readFileSync(`${GT_DIR}/edge_case_manifest.json`, "utf8"));
const gtLines: Record<string, GtLine[]> = Object.fromEntries(gt.vendors.map((v: { vendor_id: string; lines: GtLine[] }) => [v.vendor_id, v.lines]));

const near = (a: number | null | undefined, b: number | null | undefined, tol = 0.011) =>
  a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.002);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const effRaw = (b: CanonicalBid, l: CanonicalLineItem) => {
  const q = b.extraction.quotes.find((x) => x.rfx_line_id?.toUpperCase() === l.rfx_line_id);
  if (!q || q.raw_price === null) return null;
  return q.raw_price + (q.price_adjustments ?? []).reduce((s, a) => s + a.amount, 0);
};
const freightClass = (t: string | null) => !t ? null : /included/i.test(t) ? "included" : /separately|quoted/i.test(t) ? "quoted" : "excluded";
const ourFreightClass = (l: CanonicalLineItem) => l.freight.basis === "included" ? "included" : l.freight.basis === "quoted_amount" ? "quoted" : "excluded";

function loadBids(): Record<string, CanonicalBid> {
  if (!existsSync(BIDS)) return {};
  return Object.fromEntries(readdirSync(BIDS).filter((f) => f.endsWith(".json") && !f.endsWith(".error.json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(`${BIDS}/${f}`, "utf8")) as CanonicalBid]));
}

function scoreVendor(key: string, b: CanonicalBid) {
  const vid = b.vendor.vendor_id;
  const truth = gtLines[vid];
  const gtQuoted = new Set(truth.filter((l) => l.quote_status !== "not_quoted").map((l) => l.line_id));
  const ours = new Map(b.line_items.map((l) => [l.rfx_line_id, l]));
  const tp = [...ours.keys()].filter((k) => gtQuoted.has(k));
  const m = { raw: [0, 0], uom: [0, 0], cur: [0, 0], norm: [0, 0], fx: [0, 0], unit: [0, 0], freight: [0, 0], moq: [0, 0], lead: [0, 0] };
  const misses: string[] = [];
  for (const g of truth) {
    if (g.quote_status === "not_quoted") continue;
    const l = ours.get(g.line_id);
    if (!l) { misses.push(`${g.line_id}: not extracted`); continue; }
    // raw price (duplicates: any candidate may match; references: both null)
    m.raw[1]++;
    const candidates = l.candidate_quotes.map((c) => c.raw_price);
    const rawOk = g.quoted_price === null ? l.raw_price === null : near(effRaw(b, l), g.quoted_price) || (g.candidate_prices ?? []).some((cp) => candidates.some((c) => near(c, cp)));
    if (rawOk) m.raw[0]++; else misses.push(`${g.line_id}: raw ${effRaw(b, l)} vs ${g.quoted_price}`);
    m.uom[1]++;
    if ((g.pieces_per_quoted_unit ?? null) === (l.pieces_per_quoted_unit ?? null) || (g.quoted_uom === "per kg" && l.pieces_per_quoted_unit === null && /kg/i.test(l.raw_uom))) m.uom[0]++;
    else misses.push(`${g.line_id}: uom ${l.raw_uom} (${l.pieces_per_quoted_unit}) vs ${g.quoted_uom} (${g.pieces_per_quoted_unit})`);
    m.cur[1]++;
    if ((g.quoted_currency ?? "INR") === (l.raw_currency ?? "INR")) m.cur[0]++; else misses.push(`${g.line_id}: currency ${l.raw_currency} vs ${g.quoted_currency}`);
    // normalized: duplicates are unresolved by design until HITL – compare the conservative candidate
    m.norm[1]++;
    const ourNorm = l.normalized_unit_price_inr ?? (l.candidate_quotes.length > 1 ? Math.max(...l.candidate_quotes.map((c) => c.normalized_unit_price_inr ?? -1)) : null);
    const normOk = near(ourNorm, g.normalized_unit_price_inr);
    if (normOk) m.norm[0]++; else misses.push(`${g.line_id}: normalized ${ourNorm} vs ${g.normalized_unit_price_inr}`);
    if (g.quoted_currency === "USD") { m.fx[1]++; if (normOk) m.fx[0]++; }
    if (g.pieces_per_quoted_unit !== 1) { m.unit[1]++; if (normOk) m.unit[0]++; }
    m.freight[1]++;
    if (freightClass(g.freight_treatment) === ourFreightClass(l)) m.freight[0]++; else misses.push(`${g.line_id}: freight ${l.freight.basis} vs ${g.freight_treatment}`);
    if (g.moq !== null) { m.moq[1]++; if (g.moq === l.moq) m.moq[0]++; else misses.push(`${g.line_id}: moq ${l.moq} vs ${g.moq}`); }
    if (g.lead_time_days !== null) { m.lead[1]++; if (g.lead_time_days === l.lead_time_days) m.lead[0]++; else misses.push(`${g.line_id}: lead ${l.lead_time_days} vs ${g.lead_time_days}`); }
  }
  // questionnaire
  const qv = gtQual.vendors.find((v: { vendor_id: string }) => v.vendor_id === vid);
  let qOk = 0;
  const qMiss: string[] = [];
  for (const a of qv.answers) {
    const ours2 = b.questionnaire_answers.find((x) => x.qid === a.qid);
    const gtLevel = String(a.answer_level);
    const ok = a.qid === "Q09" ? ours2?.points === a.points : ours2?.compliance === gtLevel;
    if (ok) qOk++; else qMiss.push(`${a.qid}: ${ours2?.compliance}/${ours2?.points} vs ${gtLevel}/${a.points}`);
  }
  // HITL precision vs ground-truth flags (line level)
  const gtHitl = new Set(truth.filter((l) => l.hitl_required).map((l) => l.line_id));
  const ourFlag = new Set(b.line_items.filter((l) => l.review_status !== "accepted").map((l) => l.rfx_line_id));
  const flagTp = [...ourFlag].filter((x) => gtHitl.has(x)).length;
  return {
    key, vendor_id: vid, source_type: b.response_metadata.source_type, model: b.response_metadata.model,
    ms: (b as unknown as { _eval?: { ms: number } })._eval?.ms ?? null,
    coverage: { gt_quoted: gtQuoted.size, ours_quoted: ours.size, correct: tp.length, precision: pct(tp.length, ours.size), recall: pct(tp.length, gtQuoted.size) },
    raw_price_accuracy: pct(m.raw[0], m.raw[1]), uom_accuracy: pct(m.uom[0], m.uom[1]), currency_accuracy: pct(m.cur[0], m.cur[1]),
    normalized_price_accuracy: pct(m.norm[0], m.norm[1]), currency_conversion_accuracy: pct(m.fx[0], m.fx[1]),
    unit_conversion_accuracy: pct(m.unit[0], m.unit[1]), freight_accuracy: pct(m.freight[0], m.freight[1]),
    moq_accuracy: pct(m.moq[0], m.moq[1]), lead_time_accuracy: pct(m.lead[0], m.lead[1]),
    questionnaire_accuracy: pct(qOk, qv.answers.length),
    technical: { ours: b.processing_summary.technical_score, gt: qv.total_score, ours_status: b.processing_summary.qualification_status, gt_status: qv.status },
    line_review_flags: { ours: ourFlag.size, gt: gtHitl.size, true_positive: flagTp, precision: pct(flagTp, ourFlag.size), recall: pct(flagTp, gtHitl.size), false_review_rate: pct(ourFlag.size - flagTp, ours.size) },
    review_items: b.processing_summary.review_items,
    misses: [...misses, ...qMiss],
  };
}

// ------------------------------------------------------------------ edge-case detectors (generic signals in our bid)
type Bids = Record<string, CanonicalBid>;
const L = (b: CanonicalBid | undefined, id: string) => b?.line_items.find((l) => l.rfx_line_id === id);
const has = (b: CanonicalBid | undefined, id: string, r: string) => !!L(b, id)?.review_reasons.includes(r as never);
const item = (b: CanonicalBid | undefined, pred: (id: string, reason: string) => boolean) => !!b?.exceptions.some((e) => pred(e.id, e.reason));
const DETECT: Record<string, (x: Bids) => boolean> = {
  "EC-01": (x) => ["VND-1002", "VND-1003", "VND-1004", "VND-1005"].every((v) => x[v] && x[v].missing_rfx_lines.length > 0),
  "EC-02": (x) => near(L(x["VND-1001"], "CP-018")?.raw_price, gtLines["VND-1001"].find((l) => l.line_id === "CP-018")!.quoted_price),
  "EC-03": (x) => x["VND-1002"]?.processing_summary.quoted_lines === 27,
  "EC-04": (x) => ["CP-028", "CP-029", "CP-030"].every((id) => L(x["VND-1003"], id)?.raw_currency === "USD"),
  "EC-05": (x) => ["CP-020", "CP-023"].every((id) => L(x["VND-1002"], id)?.pieces_per_quoted_unit === 100),
  "EC-06": (x) => ["CP-020", "CP-021", "CP-022", "CP-023", "CP-024"].every((id) => L(x["VND-1004"], id)?.pieces_per_quoted_unit === 100),
  "EC-07": (x) => L(x["VND-1004"], "CP-001")?.pieces_per_quoted_unit === 1,
  "EC-08": (x) => item(x["VND-1002"], (id) => id === "terms:freight:incomplete_freight") && L(x["VND-1002"], "CP-001")?.freight.basis === "at_actuals" && L(x["VND-1002"], "CP-002")?.freight.basis === "included",
  "EC-09": (x) => near(L(x["VND-1005"], "CP-001")?.normalized_unit_price_inr, gtLines["VND-1005"].find((l) => l.line_id === "CP-001")!.normalized_unit_price_inr),
  "EC-10": (x) => ["VND-1001", "VND-1003"].every((v) => L(x[v], "CP-030")?.moq_exceeds_monthly_calloff === true),
  "EC-11": (x) => L(x["VND-1003"], "CP-015")?.moq === 25000,
  "EC-12": (x) => L(x["VND-1003"], "CP-015")?.lead_time_days === 28 || L(x["VND-1003"], "CP-017")?.lead_time_days === 28,
  "EC-13": (x) => has(x["VND-1004"], "CP-010", "ambiguous_image"),
  "EC-14": (x) => has(x["VND-1001"], "CP-026", "commercial_outlier"),
  "EC-15": (x) => has(x["VND-1002"], "CP-011", "duplicate_quote"),
  "EC-16": (x) => has(x["VND-1003"], "CP-014", "specification_mismatch") || has(x["VND-1003"], "CP-014", "ambiguous_match"),
  "EC-17": (x) => ["CP-016", "CP-017", "CP-025"].every((id) => has(x["VND-1005"], id, "referenced_external_price")),
  "EC-18": (x) => item(x["VND-1003"], (id) => id === "terms:validity:conflicting_values"),
  "EC-19": (x) => item(x["VND-1002"], (_, r) => r === "conditional_term"),
  "EC-20": (x) => { const p = x["VND-1004__vendor_4_rate_card_partial"]; return !!p && (L(p, "CP-022")?.review_reasons.length ?? 0) > 0; },
  "EC-21": (x) => has(x["VND-1004"], "CP-012", "specification_mismatch"),
  "EC-22": (x) => x["VND-1004"]?.processing_summary.qualification_status === "NOT QUALIFIED" && x["VND-1004"].processing_summary.mandatory_failures.includes("Q01"),
  "EC-23": (x) => {
    const wv = (b: CanonicalBid) => { let v = 0, h = 0; for (const l of b.line_items) if (l.comparable && l.evaluation_unit_price_inr !== null && l.historical_price_inr) { v += l.evaluation_unit_price_inr * l.annual_qty; h += l.historical_price_inr * l.annual_qty; } return h ? v / h : 9; };
    const main = ["VND-1001", "VND-1002", "VND-1003", "VND-1004", "VND-1005"].map((k) => x[k]).filter(Boolean);
    const v4 = x["VND-1004"];
    return !!v4 && v4.processing_summary.qualification_status === "NOT QUALIFIED" && main.every((b) => wv(v4) <= wv(b));
  },
  "EC-24": (x) => ["VND-1001", "VND-1002", "VND-1003", "VND-1004", "VND-1005"].every((v) => !!x[v]?.commercial_terms.price_validity_until),
  "EC-25": (x) => x["VND-1002"]?.commercial_terms.payment_days === 45,
  "EC-26": (x) => item(x["VND-1005"], (id, r) => id.startsWith("terms:") && r === "ambiguous_text"),
  "EC-27": (x) => ["VND-1004", "VND-1005"].every((v) => L(x[v], "CP-001")?.freight.basis !== "included" && L(x[v], "CP-001")?.landed_unit_price_inr === null),
  "EC-28": (x) => x["VND-1001"]?.processing_summary.quoted_lines === 30 && L(x["VND-1001"], "CP-001")?.freight.basis === "quoted_amount",
  "EC-29": (x) => (x["VND-1005"]?.processing_summary.quoted_lines ?? 0) >= 17,
  "EC-30": (x) => (x["VND-1002"]?.commercial_terms.tooling.length ?? 0) > 0 && (x["VND-1003"]?.commercial_terms.tooling.length ?? 0) > 0,
  "EC-31": (x) => ["CP-001", "CP-027"].every((id) => !!L(x["VND-1002"], id)),
  "EC-32": (x) => ["vendor_4_rate_card_angled", "vendor_4_rate_card_partial", "vendor_4_rate_card_glare"].every((k) => !!x[`VND-1004__${k}`]),
};

// ------------------------------------------------------------------ HITL simulation
async function simulateHitl(b: CanonicalBid) {
  const ctx = await loadEventContext();
  const truth = gtLines[b.vendor.vendor_id];
  const before = b.processing_summary.open_review_items;
  let bid = b;
  const corrections: { id: string; model: unknown; human: number }[] = [];
  for (const it of b.exceptions.filter((e) => e.status === "open")) {
    const g = it.rfx_line_id ? truth.find((l) => l.line_id === it.rfx_line_id) : null;
    const line = it.rfx_line_id ? L(bid, it.rfx_line_id) : null;
    if (g && g.normalized_unit_price_inr !== null && line && !near(line.normalized_unit_price_inr, g.normalized_unit_price_inr)) {
      bid = applyReviewAction(bid, { review_item_id: it.id, action: "edit", value: g.normalized_unit_price_inr, note: "eval: corrected to truth" }, ctx);
      corrections.push({ id: it.id, model: it.model_value, human: g.normalized_unit_price_inr });
    } else if (g && g.quote_status === "quoted_non_compliant") {
      bid = applyReviewAction(bid, { review_item_id: it.id, action: "reject", note: "eval: non-compliant" }, ctx);
    } else {
      bid = applyReviewAction(bid, { review_item_id: it.id, action: "accept", note: "eval: accepted" }, ctx);
    }
  }
  const after = bid.processing_summary.open_review_items;
  const preserved = corrections.every((c) => {
    const rec = bid.audit_log.find((r) => r.review_item_id === c.id);
    const line = L(bid, bid.exceptions.find((e) => e.id === c.id)!.rfx_line_id!);
    return rec?.human_corrected_value === c.human && rec.model_extracted_value === c.model && near(line?.normalized_unit_price_inr, c.human);
  });
  const recomputedTotal = Math.round(bid.line_items.filter((l) => l.comparable && l.evaluation_unit_price_inr !== null).reduce((s, l) => s + l.evaluation_unit_price_inr! * l.annual_qty, 0));
  const downstream = recomputedTotal === bid.processing_summary.annual_value_evaluated_inr &&
    bid.line_items.every((l) => l.normalized_unit_price_inr === null || l.evaluation_unit_price_inr === (l.landed_unit_price_inr ?? Math.round(l.normalized_unit_price_inr * (1 + ctx.evaluation.freight_loading_pct / 100) * 100) / 100));
  let finalized = false;
  try { finalized = finalizeBid(bid, ctx).review_state === "finalized"; } catch { finalized = false; }
  return { open_before: before, open_after: after, corrections: corrections.length, corrected_values_preserved: preserved, downstream_recomputed: downstream, finalized };
}

describe("offline evaluation vs ground truth", () => {
  it("scores processed bids and writes the report", async () => {
    const bids = loadBids();
    expect(Object.keys(bids).length, "run `npm run eval:process` first").toBeGreaterThan(0);
    const vendors = Object.entries(bids).map(([k, b]) => scoreVendor(k, b));
    const ecs = manifest.edge_cases.map((e: { edge_case_id: string; title: string; vendor_id: string | null; hitl_triggered: boolean }) => ({
      id: e.edge_case_id, title: e.title, vendor: e.vendor_id, hitl_expected: e.hitl_triggered, detected: DETECT[e.edge_case_id]?.(bids) ?? null,
    }));
    const scored = ecs.filter((e: { detected: boolean | null }) => e.detected !== null);
    const hitlEcs = scored.filter((e: { hitl_expected: boolean }) => e.hitl_expected);
    const hitl: Record<string, Awaited<ReturnType<typeof simulateHitl>>> = {};
    for (const [k, b] of Object.entries(bids)) if (!k.includes("__")) hitl[k] = await simulateHitl(b);
    const flags = vendors.filter((v) => !v.key.includes("__")).reduce((a, v) => ({ ours: a.ours + v.line_review_flags.ours, tp: a.tp + v.line_review_flags.true_positive, gt: a.gt + v.line_review_flags.gt, quoted: a.quoted + v.coverage.ours_quoted }), { ours: 0, tp: 0, gt: 0, quoted: 0 });
    const report = {
      generated_at: new Date().toISOString(),
      vendors,
      edge_cases: { total: ecs.length, scored: scored.length, detected: scored.filter((e: { detected: boolean }) => e.detected).length,
        recall_pct: pct(scored.filter((e: { detected: boolean }) => e.detected).length, scored.length),
        hitl_edge_case_recall_pct: pct(hitlEcs.filter((e: { detected: boolean }) => e.detected).length, hitlEcs.length), list: ecs },
      exceptions: { line_flag_precision_pct: pct(flags.tp, flags.ours), line_flag_recall_pct: pct(flags.tp, flags.gt), false_review_rate_pct: pct(flags.ours - flags.tp, flags.quoted) },
      hitl,
    };
    writeFileSync("eval/results/report.json", JSON.stringify(report, null, 2));
    writeFileSync("eval/results/report.md", toMarkdown(report));
    console.log(toMarkdown(report));
  });
});

function toMarkdown(r: { generated_at: string; vendors: ReturnType<typeof scoreVendor>[]; edge_cases: Record<string, unknown> & { list: { id: string; title: string; detected: boolean | null; hitl_expected: boolean }[] }; exceptions: Record<string, unknown>; hitl: Record<string, Record<string, unknown>> }) {
  const rows = r.vendors.map((v) => `| ${v.key} | ${v.source_type} | ${v.coverage.correct}/${v.coverage.gt_quoted} (P ${v.coverage.precision}%) | ${v.raw_price_accuracy}% | ${v.uom_accuracy}% | ${v.currency_accuracy}% | ${v.normalized_price_accuracy}% | ${v.freight_accuracy}% | ${v.questionnaire_accuracy}% | ${v.technical.ours} vs ${v.technical.gt} (${v.technical.ours_status === v.technical.gt_status ? "status ✓" : "status ✗"}) | ${v.line_review_flags.precision}% / ${v.line_review_flags.recall}% |`);
  return `# Bid Processing – offline evaluation\n\nGenerated ${r.generated_at}\n\n` +
    `| Response | Type | Lines found | Raw price | UoM | Currency | Normalized | Freight | Questionnaire | Tech score | Review flags P/R |\n|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\n` +
    `## Edge cases\nDetected ${r.edge_cases.detected}/${r.edge_cases.scored} (recall ${r.edge_cases.recall_pct}%); HITL-expected recall ${r.edge_cases.hitl_edge_case_recall_pct}%\n\n` +
    r.edge_cases.list.map((e) => `- ${e.detected === null ? "–" : e.detected ? "✅" : "❌"} ${e.id} ${e.title}`).join("\n") +
    `\n\n## Exceptions (line level, 5 primary responses)\nPrecision ${r.exceptions.line_flag_precision_pct}% · Recall ${r.exceptions.line_flag_recall_pct}% · False-review rate ${r.exceptions.false_review_rate_pct}%\n\n` +
    `## HITL simulation\n| Vendor | Open before | Open after | Corrections | Values preserved | Downstream recomputed | Finalized |\n|---|---|---|---|---|---|---|\n` +
    Object.entries(r.hitl).map(([k, h]) => `| ${k} | ${h.open_before} | ${h.open_after} | ${h.corrections} | ${h.corrected_values_preserved ? "✓" : "✗"} | ${h.downstream_recomputed ? "✓" : "✗"} | ${h.finalized ? "✓" : "✗"} |`).join("\n") +
    `\n\n## Misses\n` + r.vendors.map((v) => `### ${v.key}\n${v.misses.length ? v.misses.map((m) => `- ${m}`).join("\n") : "- none"}`).join("\n\n") + "\n";
}
