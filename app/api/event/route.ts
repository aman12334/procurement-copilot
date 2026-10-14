/** GET /api/event – the sourcing event as the UI needs it (RFx lines, questionnaire, invited vendors, evaluation config). */
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { badRequest, EventPayloadSchema, resolveContext } from "@/lib/server/bids";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(summary(await loadEventContext()));
}

/** POST { event? } – the event as resolved from a released RFx (or the default demo event). */
export async function POST(req: Request) {
  const parsed = z.object({ event: EventPayloadSchema }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid released event.", parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`));
  return Response.json(summary(await resolveContext(parsed.data.event)));
}

function summary(ctx: EventContext) {
  return {
    source: ctx.source ?? "stage1_default", released_at: ctx.released_at ?? null,
    rfx_id: ctx.rfx_id, title: ctx.title, buyer_name: ctx.buyer_name, response_due_date: ctx.response_due_date,
    plants: ctx.plants, lines: ctx.lines, questions: ctx.questions.map(({ qid, topic, mandatory, max_points }) => ({ qid, topic, mandatory, max_points })),
    qualification: ctx.qualification, evaluation: ctx.evaluation,
    vendors: ctx.vendors.map((v) => ({ vendor_id: v.vendor_id, vendor_no: v.vendor_no, vendor_name: v.vendor_name, contact_email: v.contact_email, response_token: v.response_token ?? null,
      response_files: v.response_files.map((f) => f.split("/").pop()), alternate_files: (v.alternate_files ?? []).map((f) => f.split("/").pop()) })),
  };
}
