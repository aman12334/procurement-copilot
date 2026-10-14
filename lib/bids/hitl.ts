/**
 * HITL: a human decision is stored as an override (the model's extraction is never modified), then the
 * canonical bid is recomputed end-to-end so normalization, validation, outlier checks and the summary
 * all reflect the decision.
 */
import type { EventContext } from "@/lib/event/context";
import { computeCanonicalBid } from "./compute";
import type { CanonicalBid, ReviewAction, TraceEvent } from "./schema";

export class ReviewError extends Error {}

export function recompute(bid: CanonicalBid, ctx: EventContext, patch: Partial<Pick<CanonicalBid, "overrides" | "audit_log" | "trace" | "finalized_at">> = {}): CanonicalBid {
  return computeCanonicalBid({
    ctx,
    vendor: bid.vendor,
    extraction: bid.extraction,
    source_type: bid.response_metadata.source_type,
    source_files: bid.response_metadata.source_files,
    model: bid.response_metadata.model,
    processed_at: bid.response_metadata.processed_at,
    overrides: patch.overrides ?? bid.overrides,
    audit_log: patch.audit_log ?? bid.audit_log,
    trace: patch.trace ?? bid.trace,
    doc_chunks: bid.chunks.filter((c) => c.kind === "document"),
    finalized_at: patch.finalized_at !== undefined ? patch.finalized_at : bid.finalized_at,
  });
}

export function applyReviewAction(bid: CanonicalBid, action: ReviewAction, ctx: EventContext, now = new Date()): CanonicalBid {
  if (bid.review_state === "finalized") throw new ReviewError("This bid is finalized. Reopen it before changing review decisions.");
  const item = bid.exceptions.find((i) => i.id === action.review_item_id);
  if (!item) throw new ReviewError(`Unknown review item: ${action.review_item_id}`);
  if (action.action === "edit" && (action.value === undefined || action.value === null || action.value === ""))
    throw new ReviewError("An edit needs a corrected value.");
  if (action.action === "edit" && item.scope === "line" && typeof action.value !== "number")
    throw new ReviewError("Corrected prices must be numbers (normalized INR per unit).");
  if (action.action === "remap") {
    if (item.reason !== "unmatched_sku" && item.reason !== "ambiguous_match") throw new ReviewError("Only row-mapping review items (unmatched or ambiguous rows) can be re-mapped.");
    const target = typeof action.value === "string" ? action.value.trim().toUpperCase() : "";
    if (!ctx.lines.some((l) => l.line_id === target)) throw new ReviewError(`Unknown RFx line "${action.value ?? ""}". Choose a line from this event.`);
    action = { ...action, value: target };
  }
  const at = now.toISOString();
  const overrides = { ...bid.overrides, [item.id]: { ...action, at } };
  // Recompute once to obtain the resolution record exactly as the engine derives it, then log it.
  const next = recompute(bid, ctx, { overrides });
  const resolved = next.exceptions.find((i) => i.id === item.id)?.resolution;
  const trace: TraceEvent[] = [...bid.trace, {
    at, step: "hitl",
    message: `${action.action} on ${item.id}${action.action === "edit" || action.action === "remap" ? ` → ${action.value}` : ""}; open review items ${bid.processing_summary.open_review_items} → ${next.processing_summary.open_review_items}`,
  }];
  return recompute(bid, ctx, { overrides, audit_log: resolved ? [...bid.audit_log, resolved] : bid.audit_log, trace });
}

export function finalizeBid(bid: CanonicalBid, ctx: EventContext, now = new Date()): CanonicalBid {
  const open = bid.exceptions.filter((i) => i.status === "open");
  if (open.length) throw new ReviewError(`${open.length} review item(s) are still open. Accept, edit, reject or mark them unresolved first.`);
  const at = now.toISOString();
  return recompute(bid, ctx, { finalized_at: at, trace: [...bid.trace, { at, step: "finalize", message: "Bid finalized as trusted data" }] });
}

export function reopenBid(bid: CanonicalBid, ctx: EventContext, now = new Date()): CanonicalBid {
  const at = now.toISOString();
  return recompute(bid, ctx, { finalized_at: null, trace: [...bid.trace, { at, step: "hitl", message: "Bid reopened for review" }] });
}
