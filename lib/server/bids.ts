/** Server helpers shared by the Stage 3 routes. */
import "server-only";
import { z } from "zod";
import { AIConfigError, describeAIConfig, getLLMSettings } from "@/lib/ai/model";
import { createLLMClient, type LLMClient } from "@/lib/ai/client";
import { recompute } from "@/lib/bids/hitl";
import { ExtractionSchema, ReviewActionSchema, type CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext, type EventContext, type InvitedVendor } from "@/lib/event/context";
import { contextFromReleased, ReleasedEventSchema, type ReleasedEvent } from "@/lib/event/released";
import { log } from "@/lib/log";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The parts of a bid the server trusts: the model extraction and the human decisions. Everything else is recomputed. */
export const BidEnvelopeSchema = z.object({
  schema_version: z.literal("bid.v1"),
  vendor: z.object({ vendor_id: z.string(), vendor_name: z.string(), vendor_no: z.number().nullable() }),
  response_metadata: z.object({
    source_type: z.enum(["xlsx", "pdf", "docx", "image", "email"]),
    source_files: z.array(z.string()),
    processed_at: z.string(),
    model: z.string(),
  }).passthrough(),
  extraction: ExtractionSchema,
  overrides: z.record(z.string(), ReviewActionSchema.extend({ at: z.string() })),
  audit_log: z.array(z.any()),
  trace: z.array(z.any()),
  chunks: z.array(z.object({
    chunk_id: z.string(), vendor_id: z.string(), source_file: z.string(), location: z.string(),
    page: z.number().nullable(), kind: z.enum(["document", "transcription", "term", "questionnaire", "quote"]), text: z.string(),
  })),
  finalized_at: z.string().nullable(),
}).passthrough();

export function rehydrate(envelope: z.infer<typeof BidEnvelopeSchema>, ctx: EventContext): CanonicalBid {
  return recompute(envelope as unknown as CanonicalBid, ctx);
}

/** Optional released-RFx payload accepted by every Stage 3/4 route. */
export const EventPayloadSchema = ReleasedEventSchema.optional();

/** The event every downstream step evaluates against: the released RFx if provided, else the Stage 1 demo event. */
export async function resolveContext(event?: ReleasedEvent): Promise<EventContext> {
  const defaults = await loadEventContext();
  return event ? contextFromReleased(event, defaults) : defaults;
}

export function findVendor(ctx: EventContext, id: string): InvitedVendor | undefined {
  return ctx.vendors.find((v) => v.vendor_id === id);
}

export function clientOrError(): { client: LLMClient } | { error: Response } {
  try {
    const st = getLLMSettings();
    log("info", "ai.config", { ai: describeAIConfig(st.primary), fallback: st.fallback_status });
    return { client: createLLMClient(undefined, { settings: st }) };
  } catch (e) {
    if (e instanceof AIConfigError)
      return { error: Response.json({ ok: false, error: { code: e.code, message: e.message, details: [] } }, { status: 503 }) };
    throw e;
  }
}

export function badRequest(message: string, details: string[] = []) {
  return Response.json({ ok: false, error: { code: "BAD_REQUEST", message, details } }, { status: 400 });
}

export function statusFor(code: string) {
  return code === "MODEL_UNAVAILABLE" || code === "AI_CONFIG_MISSING" ? 503 : code === "MODEL_CALL_FAILED" ? 502 : code === "NO_BIDS" || code === "BAD_REQUEST" || code === "INGEST_FAILED" ? 400 : 422;
}
