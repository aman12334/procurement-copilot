/**
 * Deterministic core of the Bid Processing Agent:
 *   canonical bid = f(extraction, human overrides, event context)
 * NORMALIZE → VALIDATE → EXCEPTION CHECK → SUMMARY. No model calls here; every HITL action re-runs this function,
 * so downstream normalization, validation, outlier checks and counts are always recomputed.
 */
import type { EventContext, RfxLine } from "@/lib/event/context";
import type {
  BidReviewState, CandidateQuote, CanonicalBid, CanonicalLineItem, CommercialTermsSummary, DocumentChunk, Evidence,
  ExtractedQuote, Extraction, Freight, ProcessingSummary, QuestionnaireResult, ReasonCode, ResolutionRecord,
  ReviewAction, ReviewItem, ReviewStatus, TermStatement, TraceEvent,
} from "./schema";

export interface ComputeInput {
  ctx: EventContext;
  vendor: { vendor_id: string; vendor_name: string; vendor_no: number | null };
  extraction: Extraction;
  source_type: CanonicalBid["response_metadata"]["source_type"];
  source_files: string[];
  model: string;
  processed_at: string;
  overrides?: CanonicalBid["overrides"];
  audit_log?: ResolutionRecord[];
  trace?: TraceEvent[];
  doc_chunks?: Omit<DocumentChunk, "vendor_id" | "chunk_id">[];
  finalized_at?: string | null;
}

// ------------------------------------------------------------------ small helpers
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type UnitParse =
  | { kind: "unit"; pieces: number }
  | { kind: "per_kg" }
  | { kind: "reference" }
  | { kind: "unknown" };

/** Unit-of-measure text → conversion. Order matters: "per 100 Nos" must not be read as "Nos". */
export function parseUom(uomText: string, priceBasis: ExtractedQuote["price_basis"]): UnitParse {
  if (priceBasis === "reference_previous_price") return { kind: "reference" };
  const t = uomText.toLowerCase().replace(/,/g, "");
  if (priceBasis === "rate_per_kg" || /\b(per\s*)?kg\b|\/\s*kg|kilo/.test(t)) return { kind: "per_kg" };
  const m = t.match(/(?:per|\/|rate\s*per)?\s*(1000|100|50|25|12|10)\s*(nos|no\.?|pcs?|pieces?|units?|sets?|boxes?|cartons?)\b/);
  if (m) return { kind: "unit", pieces: Number(m[1]) };
  if (/\b(piece|pieces|pc|pcs|nos|no\.?|each|box|boxes|carton|cartons|set|sets|unit|units|sleeve|pad|ea)\b|\/\s*(nos|pc|pcs)\b|rs\/nos/.test(t))
    return { kind: "unit", pieces: 1 };
  return { kind: "unknown" };
}

export function parseCurrency(c: string | null): "INR" | "USD" | null {
  if (!c) return null;
  const t = c.trim().toUpperCase();
  if (["INR", "RS", "RS.", "₹", "RUPEES", "RUPEE"].includes(t) || t.includes("INR") || t.includes("₹") || t.startsWith("RS")) return "INR";
  if (t === "USD" || t === "$" || t.includes("USD") || t.includes("US$") || t.includes("DOLLAR")) return "USD";
  return null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isIsoDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

const SEVERITY: Record<ReasonCode, ReviewItem["severity"]> = {
  duplicate_quote: "critical", missing_conversion_data: "critical", unknown_currency: "critical",
  missing_mandatory_answer: "major", ambiguous_image: "major", ambiguous_text: "major", commercial_outlier: "major",
  specification_mismatch: "major", referenced_external_price: "major", conflicting_values: "major",
  ambiguous_match: "major", unmatched_sku: "major", incomplete_freight: "major", conditional_term: "minor",
};
const BLOCKING: ReasonCode[] = ["missing_conversion_data", "unknown_currency"];

// ------------------------------------------------------------------ freight
export function resolveFreight(plant: string, quote: ExtractedQuote, freightTerms: TermStatement[]): Freight {
  if (quote.freight_amount !== null && quote.freight_amount !== undefined) {
    return { included: false, basis: "quoted_amount", amount: quote.freight_amount, currency: "INR",
      notes: "Freight quoted separately on the line", evidence: [quote.evidence] };
  }
  const specific = freightTerms.filter((t) => t.freight_plants.map((p) => p.toUpperCase()).includes(plant.toUpperCase()));
  const general = freightTerms.filter((t) => t.freight_plants.length === 0);
  const t = specific[0] ?? general[0];
  if (!t) return { included: null, basis: "unknown", amount: null, currency: "INR", notes: "No freight terms found for this plant", evidence: [] };
  const basis: Freight["basis"] =
    t.freight_basis === "included" || t.freight_included === true ? "included"
    : t.freight_basis === "at_actuals" ? "at_actuals"
    : t.freight_basis === "quoted_separately" ? "extra_unspecified"
    : t.freight_basis === "extra_unspecified" || t.freight_included === false ? "extra_unspecified" : "unknown";
  return { included: basis === "included" ? true : basis === "unknown" ? null : false, basis, amount: null, currency: "INR",
    notes: t.statement, evidence: [t.evidence] };
}

// ------------------------------------------------------------------ main
export function computeCanonicalBid(input: ComputeInput): CanonicalBid {
  const { ctx, vendor, extraction, overrides = {} } = input;
  const fx = ctx.evaluation;
  const lineById = new Map(ctx.lines.map((l) => [l.line_id, l]));
  const reviewItems: ReviewItem[] = [];
  const audit = [...(input.audit_log ?? [])];
  const terms = extraction.terms;
  const freightTerms = terms.filter((t) => t.topic === "freight");

  const addItem = (item: Omit<ReviewItem, "status" | "resolution" | "severity"> & { severity?: ReviewItem["severity"] }) => {
    const ov = overrides[item.id];
    const full: ReviewItem = {
      ...item, severity: item.severity ?? SEVERITY[item.reason],
      status: ov ? (ov.action === "unresolved" ? "unresolved" : "resolved") : "open",
      resolution: ov ? resolutionOf(item, ov) : null,
    };
    reviewItems.push(full);
    return full;
  };

  // ---------------- terms summary (validity / payment / contradictions)
  const quoteDate = isIsoDate(extraction.quote_date) ? extraction.quote_date : null;
  const validityStatements = terms.filter((t) => t.topic === "validity").map((t) => ({
    statement: t.statement,
    until: isIsoDate(t.validity_until) ? t.validity_until : t.validity_days && quoteDate ? addDays(quoteDate, t.validity_days) : null,
    evidence: t.evidence,
  }));
  const distinctUntil = [...new Set(validityStatements.map((v) => v.until).filter((u): u is string => !!u))].sort();
  let effectiveValidity: string | null = distinctUntil[0] ?? null;
  if (distinctUntil.length > 1) {
    const item = addItem({
      id: "terms:validity:conflicting_values", scope: "terms", rfx_line_id: null, field: "price_validity_until",
      reason: "conflicting_values",
      message: `Price validity is stated differently in ${validityStatements.length} places (${distinctUntil.join(" vs ")}). Earliest date suggested as the conservative value.`,
      model_value: distinctUntil.join(" | "), suggested_value: distinctUntil[0], candidates: distinctUntil,
      evidence: validityStatements.map((v) => v.evidence),
    });
    effectiveValidity = finalValue(item, overrides[item.id], distinctUntil[0]) as string | null;
  }
  const paymentStatements = terms.filter((t) => t.topic === "payment");
  const paymentDays = [...new Set(paymentStatements.map((t) => t.payment_days).filter((d): d is number => d !== null))];
  if (paymentDays.length > 1) {
    addItem({
      id: "terms:payment:conflicting_values", scope: "terms", rfx_line_id: null, field: "payment_days", reason: "conflicting_values",
      message: `Payment terms conflict: ${paymentDays.join(" vs ")} days.`, model_value: paymentDays.join(" | "),
      suggested_value: Math.min(...paymentDays), candidates: paymentDays, evidence: paymentStatements.map((t) => t.evidence),
    });
  }
  terms.forEach((t, i) => {
    if (t.is_conditional && (t.topic === "discount" || t.topic === "rebate")) {
      addItem({
        id: `terms:${i}:conditional_term`, scope: "terms", rfx_line_id: null, field: t.topic, reason: "conditional_term",
        message: `Conditional ${t.topic}: "${t.statement}" – not applied to normalized prices.`, model_value: t.percentage,
        suggested_value: null, candidates: [], evidence: [t.evidence],
      });
    } else if (!t.is_quantified && t.topic !== "freight" && t.topic !== "tax") {
      addItem({
        id: `terms:${i}:ambiguous_text`, scope: "terms", rfx_line_id: null, field: t.topic, reason: "ambiguous_text",
        message: `Unquantified ${t.topic} condition: "${t.statement}".`, model_value: null, suggested_value: null, candidates: [],
        evidence: [t.evidence], severity: "minor",
      });
    }
  });

  // ---------------- line items
  // Mapping as the model proposed it. Review-item IDs derive from this (stable), so a buyer re-map never renumbers them.
  const modelLine = (q: ExtractedQuote) => { const id = q.rfx_line_id?.trim().toUpperCase(); return id && lineById.has(id) ? id : null; };
  const origUnmatched = extraction.quotes.map((q, qi) => ({ q, qi })).filter(({ q }) => !modelLine(q));
  // Buyer re-maps (HITL "remap"): quote index → target line. The extraction itself is never modified.
  const remapped = new Map<number, { to: string; itemId: string; from: string | null }>();
  for (const [itemId, ov] of Object.entries(overrides)) {
    if (ov.action !== "remap" || typeof ov.value !== "string" || !lineById.has(ov.value.toUpperCase())) continue;
    const to = ov.value.toUpperCase();
    const row = itemId.match(/^row:(\d+):unmatched_sku$/);
    const amb = itemId.match(/^line:(.+):ambiguous_match$/);
    const qi = row ? origUnmatched[Number(row[1])]?.qi : amb ? extraction.quotes.findIndex((q) => modelLine(q) === amb[1]) : -1;
    if (qi !== undefined && qi >= 0) remapped.set(qi, { to, itemId, from: row ? null : amb![1] });
  }
  const effective = extraction.quotes.map((q, qi): ExtractedQuote => {
    const r = remapped.get(qi);
    return r ? { ...q, rfx_line_id: r.to, alternative_rfx_line_ids: [], mapping_basis: "explicit_code" } : q;
  });
  const isRemap = (q: ExtractedQuote) => remapped.has(effective.indexOf(q));

  const byLine = new Map<string, ExtractedQuote[]>();
  const unmatchedRows: CanonicalBid["unmatched_rows"] = [];
  effective.forEach((q) => {
    const id = q.rfx_line_id?.trim().toUpperCase();
    if (id && lineById.has(id)) {
      const arr = byLine.get(id) ?? [];
      arr.push(q);
      byLine.set(id, arr);
    } else {
      unmatchedRows.push({ vendor_item_code: q.vendor_item_code, vendor_description: q.vendor_description, raw_price_text: q.raw_price_text, evidence: q.evidence });
    }
  });
  origUnmatched.forEach(({ q, qi }, i) => addItem({
    id: `row:${i}:unmatched_sku`, scope: "bid", rfx_line_id: null, field: "rfx_line_id", reason: "unmatched_sku",
    message: `Row "${q.vendor_item_code ?? ""} ${q.vendor_description}" could not be mapped to an RFx line.${remapped.has(qi) ? ` Re-mapped by buyer to ${remapped.get(qi)!.to}.` : ""}`,
    model_value: q.raw_price_text, suggested_value: null, candidates: [], evidence: [q.evidence],
  }));

  const taxTerm = terms.find((t) => t.topic === "tax");
  const lineItems: CanonicalLineItem[] = [];
  for (const rl of ctx.lines) {
    const quotes = byLine.get(rl.line_id);
    if (!quotes?.length) continue;
    lineItems.push(buildLine(rl, quotes));
  }
  // A re-mapped "ambiguous match" item keeps its record even when its original line no longer carries the row.
  for (const r of remapped.values()) {
    if (!r.from || reviewItems.some((it) => it.id === r.itemId)) continue;
    const q = extraction.quotes[[...remapped.entries()].find(([, v]) => v === r)![0]];
    addItem({ id: r.itemId, scope: "line", rfx_line_id: r.from, field: "rfx_line_id", reason: "ambiguous_match",
      message: `${r.from}: vendor row "${q.vendor_description}" re-mapped by buyer to ${r.to}.`, model_value: r.from, suggested_value: null, candidates: [], evidence: [q.evidence] });
  }

  function normalizeQuote(rl: RfxLine, q: ExtractedQuote) {
    const reasons: ReasonCode[] = [];
    const unit = parseUom(q.uom_text, q.price_basis);
    const currency = parseCurrency(q.currency) ?? (unit.kind === "reference" ? "INR" : null);
    const adj = (q.price_adjustments ?? []).reduce((s, a) => s + a.amount, 0);
    const effRaw = q.raw_price === null ? null : q.raw_price + adj;
    let price: number | null = null, pieces: number | null = null, method = "";
    const fxRate = currency === "USD" ? fx.usd_inr : currency === "INR" ? 1 : null;
    if (unit.kind === "reference") {
      const h = ctx.historical[rl.line_id];
      reasons.push("referenced_external_price");
      if (h && h.last_year_supplier === vendor.vendor_id) {
        price = h.price_inr;
        pieces = 1;
        method = `Referenced previous price: FY25-26 PO price for ${rl.line_id} from historical_reference_prices.csv (vendor was last year's supplier)`;
      } else {
        method = "Referenced previous price, but no previous price from this vendor exists for this line";
        reasons.push("missing_conversion_data");
      }
    } else if (effRaw === null) {
      method = "No price stated";
      reasons.push("missing_conversion_data");
    } else if (!fxRate) {
      method = `Unknown currency "${q.currency ?? ""}"`;
      reasons.push("unknown_currency");
    } else if (unit.kind === "per_kg") {
      if (rl.reference_weight_g) {
        price = round2((effRaw * fxRate * rl.reference_weight_g) / 1000);
        pieces = null;
        method = `Rate per kg${adj ? ` (${q.raw_price} + ${adj} add-on)` : ""} × RFx reference weight ${rl.reference_weight_g} g${currency === "USD" ? ` × FX ${fx.usd_inr}` : ""}`;
      } else {
        method = "Per-kg rate but the RFx line has no reference weight";
        reasons.push("missing_conversion_data");
      }
    } else if (unit.kind === "unit") {
      pieces = unit.pieces;
      price = round2((effRaw * fxRate) / unit.pieces);
      method = [
        unit.pieces === 1 ? "Quoted per piece/box/set (factor 1)" : `Quoted per ${unit.pieces} → ÷ ${unit.pieces}`,
        adj ? `+ add-ons ${adj}` : null,
        currency === "USD" ? `× FX ${fx.usd_inr} (${fx.fx_source})` : null,
      ].filter(Boolean).join("; ");
    } else {
      method = `Unrecognised unit "${q.uom_text}"`;
      reasons.push("missing_conversion_data");
    }
    return { price, pieces, method, currency, fxRate, reasons };
  }

  function buildLine(rl: RfxLine, quotes: ExtractedQuote[]): CanonicalLineItem {
    const id = rl.line_id;
    const norms = quotes.map((q) => normalizeQuote(rl, q));
    const primary = quotes[0];
    const n0 = norms[0];
    const reasons = new Set<ReasonCode>(n0.reasons);
    const distinctPrices = [...new Set(norms.map((n) => n.price))];
    const isDuplicate = quotes.length > 1 && distinctPrices.length > 1;
    const candidates: CandidateQuote[] = quotes.map((q, i) => ({
      quote_index: effective.indexOf(q), raw_price: q.raw_price, raw_price_text: q.raw_price_text,
      normalized_unit_price_inr: norms[i].price, evidence: q.evidence,
    }));
    let price: number | null = isDuplicate ? null : n0.price;
    if (isDuplicate) reasons.add("duplicate_quote");

    // match status from mapping certainty (never forced)
    const alts = quotes.flatMap((q) => q.alternative_rfx_line_ids).filter((a) => a && a !== id);
    const match: CanonicalLineItem["match_status"] =
      alts.length ? "ambiguous" : primary.mapping_basis === "explicit_code" ? "exact" : primary.mapping_basis === "none" ? "unmatched" : "probable";
    const matchBasis: CanonicalLineItem["match_basis"] = isRemap(primary) ? "buyer_remap" : primary.mapping_basis;
    if (match === "ambiguous") reasons.add("ambiguous_match");
    const specDev = quotes.map((q) => q.spec_deviation).find((s) => !!s) ?? null;
    if (specDev) reasons.add("specification_mismatch");
    const ambiguity = quotes.map((q) => q.ambiguity).find((s) => !!s) ?? null;
    if (ambiguity) reasons.add(input.source_type === "image" ? "ambiguous_image" : "ambiguous_text");

    // ---- review items for this line (overrides may set the final price)
    const items: ReviewItem[] = [];
    const mk = (reason: ReasonCode, message: string, extra: Partial<ReviewItem> = {}) => {
      items.push(addItem({
        id: `line:${id}:${reason}`, scope: "line", rfx_line_id: id, field: "normalized_unit_price_inr", reason, message,
        model_value: price ?? n0.price, suggested_value: price ?? n0.price, candidates: [], evidence: quotes.map((q) => q.evidence), ...extra,
      }));
    };
    if (reasons.has("duplicate_quote")) {
      const cands = norms.map((n) => n.price).filter((p): p is number => p !== null);
      mk("duplicate_quote", `${id} is quoted ${quotes.length} times with different prices (${cands.join(" vs ")} INR/unit).`,
        { model_value: null, suggested_value: cands.length ? Math.max(...cands) : null, candidates: cands });
    }
    if (reasons.has("referenced_external_price"))
      mk("referenced_external_price", `${id} priced by reference ("${primary.raw_price_text}"). ${n0.method}.`);
    if (reasons.has("missing_conversion_data"))
      mk("missing_conversion_data", `${id}: price cannot be normalized – ${n0.method}.`, { suggested_value: null });
    if (reasons.has("unknown_currency")) mk("unknown_currency", `${id}: ${n0.method}.`, { suggested_value: null });
    if (reasons.has("ambiguous_match"))
      mk("ambiguous_match", `${id}: vendor row "${primary.vendor_description}" could also be ${[...new Set(alts)].join(", ")}.`);
    if (reasons.has("specification_mismatch")) mk("specification_mismatch", `${id}: ${specDev}`);
    if (reasons.has("ambiguous_image") || reasons.has("ambiguous_text"))
      mk(input.source_type === "image" ? "ambiguous_image" : "ambiguous_text", `${id}: ${ambiguity}`,
        { candidates: [...new Set([n0.price, ...quotes.flatMap((q) => q.alternative_values.map((v) => normalizeQuote(rl, { ...q, raw_price: v }).price))].filter((v): v is number => v !== null))] });

    // Outlier check on the model's price (before human decisions) so the buyer can accept / correct / reject it.
    const hist = ctx.historical[id]?.price_inr ?? null;
    const isOutlier = (p: number | null) => p !== null && !!hist && (p / hist > fx.outlier_high_ratio || p / hist < fx.outlier_low_ratio);
    const outlierItem = (p: number) => addItem({
      id: `line:${id}:commercial_outlier`, scope: "line", rfx_line_id: id, field: "normalized_unit_price_inr", reason: "commercial_outlier",
      message: `${id}: ${p} INR/unit is ${Math.round((p / hist! - 1) * 100)}% vs historical ${hist} (threshold ${Math.round((fx.outlier_low_ratio - 1) * 100)}% / +${Math.round((fx.outlier_high_ratio - 1) * 100)}%).`,
      model_value: p, suggested_value: p, candidates: [], evidence: quotes.map((q) => q.evidence),
    });
    if (isOutlier(price)) items.push(outlierItem(price!));

    // Decisions apply in the order they were made, so a later correction wins. "Accept" keeps the current value,
    // except for a duplicate where accepting means taking the suggested (conservative) candidate.
    let rejected = false;
    let resolution: ResolutionRecord | null = null;
    const decided = items.filter((it) => overrides[it.id]).sort((a, b) => overrides[a.id].at.localeCompare(overrides[b.id].at));
    for (const it of decided) {
      const ov = overrides[it.id];
      resolution = it.resolution;
      if (ov.action === "reject") rejected = true;
      else if (ov.action === "edit" && typeof ov.value === "number") price = round2(ov.value);
      else if (ov.action === "accept" && it.reason === "duplicate_quote" && typeof it.suggested_value === "number") price = it.suggested_value;
    }
    // Re-run the outlier check on the final (human-chosen) price if no outlier item was raised or reviewed yet.
    if (!items.some((i) => i.reason === "commercial_outlier") && isOutlier(price)) items.push(outlierItem(price!));

    // ---- downstream (always recomputed from the final price)
    const freight = resolveFreight(rl.delivery_plant, primary, freightTerms);
    const landed = price === null ? null
      : freight.basis === "included" ? price
      : freight.basis === "quoted_amount" && freight.amount !== null ? round2(price + freight.amount) : null;
    const loading = fx.freight_loading_pct / 100;
    const evaluation = price === null ? null : landed ?? round2(price * (1 + loading));
    const variance = evaluation !== null && hist ? Math.round(((evaluation - hist) / hist) * 1000) / 10 : null;

    const open = items.filter((i) => i.status === "open");
    const status: ReviewStatus = rejected ? "rejected"
      : open.some((i) => BLOCKING.includes(i.reason)) || (price === null && open.length) ? "blocked"
      : open.length ? "needs_review"
      : items.some((i) => i.status === "unresolved") ? "unresolved"
      : items.length ? "human_verified" : "accepted";
    const moq = quotes.map((q) => q.moq).find((m) => m !== null) ?? null;
    const lead = quotes.map((q) => q.lead_time_days).find((m) => m !== null) ?? null;
    return {
      rfx_line_id: id, rfx_sku: id, rfx_description: rl.item_description, delivery_plant: rl.delivery_plant, annual_qty: rl.annual_qty,
      vendor_item_code: primary.vendor_item_code, vendor_description: primary.vendor_description,
      match_status: match, match_basis: matchBasis,
      raw_price: primary.raw_price, raw_price_text: primary.raw_price_text, raw_currency: n0.currency, raw_uom: primary.uom_text,
      pieces_per_quoted_unit: n0.pieces, fx_rate_to_inr: n0.fxRate, fx_source: n0.currency === "USD" ? fx.fx_source : null,
      normalized_unit_price_inr: rejected ? null : price, normalized_currency: "INR", normalized_uom: rl.uom,
      normalization_method: resolution?.resolution === "human_corrected" ? `Human corrected (${n0.method})` : n0.method,
      freight, landed_unit_price_inr: rejected ? null : landed, evaluation_unit_price_inr: rejected ? null : evaluation,
      evaluation_basis: evaluation === null || rejected ? null : landed !== null ? "landed (freight known)" : `normalized + ${fx.freight_loading_pct}% freight loading (${fx.freight_loading_source})`,
      historical_price_inr: hist, variance_vs_historical_pct: rejected ? null : variance,
      moq, moq_exceeds_monthly_calloff: moq === null ? null : moq > Math.round(rl.annual_qty / 12),
      lead_time_days: lead,
      tax: { treatment: taxTerm?.statement ?? null, evidence: taxTerm ? [taxTerm.evidence] : [] },
      price_validity_until: effectiveValidity,
      remarks: quotes.map((q) => q.remarks).filter(Boolean).join(" | ") || null,
      spec_deviation: specDev, candidate_quotes: candidates, evidence: quotes.map((q) => q.evidence),
      review_status: status, review_reasons: [...new Set(items.map((i) => i.reason))], resolution,
      comparable: !rejected && price !== null && status !== "blocked",
    };
  }

  // ---------------- freight completeness (one bid-level item)
  const incompleteFreight = lineItems.filter((l) => ["at_actuals", "extra_unspecified", "unknown"].includes(l.freight.basis));
  if (incompleteFreight.length) {
    const bases = [...new Set(incompleteFreight.map((l) => l.freight.basis))];
    addItem({
      id: "terms:freight:incomplete_freight", scope: "terms", rfx_line_id: null, field: "freight", reason: "incomplete_freight",
      message: `Landed cost cannot be computed for ${incompleteFreight.length} line(s): freight ${bases.join("/").replace(/_/g, " ")}. ` +
        `Evaluation uses the RFx ${fx.freight_loading_pct}% loading rule; landed price left unresolved.`,
      model_value: null, suggested_value: null, candidates: [], evidence: dedupeEvidence(incompleteFreight.flatMap((l) => l.freight.evidence)),
    });
  }

  // ---------------- missing / declined
  const quoted = new Set(lineItems.map((l) => l.rfx_line_id));
  const declined: CanonicalBid["declined_rfx_lines"] = [];
  for (const d of extraction.declined_lines) for (const lid of d.rfx_line_ids) {
    const id = lid.toUpperCase();
    if (lineById.has(id) && !quoted.has(id) && !declined.some((x) => x.rfx_line_id === id)) declined.push({ rfx_line_id: id, statement: d.statement, evidence: d.evidence });
  }
  const missing = ctx.lines.map((l) => l.line_id).filter((id) => !quoted.has(id));

  // ---------------- questionnaire (deterministic scoring)
  const answers: QuestionnaireResult[] = ctx.questions.map((q) => {
    const a = extraction.questionnaire_answers.find((x) => x.qid.toUpperCase() === q.qid.toUpperCase());
    let compliance = a?.compliance ?? "unanswered";
    const id = `q:${q.qid}:missing_mandatory_answer`;
    if (q.mandatory && compliance === "unanswered") {
      const item = addItem({
        id, scope: "questionnaire", rfx_line_id: null, field: q.qid, reason: "missing_mandatory_answer",
        message: `Mandatory question ${q.qid} (${q.topic}) is not answered.`, model_value: null, suggested_value: "none",
        candidates: ["full", "partial", "none"], evidence: [],
      });
      const ov = overrides[item.id];
      if (ov?.action === "edit" && typeof ov.value === "string" && ["full", "partial", "none"].includes(ov.value)) compliance = ov.value as typeof compliance;
    }
    const n = a?.plants_within_350km;
    const points = n !== null && n !== undefined
      ? Math.round((q.max_points * Math.max(0, Math.min(3, n))) / 3)
      : compliance === "full" ? q.max_points : compliance === "partial" ? q.partial_points ?? 0 : 0;
    return {
      qid: q.qid, topic: q.topic, mandatory: q.mandatory, answer_text: a?.answer_text ?? null, compliance, points,
      max_points: q.max_points, mandatory_pass: q.mandatory ? compliance === "full" : null, rationale: a?.rationale ?? "Not answered",
      evidence: a?.evidence ?? null, review_status: q.mandatory && (a?.compliance ?? "unanswered") === "unanswered" && !overrides[id] ? "needs_review" : "accepted",
    };
  });
  const technical = answers.reduce((s, a) => s + a.points, 0);
  const mandatoryFailures = answers.filter((a) => a.mandatory && !a.mandatory_pass).map((a) => a.qid);
  const qualified = technical >= ctx.qualification.min_total_score && mandatoryFailures.length === 0;

  // ---------------- commercial terms summary
  const first = (topic: TermStatement["topic"]) => terms.find((t) => t.topic === topic);
  const commercial: CommercialTermsSummary = {
    currency: [...new Set(lineItems.map((l) => l.raw_currency).filter(Boolean))].join(", ") || null,
    payment_days: paymentDays.length === 1 ? paymentDays[0] : paymentDays.length ? Math.min(...paymentDays) : null,
    payment_terms: first("payment")?.statement ?? null,
    price_validity_until: effectiveValidity,
    price_validity_statements: validityStatements,
    freight_statements: freightTerms,
    tax: taxTerm?.statement ?? null,
    discounts: terms.filter((t) => t.topic === "discount" || t.topic === "rebate"),
    tooling: terms.filter((t) => t.topic === "tooling"),
    other_terms: terms.filter((t) => ["moq", "lead_time", "price_escalation", "other"].includes(t.topic)),
    lead_time: first("lead_time")?.statement ?? null,
    moq: first("moq")?.statement ?? null,
  };

  // ---------------- summary (deterministic counts)
  const counted = lineItems.filter((l) => l.comparable && l.evaluation_unit_price_inr !== null);
  const summary: ProcessingSummary = {
    rfx_lines: ctx.lines.length,
    quoted_lines: lineItems.length,
    missing_lines: missing.length,
    declined_lines: declined.length,
    duplicate_lines: lineItems.filter((l) => l.candidate_quotes.length > 1).length,
    unmatched_rows: unmatchedRows.length,
    ambiguous_matches: lineItems.filter((l) => l.match_status === "ambiguous").length,
    accepted_lines: lineItems.filter((l) => l.review_status === "accepted" || l.review_status === "human_verified").length,
    lines_needing_review: lineItems.filter((l) => l.review_status === "needs_review" || l.review_status === "blocked").length,
    review_items: reviewItems.length,
    open_review_items: reviewItems.filter((i) => i.status === "open").length,
    resolved_review_items: reviewItems.filter((i) => i.status === "resolved").length,
    unresolved_review_items: reviewItems.filter((i) => i.status === "unresolved").length,
    blocked_items: lineItems.filter((l) => l.review_status === "blocked").length,
    technical_score: technical,
    technical_max: ctx.questions.reduce((s, q) => s + q.max_points, 0),
    qualification_status: qualified ? "QUALIFIED" : "NOT QUALIFIED",
    mandatory_failures: mandatoryFailures,
    annual_value_evaluated_inr: counted.length ? Math.round(counted.reduce((s, l) => s + l.evaluation_unit_price_inr! * l.annual_qty, 0)) : null,
    annual_value_lines_counted: counted.length,
  };

  const openMajor = reviewItems.some((i) => i.status === "open" && i.severity !== "minor");
  const review_state: BidReviewState = input.finalized_at ? "finalized"
    : openMajor ? "needs_review" : reviewItems.length ? "processed_with_exceptions" : "processed";

  return {
    schema_version: "bid.v1",
    vendor: { vendor_id: vendor.vendor_id, vendor_name: vendor.vendor_name, vendor_no: vendor.vendor_no ?? null },
    response_metadata: {
      source_type: input.source_type, source_files: input.source_files, quote_reference: extraction.quote_reference,
      quote_date: quoteDate, processed_at: input.processed_at, model: input.model, fx: { usd_inr: fx.usd_inr, source: fx.fx_source },
    },
    line_items: lineItems,
    unmatched_rows: unmatchedRows,
    questionnaire_answers: answers,
    commercial_terms: commercial,
    missing_rfx_lines: missing,
    declined_rfx_lines: declined,
    exceptions: reviewItems,
    processing_summary: summary,
    review_state,
    finalized_at: input.finalized_at ?? null,
    trace: input.trace ?? [],
    extraction,
    overrides,
    audit_log: audit,
    chunks: buildChunks(vendor.vendor_id, extraction, input.doc_chunks ?? [], input.source_files[0] ?? ""),
  };
}

function dedupeEvidence(ev: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return ev.filter((e) => {
    const k = `${e.source_file}|${e.location}|${e.source_text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function finalValue(item: ReviewItem, ov: (ReviewAction & { at: string }) | undefined, fallback: number | string | null) {
  if (!ov || ov.action === "remap") return fallback;
  if (ov.action === "edit" && ov.value !== undefined && ov.value !== null) return ov.value;
  if (ov.action === "accept") return item.suggested_value ?? fallback;
  return fallback;
}

function resolutionOf(item: Omit<ReviewItem, "status" | "resolution" | "severity">, ov: ReviewAction & { at: string }): ResolutionRecord {
  const human = ov.action === "edit" || ov.action === "remap" ? ov.value ?? null : null;
  const final = ov.action === "edit" || ov.action === "remap" ? human : ov.action === "accept" ? item.suggested_value ?? item.model_value : ov.action === "reject" ? null : item.model_value;
  return {
    review_item_id: item.id, action: ov.action, model_extracted_value: item.model_value, human_corrected_value: human, final_value: final,
    resolution: ov.action === "accept" ? "human_accepted" : ov.action === "edit" || ov.action === "remap" ? "human_corrected" : ov.action === "reject" ? "human_rejected" : "marked_unresolved",
    note: ov.note ?? null, at: ov.at,
  };
}

function buildChunks(vendorId: string, ex: Extraction, docChunks: Omit<DocumentChunk, "vendor_id" | "chunk_id">[], file: string): DocumentChunk[] {
  const out: Omit<DocumentChunk, "vendor_id" | "chunk_id">[] = [...docChunks];
  if (ex.transcription) {
    ex.transcription.split(/\n+/).map((l) => l.trim()).filter(Boolean).forEach((line, i) =>
      out.push({ source_file: file, location: `image transcription line ${i + 1}`, page: null, kind: "transcription", text: line }));
  }
  ex.terms.forEach((t) => out.push({ source_file: t.evidence.source_file, location: t.evidence.location, page: t.evidence.page, kind: "term", text: `[${t.topic}] ${t.statement}` }));
  ex.questionnaire_answers.forEach((a) => a.answer_text && out.push({
    source_file: a.evidence?.source_file ?? file, location: a.evidence?.location ?? "questionnaire", page: a.evidence?.page ?? null,
    kind: "questionnaire", text: `[${a.qid}] ${a.answer_text}`,
  }));
  return out.map((c, i) => ({ ...c, vendor_id: vendorId, chunk_id: `${vendorId}#${i + 1}` }));
}
