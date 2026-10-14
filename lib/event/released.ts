/**
 * RFx hand-off: a finalized Stage 2 RFx draft + invited vendors becomes the event that every downstream step
 * (ingestion, identity matching, bid processing, comparison, scenarios, analyst) evaluates against.
 * Pure mapping/validation – usable on the server (context) and the client (release checks).
 */
import { z } from "zod";
import { RfxDraftSchema, type RfxDraft } from "@/lib/rfx/schema";
import { validateBusinessRules } from "@/lib/rfx/validate";
import type { EventContext, QuestionDef, RfxLine } from "./context";

export const ReleasedVendorSchema = z.object({
  vendor_id: z.string().min(1).max(40),
  vendor_no: z.number().int().positive(),
  vendor_name: z.string().min(1).max(200),
  contact_email: z.string().email().max(200),
  response_token: z.string().regex(/^RSP-[A-Z0-9]{6,12}$/).nullable().optional(),
});
export type ReleasedVendor = z.infer<typeof ReleasedVendorSchema>;

export const ReleasedEventSchema = z.object({
  status: z.literal("open"),
  released_at: z.string(),
  rfx: RfxDraftSchema,
  vendors: z.array(ReleasedVendorSchema).min(1).max(30),
});
export type ReleasedEvent = z.infer<typeof ReleasedEventSchema>;

/** What must be true before an RFx can be released for vendor responses. Empty list = releasable. */
export function releaseBlockers(rfx: RfxDraft, vendors: ReleasedVendor[], today = new Date()): string[] {
  const out: string[] = [];
  for (const i of validateBusinessRules(rfx, today).filter((x) => x.severity === "error")) out.push(`${i.path}: ${i.message}`);
  if (!rfx.rfx_id.trim()) out.push("RFx ID is empty.");
  if (!rfx.response_deadline) out.push("Set a response deadline.");
  if (!rfx.line_items.length) out.push("Add the line items vendors must quote (or import the SKU CSV).");
  const codes = new Set(rfx.buyer.locations.map((l) => l.code.toUpperCase()));
  rfx.line_items.forEach((l) => {
    if (l.annual_qty === null || !(l.annual_qty > 0)) out.push(`${l.line_id}: annual quantity is required.`);
    if (!l.delivery_plant || !codes.has(l.delivery_plant.toUpperCase())) out.push(`${l.line_id}: delivery plant must be one of the buyer locations.`);
  });
  if (rfx.scope.line_count && rfx.line_items.length < rfx.scope.line_count)
    out.push(`Scope states ${rfx.scope.line_count} lines but only ${rfx.line_items.length} are defined.`);
  if (!rfx.technical_questionnaire.length) out.push("Add the technical questionnaire.");
  if (!vendors.length) out.push("Invite at least one vendor.");
  const ids = vendors.map((v) => v.vendor_id);
  if (new Set(ids).size !== ids.length) out.push("Vendor IDs must be unique.");
  const toks = vendors.map((v) => v.response_token).filter(Boolean);
  if (new Set(toks).size !== toks.length) out.push("Response tokens must be unique.");
  return out;
}

const spec = (l: RfxDraft["line_items"][number], name: string) => l.additional_specs.find((s) => s.name === name)?.value;
const numOrNull = (v: string | undefined | null) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

/**
 * Event context built from the released RFx. Values the RFx does not carry come from the buyer's standing
 * configuration (`defaults`): evaluation FX / freight-loading rule and the buyer's internal historical prices
 * (matched by line ID). Vendor fixture files are only taken from the server-side registry.
 */
export function contextFromReleased(ev: ReleasedEvent, defaults: EventContext): EventContext {
  const r = ev.rfx;
  const registry = new Map(defaults.vendors.map((v) => [v.vendor_id, v]));
  const lines: RfxLine[] = r.line_items.map((l) => ({
    line_id: l.line_id,
    item_description: l.item_description,
    style: l.style,
    dimensions_text: l.dimensions_text,
    ply: l.ply,
    flute: l.flute,
    printing: l.printing,
    coating: l.coating,
    delivery_plant: (l.delivery_plant ?? "").toUpperCase(),
    annual_qty: l.annual_qty ?? 0,
    uom: l.uom,
    reference_weight_g: numOrNull(spec(l, "reference_weight_g")),
    recycled_content_min_pct: l.recycled_content_min_pct,
    end_use: l.end_use,
  }));
  const questions: QuestionDef[] = r.technical_questionnaire.map((q) => ({
    qid: q.qid, topic: q.topic, question: q.question, mandatory: q.mandatory, max_points: q.max_points,
    partial_points: Math.floor(q.max_points / 2), full: q.scoring_rule, partial: `${q.scoring_rule} (partial compliance scores half points)`,
  }));
  const historical = Object.fromEntries(lines.filter((l) => defaults.historical[l.line_id]).map((l) => [l.line_id, defaults.historical[l.line_id]]));
  return {
    rfx_id: r.rfx_id,
    title: r.title,
    buyer_name: r.buyer.company ?? defaults.buyer_name,
    issue_date: ev.released_at.slice(0, 10),
    response_due_date: r.response_deadline ?? "",
    contract_start: null,
    contract_end: null,
    plants: r.buyer.locations.map((p) => ({ code: p.code.toUpperCase(), name: p.name, state: p.state ?? "" })),
    lines,
    questions,
    qualification: { min_total_score: r.qualification.min_total_score ?? defaults.qualification.min_total_score, rule: r.qualification.rule },
    requirements: [...r.mandatory_requirements, ...r.preferred_requirements].map((q) => ({ id: q.id, area: q.area, requirement: q.requirement, type: q.type })),
    historical,
    vendors: ev.vendors.map((v) => ({
      ...v,
      response_files: registry.get(v.vendor_id)?.response_files ?? [],
      alternate_files: registry.get(v.vendor_id)?.alternate_files ?? [],
    })),
    evaluation: defaults.evaluation,
    source: "released_rfx",
    released_at: ev.released_at,
  };
}

/** Random per-vendor response reference, generated in the browser at release time. */
export function newResponseToken(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return `RSP-${[...b].map((x) => A[x % A.length]).join("")}`;
}
