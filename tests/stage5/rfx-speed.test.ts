import { describe, expect, it } from "vitest";
import { toOpenAIStrictSchema } from "@/lib/ai/client";
import { ToolArgsInputSchema } from "@/lib/analyst/tools";
import { ExtractionSchema } from "@/lib/bids/schema";
import { generateRfxParallel } from "@/lib/rfx/agent";
import { GENERATION_PARTS, RfxDraftSchema, SECTIONS, partResponseSchema, toModelJsonSchema, type GenerationPart } from "@/lib/rfx/schema";
import { FakeLLM } from "../fixtures/fake-client";
import { completeRfx } from "../fixtures/rfx";

const parts = Object.keys(GENERATION_PARTS) as GenerationPart[];
const partAnswer = (p: GenerationPart, r = completeRfx()) => ({
  ...Object.fromEntries(GENERATION_PARTS[p].keys.map((k) => [k, r[k]])),
  new_assumptions: r.assumptions.filter((a) => GENERATION_PARTS[p].keys.some((k) => a.field.startsWith(k))),
  new_unresolved_fields: r.unresolved_fields.filter((u) => GENERATION_PARTS[p].keys.some((k) => u.field.startsWith(k))),
});

describe("OpenAI strict structured output", () => {
  it("RFx (full and parts) and bid extraction schemas are strict-compatible: no omitted keys possible", () => {
    for (const s of [RfxDraftSchema, ExtractionSchema, ...parts.map(partResponseSchema)]) {
      const strict = toOpenAIStrictSchema(toModelJsonSchema(s)) as Record<string, unknown> | null;
      expect(strict).not.toBeNull();
      expect(strict!.additionalProperties).toBe(false);
      expect(JSON.stringify(strict)).not.toMatch(/"oneOf"|"propertyOrdering"|"prefixItems"/);
    }
  });
  it("schemas with optional keys (analyst tool args) stay non-strict", () => {
    expect(toOpenAIStrictSchema(toModelJsonSchema(ToolArgsInputSchema))).toBeNull();
  });
});

describe("parallel RFx generation", () => {
  it("parts cover every draft key exactly once", () => {
    const keys = parts.flatMap((p) => GENERATION_PARTS[p].keys as readonly string[]);
    const expected = Object.keys(RfxDraftSchema.shape).filter((k) => !["schema_version", "assumptions", "unresolved_fields"].includes(k));
    expect([...keys].sort()).toEqual(expected.sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(SECTIONS).length).toBeGreaterThan(0);
  });

  it("runs all parts concurrently and merges them into one valid draft", async () => {
    let inFlight = 0, maxInFlight = 0;
    const llm = new FakeLLM(parts.map((p) => partAnswer(p)));
    const gen = llm.generateJson.bind(llm);
    llm.generateJson = async (req) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await gen(req); } finally { inFlight--; } };
    const r = await generateRfxParallel(llm, "Corrugated boxes for Bengaluru, Pune and Hyderabad");
    expect(maxInFlight).toBe(parts.length);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ref = completeRfx();
    expect(r.rfx.line_items).toEqual(ref.line_items);
    expect(r.rfx.commercial_terms).toEqual(ref.commercial_terms);
    expect(r.rfx.assumptions.map((a) => a.field).sort()).toEqual(ref.assumptions.map((a) => a.field).sort());
    expect(new Set(r.rfx.assumptions.map((a) => a.id)).size).toBe(r.rfx.assumptions.length); // ids renumbered, unique
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.meta).toMatchObject({ attempts: 1, promptVersion: "rfx-parallel.v1" });
    expect(llm.calls[1].prompt).toContain("Draft ONLY this part: line items");
  });

  it("a failing part fails the whole generation (no half drafts), naming the part", async () => {
    const answers: unknown[] = parts.map((p) => partAnswer(p));
    answers[1] = new Error("boom");
    const r = await generateRfxParallel(new FakeLLM(answers as never), "boxes");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/line items/);
  });
});

describe("requirements are filed by their own type", () => {
  it("an 'information' item in the mandatory list moves out; types are never changed", async () => {
    const { placeRequirementsByType } = await import("@/lib/rfx/agent");
    const { validateBusinessRules } = await import("@/lib/rfx/validate");
    const r = completeRfx();
    r.mandatory_requirements.push({ id: "BR-12", area: "Scope", requirement: "Partial bids are allowed.", type: "information", source: "explicit" });
    r.preferred_requirements.push({ id: "BR-13", area: "Cert", requirement: "ISO 14001.", type: "mandatory", source: "explicit" });
    expect(validateBusinessRules(r).filter((i) => i.code === "TYPE_MISMATCH")).toHaveLength(2);
    const fixed = placeRequirementsByType(r);
    expect(fixed.mandatory_requirements.map((x) => x.id)).toContain("BR-13");
    expect(fixed.preferred_requirements.find((x) => x.id === "BR-12")?.type).toBe("information");
    expect(validateBusinessRules(fixed).filter((i) => i.code === "TYPE_MISMATCH")).toEqual([]);
    expect(placeRequirementsByType(completeRfx())).toEqual(completeRfx());
  });
});
