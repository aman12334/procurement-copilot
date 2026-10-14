/**
 * Opt-in live integration test for Stage 3 (real model): `npm run test:live`.
 * Processes Vendor 5's email and asks the analyst one grounded question. Skipped unless RFX_LIVE_TEST is set.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const live = !!process.env.RFX_LIVE_TEST;
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");

describe.skipIf(!live)("live Stage 3 (opt-in)", () => {
  it("processes a real vendor email and answers a grounded analyst question", async () => {
    const { createLLMClient } = await import("@/lib/ai/client");
    const { loadEventContext } = await import("@/lib/event/context");
    const { processVendorResponse } = await import("@/lib/bids/agent");
    const { askAnalyst } = await import("@/lib/analyst/agent");
    const ctx = await loadEventContext();
    const client = createLLMClient();
    const v = ctx.vendors.find((x) => x.vendor_id === "VND-1005")!;
    const r = await processVendorResponse(client, ctx, v, [{ name: "Godavari_Packaging_email_response.txt", data: readFileSync(v.response_files[0]) }]);
    if (!r.ok) console.error(r.error);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bid.processing_summary.quoted_lines).toBeGreaterThanOrEqual(17);
    expect(r.bid.line_items.find((l) => l.rfx_line_id === "CP-001")?.normalized_unit_price_inr).toBeCloseTo(7.39, 2);
    expect(r.bid.line_items.find((l) => l.rfx_line_id === "CP-016")?.review_reasons).toContain("referenced_external_price");
    const a = await askAnalyst(client, ctx, [r.bid], "What did Vendor 5 say about freight and which lines are priced by reference to last year?");
    if (!a.ok) console.error(a.error);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.citations.length).toBeGreaterThan(0);
    expect(a.answer.answer_markdown).toMatch(/freight/i);
    expect(a.answer.answer_markdown).toMatch(/CP-016|CP-017|CP-025/);
  }, 600_000);
});
