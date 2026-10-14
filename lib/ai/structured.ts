/**
 * Shared "structured call": one model call validated against a Zod schema, with exactly one
 * corrective retry on schema failure (never a loop). Used by the RFx, bid-processing and analyst agents.
 */
import type { z } from "zod";
import type { Attachment, LLMClient } from "@/lib/ai/client";
import { log, truncate } from "@/lib/log";
import { formatZodIssues } from "@/lib/rfx/validate";
import { toModelJsonSchema } from "@/lib/rfx/schema";

export const MAX_ATTEMPTS = 2; // first call + exactly one corrective retry

export type StructuredErrorCode = "SCHEMA_VALIDATION_FAILED" | "MODEL_CALL_FAILED" | "MODEL_UNAVAILABLE";

export type StructuredOutcome<T> =
  | { ok: true; data: T; attempts: number; raw?: string }
  | { ok: false; code: StructuredErrorCode; message: string; details: string[]; attempts: number };

export function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (e) {
    return { ok: false, error: `Output is not valid JSON: ${(e as Error).message}` };
  }
}

export async function runStructuredCall<T>(
  client: LLMClient,
  opts: { label: string; system: string; prompt: string; schema: z.ZodType<T>; attachments?: Attachment[];
    /** Top-level keys set to this value when the model omits them (only for genuinely optional content, e.g. charts: []). */
    defaults?: Record<string, unknown> },
): Promise<StructuredOutcome<T>> {
  const { label, system, prompt, schema, attachments, defaults } = opts;
  const jsonSchema = toModelJsonSchema(schema);
  let currentPrompt = prompt;
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await client.generateJson({ system, prompt: currentPrompt, jsonSchema, attachments });
    } catch (e) {
      const message = (e as Error).message;
      const unavailable = (e as { code?: string }).code === "MODEL_UNAVAILABLE";
      const kind = (e as { kind?: string }).kind;
      log("error", "llm.call_failed", { label, model: client.model, attempt, unavailable, kind, message });
      return unavailable
        ? { ok: false, code: "MODEL_UNAVAILABLE", message, details: kind ? [`kind:${kind}`] : [], attempts: attempt }
        : { ok: false, code: "MODEL_CALL_FAILED", message: `Model call failed: ${message}`, details: [], attempts: attempt };
    }
    log("debug", "llm.raw_response", { label, model: client.model, attempt, raw: truncate(raw) });
    const parsed = parseJson(raw);
    if (parsed.ok) {
      const filled = fillOmittedNulls(parsed.value, jsonSchema);
      if (defaults && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value))
        for (const [k, v] of Object.entries(defaults)) if (!(k in parsed.value)) { (parsed.value as Record<string, unknown>)[k] = structuredClone(v); filled.push(k); }
      if (filled.length) log("info", "llm.omitted_nullable_filled", { label, model: client.model, attempt, count: filled.length, fields: filled.slice(0, 20) });
      const r = schema.safeParse(parsed.value);
      if (r.success) {
        log("info", "llm.schema_valid", { label, model: client.model, attempt });
        return { ok: true, data: r.data, attempts: attempt, raw };
      }
      lastErrors = formatZodIssues(r.error.issues);
    } else {
      lastErrors = [parsed.error];
    }
    log("warn", "llm.schema_invalid", { label, model: client.model, attempt, errors: lastErrors, raw: truncate(raw, 1500) });
    if (attempt < MAX_ATTEMPTS) {
      log("info", "llm.retry", { label, model: client.model, nextAttempt: attempt + 1 });
      currentPrompt = `${prompt}

Your previous response failed schema validation with these violations:
${lastErrors.map((e) => `- ${e}`).join("\n")}

Return the complete corrected JSON object only, fixing every violation.`;
    }
  }
  return {
    ok: false, code: "SCHEMA_VALIDATION_FAILED",
    message: `The model output did not match the required schema after ${MAX_ATTEMPTS} attempts.`,
    details: lastErrors, attempts: MAX_ATTEMPTS,
  };
}

type JsonSchema = Record<string, unknown>;

/**
 * Some providers (OpenAI with non-strict json_schema) omit nullable keys they have no value for instead of
 * sending null. A missing required-but-nullable key means "unknown", so it is set to null before validation.
 * Nothing else is added or changed: non-nullable missing keys still fail validation. Mutates `value`;
 * returns the filled paths for logging.
 */
export function fillOmittedNulls(value: unknown, schema: JsonSchema, root: JsonSchema = schema, path = ""): string[] {
  const s = deref(schema, root);
  const filled: string[] = [];
  if (Array.isArray(value)) {
    const items = s.items as JsonSchema | undefined;
    if (items) value.forEach((v, i) => filled.push(...fillOmittedNulls(v, items, root, `${path}.${i}`)));
    return filled;
  }
  if (!value || typeof value !== "object") return filled;
  const branch = objectBranch(s, root);
  if (!branch) return filled;
  const props = (branch.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((branch.required as string[] | undefined) ?? []);
  const obj = value as Record<string, unknown>;
  for (const [k, ps] of Object.entries(props)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in obj)) { if (required.has(k) && isNullable(ps, root)) { obj[k] = null; filled.push(p); } continue; }
    filled.push(...fillOmittedNulls(obj[k], ps, root, p));
  }
  return filled;
}

function deref(s: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = s?.$ref;
  if (typeof ref !== "string") return s ?? {};
  const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>;
  return defs[ref.split("/").pop()!] ?? {};
}

const variants = (s: JsonSchema) => [...((s.anyOf as JsonSchema[]) ?? []), ...((s.oneOf as JsonSchema[]) ?? [])];

function objectBranch(s: JsonSchema, root: JsonSchema): JsonSchema | null {
  if (s.properties) return s;
  for (const v of variants(s)) { const b = objectBranch(deref(v, root), root); if (b) return b; }
  return null;
}

function isNullable(s: JsonSchema, root: JsonSchema): boolean {
  const d = deref(s, root);
  if (d.type === "null" || (Array.isArray(d.type) && d.type.includes("null"))) return true;
  if (Array.isArray(d.enum) && d.enum.includes(null)) return true;
  return variants(d).some((v) => isNullable(v, root));
}
