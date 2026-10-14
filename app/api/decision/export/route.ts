/** POST /api/decision/export – award recommendation as JSON or PDF. Body: { bids, decision, format: "json" | "pdf" } */
import { z } from "zod";
import { buildAwardSummary, renderAwardPdf } from "@/lib/scenarios/export";
import { recommend } from "@/lib/scenarios/recommend";
import { runAll } from "@/lib/scenarios/standard";
import { DecisionStateSchema } from "@/lib/scenarios/types";
import { BidEnvelopeSchema, EventPayloadSchema, badRequest, rehydrate, resolveContext } from "@/lib/server/bids";

export const runtime = "nodejs";

const Body = z.object({
  event: EventPayloadSchema, bids: z.array(BidEnvelopeSchema).max(20), decision: DecisionStateSchema, format: z.enum(["json", "pdf"]) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const bids = parsed.data.bids.map((b) => rehydrate(b, ctx));
  const d = parsed.data.decision;
  const { scenarios } = runAll(ctx, bids, d.custom_scenarios, d.include_unfinalized);
  const summary = buildAwardSummary(ctx, bids, scenarios, recommend(ctx, bids, scenarios, d.include_unfinalized), d);
  const name = `award_recommendation_${ctx.rfx_id.replace(/[^\w]+/g, "_")}`;
  if (parsed.data.format === "json")
    return new Response(JSON.stringify(summary, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}.json"` } });
  const pdf = await renderAwardPdf(summary);
  return new Response(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"` } });
}
