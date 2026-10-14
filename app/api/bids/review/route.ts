/**
 * POST /api/bids/review – HITL decisions and finalization. Stateless: the client sends the bid, the server
 * re-validates the trusted parts, applies the decision and recomputes everything.
 * Body: { bid, action: { review_item_id, action: accept|edit|reject|unresolved, value?, note? } }
 *    or { bid, op: "finalize" | "reopen" | "recompute" }
 */
import { z } from "zod";
import { applyReviewAction, finalizeBid, reopenBid, ReviewError } from "@/lib/bids/hitl";
import { ReviewActionSchema } from "@/lib/bids/schema";
import { BidEnvelopeSchema, EventPayloadSchema, badRequest, rehydrate, resolveContext } from "@/lib/server/bids";

export const runtime = "nodejs";

const Body = z.object({
  event: EventPayloadSchema,
  bid: BidEnvelopeSchema,
  action: ReviewActionSchema.optional(),
  op: z.enum(["finalize", "reopen", "recompute"]).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const bid = rehydrate(parsed.data.bid, ctx);
  try {
    const next = parsed.data.action ? applyReviewAction(bid, parsed.data.action, ctx)
      : parsed.data.op === "finalize" ? finalizeBid(bid, ctx)
      : parsed.data.op === "reopen" ? reopenBid(bid, ctx) : bid;
    return Response.json({ ok: true, bid: next });
  } catch (e) {
    if (e instanceof ReviewError) return Response.json({ ok: false, error: { code: "REVIEW_REJECTED", message: e.message, details: [] } }, { status: 409 });
    throw e;
  }
}
