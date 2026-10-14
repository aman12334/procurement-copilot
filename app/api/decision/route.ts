/**
 * POST /api/decision – deterministic scenarios, recommendation and sensitivity for the current bids.
 * Body: { bids, decision }  (stateless: scenarios are stored as constraints and recomputed here)
 */
import { z } from "zod";
import { recommend } from "@/lib/scenarios/recommend";
import { runSensitivity, standardWhatIfs } from "@/lib/scenarios/sensitivity";
import { runAll } from "@/lib/scenarios/standard";
import { DecisionStateSchema } from "@/lib/scenarios/types";
import { BidEnvelopeSchema, EventPayloadSchema, badRequest, rehydrate, resolveContext } from "@/lib/server/bids";

export const runtime = "nodejs";

const Body = z.object({
  event: EventPayloadSchema, bids: z.array(BidEnvelopeSchema).max(20), decision: DecisionStateSchema });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const bids = parsed.data.bids.map((b) => rehydrate(b, ctx));
  const d = parsed.data.decision;
  const { scenarios } = runAll(ctx, bids, d.custom_scenarios, d.include_unfinalized);
  const recommendation = recommend(ctx, bids, scenarios, d.include_unfinalized);
  const sensitivity = recommendation.recommended_scenario_id
    ? runSensitivity(ctx, bids, d.custom_scenarios, d.include_unfinalized, standardWhatIfs(scenarios, recommendation, bids, ctx), { scenarios, rec: recommendation })
    : [];
  return Response.json({
    ok: true, scenarios, recommendation, sensitivity,
    finalized_bids: bids.filter((b) => b.review_state === "finalized").length, total_bids: bids.length,
  });
}
