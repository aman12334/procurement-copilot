import { describe, expect, it } from "vitest";
import { fillOmittedNulls, runStructuredCall } from "@/lib/ai/structured";
import { RfxDraftSchema, toModelJsonSchema } from "@/lib/rfx/schema";
import { FakeLLM } from "../fixtures/fake-client";
import { completeRfx } from "../fixtures/rfx";

const OMITTED = ["style", "flute", "dimensions_text", "dimension_basis", "board_construction", "combined_board_gsm"] as const;
const withoutNullables = () => {
  const r = completeRfx() as unknown as { line_items: Record<string, unknown>[]; buyer: Record<string, unknown> };
  for (const l of r.line_items) for (const k of OMITTED) delete l[k];
  delete r.buyer.business_unit;
  return r;
};

describe("provider omits nullable keys (OpenAI non-strict json_schema)", () => {
  it("fills only missing required-nullable keys with null; the draft then validates", () => {
    const raw = withoutNullables();
    expect(RfxDraftSchema.safeParse(raw).success).toBe(false); // the reported SCHEMA_VALIDATION_FAILED
    const filled = fillOmittedNulls(raw, toModelJsonSchema(RfxDraftSchema));
    expect(filled).toContain("line_items.0.flute");
    expect(filled).toContain("buyer.business_unit");
    expect(raw.line_items[0].combined_board_gsm).toBeNull();
    expect(RfxDraftSchema.safeParse(raw).success).toBe(true);
  });

  it("never invents non-nullable values: a missing required string still fails", () => {
    const raw = withoutNullables();
    delete raw.line_items[0].uom;
    fillOmittedNulls(raw, toModelJsonSchema(RfxDraftSchema));
    const r = RfxDraftSchema.safeParse(raw);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("uom");
  });

  it("first model answer is accepted – no corrective retry (one call instead of two)", async () => {
    const llm = new FakeLLM([withoutNullables()]);
    const out = await runStructuredCall(llm, { label: "t", system: "s", prompt: "p", schema: RfxDraftSchema });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });
});
