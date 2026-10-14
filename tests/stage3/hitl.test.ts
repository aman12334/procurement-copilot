import { beforeAll, describe, expect, it } from "vitest";
import { computeCanonicalBid } from "@/lib/bids/compute";
import { applyReviewAction, finalizeBid, ReviewError } from "@/lib/bids/hitl";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { extraction, quote } from "../fixtures/bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });

function bid() {
  return computeCanonicalBid({
    ctx, vendor: { vendor_id: "VND-1004", vendor_name: "V4", vendor_no: 4 }, source_type: "image", source_files: ["card.png"],
    model: "fake", processed_at: "2026-10-14T00:00:00Z",
    extraction: extraction({ quotes: [
      quote("CP-010", 30.5, "Rate / Box", { ambiguity: "printed 33.00 struck through; handwritten 30.50", alternative_values: [33] }),
      quote("CP-011", 32.33, "Nos"), quote("CP-011", 32.83, "Nos"),
      quote("CP-026", 9.6), quote("CP-001", ctx.historical["CP-001"].price_inr),
    ] }),
  });
}
const L = (b: ReturnType<typeof bid>, id: string) => b.line_items.find((l) => l.rfx_line_id === id)!;
const T = new Date("2026-10-14T10:00:00Z");

describe("HITL loop closes and recomputes downstream", () => {
  it("(15) accept: item resolved, line human_verified, removed from open queue, audit kept", () => {
    const b0 = bid();
    const b1 = applyReviewAction(b0, { review_item_id: "line:CP-010:ambiguous_image", action: "accept" }, ctx, T);
    expect(L(b1, "CP-010")).toMatchObject({ review_status: "human_verified", normalized_unit_price_inr: 30.5 });
    expect(b1.processing_summary.open_review_items).toBe(b0.processing_summary.open_review_items - 1);
    expect(b1.audit_log[0]).toMatchObject({ resolution: "human_accepted", model_extracted_value: 30.5, final_value: 30.5 });
    expect(b1.extraction).toEqual(b0.extraction); // original extraction preserved
  });

  it("(16) correction: model value preserved, human value final, normalization re-run", () => {
    const b1 = applyReviewAction(bid(), { review_item_id: "line:CP-010:ambiguous_image", action: "edit", value: 30.8, note: "confirmed by phone" }, ctx, T);
    expect(b1.audit_log.at(-1)).toMatchObject({ model_extracted_value: 30.5, human_corrected_value: 30.8, final_value: 30.8, resolution: "human_corrected" });
    const l = L(b1, "CP-010");
    expect(l).toMatchObject({ normalized_unit_price_inr: 30.8, review_status: "human_verified" });
    // fixture freight is "included", so landed and evaluation prices follow the corrected value
    expect(l).toMatchObject({ landed_unit_price_inr: 30.8, evaluation_unit_price_inr: 30.8 });
  });

  it("(17) reject: line excluded from comparison, totals recomputed", () => {
    const b0 = bid();
    const b1 = applyReviewAction(b0, { review_item_id: "line:CP-026:commercial_outlier", action: "reject", note: "keying error" }, ctx, T);
    expect(L(b1, "CP-026")).toMatchObject({ review_status: "rejected", comparable: false, normalized_unit_price_inr: null });
    expect(b1.processing_summary.annual_value_lines_counted).toBe(b0.processing_summary.annual_value_lines_counted - 1);
  });

  it("(18) downstream recomputation after resolving a duplicate: price, evaluation, outlier check, summary", () => {
    const b0 = bid();
    expect(L(b0, "CP-011").normalized_unit_price_inr).toBeNull();
    const b1 = applyReviewAction(b0, { review_item_id: "line:CP-011:duplicate_quote", action: "edit", value: 32.33 }, ctx, T);
    const l = L(b1, "CP-011");
    expect(l.normalized_unit_price_inr).toBe(32.33);
    expect(l.evaluation_unit_price_inr).not.toBeNull();
    expect(l.comparable).toBe(true);
    expect(b1.processing_summary.annual_value_lines_counted).toBe(b0.processing_summary.annual_value_lines_counted + 1);
    expect(b1.processing_summary.annual_value_evaluated_inr).toBeGreaterThan(b0.processing_summary.annual_value_evaluated_inr!);
    // a human choosing an outlier value triggers a NEW outlier check on the final value
    const b2 = applyReviewAction(b0, { review_item_id: "line:CP-011:duplicate_quote", action: "edit", value: 99 }, ctx, T);
    expect(b2.exceptions.find((e) => e.id === "line:CP-011:commercial_outlier")?.status).toBe("open");
    expect(b2.trace.at(-1)?.step).toBe("hitl");
  });

  it("mark unresolved leaves the issue visible but out of the open queue; finalize requires an empty queue", () => {
    let b = bid();
    expect(() => finalizeBid(b, ctx, T)).toThrow(ReviewError);
    for (const it of b.exceptions.filter((e) => e.status === "open")) b = applyReviewAction(b, { review_item_id: it.id, action: "unresolved" }, ctx, T);
    expect(b.processing_summary).toMatchObject({ open_review_items: 0, unresolved_review_items: b.exceptions.length });
    const f = finalizeBid(b, ctx, T);
    expect(f.review_state).toBe("finalized");
    expect(() => applyReviewAction(f, { review_item_id: b.exceptions[0].id, action: "accept" }, ctx, T)).toThrow(/finalized/);
  });
});

describe("HITL ordering", () => {
  it("accepting a second item on a line does not overwrite an earlier human correction", () => {
    let b = computeCanonicalBid({
      ctx, vendor: { vendor_id: "VND-1002", vendor_name: "V2", vendor_no: 2 }, source_type: "pdf", source_files: ["q.pdf"], model: "fake", processed_at: "2026-10-14T00:00:00Z",
      extraction: extraction({ quotes: [quote("CP-011", 32.33, "Nos", { ambiguity: "appears twice" }), quote("CP-011", 32.83, "Nos")] }),
    });
    b = applyReviewAction(b, { review_item_id: "line:CP-011:duplicate_quote", action: "edit", value: 32.83 }, ctx, new Date("2026-10-14T10:00:00Z"));
    b = applyReviewAction(b, { review_item_id: "line:CP-011:ambiguous_text", action: "accept" }, ctx, new Date("2026-10-14T10:01:00Z"));
    expect(b.line_items[0].normalized_unit_price_inr).toBe(32.83);
    expect(b.audit_log.map((r) => r.resolution)).toEqual(["human_corrected", "human_accepted"]);
  });
});

describe("HITL outlier correction (regression)", () => {
  it("editing a commercial_outlier item changes the final price and recomputes downstream values", () => {
    const b0 = bid();
    const b1 = applyReviewAction(b0, { review_item_id: "line:CP-026:commercial_outlier", action: "edit", value: 4.1, note: "keying error" }, ctx, T);
    const l = L(b1, "CP-026");
    expect(l).toMatchObject({ normalized_unit_price_inr: 4.1, landed_unit_price_inr: 4.1, evaluation_unit_price_inr: 4.1, review_status: "human_verified" });
    expect(l.resolution).toMatchObject({ model_extracted_value: 9.6, human_corrected_value: 4.1, final_value: 4.1, resolution: "human_corrected" });
    expect(l.variance_vs_historical_pct).toBe(Math.round(((4.1 - ctx.historical["CP-026"].price_inr) / ctx.historical["CP-026"].price_inr) * 1000) / 10);
    expect(b1.processing_summary.annual_value_evaluated_inr).toBe(b0.processing_summary.annual_value_evaluated_inr! - Math.round((9.6 - 4.1) * l.annual_qty));
  });
});
