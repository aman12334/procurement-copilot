import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { processVendorResponse } from "@/lib/bids/agent";
import { MAX_ATTEMPTS } from "@/lib/ai/structured";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { FakeLLM } from "../fixtures/fake-client";
import { extraction, quote, term } from "../fixtures/bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const v5 = { vendor_id: "VND-1005", vendor_name: "Godavari Packaging Works", vendor_no: 5 };
const email = () => [{ name: "Godavari_Packaging_email_response.txt", data: readFileSync("stage1/vendors/vendor_5/Godavari_Packaging_email_response.txt") }];
const good = () => extraction({
  quotes: [quote("CP-001", 44, "per kg", { price_basis: "rate_per_kg", mapping_basis: "group_statement" })],
  terms: [term("freight", "Freight extra.", { freight_basis: "extra_unspecified", freight_included: false, is_quantified: false })],
});

describe("Bid Processing Agent orchestration (mocked model)", () => {
  it("runs ingest → extract → compute with an observable trace and the RFx in the prompt", async () => {
    const llm = new FakeLLM([good()]);
    const r = await processVendorResponse(llm, ctx, v5, email());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bid.trace.map((t) => t.step)).toEqual(["ingest", "extract", "extract", "match", "interpret", "normalize", "validate", "exceptions"]);
    expect(r.bid.line_items[0].normalized_unit_price_inr).toBe(7.39);
    expect(llm.calls[0].prompt).toContain("CP-030");
    expect(llm.calls[0].prompt).toMatch(/L\d+: - 3-ply plain brown boxes: Rs 44\/kg/);
    expect(r.bid.chunks.some((c) => c.kind === "document" && c.text.includes("Freight extra"))).toBe(true);
  });

  it("(20) retries exactly once when the model output fails schema validation", async () => {
    const llm = new FakeLLM([{ quotes: "lots" }, good()]);
    const r = await processVendorResponse(llm, ctx, v5, email());
    expect(r.ok && r.attempts).toBe(2);
    expect(llm.calls[1].prompt).toContain("failed schema validation");
  });

  it("(21) never retries indefinitely: two bad outputs → controlled error after MAX_ATTEMPTS", async () => {
    const llm = new FakeLLM(["not json", "{\"still\": \"wrong\"}", good()]);
    const r = await processVendorResponse(llm, ctx, v5, email());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(llm.calls).toHaveLength(MAX_ATTEMPTS);
    expect(r.error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(r.trace.at(-1)?.message).toContain("Extraction failed after 2 attempt(s)");
  });

  it("model unavailability is not retried by the agent and is reported as such", async () => {
    const llm = new FakeLLM([Object.assign(new Error("overloaded"), { code: "MODEL_UNAVAILABLE" })]);
    const r = await processVendorResponse(llm, ctx, v5, email());
    expect(!r.ok && r.error.code).toBe("MODEL_UNAVAILABLE");
    expect(llm.calls).toHaveLength(1);
  });
});
