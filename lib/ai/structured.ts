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
  opts: { label: string; system: string; prompt: string; schema: z.ZodType<T>; attachments?: Attachment[] },
): Promise<StructuredOutcome<T>> {
  const { label, system, prompt, schema, attachments } = opts;
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
