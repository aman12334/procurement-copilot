/** POST /api/analyst – Sourcing Analyst. Body: { question, history, bids }. Bids are recomputed server-side. */
import { z } from "zod";
import { askAnalyst } from "@/lib/analyst/agent";
import { BidEnvelopeSchema, EventPayloadSchema, badRequest, clientOrError, rehydrate, resolveContext, statusFor } from "@/lib/server/bids";
import { DecisionStateSchema, emptyDecision } from "@/lib/scenarios/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  event: EventPayloadSchema,
  question: z.string().trim().min(3).max(2000),
  history: z.array(z.object({ question: z.string(), resolved_question: z.string(), answer_summary: z.string(), scenario_ids: z.array(z.string()).optional() })).max(20).default([]),
  bids: z.array(BidEnvelopeSchema).max(20),
  decision: DecisionStateSchema.optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const bids = parsed.data.bids.map((b) => rehydrate(b, ctx));
  const c = clientOrError();
  if ("error" in c) return c.error;
  const r = await askAnalyst(c.client, ctx, bids, parsed.data.question, parsed.data.history, parsed.data.decision ?? emptyDecision());
  return Response.json(r, { status: r.ok ? 200 : statusFor(r.error.code) });
}
