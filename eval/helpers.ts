/** Eval-only helpers (may read eval/results). */
import { readFileSync, readdirSync } from "node:fs";
import { applyReviewAction, finalizeBid, recompute } from "@/lib/bids/hitl";
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";

/** Processed Stage 1 bids after a simulated buyer review (accept every open item) and finalization. */
export function loadReviewedBids(ctx: EventContext, dir = "eval/results/bids"): CanonicalBid[] {
  return readdirSync(dir).filter((f) => /^VND-\d+\.json$/.test(f)).map((f) => {
    let b = recompute(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")), ctx);
    for (let i = 0; i < 30 && b.exceptions.some((e) => e.status === "open"); i++)
      b = applyReviewAction(b, { review_item_id: b.exceptions.find((e) => e.status === "open")!.id, action: "accept", note: "eval: simulated buyer review" }, ctx);
    return finalizeBid(b, ctx);
  });
}
