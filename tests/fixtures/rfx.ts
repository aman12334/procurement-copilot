/** Hand-written model outputs used by the tests (no live Gemini calls). */
import type { LineItem, Question, RfxDraft, SourcedValue } from "@/lib/rfx/schema";

const sv = (value: string | null, source: SourcedValue["source"], note: string | null = null): SourcedValue => ({ value, source, note });

const line = (id: string, desc: string, plant: string, ply: number, qty: number | null): LineItem => ({
  line_id: id, sku: null, item_description: desc, category: `${ply}-ply carton`, style: "RSC", ply, flute: ply === 3 ? "B" : "BC",
  dimensions_text: null, dimension_basis: null, board_construction: null, combined_board_gsm: null,
  min_bursting_factor_outer_liner: null, min_bursting_strength_kg_cm2: null, recycled_content_min_pct: 70,
  printing: "Plain", coating: null, annual_qty: qty, uom: "piece", delivery_plant: plant, end_use: null, notes: null,
  additional_specs: [], source: "generated_assumption",
});

const topics: [string, boolean, number][] = [
  ["ISO 9001", true, 12], ["FSC certification", false, 8], ["Recycled content", false, 8], ["Bursting strength testing", true, 10],
  ["Moisture resistance", false, 8], ["Traceability", true, 10], ["Production capacity", true, 10], ["Manufacturing locations", false, 8],
  ["Business continuity", false, 8], ["Complaint-resolution SLA", false, 6], ["Printing capability", false, 6], ["Sustainability", false, 6],
];
const questions: Question[] = topics.map(([topic, mandatory, pts], i) => ({
  qid: `Q${String(i + 1).padStart(2, "0")}`, topic, question: `Describe your ${topic.toLowerCase()}.`,
  answer_type: i === 0 ? "document_upload" : "text", mandatory, max_points: pts,
  scoring_rule: "Full points if fully compliant, half if partial, zero otherwise.", rationale: `Relevant to ${topic}.`,
  source: topic === "ISO 9001" || topic === "FSC certification" ? "explicit" : "generated_assumption",
}));

export function completeRfx(): RfxDraft {
  return {
    schema_version: "rfx.v1",
    rfx_id: "RFX-DRAFT-PKG",
    title: "Annual Rate Contract – Corrugated Packaging",
    category: "Corrugated packaging",
    buyer: {
      company: "Sahyadri Consumer Products",
      business_unit: null,
      locations: [
        { code: "BLR", name: "Bengaluru Plant", address: null, state: "Karnataka" },
        { code: "PNQ", name: "Pune Plant", address: null, state: "Maharashtra" },
        { code: "HYD", name: "Hyderabad Plant", address: null, state: "Telangana" },
      ],
    },
    scope: {
      description: "Corrugated packaging for three plants, 30 SKUs.", annual_volume: 7400000, annual_volume_uom: "units",
      line_count: 30, currency: "INR", contract_period: "12 months from 2026-12-01", partial_bids_allowed: true,
    },
    line_items: [
      line("CP-001", "3-ply RSC shipper – plain", "BLR", 3, null),
      line("CP-002", "5-ply RSC shipper – printed", "PNQ", 5, null),
      line("CP-003", "7-ply export carton", "HYD", 7, null),
    ],
    commercial_requirements: [
      { field: "unit_price", description: "Price per piece ex-GST", required: true },
      { field: "freight", description: "Freight per piece to each plant, quoted separately", required: true },
      { field: "moq", description: "Minimum order quantity", required: true },
    ],
    technical_questionnaire: questions,
    qualification: { min_total_score: 70, rule: "Score >= 70 and full compliance on all mandatory questions." },
    mandatory_requirements: [
      { id: "BR-01", area: "Certification", requirement: "ISO 9001:2015 certification of supplying plants.", type: "mandatory", source: "explicit" },
      { id: "BR-02", area: "Lead time", requirement: "Lead time below 14 days from PO.", type: "mandatory", source: "explicit" },
      { id: "BR-03", area: "Freight", requirement: "Freight quoted separately per plant.", type: "mandatory", source: "explicit" },
    ],
    preferred_requirements: [
      { id: "BR-04", area: "Certification", requirement: "FSC Chain-of-Custody certification.", type: "preferred", source: "explicit" },
    ],
    evaluation_criteria: [
      { criterion_id: "EC-1", name: "Commercial competitiveness", description: "Landed price", weight: 45, source: "generated_assumption" },
      { criterion_id: "EC-2", name: "Technical quality", description: "Questionnaire score", weight: 25, source: "generated_assumption" },
      { criterion_id: "EC-3", name: "Delivery capability", description: "Lead time and proximity", weight: 20, source: "generated_assumption" },
      { criterion_id: "EC-4", name: "Sustainability", description: "FSC, recycled content", weight: 10, source: "generated_assumption" },
    ],
    commercial_terms: {
      currency: sv("INR", "explicit"),
      price_basis: sv("Ex-works price per piece with freight quoted separately", "explicit"),
      freight_treatment: sv("Quoted separately per piece to each plant", "explicit"),
      taxes: sv("Exclusive of GST", "explicit"),
      payment_terms: sv("45 days from invoice", "generated_assumption"),
      price_validity: sv("90 days", "generated_assumption"),
      moq_expectation: sv("MOQ not to exceed one month's call-off", "generated_assumption"),
      tooling: sv("State plate/die costs separately", "generated_assumption"),
      rebates_discounts: sv("Volume rebates optional", "generated_assumption"),
      price_escalation: sv("Index-linked kraft paper clause if any", "generated_assumption"),
    },
    delivery_requirements: {
      lead_time_days: 14,
      lead_time: sv("Below 14 days from PO", "explicit"),
      delivery_terms: sv("Delivered to each plant", "inferred"),
      delivery_schedule: sv(null, "unresolved"),
      packaging_and_palletisation: sv("Palletised and stretch-wrapped", "generated_assumption"),
      service_level: sv("OTIF >= 95%", "generated_assumption"),
    },
    response_deadline: "2026-10-30",
    assumptions: [
      { id: "A-01", field: "commercial_terms.payment_terms", assumption: "45 days from invoice", rationale: "Common practice" },
      { id: "A-02", field: "commercial_terms.price_validity", assumption: "90 days", rationale: "Common practice" },
      { id: "A-03", field: "commercial_terms.moq_expectation", assumption: "<= monthly call-off", rationale: "Inventory" },
      { id: "A-04", field: "commercial_terms.tooling", assumption: "Separate", rationale: "TCO visibility" },
      { id: "A-05", field: "commercial_terms.rebates_discounts", assumption: "Optional", rationale: "Common" },
      { id: "A-06", field: "commercial_terms.price_escalation", assumption: "Index-linked", rationale: "Kraft volatility" },
      { id: "A-07", field: "delivery_requirements.packaging_and_palletisation", assumption: "Palletised", rationale: "Handling" },
      { id: "A-08", field: "delivery_requirements.service_level", assumption: "OTIF 95%", rationale: "Common" },
      { id: "A-09", field: "line_items", assumption: "Representative template lines", rationale: "SKU list not supplied" },
    ],
    unresolved_fields: [
      { field: "line_items", reason: "Only the SKU count was given", criticality: "high", suggested_question: "Please share the 30-SKU list." },
      { field: "delivery_requirements.delivery_schedule", reason: "Call-off frequency unknown", criticality: "medium", suggested_question: "Weekly or monthly call-offs?" },
    ],
  };
}

/** What a model might return for "I need some boxes": thin, honest about gaps. */
export function vagueRfx(): RfxDraft {
  const r = completeRfx();
  r.title = "Corrugated boxes – draft";
  r.buyer = { company: null, business_unit: null, locations: [] };
  r.scope = { ...r.scope, description: "Corrugated boxes", annual_volume: null, line_count: null, contract_period: null };
  r.line_items = [line("CB-001", "Corrugated box (type to be confirmed)", "", 3, null)];
  r.line_items[0].delivery_plant = null;
  r.mandatory_requirements = [{ id: "BR-01", area: "Quality", requirement: "Boxes must meet agreed specification.", type: "mandatory", source: "generated_assumption" }];
  r.preferred_requirements = [];
  r.response_deadline = null;
  r.commercial_terms.currency = { value: "INR", source: "generated_assumption", note: null };
  r.commercial_terms.freight_treatment = { value: null, source: "unresolved", note: null };
  r.delivery_requirements.lead_time_days = null;
  r.delivery_requirements.lead_time = { value: null, source: "unresolved", note: null };
  r.assumptions.push({ id: "A-10", field: "commercial_terms.currency", assumption: "INR", rationale: "Assumed Indian buyer" });
  r.unresolved_fields.push(
    { field: "buyer.locations", reason: "No delivery sites given", criticality: "high", suggested_question: "Which plants?" },
    { field: "response_deadline", reason: "No date given", criticality: "high", suggested_question: "When are responses due?" },
    { field: "commercial_terms.freight_treatment", reason: "Not stated", criticality: "medium", suggested_question: "Freight included or separate?" },
    { field: "delivery_requirements.lead_time", reason: "Not stated", criticality: "medium", suggested_question: "Required lead time?" },
  );
  return r;
}
