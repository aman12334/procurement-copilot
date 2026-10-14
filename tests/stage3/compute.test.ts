import { beforeAll, describe, expect, it } from "vitest";
import { computeCanonicalBid, parseUom } from "@/lib/bids/compute";
import type { Extraction } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { allFullAnswers, extraction, quote, term } from "../fixtures/bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });

const vendor = { vendor_id: "VND-1003", vendor_name: "Test", vendor_no: 3 };
const run = (ex: Extraction, source_type: "pdf" | "image" | "email" = "pdf", vid = vendor) =>
  computeCanonicalBid({ ctx, vendor: vid, extraction: ex, source_type, source_files: ["quote.pdf"], model: "fake", processed_at: "2026-10-14T00:00:00Z" });
const line = (b: ReturnType<typeof run>, id: string) => b.line_items.find((l) => l.rfx_line_id === id)!;
const hist = (id: string) => ctx.historical[id].price_inr;

describe("deterministic normalization, validation and exceptions", () => {
  it("(6) SKU mapping status: exact, probable, ambiguous (never forced), unmatched", () => {
    const b = run(extraction({ quotes: [
      quote("CP-001", hist("CP-001")),
      quote("CP-002", hist("CP-002"), "per piece", { mapping_basis: "description_match", vendor_item_code: null }),
      quote("CP-014", hist("CP-014"), "per piece", { alternative_rfx_line_ids: ["CP-007"], spec_deviation: "Vendor size 450x350x300 vs RFx 450x350x250" }),
      quote(null, 5, "per piece", { mapping_basis: "none", vendor_item_code: "X-99", vendor_description: "Mystery box" }),
    ] }));
    expect(line(b, "CP-001").match_status).toBe("exact");
    expect(line(b, "CP-002").match_status).toBe("probable");
    expect(line(b, "CP-014")).toMatchObject({ match_status: "ambiguous", review_status: "needs_review" });
    expect(line(b, "CP-014").review_reasons).toEqual(expect.arrayContaining(["ambiguous_match", "specification_mismatch"]));
    expect(b.unmatched_rows).toHaveLength(1);
    expect(b.exceptions.some((e) => e.reason === "unmatched_sku")).toBe(true);
  });

  it("(7) missing-line detection against the RFx (not hardcoded), with explicit declines", () => {
    const b = run(extraction({
      quotes: ctx.lines.slice(0, 27).map((l) => quote(l.line_id, hist(l.line_id))),
      declined_lines: [{ rfx_line_ids: ["CP-029", "CP-030"], statement: "7-ply export not quoted", evidence: { source_file: "q", location: "note 8", page: 2, source_text: "not quoted" } }],
    }));
    expect(b.missing_rfx_lines).toEqual(["CP-028", "CP-029", "CP-030"]);
    expect(b.declined_rfx_lines.map((d) => d.rfx_line_id)).toEqual(["CP-029", "CP-030"]);
    expect(b.processing_summary).toMatchObject({ quoted_lines: 27, missing_lines: 3, declined_lines: 2 });
  });

  it("(8) duplicates keep both values, require review and are not auto-chosen", () => {
    const b = run(extraction({ quotes: [quote("CP-011", 32.33, "Nos"), quote("CP-011", 32.83, "Nos", { evidence: { source_file: "q.pdf", location: "page 2 row 28", page: 2, source_text: "32.83" } })] }));
    const l = line(b, "CP-011");
    expect(l.candidate_quotes.map((c) => c.raw_price)).toEqual([32.33, 32.83]);
    expect(l.normalized_unit_price_inr).toBeNull();
    expect(l.review_status).toBe("blocked");
    const item = b.exceptions.find((e) => e.id === "line:CP-011:duplicate_quote")!;
    expect(item).toMatchObject({ severity: "critical", suggested_value: 32.83, candidates: [32.33, 32.83] });
    expect(item.evidence).toHaveLength(2);
    expect(b.processing_summary.duplicate_lines).toBe(1);
  });

  it("(9) contradiction between table and prose is flagged, not silently resolved", () => {
    const b = run(extraction({ terms: [
      term("freight", "FOR SCPL plants", { freight_basis: "included", freight_included: true }),
      term("validity", "Price validity: 90 days from date of offer", { validity_days: 90 }),
      term("validity", "the above rates are valid until 31 December 2026", { validity_until: "2026-12-31" }),
    ], quotes: [quote("CP-001", hist("CP-001"))] }));
    const item = b.exceptions.find((e) => e.id === "terms:validity:conflicting_values")!;
    expect(item.candidates).toEqual(["2026-12-31", "2027-01-07"]);
    expect(item.status).toBe("open");
    expect(b.commercial_terms.price_validity_statements).toHaveLength(2);
    expect(b.review_state).toBe("needs_review");
  });

  it("(10) per-100 normalization is done by code", () => {
    expect(parseUom("per 100 Nos (footnote *)", "stated")).toEqual({ kind: "unit", pieces: 100 });
    expect(parseUom("Rate / Box", "stated")).toEqual({ kind: "unit", pieces: 1 });
    const b = run(extraction({ quotes: [quote("CP-020", 867, "100 Nos")] }));
    expect(line(b, "CP-020")).toMatchObject({ pieces_per_quoted_unit: 100, normalized_unit_price_inr: 8.67, raw_price: 867 });
  });

  it("(11) USD conversion uses the explicit evaluation FX config and records it", () => {
    const b = run(extraction({ quotes: [quote("CP-028", 0.74, "per piece", { currency: "USD" })] }));
    const l = line(b, "CP-028");
    expect(ctx.evaluation.usd_inr).toBe(88.5);
    expect(l).toMatchObject({ raw_currency: "USD", fx_rate_to_inr: 88.5, normalized_unit_price_inr: 65.49, normalized_currency: "INR" });
    expect(l.fx_source).toContain("buyer_requirements.json");
    expect(b.response_metadata.fx.usd_inr).toBe(88.5);
  });

  it("(12) freight at actuals: landed cost unresolved, explicit evaluation loading, review item", () => {
    const b = run(extraction({ terms: [
      term("freight", "FOR Chakan", { freight_basis: "included", freight_plants: ["PNQ"] }),
      term("freight", "Bengaluru & Hyderabad freight extra at actuals", { freight_basis: "at_actuals", freight_plants: ["BLR", "HYD"], is_quantified: false }),
    ], quotes: [quote("CP-001", 7.56), quote("CP-002", 11.23)] }));
    expect(line(b, "CP-001").freight).toMatchObject({ included: false, basis: "at_actuals", amount: null });
    expect(line(b, "CP-001").landed_unit_price_inr).toBeNull();
    expect(line(b, "CP-001").evaluation_unit_price_inr).toBe(7.94);
    expect(line(b, "CP-002")).toMatchObject({ landed_unit_price_inr: 11.23, evaluation_unit_price_inr: 11.23 });
    expect(b.exceptions.find((e) => e.id === "terms:freight:incomplete_freight")?.message).toContain("1 line(s)");
  });

  it("(13) commercial outlier vs historical price is flagged", () => {
    const b = run(extraction({ quotes: [quote("CP-026", 9.6), quote("CP-001", hist("CP-001"))] }));
    expect(line(b, "CP-026").review_reasons).toContain("commercial_outlier");
    expect(line(b, "CP-001").review_reasons).not.toContain("commercial_outlier");
  });

  it("(14) 'same as last year' resolves only to this vendor's own previous price, flagged for review", () => {
    const v5 = { vendor_id: "VND-1005", vendor_name: "V5", vendor_no: 5 };
    const ref = (id: string) => quote(id, null, "piece", { price_basis: "reference_previous_price", mapping_basis: "reference", raw_price_text: "same as last year's pricing" });
    const b = run(extraction({ quotes: [ref("CP-016"), ref("CP-001")] }), "email", v5);
    expect(line(b, "CP-016")).toMatchObject({ normalized_unit_price_inr: hist("CP-016"), review_status: "needs_review" });
    expect(line(b, "CP-016").review_reasons).toContain("referenced_external_price");
    expect(line(b, "CP-001").normalized_unit_price_inr).toBeNull(); // VND-1005 was not last year's CP-001 supplier
    expect(line(b, "CP-001").review_reasons).toContain("missing_conversion_data");
  });

  it("per-kg uses the RFx reference weight and structured add-ons (code adds them)", () => {
    const b = run(extraction({ quotes: [quote("CP-004", 44, "per kg", { price_basis: "rate_per_kg", price_adjustments: [{ description: "printed", amount: 5 }] })] }), "email");
    expect(line(b, "CP-004").normalized_unit_price_inr).toBe(8.23); // 49 × 0.168
  });

  it("(19) processing summary counts are deterministic and questionnaire scoring follows the RFx rule", () => {
    const ex = extraction({ quotes: [quote("CP-001", hist("CP-001")), quote("CP-011", 30, "Nos"), quote("CP-011", 31, "Nos")],
      questionnaire_answers: allFullAnswers(ctx.questions.map((q) => q.qid)) });
    const s = run(ex).processing_summary;
    expect(s).toMatchObject({ rfx_lines: 30, quoted_lines: 2, missing_lines: 28, duplicate_lines: 1, technical_score: 100, qualification_status: "QUALIFIED" });
    expect(s.open_review_items).toBe(s.review_items);
    const noIso = { ...ex, questionnaire_answers: ex.questionnaire_answers.map((a) => (a.qid === "Q01" ? { ...a, compliance: "none" as const } : a)) };
    expect(run(noIso).processing_summary).toMatchObject({ qualification_status: "NOT QUALIFIED", mandatory_failures: ["Q01"] });
  });
});
