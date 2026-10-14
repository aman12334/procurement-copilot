/** Hand-built model extractions for deterministic tests (no live model calls). */
import type { Evidence, ExtractedQuote, Extraction, TermStatement } from "@/lib/bids/schema";

export const ev = (text: string, location = "row", page: number | null = null, file = "quote.pdf"): Evidence => ({ source_file: file, location, page, source_text: text });

export function quote(rfx_line_id: string | null, raw_price: number | null, uom_text = "per piece", o: Partial<ExtractedQuote> = {}): ExtractedQuote {
  return {
    rfx_line_id, mapping_basis: "explicit_code", alternative_rfx_line_ids: [], vendor_item_code: rfx_line_id, vendor_description: `item ${rfx_line_id}`,
    vendor_dimensions: null, raw_price, price_adjustments: [], raw_price_text: raw_price === null ? "" : String(raw_price), currency: "INR", uom_text,
    price_basis: "stated", freight_amount: null, moq: null, moq_text: null, lead_time_days: null, lead_time_text: null, remarks: null,
    spec_deviation: null, ambiguity: null, alternative_values: [], evidence: ev(`${rfx_line_id} ${raw_price}`, `row ${rfx_line_id}`), ...o,
  };
}

export function term(topic: TermStatement["topic"], statement: string, o: Partial<TermStatement> = {}): TermStatement {
  return {
    topic, statement, applies_to: null, freight_included: null, freight_basis: null, freight_plants: [], payment_days: null,
    validity_days: null, validity_until: null, percentage: null, amount: null, is_conditional: false, condition: null, is_quantified: true,
    evidence: ev(statement, "terms", 2), ...o,
  };
}

export function extraction(o: Partial<Extraction> = {}): Extraction {
  return {
    vendor_name: "Test Vendor", quote_reference: "Q-1", quote_date: "2026-10-09", document_overview: "test", transcription: null,
    quotes: [], declined_lines: [], terms: [term("freight", "Freight included to all plants", { freight_basis: "included", freight_included: true })],
    questionnaire_answers: [], ...o,
  };
}

export const allFullAnswers = (qids: string[]) => qids.map((qid) => ({
  qid, answer_text: `answer ${qid}`, compliance: "full" as const, plants_within_350km: qid === "Q09" ? 3 : null, rationale: "meets", evidence: ev(`answer ${qid}`, `Q ${qid}`),
}));
