/**
 * Thin deterministic business validation that runs after Zod schema validation.
 * Returns issues; it never mutates the draft. "error" = must be fixed before the RFx
 * is issued; "warning" = buyer should review.
 */
import {
  COMMERCIAL_TERM_KEYS,
  RfxDraftSchema,
  type RfxDraft,
  type SourcedValue,
} from "./schema";

export type IssueSeverity = "error" | "warning";
export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  path: string;
  message: string;
}

export interface SchemaResult {
  ok: boolean;
  data?: RfxDraft;
  errors: string[];
}

/** Zod validation with readable, path-prefixed error strings (also fed back to the model on retry). */
export function validateSchema(input: unknown): SchemaResult {
  const r = RfxDraftSchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data, errors: [] };
  return { ok: false, errors: formatZodIssues(r.error.issues) };
}

export function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.slice(0, 40).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function isUnresolved(rfx: RfxDraft, path: string): boolean {
  return rfx.unresolved_fields.some(
    (u) => u.field === path || path.startsWith(u.field + ".") || u.field.startsWith(path + "."),
  );
}

function hasAssumption(rfx: RfxDraft, path: string): boolean {
  return rfx.assumptions.some((a) => a.field === path || a.field.startsWith(path) || path.startsWith(a.field));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

export function validateBusinessRules(rfx: RfxDraft, today: Date = new Date()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (severity: IssueSeverity, code: string, path: string, message: string) =>
    issues.push({ severity, code, path, message });

  // ---- line items
  for (const d of duplicates(rfx.line_items.map((l) => l.line_id.trim())))
    add("error", "DUPLICATE_LINE_ID", "line_items", `Line ID "${d}" is used more than once.`);
  for (const d of duplicates(rfx.line_items.map((l) => l.sku?.trim()).filter((s): s is string => !!s)))
    add("error", "DUPLICATE_SKU", "line_items", `SKU "${d}" is used more than once.`);
  const locCodes = new Set(rfx.buyer.locations.map((l) => l.code.trim().toUpperCase()));
  rfx.line_items.forEach((l, i) => {
    const p = `line_items[${i}]`;
    if (!l.line_id.trim()) add("error", "EMPTY_LINE_ID", p, "Line ID is empty.");
    if (l.annual_qty !== null && !(l.annual_qty > 0))
      add("error", "NON_POSITIVE_QTY", `${p}.annual_qty`, `Line ${l.line_id}: annual quantity must be positive.`);
    if (l.annual_qty === null && !isUnresolved(rfx, "line_items"))
      add("warning", "MISSING_QTY", `${p}.annual_qty`, `Line ${l.line_id}: annual quantity missing and not listed as unresolved.`);
    if (l.delivery_plant && locCodes.size && !locCodes.has(l.delivery_plant.trim().toUpperCase()))
      add("warning", "UNKNOWN_DELIVERY_PLANT", `${p}.delivery_plant`, `Line ${l.line_id}: delivery plant "${l.delivery_plant}" is not a buyer location code.`);
  });
  if (rfx.line_items.length === 0 && !isUnresolved(rfx, "line_items"))
    add("error", "NO_LINE_ITEMS", "line_items", "No line items and line items are not listed as unresolved.");
  if (rfx.scope.line_count && rfx.line_items.length < rfx.scope.line_count && !isUnresolved(rfx, "line_items"))
    add("warning", "INCOMPLETE_LINES", "line_items",
      `Scope states ${rfx.scope.line_count} lines but only ${rfx.line_items.length} are defined; add them or list line_items as unresolved.`);
  const qtySum = rfx.line_items.reduce((s, l) => s + (l.annual_qty ?? 0), 0);
  if (rfx.scope.annual_volume && rfx.scope.line_count && rfx.line_items.length === rfx.scope.line_count &&
      rfx.line_items.every((l) => l.annual_qty !== null) &&
      Math.abs(qtySum - rfx.scope.annual_volume) / rfx.scope.annual_volume > 0.05)
    add("warning", "VOLUME_MISMATCH", "scope.annual_volume",
      `Line quantities sum to ${qtySum.toLocaleString("en-IN")}, scope states ${rfx.scope.annual_volume.toLocaleString("en-IN")}.`);
  if (rfx.scope.annual_volume !== null && rfx.scope.annual_volume <= 0)
    add("error", "NON_POSITIVE_VOLUME", "scope.annual_volume", "Annual volume must be positive.");

  // ---- evaluation criteria
  const wsum = rfx.evaluation_criteria.reduce((s, c) => s + c.weight, 0);
  if (rfx.evaluation_criteria.length === 0)
    add("error", "NO_EVALUATION_CRITERIA", "evaluation_criteria", "No evaluation criteria defined.");
  else if (Math.abs(wsum - 100) > 0.01)
    add("error", "WEIGHTS_NOT_100", "evaluation_criteria", `Evaluation weights sum to ${wsum}, not 100.`);
  rfx.evaluation_criteria.forEach((c, i) => {
    if (c.weight < 0) add("error", "NEGATIVE_WEIGHT", `evaluation_criteria[${i}].weight`, `"${c.name}" has a negative weight.`);
  });
  for (const d of duplicates(rfx.evaluation_criteria.map((c) => c.criterion_id)))
    add("error", "DUPLICATE_CRITERION_ID", "evaluation_criteria", `Criterion ID "${d}" is duplicated.`);

  // ---- questionnaire
  for (const d of duplicates(rfx.technical_questionnaire.map((q) => q.qid.trim())))
    add("error", "DUPLICATE_QID", "technical_questionnaire", `Question ID "${d}" is used more than once.`);
  if (rfx.technical_questionnaire.length === 0)
    add("warning", "NO_QUESTIONNAIRE", "technical_questionnaire", "Technical questionnaire is empty.");
  const psum = rfx.technical_questionnaire.reduce((s, q) => s + q.max_points, 0);
  if (rfx.technical_questionnaire.length && Math.abs(psum - 100) > 0.01)
    add("warning", "QUESTION_POINTS_NOT_100", "technical_questionnaire", `Questionnaire points sum to ${psum}, expected 100.`);
  if (rfx.technical_questionnaire.length && !rfx.technical_questionnaire.some((q) => q.mandatory))
    add("warning", "NO_MANDATORY_QUESTIONS", "technical_questionnaire", "No questionnaire item is marked mandatory.");

  // ---- requirements
  if (rfx.mandatory_requirements.length === 0)
    add("error", "NO_MANDATORY_REQUIREMENTS", "mandatory_requirements", "No mandatory requirements are identified.");
  rfx.mandatory_requirements.forEach((r, i) => {
    if (r.type !== "mandatory")
      add("error", "TYPE_MISMATCH", `mandatory_requirements[${i}]`, `"${r.id}" is in mandatory list but typed "${r.type}".`);
  });
  rfx.preferred_requirements.forEach((r, i) => {
    if (r.type === "mandatory")
      add("error", "TYPE_MISMATCH", `preferred_requirements[${i}]`, `"${r.id}" is in preferred list but typed "mandatory".`);
  });
  const all = [...rfx.mandatory_requirements, ...rfx.preferred_requirements];
  for (const d of duplicates(all.map((r) => r.id.trim())))
    add("error", "DUPLICATE_REQUIREMENT_ID", "requirements", `Requirement ID "${d}" is used more than once.`);
  const mandText = new Set(rfx.mandatory_requirements.map((r) => norm(r.requirement)));
  for (const r of rfx.preferred_requirements)
    if (mandText.has(norm(r.requirement)))
      add("error", "CONTRADICTORY_REQUIREMENT", "requirements", `"${r.requirement}" is listed as both mandatory and preferred.`);

  // ---- buyer / locations
  if (rfx.buyer.locations.length === 0 && !isUnresolved(rfx, "buyer.locations"))
    add("error", "NO_LOCATIONS", "buyer.locations", "No delivery locations and not listed as unresolved.");
  rfx.buyer.locations.forEach((l, i) => {
    if (!l.code.trim() || !l.name.trim())
      add("error", "EMPTY_LOCATION", `buyer.locations[${i}]`, "Location code and name must be non-empty.");
  });
  for (const d of duplicates(rfx.buyer.locations.map((l) => l.code.trim().toUpperCase())))
    add("error", "DUPLICATE_LOCATION", "buyer.locations", `Location code "${d}" is duplicated.`);

  // ---- currency / deadline
  if (!rfx.scope.currency.trim()) add("error", "NO_CURRENCY", "scope.currency", "Currency is missing.");
  if (!rfx.commercial_terms.currency.value && !isUnresolved(rfx, "commercial_terms.currency"))
    add("error", "NO_CURRENCY", "commercial_terms.currency", "Commercial currency is missing.");
  if (!rfx.response_deadline) {
    if (!isUnresolved(rfx, "response_deadline"))
      add("error", "NO_DEADLINE", "response_deadline", "Response deadline is missing and not listed as unresolved.");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(rfx.response_deadline) || isNaN(Date.parse(rfx.response_deadline))) {
    add("warning", "DEADLINE_FORMAT", "response_deadline", `Response deadline "${rfx.response_deadline}" is not an ISO date (YYYY-MM-DD).`);
  } else if (rfx.response_deadline < today.toISOString().slice(0, 10)) {
    add("warning", "DEADLINE_IN_PAST", "response_deadline", `Response deadline ${rfx.response_deadline} is in the past.`);
  }

  // ---- sourced values: nothing silently omitted, assumptions visible
  const sourced: [string, SourcedValue][] = [
    ...COMMERCIAL_TERM_KEYS.map((k) => [`commercial_terms.${k}`, rfx.commercial_terms[k]] as [string, SourcedValue]),
    ...(["lead_time", "delivery_terms", "delivery_schedule", "packaging_and_palletisation", "service_level"] as const).map(
      (k) => [`delivery_requirements.${k}`, rfx.delivery_requirements[k]] as [string, SourcedValue]),
  ];
  for (const [path, sv] of sourced) {
    const empty = sv.value === null || sv.value.trim() === "";
    if (empty && sv.source !== "unresolved")
      add("error", "SILENT_OMISSION", path, `${path} is empty but marked "${sv.source}" – mark it unresolved or provide a value.`);
    if ((empty || sv.source === "unresolved") && !isUnresolved(rfx, path))
      add("error", "UNRESOLVED_NOT_LISTED", path, `${path} is unresolved but not listed in unresolved_fields.`);
    if (sv.source === "generated_assumption" && !hasAssumption(rfx, path))
      add("warning", "ASSUMPTION_NOT_LISTED", path, `${path} is a generated assumption but has no entry in assumptions.`);
  }
  const lt = rfx.delivery_requirements;
  if (lt.lead_time_days !== null && lt.lead_time_days <= 0)
    add("error", "NON_POSITIVE_LEAD_TIME", "delivery_requirements.lead_time_days", "Lead time must be positive.");
  if (lt.lead_time_days === null && lt.lead_time.value && lt.lead_time.source !== "unresolved")
    add("warning", "LEAD_TIME_NOT_NUMERIC", "delivery_requirements.lead_time_days", "Lead time is described but lead_time_days is not set.");

  return issues;
}

export function validateDraft(input: unknown): { schema: SchemaResult; issues: ValidationIssue[] } {
  const schema = validateSchema(input);
  return { schema, issues: schema.ok && schema.data ? validateBusinessRules(schema.data) : [] };
}
