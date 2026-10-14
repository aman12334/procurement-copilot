/**
 * Event-driven ingestion around the existing Bid Processing Agent.
 *   inbound event → job (received) → identity match → queued | needs_identity_review
 *   → processing (existing processVendorResponse) → completed | retrying | failed
 * Pure state transitions + one async runner. Job state is held by the caller (browser store / tests), so the
 * abstraction is stateless on the server and Vercel-compatible. Each run is one bounded request.
 */
import type { LLMClient } from "@/lib/ai/client";
import { processVendorResponse } from "@/lib/bids/agent";
import type { InputFile } from "@/lib/bids/ingest";
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { matchIdentity, type IdentityResult, type InboundAttachment, type InboundMessage } from "./identity";

export type JobState = "received" | "queued" | "processing" | "completed" | "needs_identity_review" | "retrying" | "failed";
export const MAX_JOB_ATTEMPTS = 3;
const RETRYABLE = new Set(["overloaded", "rate_limited", "timeout"]);

export interface JobEvent { at: string; state: JobState; note: string }

export interface IngestionJob {
  job_id: string;
  message: InboundMessage;
  state: JobState;
  identity: IdentityResult;
  rfx_id: string | null;
  vendor_id: string | null;
  identity_decision: { action: IdentityAction["type"]; vendor_id: string | null; by: "system" | "buyer"; at: string; note: string | null } | null;
  attempts: number;
  last_error: { code: string; kind: string | null; message: string } | null;
  result: { vendor_id: string; processed_at: string; quoted_lines: number; review_items: number; open_review_items: number } | null;
  history: JobEvent[];
}

export type IdentityAction =
  | { type: "confirm"; note?: string | null }
  | { type: "select_vendor"; vendor_id: string; note?: string | null }
  | { type: "assign_rfx"; rfx_id: string; vendor_id?: string | null; note?: string | null }
  | { type: "reject"; note?: string | null };

const push = (j: IngestionJob, state: JobState, note: string, now: Date): IngestionJob =>
  ({ ...j, state, history: [...j.history, { at: now.toISOString(), state, note }] });

/** Thread → vendor relationships learned from earlier completed jobs (prior email/thread signal). */
export function threadMap(jobs: IngestionJob[]): Record<string, string> {
  return Object.fromEntries(jobs.filter((j) => j.message.thread_id && j.vendor_id && j.state === "completed").map((j) => [j.message.thread_id!, j.vendor_id!]));
}

export function receive(ctx: EventContext, message: InboundMessage, priorJobs: IngestionJob[] = [], now = new Date()): IngestionJob {
  const identity = matchIdentity(ctx, message, threadMap(priorJobs));
  let job: IngestionJob = {
    job_id: `JOB-${message.message_id}`, message, state: "received", identity, rfx_id: identity.rfx.rfx_id, vendor_id: identity.vendor.vendor_id,
    identity_decision: null, attempts: 0, last_error: null, result: null,
    history: [{ at: now.toISOString(), state: "received", note: `${message.channel} from ${identity.contact.email}: "${message.subject}" (${message.attachments.length} attachment(s))` }],
  };
  if (identity.status === "matched" || identity.status === "probable") {
    job = { ...job, identity_decision: { action: "confirm", vendor_id: identity.vendor.vendor_id, by: "system", at: now.toISOString(), note: identity.summary } };
    return push(job, "queued", `Identity ${identity.status}: ${identity.summary}`, now);
  }
  return push(job, "needs_identity_review", identity.summary, now);
}

export class JobError extends Error {}

/** Buyer resolves an ambiguous / unmatched identity; processing resumes from the queue. */
export function resolveIdentity(ctx: EventContext, job: IngestionJob, action: IdentityAction, now = new Date()): IngestionJob {
  if (job.state !== "needs_identity_review") throw new JobError(`Job ${job.job_id} is ${job.state}, not awaiting identity review.`);
  const decision = (vendor: string | null) => ({ action: action.type, vendor_id: vendor, by: "buyer" as const, at: now.toISOString(), note: action.note ?? null });
  if (action.type === "reject") return push({ ...job, identity_decision: decision(null), vendor_id: null }, "failed", `Rejected by buyer as unrelated${action.note ? `: ${action.note}` : ""}`, now);
  const vendorId = action.type === "select_vendor" ? action.vendor_id : action.type === "assign_rfx" ? action.vendor_id ?? job.vendor_id ?? job.identity.vendor.candidates[0]?.vendor_id ?? null : job.identity.vendor.candidates[0]?.vendor_id ?? null;
  if (!vendorId || !ctx.vendors.some((v) => v.vendor_id === vendorId)) throw new JobError("Select a valid invited vendor for this response.");
  const rfxId = action.type === "assign_rfx" ? action.rfx_id : job.rfx_id ?? ctx.rfx_id;
  if (rfxId !== ctx.rfx_id) throw new JobError(`Unknown RFx ${rfxId}.`);
  const vname = ctx.vendors.find((v) => v.vendor_id === vendorId)!.vendor_name;
  return push({ ...job, vendor_id: vendorId, rfx_id: rfxId, identity_decision: decision(vendorId) }, "queued", `Buyer ${action.type.replace("_", " ")}: ${vname} for ${rfxId}`, now);
}

/** Files the agent should read: attachments, or the email body itself when it is the response. */
export async function jobFiles(job: IngestionJob, load: (ref: string) => Promise<Buffer>): Promise<InputFile[]> {
  const files: InputFile[] = [];
  for (const a of job.message.attachments) {
    if (a.ref) files.push({ name: a.name, data: await load(a.ref) });
    else if (a.data_base64) files.push({ name: a.name, data: Buffer.from(a.data_base64, "base64") });
  }
  if (!files.length) files.push({ name: `email_${job.message.message_id}.txt`, data: Buffer.from(`From: ${job.message.from}\nSubject: ${job.message.subject}\n\n${job.message.body}`) });
  return files;
}

/** Runs one queued/retrying job through the existing Bid Processing Agent. Never returns a bid on failure. */
export async function runJob(client: LLMClient, ctx: EventContext, job: IngestionJob, load: (ref: string) => Promise<Buffer>, now: () => Date = () => new Date()):
  Promise<{ job: IngestionJob; bid: CanonicalBid | null }> {
  if (job.state !== "queued" && job.state !== "retrying") throw new JobError(`Job ${job.job_id} is ${job.state}; only queued or retrying jobs can run.`);
  const vendor = ctx.vendors.find((v) => v.vendor_id === job.vendor_id);
  if (!vendor) throw new JobError("Job has no confirmed vendor.");
  let j = push({ ...job, attempts: job.attempts + 1 }, "processing", `Attempt ${job.attempts + 1}: Bid Processing Agent (${client.model})`, now());
  let files: InputFile[];
  try { files = await jobFiles(j, load); }
  catch (e) { return { job: push({ ...j, last_error: { code: "INGEST_FAILED", kind: null, message: (e as Error).message } }, "failed", `Attachment could not be read: ${(e as Error).message}`, now()), bid: null }; }
  const r = await processVendorResponse(client, ctx, vendor, files, now);
  if (!r.ok) {
    const kind = r.error.details.find((d) => d.startsWith("kind:"))?.slice(5) ?? null;
    const last_error = { code: r.error.code, kind, message: r.error.message };
    const retry = r.error.code === "MODEL_UNAVAILABLE" && kind !== null && RETRYABLE.has(kind) && j.attempts < MAX_JOB_ATTEMPTS;
    return { job: push({ ...j, last_error }, retry ? "retrying" : "failed", `${r.error.code}${kind ? ` (${kind})` : ""}: ${r.error.message}${retry ? " – can be retried" : ""}`, now()), bid: null };
  }
  const s = r.bid.processing_summary;
  j = { ...j, last_error: null, result: { vendor_id: vendor.vendor_id, processed_at: r.bid.response_metadata.processed_at, quoted_lines: s.quoted_lines, review_items: s.review_items, open_review_items: s.open_review_items } };
  return { job: push(j, "completed", `Canonical bid created: ${s.quoted_lines}/${s.rfx_lines} lines, ${s.open_review_items} open review item(s)`, now()), bid: r.bid };
}

/**
 * Buyer-side submission: the buyer loads or uploads a response for a vendor they selected. Same job/queue path
 * as inbound email; identity is the buyer's explicit choice (recorded), not inferred.
 */
export function submitDirect(ctx: EventContext, vendorId: string, attachments: InboundAttachment[], now = new Date()): IngestionJob {
  const v = ctx.vendors.find((x) => x.vendor_id === vendorId);
  if (!v) throw new JobError(`Unknown vendor ${vendorId}`);
  if (!attachments.length) throw new JobError("Nothing to process: no file was provided.");
  const signal = "buyer selected vendor (manual load/upload)";
  const identity: IdentityResult = {
    status: "matched",
    rfx: { status: "matched", rfx_id: ctx.rfx_id, signals: [`loaded by the buyer inside ${ctx.rfx_id}`] },
    vendor: { status: "matched", vendor_id: v.vendor_id, candidates: [{ vendor_id: v.vendor_id, vendor_name: v.vendor_name, score: 10, signals: [signal] }] },
    contact: { email: v.contact_email.toLowerCase(), known_poc: true },
    summary: `Buyer loaded a response for ${v.vendor_name} (${attachments.map((a) => a.name).join(", ")}).`,
  };
  const message: InboundMessage = {
    message_id: `${vendorId}-portal-${now.getTime().toString(36)}`, channel: "portal", received_at: now.toISOString(),
    from: `buyer on behalf of ${v.vendor_name} <${v.contact_email}>`, to: null, subject: `${ctx.rfx_id} – response loaded by buyer`, body: "",
    thread_id: null, attachments, body_ref: null,
  };
  const at = now.toISOString();
  return {
    job_id: `JOB-${message.message_id}`, message, state: "queued", identity, rfx_id: ctx.rfx_id, vendor_id: v.vendor_id,
    identity_decision: { action: "select_vendor", vendor_id: v.vendor_id, by: "buyer", at, note: signal },
    attempts: 0, last_error: null, result: null,
    history: [
      { at, state: "received", note: `portal: ${identity.summary}` },
      { at, state: "queued", note: `Identity set by buyer: ${v.vendor_name} for ${ctx.rfx_id}` },
    ],
  };
}

/** Server-side: fill a simulated body from its registered fixture (validated by the caller's loader). */
export async function hydrateMessage(m: InboundMessage, load: (ref: string) => Promise<Buffer>): Promise<InboundMessage> {
  if (!m.body_ref) return m;
  const text = (await load(m.body_ref)).toString("utf8");
  return { ...m, body: m.body ? `${m.body}\n\n${text}` : text, body_ref: null };
}

/** Builds a simulated inbound email from a vendor's Stage 1 fixture (the event path, not a direct agent call). */
export function simulatedEmail(ctx: EventContext, vendorId: string, opts: { unknownSender?: boolean; file?: string; now?: Date } = {}): InboundMessage {
  const v = ctx.vendors.find((x) => x.vendor_id === vendorId);
  if (!v) throw new JobError(`Unknown vendor ${vendorId}`);
  const now = opts.now ?? new Date();
  const files = [...v.response_files, ...(v.alternate_files ?? [])];
  const file = files.find((f) => f.split("/").pop() === opts.file) ?? v.response_files[0];
  const isEmailBody = /\.(txt|eml)$/i.test(file);
  const base = { message_id: `${vendorId}-${now.getTime().toString(36)}`, channel: "simulated" as const, received_at: now.toISOString(), thread_id: `thread-${vendorId}`, to: "procurement@sahyadricp.example" };
  if (opts.unknownSender) {
    return { ...base, thread_id: null, from: "accounts.team@mail.example", subject: "Quotation as requested", attachments: isEmailBody ? [] : [{ name: file.split("/").pop()!, ref: file }],
      body: isEmailBody ? "" : "Dear Sir/Madam,\nPlease find our quotation attached.\nRegards", body_ref: isEmailBody ? file : null };
  }
  const ref = v.response_token ? ` [Response ref: ${v.response_token}]` : "";
  return { ...base, from: `${v.vendor_name} <${v.contact_email}>`, subject: `RE: ${ctx.rfx_id} – quotation from ${v.vendor_name}${ref}`,
    body: isEmailBody ? "" : `Dear Ms. Raghunathan,\nPlease find attached our offer against ${ctx.rfx_id}.${ref}\nRegards,\n${v.vendor_name}`,
    attachments: isEmailBody ? [] : [{ name: file.split("/").pop()!, ref: file }], body_ref: isEmailBody ? file : null };
}
