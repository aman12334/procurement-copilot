/**
 * POST /api/ingest – async vendor-response ingestion (stateless; the caller keeps job state).
 *   { action: "receive", message, prior_jobs? }  → new job (received → queued | needs_identity_review)
 *   { action: "resolve", job, resolution }       → identity HITL (confirm / select vendor / assign RFx / reject)
 *   { action: "submit", vendor_id, files? | upload? } → buyer loads/uploads a response for a known vendor → queued job
 *   { action: "process", job }                   → queued|retrying → processing → completed (+bid) | retrying | failed
 * Attachments may only reference registered vendor-facing fixture files or be inline uploads.
 */
import { z } from "zod";
import { readEventFile } from "@/lib/event/files";
import { detectSourceType } from "@/lib/bids/ingest";
import { hydrateMessage, JobError, receive, resolveIdentity, runJob, simulatedEmail, submitDirect, type IngestionJob } from "@/lib/ingestion/queue";
import { badRequest, clientOrError, EventPayloadSchema, findVendor, MAX_UPLOAD_BYTES, resolveContext } from "@/lib/server/bids";

export const runtime = "nodejs";
export const maxDuration = 300;

const Message = z.object({
  message_id: z.string().min(1).max(120), channel: z.enum(["email", "webhook", "simulated", "portal"]), received_at: z.string(),
  from: z.string().max(300), to: z.string().nullable().optional(), subject: z.string().max(500), body: z.string().max(100_000),
  thread_id: z.string().max(200).nullable().optional(), body_ref: z.string().nullable().optional(),
  attachments: z.array(z.object({ name: z.string().max(200), ref: z.string().optional(), data_base64: z.string().optional() })).max(5),
});
const Body = z.discriminatedUnion("action", [
  z.object({ event: EventPayloadSchema, action: z.literal("simulate"), vendor_id: z.string(), unknown_sender: z.boolean().optional(), file: z.string().optional(), prior_jobs: z.array(z.any()).max(100).optional() }),
  z.object({ event: EventPayloadSchema, action: z.literal("receive"), message: Message, prior_jobs: z.array(z.any()).max(100).optional() }),
  z.object({ event: EventPayloadSchema, action: z.literal("resolve"), job: z.any(), resolution: z.object({ type: z.enum(["confirm", "select_vendor", "assign_rfx", "reject"]), vendor_id: z.string().nullable().optional(), rfx_id: z.string().optional(), note: z.string().max(1000).nullable().optional() }) }),
  z.object({ event: EventPayloadSchema, action: z.literal("process"), job: z.any() }),
  z.object({ event: EventPayloadSchema, action: z.literal("submit"), vendor_id: z.string(), files: z.array(z.string()).max(5).optional(),
    upload: z.array(z.object({ name: z.string().min(1).max(200), data_base64: z.string() })).max(5).optional() }),
]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const allowed = new Set(ctx.vendors.flatMap((v) => [...v.response_files, ...(v.alternate_files ?? [])]));
  const load = async (ref: string) => {
    if (!allowed.has(ref)) throw new JobError(`Attachment reference not registered: ${ref}`);
    return readEventFile(ref);
  };
  const r = parsed.data;
  try {
    if (r.action === "simulate" || r.action === "receive") {
      const raw = r.action === "simulate" ? simulatedEmail(ctx, r.vendor_id, { unknownSender: r.unknown_sender, file: r.file }) : r.message;
      for (const a of raw.attachments) if (a.ref && !allowed.has(a.ref)) return badRequest(`Attachment reference not registered: ${a.ref}`);
      const message = await hydrateMessage(raw, load);
      return Response.json({ ok: true, job: receive(ctx, message, (r.prior_jobs ?? []) as IngestionJob[]) });
    }
    if (r.action === "submit") {
      const vendor = findVendor(ctx, r.vendor_id);
      if (!vendor) return badRequest(`Unknown vendor ${r.vendor_id}`);
      let attachments: { name: string; ref?: string; data_base64?: string }[];
      if (r.upload?.length) {
        for (const u of r.upload) {
          try { detectSourceType(u.name); } catch (e) { return badRequest((e as Error).message); }
          if (Buffer.byteLength(u.data_base64, "base64") > MAX_UPLOAD_BYTES) return badRequest(`${u.name} is larger than 4 MB.`);
        }
        attachments = r.upload.map((u) => ({ name: u.name.replace(/[^\w.\- ]+/g, "_"), data_base64: u.data_base64 }));
      } else {
        // Only the vendor's own registered response files may be referenced – never arbitrary paths.
        const own = [...vendor.response_files, ...(vendor.alternate_files ?? [])];
        const wanted = r.files?.length ? r.files : vendor.response_files.map((f) => f.split("/").pop()!);
        const refs = wanted.map((w) => own.find((a) => a.split("/").pop() === w));
        if (refs.some((x) => !x)) return badRequest(`File not registered for ${vendor.vendor_id}: ${wanted.join(", ")}`);
        attachments = refs.map((ref) => ({ name: ref!.split("/").pop()!, ref: ref! }));
      }
      return Response.json({ ok: true, job: submitDirect(ctx, vendor.vendor_id, attachments) });
    }
    if (r.action === "resolve") {
      const res = r.resolution;
      const action = res.type === "select_vendor" ? { type: res.type, vendor_id: res.vendor_id ?? "", note: res.note }
        : res.type === "assign_rfx" ? { type: res.type, rfx_id: res.rfx_id ?? ctx.rfx_id, vendor_id: res.vendor_id ?? null, note: res.note }
        : { type: res.type, note: res.note };
      return Response.json({ ok: true, job: resolveIdentity(ctx, r.job as IngestionJob, action as Parameters<typeof resolveIdentity>[2]) });
    }
    const c = clientOrError();
    if ("error" in c) return c.error;
    const out = await runJob(c.client, ctx, r.job as IngestionJob, load);
    return Response.json({ ok: true, job: out.job, bid: out.bid });
  } catch (e) {
    if (e instanceof JobError) return Response.json({ ok: false, error: { code: "JOB_REJECTED", message: e.message, details: [] } }, { status: 409 });
    throw e;
  }
}
