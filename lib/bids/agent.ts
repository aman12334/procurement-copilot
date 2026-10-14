/**
 * Bid Processing Agent: one controlled, observable workflow with internal steps
 *   INGEST → EXTRACT (+ MATCH + INTERPRET, model) → NORMALIZE → VALIDATE → EXCEPTIONS (code) → canonical bid
 * The trace records execution events (not chain-of-thought).
 */
import { providerSwitches, type LLMClient } from "@/lib/ai/client";
import { BID_EXTRACTION_SYSTEM_PROMPT, BID_PROMPT_VERSION, buildExtractionPrompt } from "@/lib/ai/prompts/bid-extraction";
import { runStructuredCall, type StructuredErrorCode } from "@/lib/ai/structured";
import type { EventContext } from "@/lib/event/context";
import { log } from "@/lib/log";
import { computeCanonicalBid } from "./compute";
import { ingestFile, type InputFile, type IngestedDocument } from "./ingest";
import { ExtractionSchema, type CanonicalBid, type TraceEvent } from "./schema";

export type ProcessResult =
  | { ok: true; bid: CanonicalBid; attempts: number }
  | { ok: false; error: { code: StructuredErrorCode | "INGEST_FAILED"; message: string; details: string[] }; trace: TraceEvent[] };

export async function processVendorResponse(
  client: LLMClient,
  ctx: EventContext,
  vendor: { vendor_id: string; vendor_name: string; vendor_no: number | null },
  files: InputFile[],
  now: () => Date = () => new Date(),
): Promise<ProcessResult> {
  const trace: TraceEvent[] = [];
  const ev = (step: TraceEvent["step"], message: string) => {
    trace.push({ at: now().toISOString(), step, message });
    log("info", "bid.trace", { vendor: vendor.vendor_id, step, message });
  };

  // INGEST
  let docs: IngestedDocument[];
  try {
    docs = await Promise.all(files.map(ingestFile));
  } catch (e) {
    ev("ingest", `Ingest failed: ${(e as Error).message}`);
    return { ok: false, error: { code: "INGEST_FAILED", message: (e as Error).message, details: [] }, trace };
  }
  for (const d of docs) ev("ingest", `Parsed ${d.source_file} as ${d.source_type} (${Object.entries(d.stats).map(([k, v]) => `${k} ${v}`).join(", ")}); ${d.chunks.length} evidence chunks`);

  // EXTRACT + MATCH + INTERPRET (model)
  ev("extract", `Sending ${docs.length} document(s) to ${client.model} with ${ctx.lines.length} RFx lines and ${ctx.questions.length} questions (${BID_PROMPT_VERSION})`);
  const out = await runStructuredCall(client, {
    label: `bid:${vendor.vendor_id}`,
    system: BID_EXTRACTION_SYSTEM_PROMPT,
    prompt: buildExtractionPrompt(ctx, vendor, docs),
    schema: ExtractionSchema,
    attachments: docs.flatMap((d) => d.attachments),
  });
  if (!out.ok) {
    ev("extract", `Extraction failed after ${out.attempts} attempt(s): ${out.message}`);
    return { ok: false, error: { code: out.code, message: out.message, details: out.details }, trace };
  }
  const ex = out.data;
  for (const sw of providerSwitches(client)) ev("extract", `Provider switch recorded: ${sw.from} → ${sw.to} (${sw.kind}): ${sw.reason.slice(0, 160)}`);
  ev("extract", `Extraction valid on attempt ${out.attempts}: ${ex.quotes.length} candidate price rows, ${ex.terms.length} term statements, ${ex.questionnaire_answers.length} questionnaire answers, ${ex.declined_lines.length} decline statements`);
  const byBasis = ex.quotes.reduce<Record<string, number>>((m, q) => ((m[q.mapping_basis] = (m[q.mapping_basis] ?? 0) + 1), m), {});
  ev("match", `Mapping basis: ${Object.entries(byBasis).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${ex.quotes.filter((q) => q.alternative_rfx_line_ids.length).length} with alternative candidates`);
  ev("interpret", `Terms by topic: ${[...new Set(ex.terms.map((t) => t.topic))].map((t) => `${t} ${ex.terms.filter((x) => x.topic === t).length}`).join(", ")}`);

  // NORMALIZE + VALIDATE + EXCEPTIONS (code)
  const bid = computeCanonicalBid({
    ctx, vendor, extraction: ex, source_type: docs[0].source_type, source_files: docs.map((d) => d.source_file),
    model: client.model, processed_at: now().toISOString(), trace, doc_chunks: docs.flatMap((d) => d.chunks),
  });
  const s = bid.processing_summary;
  ev("normalize", `${s.quoted_lines} RFx lines quoted; ${bid.line_items.filter((l) => l.normalized_unit_price_inr !== null).length} normalized to INR/unit; ${s.blocked_items} blocked`);
  ev("validate", `${s.missing_lines} missing (${s.declined_lines} explicitly declined), ${s.duplicate_lines} duplicated, ${s.unmatched_rows} unmatched rows, ${s.ambiguous_matches} ambiguous matches`);
  const byReason = bid.exceptions.reduce<Record<string, number>>((m, i) => ((m[i.reason] = (m[i.reason] ?? 0) + 1), m), {});
  ev("exceptions", `${s.review_items} review item(s): ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; technical ${s.technical_score}/${s.technical_max} → ${s.qualification_status}`);
  bid.trace = trace;
  return { ok: true, bid, attempts: out.attempts };
}
