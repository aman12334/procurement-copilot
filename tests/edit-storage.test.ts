import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lineItemsFromCsv } from "@/lib/rfx/csv";
import {
  addLineItem, addQuestion, removeLineItem, removeQuestion, replaceLineItems, setCriterionWeight,
  setSourcedValue, toggleRequirementType, updateLineItem,
} from "@/lib/rfx/edit";
import { RfxDraftSchema } from "@/lib/rfx/schema";
import { MemoryStore, listDrafts, loadDraft, saveDraft } from "@/lib/rfx/storage";
import { validateBusinessRules } from "@/lib/rfx/validate";
import { completeRfx } from "./fixtures/rfx";

const TODAY = new Date("2026-10-13T00:00:00Z");

describe("editing an existing RFx (10)", () => {
  it("adds, updates and removes line items and questions immutably", () => {
    const original = completeRfx();
    let r = addLineItem(original);
    expect(r.line_items).toHaveLength(4);
    expect(r.line_items[3].line_id).toBe("CP-004");
    expect(original.line_items).toHaveLength(3);
    r = updateLineItem(r, 3, { item_description: "Layer pad", annual_qty: 150000 });
    expect(r.line_items[3]).toMatchObject({ item_description: "Layer pad", annual_qty: 150000, source: "explicit" });
    r = removeLineItem(r, 0);
    expect(r.line_items.map((l) => l.line_id)).toEqual(["CP-002", "CP-003", "CP-004"]);
    r = addQuestion(r, { topic: "Pallet compliance", max_points: 0 });
    expect(r.technical_questionnaire.at(-1)!.qid).toBe("Q13");
    r = removeQuestion(r, 0);
    expect(r.technical_questionnaire[0].qid).toBe("Q02");
    expect(RfxDraftSchema.safeParse(r).success).toBe(true);
  });

  it("toggles mandatory/preferred keeping the type field consistent", () => {
    const r = toggleRequirementType(completeRfx(), "preferred_requirements", 0);
    expect(r.preferred_requirements).toHaveLength(0);
    expect(r.mandatory_requirements.at(-1)).toMatchObject({ id: "BR-04", type: "mandatory" });
    expect(validateBusinessRules(r, TODAY).filter((i) => i.code === "TYPE_MISMATCH")).toEqual([]);
  });

  it("manual edit of a term becomes explicit and clears the matching unresolved entry", () => {
    const r = setSourcedValue(completeRfx(), "delivery_requirements.delivery_schedule", "Weekly call-offs");
    expect(r.delivery_requirements.delivery_schedule).toMatchObject({ value: "Weekly call-offs", source: "explicit" });
    expect(r.unresolved_fields.map((u) => u.field)).not.toContain("delivery_requirements.delivery_schedule");
  });

  it("edited weights are re-validated", () => {
    const r = setCriterionWeight(completeRfx(), 0, 40);
    expect(validateBusinessRules(r, TODAY).map((i) => i.code)).toContain("WEIGHTS_NOT_100");
  });
});

describe("saving and reloading (12)", () => {
  it("round-trips a draft through the store and re-validates it", () => {
    const store = new MemoryStore();
    const rfx = updateLineItem(completeRfx(), 0, { notes: "edited by buyer" });
    saveDraft(store, { draft_id: "d1", title: rfx.title, rfx, conversation: [{ role: "buyer", text: "hi" }] }, TODAY);
    const loaded = loadDraft(store, "d1");
    expect(loaded?.rfx).toEqual(rfx);
    expect(loaded?.conversation).toHaveLength(1);
    expect(listDrafts(store)).toEqual([{ draft_id: "d1", title: rfx.title, saved_at: TODAY.toISOString() }]);
  });

  it("returns null for corrupted or schema-invalid saved data", () => {
    const store = new MemoryStore();
    store.setItem("rfx.draft.bad", "{oops");
    store.setItem("rfx.draft.old", JSON.stringify({ draft_id: "old", rfx: { rfx_id: 1 } }));
    expect(loadDraft(store, "bad")).toBeNull();
    expect(loadDraft(store, "old")).toBeNull();
    expect(loadDraft(store, "missing")).toBeNull();
  });
});

describe("Stage 1 compatibility", () => {
  const csv = readFileSync(path.resolve(__dirname, "../stage1/buyer/rfx_master.csv"), "utf8");

  it("imports all 30 Stage 1 rfx_master lines into schema-valid line items", () => {
    const { items, errors } = lineItemsFromCsv(csv);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(30);
    expect(items[0]).toMatchObject({ line_id: "CP-001", ply: 3, flute: "B", delivery_plant: "BLR", annual_qty: 480000, uom: "piece" });
    expect(items[21].end_use).toBe("Glass jar separation in CP-009"); // quoted CSV field
    expect(items[0].additional_specs.map((s) => s.name)).toEqual(expect.arrayContaining(["reference_weight_g", "monthly_calloff_qty"]));
    const r = replaceLineItems(completeRfx(), items);
    expect(r.scope.annual_volume).toBe(items.reduce((s, l) => s + (l.annual_qty ?? 0), 0));
    expect(validateBusinessRules(r, TODAY).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("line-item schema uses Stage 1 rfx_master column names", () => {
    const header = csv.split(/\r?\n/)[0].split(",");
    const keys = Object.keys(RfxDraftSchema.shape.line_items.element.shape);
    const covered = header.filter((h) => keys.includes(h));
    expect(header.filter((h) => !covered.includes(h))).toEqual(["reference_weight_g", "monthly_calloff_qty"]);
  });

  it("questionnaire and requirement field names match Stage 1 files", () => {
    const tq = JSON.parse(readFileSync(path.resolve(__dirname, "../stage1/buyer/technical_questionnaire.json"), "utf8"));
    const br = JSON.parse(readFileSync(path.resolve(__dirname, "../stage1/buyer/buyer_requirements.json"), "utf8"));
    const qKeys = Object.keys(RfxDraftSchema.shape.technical_questionnaire.element.shape);
    for (const k of ["qid", "topic", "question", "mandatory", "max_points"]) expect(Object.keys(tq.questions[0])).toContain(k);
    for (const k of ["qid", "topic", "question", "mandatory", "max_points"]) expect(qKeys).toContain(k);
    const rKeys = Object.keys(RfxDraftSchema.shape.mandatory_requirements.element.shape);
    for (const k of ["id", "area", "requirement", "type"]) { expect(Object.keys(br.requirements[0])).toContain(k); expect(rKeys).toContain(k); }
  });
});
