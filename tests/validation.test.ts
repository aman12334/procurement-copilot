import { describe, expect, it } from "vitest";
import { validateBusinessRules, validateSchema } from "@/lib/rfx/validate";
import { completeRfx } from "./fixtures/rfx";

const TODAY = new Date("2026-10-13T00:00:00Z");
const codes = (r: ReturnType<typeof completeRfx>) => validateBusinessRules(r, TODAY).map((i) => i.code);
const errors = (r: ReturnType<typeof completeRfx>) => validateBusinessRules(r, TODAY).filter((i) => i.severity === "error");

describe("schema + business validation", () => {
  it("accepts a complete, consistent draft with no errors", () => {
    expect(validateSchema(completeRfx()).ok).toBe(true);
    expect(errors(completeRfx())).toEqual([]);
  });

  it("(3) missing location: error unless the gap is listed as unresolved", () => {
    const r = completeRfx();
    r.buyer.locations = [];
    expect(codes(r)).toContain("NO_LOCATIONS");
    r.unresolved_fields.push({ field: "buyer.locations", reason: "not given", criticality: "high", suggested_question: "Which plants?" });
    expect(codes(r)).not.toContain("NO_LOCATIONS");
  });

  it("(3b) blank location strings are rejected", () => {
    const r = completeRfx();
    r.buyer.locations[0].name = "  ";
    expect(codes(r)).toContain("EMPTY_LOCATION");
  });

  it("(4) missing payment terms must be unresolved or an assumption, never silently empty", () => {
    const silent = completeRfx();
    silent.commercial_terms.payment_terms = { value: null, source: "generated_assumption", note: null };
    expect(codes(silent)).toEqual(expect.arrayContaining(["SILENT_OMISSION", "UNRESOLVED_NOT_LISTED"]));

    const unresolved = completeRfx();
    unresolved.commercial_terms.payment_terms = { value: null, source: "unresolved", note: null };
    unresolved.unresolved_fields.push({ field: "commercial_terms.payment_terms", reason: "not stated", criticality: "medium", suggested_question: "Payment terms?" });
    expect(errors(unresolved)).toEqual([]);

    const unlistedAssumption = completeRfx();
    unlistedAssumption.assumptions = unlistedAssumption.assumptions.filter((a) => a.field !== "commercial_terms.payment_terms");
    expect(codes(unlistedAssumption)).toContain("ASSUMPTION_NOT_LISTED");
  });

  it("(5) contradictory requirements: same requirement mandatory and preferred", () => {
    const r = completeRfx();
    r.preferred_requirements.push({ id: "BR-05", area: "Certification", requirement: "ISO 9001:2015 certification of supplying plants.", type: "preferred", source: "explicit" });
    expect(codes(r)).toContain("CONTRADICTORY_REQUIREMENT");
  });

  it("(5b) type field contradicting the list it sits in", () => {
    const r = completeRfx();
    r.mandatory_requirements[0].type = "preferred";
    expect(codes(r)).toContain("TYPE_MISMATCH");
  });

  it("(6) duplicate SKU IDs and duplicate line IDs", () => {
    const r = completeRfx();
    r.line_items[0].sku = "SKU-1";
    r.line_items[1].sku = "SKU-1";
    r.line_items[2].line_id = "CP-001";
    expect(codes(r)).toEqual(expect.arrayContaining(["DUPLICATE_SKU", "DUPLICATE_LINE_ID"]));
  });

  it("(7) evaluation weights not summing to 100", () => {
    const r = completeRfx();
    r.evaluation_criteria[0].weight = 50;
    const issue = validateBusinessRules(r, TODAY).find((i) => i.code === "WEIGHTS_NOT_100");
    expect(issue?.message).toContain("105");
  });

  it("flags duplicate question IDs, non-positive quantities, missing deadline and past deadline", () => {
    const r = completeRfx();
    r.technical_questionnaire[1].qid = "Q01";
    r.line_items[0].annual_qty = 0;
    expect(codes(r)).toEqual(expect.arrayContaining(["DUPLICATE_QID", "NON_POSITIVE_QTY"]));
    r.response_deadline = null;
    expect(codes(r)).toContain("NO_DEADLINE");
    r.response_deadline = "2026-01-01";
    expect(codes(r)).toContain("DEADLINE_IN_PAST");
  });

  it("schema rejects wrong types with readable paths", () => {
    const bad = { ...completeRfx(), evaluation_criteria: [{ name: "x", weight: "40" }] };
    const r = validateSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("evaluation_criteria.0.weight"))).toBe(true);
  });
});
