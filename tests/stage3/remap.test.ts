import { beforeAll, describe, expect, it } from "vitest";
import { computeCanonicalBid } from "@/lib/bids/compute";
import { applyReviewAction, ReviewError } from "@/lib/bids/hitl";
import type { Extraction } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { extraction, quote } from "../fixtures/bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const vendor = { vendor_id: "VND-1003", vendor_name: "Test", vendor_no: 3 };
const run = (ex: Extraction) =>
  computeCanonicalBid({ ctx, vendor, extraction: ex, source_type: "pdf", source_files: ["quote.pdf"], model: "fake", processed_at: "2026-10-14T00:00:00Z" });
const hist = (id: string) => ctx.historical[id].price_inr;
const T = new Date("2026-10-14T10:00:00Z");

describe("HITL re-map of a vendor row to another RFx line", () => {
  it("an unmatched row re-mapped to a line fills that line; extraction untouched; audit written; IDs stable", () => {
    const ex = extraction({ quotes: [
      quote("CP-001", hist("CP-001")),
      quote(null, hist("CP-005"), "per piece", { mapping_basis: "none", vendor_item_code: "X-99", vendor_description: "Mystery box" }),
      quote(null, 3, "per piece", { mapping_basis: "none", vendor_item_code: "X-100", vendor_description: "Other box" }),
    ] });
    const before = run(ex);
    expect(before.missing_rfx_lines).toContain("CP-005");
    expect(before.unmatched_rows).toHaveLength(2);
    const after = applyReviewAction(before, { review_item_id: "row:0:unmatched_sku", action: "remap", value: "cp-005", note: "X-99 is our CP-005" }, ctx, T);
    const l = after.line_items.find((x) => x.rfx_line_id === "CP-005")!;
    expect(l).toMatchObject({ vendor_item_code: "X-99", match_basis: "buyer_remap", normalized_unit_price_inr: hist("CP-005") });
    expect(after.missing_rfx_lines).not.toContain("CP-005");
    expect(after.unmatched_rows.map((r) => r.vendor_item_code)).toEqual(["X-100"]);
    expect(JSON.stringify(after.extraction)).toBe(JSON.stringify(before.extraction));
    // The other row keeps its review-item ID (no renumbering) and the re-mapped one is resolved.
    expect(after.exceptions.find((e) => e.id === "row:1:unmatched_sku")?.status).toBe("open");
    expect(after.exceptions.find((e) => e.id === "row:0:unmatched_sku")).toMatchObject({ status: "resolved" });
    expect(after.audit_log.at(-1)).toMatchObject({ review_item_id: "row:0:unmatched_sku", action: "remap", human_corrected_value: "CP-005", final_value: "CP-005", resolution: "human_corrected" });
    expect(after.processing_summary.quoted_lines).toBe(before.processing_summary.quoted_lines + 1);
  });

  it("an ambiguous match can be moved to the alternative line", () => {
    const before = run(extraction({ quotes: [quote("CP-014", hist("CP-007"), "per piece", { alternative_rfx_line_ids: ["CP-007"] })] }));
    expect(before.line_items[0]).toMatchObject({ rfx_line_id: "CP-014", match_status: "ambiguous" });
    const after = applyReviewAction(before, { review_item_id: "line:CP-014:ambiguous_match", action: "remap", value: "CP-007" }, ctx, T);
    expect(after.line_items.map((x) => x.rfx_line_id)).toEqual(["CP-007"]);
    expect(after.line_items[0]).toMatchObject({ match_status: "exact", match_basis: "buyer_remap" });
    expect(after.exceptions.find((e) => e.id === "line:CP-014:ambiguous_match")).toMatchObject({ status: "resolved", rfx_line_id: "CP-014" });
    expect(after.audit_log.at(-1)).toMatchObject({ action: "remap", final_value: "CP-007" });
  });

  it("rejects unknown target lines and re-maps of non-mapping review items", () => {
    const b = run(extraction({ quotes: [quote(null, 5, "per piece", { mapping_basis: "none" }), quote("CP-001", hist("CP-001") * 3)] }));
    expect(() => applyReviewAction(b, { review_item_id: "row:0:unmatched_sku", action: "remap", value: "CP-999" }, ctx)).toThrow(ReviewError);
    expect(() => applyReviewAction(b, { review_item_id: "line:CP-001:commercial_outlier", action: "remap", value: "CP-002" }, ctx)).toThrow(/Only row-mapping/);
  });
});
