/**
 * Bid schemas.
 *
 * 1. ExtractionSchema  – what the model returns: verbatim values + evidence + interpretations.
 *                        It never contains normalized prices or counts.
 * 2. CanonicalBid      – computed deterministically from (extraction + human overrides + event context).
 *
 * Field names follow Stage 1 (stage1/buyer, ground-truth record shape) where practical:
 * rfx_line_id, raw_price_text, quoted_uom, normalized_unit_price_inr, landed_unit_price_inr, moq, lead_time_days.
 */
import { z } from "zod";

// ------------------------------------------------------------------ evidence
export const EvidenceSchema = z.object({
  source_file: z.string().describe("File name the value came from"),
  location: z.string().describe("Human-readable location: 'page 2, price table row 19', 'Sheet Quotation row 14', 'paragraph 6', 'rate card row CP-010 rate cell'"),
  page: z.number().int().nullable().describe("1-based page number for PDFs, else null"),
  source_text: z.string().describe("Verbatim text copied from the document (or exact transcription from the image)"),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ------------------------------------------------------------------ model extraction
export const MappingBasisSchema = z.enum(["explicit_code", "description_match", "group_statement", "reference", "none"]);

export const ExtractedQuoteSchema = z.object({
  rfx_line_id: z.string().nullable().describe("RFx line this quote is for (from the provided RFx line list), or null if it cannot be mapped"),
  mapping_basis: MappingBasisSchema.describe("explicit_code = vendor printed the RFx code; description_match = mapped by description/specs; group_statement = a rate stated for a group of items; reference = price given by reference (e.g. last year's price); none = unmapped"),
  alternative_rfx_line_ids: z.array(z.string()).describe("Other RFx lines this row could plausibly be, if the mapping is not certain"),
  vendor_item_code: z.string().nullable().describe("Item code exactly as printed by the vendor"),
  vendor_description: z.string(),
  vendor_dimensions: z.string().nullable().describe("Dimensions exactly as stated by the vendor for this row"),
  raw_price: z.number().nullable().describe("Numeric price exactly as written (no unit conversion, no currency conversion). For a base rate plus stated add-ons, the base rate."),
  price_adjustments: z.array(z.object({ description: z.string(), amount: z.number() }))
    .describe("Stated add-ons/deductions that apply to this line in the same unit and currency (e.g. 'printed +Rs 5/kg'). Code adds them; do not add them yourself."),
  raw_price_text: z.string().describe("The price text exactly as written, including any annotations"),
  currency: z.string().nullable().describe("Currency as stated or clearly implied by the document (INR, USD); null if unknown"),
  uom_text: z.string().describe("Unit the price is quoted per, as stated: 'per piece', 'Nos', 'per 100 nos', 'per kg', 'Rate/Box', 'Set'. Use the document's words."),
  price_basis: z.enum(["stated", "rate_per_kg", "reference_previous_price", "not_stated"]),
  freight_amount: z.number().nullable().describe("Freight amount per unit if this row quotes freight separately"),
  moq: z.number().nullable(),
  moq_text: z.string().nullable(),
  lead_time_days: z.number().nullable(),
  lead_time_text: z.string().nullable(),
  remarks: z.string().nullable(),
  spec_deviation: z.string().nullable().describe("Any stated deviation from the RFx specification for this line (e.g. 'without coating'), or a dimension/spec conflict you noticed"),
  ambiguity: z.string().nullable().describe("Anything that makes this value uncertain: handwritten corrections, struck-through values, smudged or unreadable digits, conflicting rows"),
  alternative_values: z.array(z.number()).describe("Other candidate numeric values visible for this price (e.g. a struck-through printed value)"),
  evidence: EvidenceSchema,
});
export type ExtractedQuote = z.infer<typeof ExtractedQuoteSchema>;

export const TermTopicSchema = z.enum(["freight", "payment", "validity", "tax", "moq", "lead_time", "tooling", "discount", "rebate", "price_escalation", "other"]);
export type TermTopic = z.infer<typeof TermTopicSchema>;

export const TermStatementSchema = z.object({
  topic: TermTopicSchema,
  statement: z.string().describe("Verbatim statement"),
  applies_to: z.string().nullable().describe("Scope as stated: 'all items', 'Bengaluru & Hyderabad plants', 'CP-015', 'printed boxes'"),
  freight_included: z.boolean().nullable(),
  freight_basis: z.enum(["included", "quoted_separately", "at_actuals", "extra_unspecified"]).nullable(),
  freight_plants: z.array(z.string()).describe("Plant codes this freight statement applies to (BLR, PNQ, HYD); empty = all plants"),
  payment_days: z.number().nullable(),
  validity_days: z.number().nullable().describe("Validity expressed as a number of days, if stated that way"),
  validity_until: z.string().nullable().describe("Validity end date YYYY-MM-DD, if stated as a date"),
  percentage: z.number().nullable().describe("Discount / rebate / tax percentage if stated"),
  amount: z.number().nullable().describe("Monetary amount if stated (e.g. tooling cost)"),
  is_conditional: z.boolean().describe("True if the term only applies under a condition"),
  condition: z.string().nullable(),
  is_quantified: z.boolean().describe("False if the statement leaves an amount/value unspecified (e.g. 'small run charges will apply', 'at actuals')"),
  evidence: EvidenceSchema,
});
export type TermStatement = z.infer<typeof TermStatementSchema>;

export const ExtractedAnswerSchema = z.object({
  qid: z.string().describe("Question ID from the RFx questionnaire"),
  answer_text: z.string().nullable().describe("The vendor's answer, verbatim or closely paraphrased; null if not answered"),
  compliance: z.enum(["full", "partial", "none", "unanswered"]).describe("Classify against the question's full / partial criteria"),
  plants_within_350km: z.number().int().nullable().describe("Only for the production-locations question: how many buyer plants have a vendor plant within 350 km"),
  rationale: z.string().describe("One sentence explaining the classification"),
  evidence: EvidenceSchema.nullable(),
});
export type ExtractedAnswer = z.infer<typeof ExtractedAnswerSchema>;

export const ExtractionSchema = z.object({
  vendor_name: z.string().nullable(),
  quote_reference: z.string().nullable(),
  quote_date: z.string().nullable().describe("YYYY-MM-DD"),
  document_overview: z.string().describe("2-3 sentences describing the document's structure"),
  transcription: z.string().nullable().describe("For images only: a faithful plain-text transcription of the whole image, row by row"),
  quotes: z.array(ExtractedQuoteSchema),
  declined_lines: z.array(z.object({
    rfx_line_ids: z.array(z.string()),
    statement: z.string(),
    evidence: EvidenceSchema,
  })).describe("RFx lines the vendor explicitly says it is not quoting"),
  terms: z.array(TermStatementSchema),
  questionnaire_answers: z.array(ExtractedAnswerSchema),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// ------------------------------------------------------------------ canonical bid (computed)
export const REASON_CODES = [
  "ambiguous_text", "ambiguous_image", "conflicting_values", "missing_conversion_data", "unmatched_sku",
  "duplicate_quote", "missing_mandatory_answer", "commercial_outlier", "referenced_external_price",
  "incomplete_freight", "specification_mismatch", "ambiguous_match", "conditional_term", "unknown_currency",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReviewStatus = "accepted" | "needs_review" | "blocked" | "human_verified" | "rejected" | "unresolved";
export type MatchStatus = "exact" | "probable" | "ambiguous" | "unmatched";
export type BidReviewState = "processed" | "processed_with_exceptions" | "needs_review" | "finalized";

export interface Freight {
  included: boolean | null;
  basis: "included" | "quoted_amount" | "at_actuals" | "extra_unspecified" | "unknown";
  amount: number | null;
  currency: "INR";
  notes: string | null;
  evidence: Evidence[];
}

export interface CandidateQuote {
  quote_index: number;
  raw_price: number | null;
  raw_price_text: string;
  normalized_unit_price_inr: number | null;
  evidence: Evidence;
}

export interface ResolutionRecord {
  review_item_id: string;
  action: ReviewAction["action"];
  model_extracted_value: number | string | null;
  human_corrected_value: number | string | null;
  final_value: number | string | null;
  resolution: "human_accepted" | "human_corrected" | "human_rejected" | "marked_unresolved";
  note: string | null;
  at: string;
}

export interface CanonicalLineItem {
  rfx_line_id: string;
  rfx_sku: string;
  rfx_description: string;
  delivery_plant: string;
  annual_qty: number;
  vendor_item_code: string | null;
  vendor_description: string;
  match_status: MatchStatus;
  /** "buyer_remap" = the buyer re-mapped this row to the line (HITL); never produced by the model. */
  match_basis: z.infer<typeof MappingBasisSchema> | "buyer_remap";
  raw_price: number | null;
  raw_price_text: string;
  raw_currency: string | null;
  raw_uom: string;
  pieces_per_quoted_unit: number | null;
  fx_rate_to_inr: number | null;
  fx_source: string | null;
  normalized_unit_price_inr: number | null;
  normalized_currency: "INR";
  normalized_uom: string;
  normalization_method: string;
  freight: Freight;
  landed_unit_price_inr: number | null;
  evaluation_unit_price_inr: number | null;
  evaluation_basis: string | null;
  historical_price_inr: number | null;
  variance_vs_historical_pct: number | null;
  moq: number | null;
  moq_exceeds_monthly_calloff: boolean | null;
  lead_time_days: number | null;
  tax: { treatment: string | null; evidence: Evidence[] };
  price_validity_until: string | null;
  remarks: string | null;
  spec_deviation: string | null;
  candidate_quotes: CandidateQuote[];
  evidence: Evidence[];
  review_status: ReviewStatus;
  review_reasons: ReasonCode[];
  resolution: ResolutionRecord | null;
  comparable: boolean;
}

export interface QuestionnaireResult {
  qid: string;
  topic: string;
  mandatory: boolean;
  answer_text: string | null;
  compliance: ExtractedAnswer["compliance"];
  points: number;
  max_points: number;
  mandatory_pass: boolean | null;
  rationale: string;
  evidence: Evidence | null;
  review_status: ReviewStatus;
}

export interface CommercialTermsSummary {
  currency: string | null;
  payment_days: number | null;
  payment_terms: string | null;
  price_validity_until: string | null;
  price_validity_statements: { statement: string; until: string | null; evidence: Evidence }[];
  freight_statements: TermStatement[];
  tax: string | null;
  discounts: TermStatement[];
  tooling: TermStatement[];
  other_terms: TermStatement[];
  lead_time: string | null;
  moq: string | null;
}

export interface ReviewItem {
  id: string;
  scope: "line" | "terms" | "questionnaire" | "bid";
  rfx_line_id: string | null;
  field: string;
  reason: ReasonCode;
  severity: "critical" | "major" | "minor";
  message: string;
  model_value: number | string | null;
  suggested_value: number | string | null;
  candidates: (number | string)[];
  evidence: Evidence[];
  status: "open" | "resolved" | "unresolved";
  resolution: ResolutionRecord | null;
}

export interface ProcessingSummary {
  rfx_lines: number;
  quoted_lines: number;
  missing_lines: number;
  declined_lines: number;
  duplicate_lines: number;
  unmatched_rows: number;
  ambiguous_matches: number;
  accepted_lines: number;
  lines_needing_review: number;
  review_items: number;
  open_review_items: number;
  resolved_review_items: number;
  unresolved_review_items: number;
  blocked_items: number;
  technical_score: number;
  technical_max: number;
  qualification_status: "QUALIFIED" | "NOT QUALIFIED";
  mandatory_failures: string[];
  annual_value_evaluated_inr: number | null;
  annual_value_lines_counted: number;
}

export interface TraceEvent {
  at: string;
  step: "ingest" | "extract" | "match" | "interpret" | "normalize" | "validate" | "exceptions" | "hitl" | "finalize";
  message: string;
}

export interface DocumentChunk {
  chunk_id: string;
  vendor_id: string;
  source_file: string;
  location: string;
  page: number | null;
  kind: "document" | "transcription" | "term" | "questionnaire" | "quote";
  text: string;
}

export interface CanonicalBid {
  schema_version: "bid.v1";
  vendor: { vendor_id: string; vendor_name: string; vendor_no: number | null };
  response_metadata: {
    source_type: "xlsx" | "pdf" | "docx" | "image" | "email";
    source_files: string[];
    quote_reference: string | null;
    quote_date: string | null;
    processed_at: string;
    model: string;
    fx: { usd_inr: number; source: string };
  };
  line_items: CanonicalLineItem[];
  unmatched_rows: { vendor_item_code: string | null; vendor_description: string; raw_price_text: string; evidence: Evidence }[];
  questionnaire_answers: QuestionnaireResult[];
  commercial_terms: CommercialTermsSummary;
  missing_rfx_lines: string[];
  declined_rfx_lines: { rfx_line_id: string; statement: string; evidence: Evidence }[];
  exceptions: ReviewItem[];
  processing_summary: ProcessingSummary;
  review_state: BidReviewState;
  finalized_at: string | null;
  trace: TraceEvent[];
  extraction: Extraction;
  overrides: Record<string, ReviewAction & { at: string }>;
  audit_log: ResolutionRecord[];
  chunks: DocumentChunk[];
}

// ------------------------------------------------------------------ HITL actions
export const ReviewActionSchema = z.object({
  review_item_id: z.string(),
  action: z.enum(["accept", "edit", "reject", "unresolved", "remap"]),
  value: z.union([z.number(), z.string()]).nullable().optional().describe("For edit: corrected value (normalized INR/unit price for prices; YYYY-MM-DD for validity). For remap: target RFx line ID"),
  note: z.string().max(2000).nullable().optional(),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
