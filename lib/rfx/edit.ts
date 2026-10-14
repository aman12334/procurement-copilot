/** Pure, immutable edit operations used by the UI (and unit-tested). */
import type { LineItem, Question, Requirement, RfxDraft } from "./schema";

const clone = (r: RfxDraft): RfxDraft => structuredClone(r);

function nextId(existing: string[], prefix: string, width: number): string {
  let max = 0;
  for (const id of existing) {
    const m = id.match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

/** Set any value by dotted path, e.g. "commercial_terms.payment_terms.value" or "line_items.2.annual_qty". */
export function setPath(rfx: RfxDraft, path: string, value: unknown): RfxDraft {
  const next = clone(rfx);
  const parts = path.split(".");
  let node: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (node[p] === undefined || node[p] === null) throw new Error(`Invalid path: ${path}`);
    node = node[p] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
  return next;
}

/** Editing a sourced value by hand makes it an explicit buyer decision. */
export function setSourcedValue(rfx: RfxDraft, path: string, value: string | null): RfxDraft {
  let next = setPath(rfx, `${path}.value`, value);
  next = setPath(next, `${path}.source`, value === null || value === "" ? "unresolved" : "explicit");
  if (value) next.unresolved_fields = next.unresolved_fields.filter((u) => u.field !== path);
  return next;
}

export function blankLineItem(rfx: RfxDraft): LineItem {
  const prefix = rfx.line_items[0]?.line_id.match(/^(.*?)(\d+)$/)?.[1] ?? "L-";
  return {
    line_id: nextId(rfx.line_items.map((l) => l.line_id), prefix, 3),
    sku: null, item_description: "", category: rfx.category, style: null, ply: null, flute: null,
    dimensions_text: null, dimension_basis: null, board_construction: null, combined_board_gsm: null,
    min_bursting_factor_outer_liner: null, min_bursting_strength_kg_cm2: null, recycled_content_min_pct: null,
    printing: null, coating: null, annual_qty: null, uom: "piece",
    delivery_plant: rfx.buyer.locations[0]?.code ?? null, end_use: null, notes: null, additional_specs: [], source: "explicit",
  };
}

export function addLineItem(rfx: RfxDraft, item?: Partial<LineItem>): RfxDraft {
  const next = clone(rfx);
  next.line_items.push({ ...blankLineItem(rfx), ...item });
  return next;
}

export function updateLineItem(rfx: RfxDraft, index: number, patch: Partial<LineItem>): RfxDraft {
  const next = clone(rfx);
  next.line_items[index] = { ...next.line_items[index], ...patch, source: "explicit" };
  return next;
}

export function removeLineItem(rfx: RfxDraft, index: number): RfxDraft {
  const next = clone(rfx);
  next.line_items.splice(index, 1);
  return next;
}

export function replaceLineItems(rfx: RfxDraft, items: LineItem[]): RfxDraft {
  const next = clone(rfx);
  next.line_items = items;
  next.scope.line_count = items.length;
  const total = items.reduce((s, l) => s + (l.annual_qty ?? 0), 0);
  if (total > 0) next.scope.annual_volume = total;
  next.unresolved_fields = next.unresolved_fields.filter((u) => !u.field.startsWith("line_items"));
  return next;
}

export function blankQuestion(rfx: RfxDraft): Question {
  return {
    qid: nextId(rfx.technical_questionnaire.map((q) => q.qid), "Q", 2),
    topic: "", question: "", answer_type: "yes_no", mandatory: false, max_points: 0,
    scoring_rule: "", rationale: "", source: "explicit",
  };
}

export function addQuestion(rfx: RfxDraft, q?: Partial<Question>): RfxDraft {
  const next = clone(rfx);
  next.technical_questionnaire.push({ ...blankQuestion(rfx), ...q });
  return next;
}

export function updateQuestion(rfx: RfxDraft, index: number, patch: Partial<Question>): RfxDraft {
  const next = clone(rfx);
  next.technical_questionnaire[index] = { ...next.technical_questionnaire[index], ...patch, source: "explicit" };
  return next;
}

export function removeQuestion(rfx: RfxDraft, index: number): RfxDraft {
  const next = clone(rfx);
  next.technical_questionnaire.splice(index, 1);
  return next;
}

type ReqList = "mandatory_requirements" | "preferred_requirements";

export function addRequirement(rfx: RfxDraft, list: ReqList): RfxDraft {
  const next = clone(rfx);
  const id = nextId([...rfx.mandatory_requirements, ...rfx.preferred_requirements].map((r) => r.id), "BR-", 2);
  next[list].push({ id, area: "", requirement: "", type: list === "mandatory_requirements" ? "mandatory" : "preferred", source: "explicit" });
  return next;
}

export function updateRequirement(rfx: RfxDraft, list: ReqList, index: number, patch: Partial<Requirement>): RfxDraft {
  const next = clone(rfx);
  next[list][index] = { ...next[list][index], ...patch, source: "explicit" };
  return next;
}

export function removeRequirement(rfx: RfxDraft, list: ReqList, index: number): RfxDraft {
  const next = clone(rfx);
  next[list].splice(index, 1);
  return next;
}

/** Move a requirement between mandatory and preferred, keeping its type field consistent. */
export function toggleRequirementType(rfx: RfxDraft, from: ReqList, index: number): RfxDraft {
  const next = clone(rfx);
  const to: ReqList = from === "mandatory_requirements" ? "preferred_requirements" : "mandatory_requirements";
  const [req] = next[from].splice(index, 1);
  next[to].push({ ...req, type: to === "mandatory_requirements" ? "mandatory" : "preferred", source: "explicit" });
  return next;
}

export function setCriterionWeight(rfx: RfxDraft, index: number, weight: number): RfxDraft {
  const next = clone(rfx);
  next.evaluation_criteria[index] = { ...next.evaluation_criteria[index], weight, source: "explicit" };
  return next;
}
