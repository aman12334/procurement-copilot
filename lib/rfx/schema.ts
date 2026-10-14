/**
 * RFx draft schema (rfx.v1).
 *
 * Field names follow Stage 1 (stage1/buyer/*) wherever they overlap so later stages
 * (vendor-response extraction, normalization, comparison) need no translation:
 *
 *   Stage 2 concept        -> field used (Stage 1 source)
 *   description            -> item_description        (rfx_master)
 *   carton_type            -> style                   (rfx_master)
 *   dimensions             -> dimensions_text         (rfx_master)
 *   gsm                    -> combined_board_gsm      (rfx_master)
 *   bursting_factor        -> min_bursting_factor_outer_liner (rfx_master)
 *   flute_type             -> flute                   (rfx_master)
 *   print_requirement      -> printing                (rfx_master)
 *   coating_requirement    -> coating                 (rfx_master)
 *   annual_quantity        -> annual_qty              (rfx_master)
 *   unit_of_measure        -> uom                     (rfx_master)
 *   delivery_location      -> delivery_plant          (rfx_master; plant code)
 *   question_id / weight   -> qid / max_points        (technical_questionnaire)
 *   requirement entries    -> {id, area, requirement, type} (buyer_requirements)
 *   commercial_requirements-> {field, description, required} (commercial_terms.response_fields)
 *
 * Packaging-specific line fields are nullable so other categories can leave them empty
 * and use `additional_specs` instead.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "rfx.v1" as const;

export const SourceSchema = z
  .enum(["explicit", "inferred", "generated_assumption", "unresolved"])
  .describe("explicit = stated by buyer; inferred = logically derived from buyer input; generated_assumption = drafting suggestion the buyer did not state; unresolved = unknown");
export type Source = z.infer<typeof SourceSchema>;

/** A single commercial / delivery value together with where it came from. */
export const SourcedValueSchema = z.object({
  value: z.string().nullable().describe("Human-readable value, e.g. '60 days from GRN'. null when unresolved."),
  source: SourceSchema,
  note: z.string().nullable(),
});
export type SourcedValue = z.infer<typeof SourcedValueSchema>;

export const LocationSchema = z.object({
  code: z.string().describe("Short plant/location code, e.g. BLR"),
  name: z.string().describe("e.g. Bengaluru Plant"),
  address: z.string().nullable(),
  state: z.string().nullable(),
});
export type Location = z.infer<typeof LocationSchema>;

export const AdditionalSpecSchema = z.object({ name: z.string(), value: z.string() });

export const LineItemSchema = z.object({
  line_id: z.string().describe("Unique line ID, e.g. CP-001"),
  sku: z.string().nullable().describe("Buyer SKU / material code if known"),
  item_description: z.string(),
  category: z.string().describe("Sub-category, e.g. '3-ply carton', 'partition', 'layer pad'"),
  style: z.string().nullable().describe("Carton type, e.g. RSC, HSC, die-cut tray"),
  ply: z.number().int().nullable(),
  flute: z.string().nullable().describe("Flute type, e.g. B, BC, E"),
  dimensions_text: z.string().nullable().describe("L x W x H in mm"),
  dimension_basis: z.string().nullable(),
  board_construction: z.string().nullable(),
  combined_board_gsm: z.number().nullable(),
  min_bursting_factor_outer_liner: z.number().nullable(),
  min_bursting_strength_kg_cm2: z.number().nullable(),
  recycled_content_min_pct: z.number().nullable(),
  printing: z.string().nullable(),
  coating: z.string().nullable(),
  annual_qty: z.number().nullable().describe("Annual quantity in uom; null if unknown"),
  uom: z.string().describe("piece, set, kg, ..."),
  delivery_plant: z.string().nullable().describe("Location code from buyer.locations"),
  end_use: z.string().nullable(),
  notes: z.string().nullable(),
  additional_specs: z.array(AdditionalSpecSchema).describe("Category-specific specs not covered above"),
  source: SourceSchema,
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const RequirementSchema = z.object({
  id: z.string().describe("e.g. BR-01"),
  area: z.string().describe("e.g. Certification, Lead time, Freight"),
  requirement: z.string(),
  type: z.enum(["mandatory", "preferred", "information"]),
  source: SourceSchema,
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const CommercialRequirementSchema = z.object({
  field: z.string().describe("Field the vendor must quote, e.g. unit_price, freight, moq"),
  description: z.string(),
  required: z.boolean(),
});
export type CommercialRequirement = z.infer<typeof CommercialRequirementSchema>;

export const QuestionSchema = z.object({
  qid: z.string().describe("Question ID, e.g. Q01"),
  topic: z.string(),
  question: z.string(),
  answer_type: z.enum(["yes_no", "numeric", "text", "multiple_choice", "document_upload"]),
  mandatory: z.boolean(),
  max_points: z.number().describe("Scoring weight in points"),
  scoring_rule: z.string().describe("How full / partial / zero points are awarded"),
  rationale: z.string().describe("Why this question matters for the request"),
  source: SourceSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const EvaluationCriterionSchema = z.object({
  criterion_id: z.string(),
  name: z.string(),
  description: z.string(),
  weight: z.number().describe("Percentage weight; all weights must sum to 100"),
  source: SourceSchema,
});
export type EvaluationCriterion = z.infer<typeof EvaluationCriterionSchema>;

export const CommercialTermsSchema = z.object({
  currency: SourcedValueSchema,
  price_basis: SourcedValueSchema,
  freight_treatment: SourcedValueSchema,
  taxes: SourcedValueSchema,
  payment_terms: SourcedValueSchema,
  price_validity: SourcedValueSchema,
  moq_expectation: SourcedValueSchema,
  tooling: SourcedValueSchema,
  rebates_discounts: SourcedValueSchema,
  price_escalation: SourcedValueSchema,
});
export type CommercialTerms = z.infer<typeof CommercialTermsSchema>;
export const COMMERCIAL_TERM_KEYS = Object.keys(CommercialTermsSchema.shape) as (keyof CommercialTerms)[];

export const DeliveryRequirementsSchema = z.object({
  lead_time_days: z.number().nullable().describe("Maximum lead time from PO in days; null if unresolved"),
  lead_time: SourcedValueSchema,
  delivery_terms: SourcedValueSchema,
  delivery_schedule: SourcedValueSchema,
  packaging_and_palletisation: SourcedValueSchema,
  service_level: SourcedValueSchema,
});
export type DeliveryRequirements = z.infer<typeof DeliveryRequirementsSchema>;

export const AssumptionSchema = z.object({
  id: z.string(),
  field: z.string().describe("Path of the field the assumption applies to, e.g. commercial_terms.payment_terms"),
  assumption: z.string(),
  rationale: z.string(),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const UnresolvedFieldSchema = z.object({
  field: z.string().describe("Field path, e.g. response_deadline"),
  reason: z.string(),
  criticality: z.enum(["high", "medium", "low"]),
  suggested_question: z.string().describe("Question to ask the buyer to resolve it"),
});
export type UnresolvedField = z.infer<typeof UnresolvedFieldSchema>;

export const RfxDraftSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  rfx_id: z.string(),
  title: z.string(),
  category: z.string(),
  buyer: z.object({
    company: z.string().nullable(),
    business_unit: z.string().nullable(),
    locations: z.array(LocationSchema),
  }),
  scope: z.object({
    description: z.string(),
    annual_volume: z.number().nullable(),
    annual_volume_uom: z.string().nullable(),
    line_count: z.number().int().nullable().describe("Number of SKUs / lines in scope as stated by buyer"),
    currency: z.string(),
    contract_period: z.string().nullable(),
    partial_bids_allowed: z.boolean().nullable(),
  }),
  line_items: z.array(LineItemSchema),
  commercial_requirements: z.array(CommercialRequirementSchema),
  technical_questionnaire: z.array(QuestionSchema),
  qualification: z.object({
    min_total_score: z.number().nullable(),
    rule: z.string(),
  }),
  mandatory_requirements: z.array(RequirementSchema),
  preferred_requirements: z.array(RequirementSchema),
  evaluation_criteria: z.array(EvaluationCriterionSchema),
  commercial_terms: CommercialTermsSchema,
  delivery_requirements: DeliveryRequirementsSchema,
  response_deadline: z.string().nullable().describe("ISO date YYYY-MM-DD, or null and listed in unresolved_fields"),
  assumptions: z.array(AssumptionSchema),
  unresolved_fields: z.array(UnresolvedFieldSchema),
});
export type RfxDraft = z.infer<typeof RfxDraftSchema>;

// ---------------------------------------------------------------- sections
export const SECTIONS = {
  overview: { label: "RFx overview", keys: ["rfx_id", "title", "category", "buyer", "response_deadline"] },
  scope: { label: "Sourcing scope", keys: ["scope"] },
  line_items: { label: "Line items", keys: ["line_items"] },
  commercial_requirements: { label: "Commercial requirements", keys: ["commercial_requirements"] },
  technical_questionnaire: { label: "Technical questionnaire", keys: ["technical_questionnaire", "qualification"] },
  mandatory_requirements: { label: "Mandatory requirements", keys: ["mandatory_requirements"] },
  preferred_requirements: { label: "Preferred requirements", keys: ["preferred_requirements"] },
  evaluation_criteria: { label: "Evaluation criteria", keys: ["evaluation_criteria"] },
  commercial_terms: { label: "Commercial terms", keys: ["commercial_terms"] },
  delivery_requirements: { label: "Delivery requirements", keys: ["delivery_requirements"] },
  assumptions: { label: "Assumptions", keys: ["assumptions"] },
  unresolved_fields: { label: "Unresolved fields", keys: ["unresolved_fields"] },
} as const satisfies Record<string, { label: string; keys: readonly (keyof RfxDraft)[] }>;

export type SectionId = keyof typeof SECTIONS;
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

/**
 * Schema the model returns when regenerating one section: the section's own keys,
 * plus any assumptions / unresolved fields created while doing so (merged, not replaced).
 */
export function sectionResponseSchema(section: SectionId) {
  const shape: Record<string, z.ZodType> = {};
  for (const k of SECTIONS[section].keys) shape[k] = RfxDraftSchema.shape[k];
  if (section !== "assumptions") shape.new_assumptions = z.array(AssumptionSchema);
  if (section !== "unresolved_fields") shape.new_unresolved_fields = z.array(UnresolvedFieldSchema);
  return z.object(shape);
}

/** JSON Schema keywords Gemini structured output accepts (see @google/genai responseJsonSchema docs). */
const GEMINI_KEYWORDS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties",
  "required", "propertyOrdering",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "const") { out.enum = [v]; if (!src.type) out.type = typeof v === "number" ? "number" : "string"; continue; }
    if (!GEMINI_KEYWORDS.has(k)) continue;
    if (k === "properties" || k === "$defs") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitize(pv)]));
    } else if (k === "minimum" || k === "maximum") {
      if (Math.abs(v as number) < Number.MAX_SAFE_INTEGER) out[k] = v; // drop zod's safe-int bounds
    } else {
      out[k] = sanitize(v);
    }
  }
  if (out.properties) out.propertyOrdering = Object.keys(out.properties as object);
  return out;
}

/** JSON Schema handed to Gemini structured output (derived from the Zod schema – single source of truth). */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any", io: "input" });
  return sanitize(js) as Record<string, unknown>;
}

// ---------------------------------------------------------------- parallel generation
/**
 * Parts drafted concurrently from the same buyer requirement (wall time ≈ slowest part instead of one long
 * output). Keys that must agree closely stay in the same part; cross-part consistency is then checked by
 * validateBusinessRules like any draft.
 */
export const GENERATION_PARTS = {
  core: { label: "RFx header, scope, commercial terms and delivery", keys: ["rfx_id", "title", "category", "buyer", "response_deadline", "scope", "commercial_terms", "delivery_requirements"] },
  items: { label: "line items and commercial requirements", keys: ["line_items", "commercial_requirements"] },
  questionnaire: { label: "technical questionnaire and qualification", keys: ["technical_questionnaire", "qualification"] },
  requirements: { label: "mandatory/preferred requirements and evaluation criteria", keys: ["mandatory_requirements", "preferred_requirements", "evaluation_criteria"] },
} as const satisfies Record<string, { label: string; keys: readonly (keyof RfxDraft)[] }>;
export type GenerationPart = keyof typeof GENERATION_PARTS;

export function partResponseSchema(part: GenerationPart) {
  const shape: Record<string, z.ZodType> = {};
  for (const k of GENERATION_PARTS[part].keys) shape[k] = RfxDraftSchema.shape[k];
  shape.new_assumptions = z.array(AssumptionSchema);
  shape.new_unresolved_fields = z.array(UnresolvedFieldSchema);
  return z.object(shape);
}
