import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { commitOutcome, emptyVersions } from "@/lib/bids/versions";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { matchIdentity, type InboundMessage } from "@/lib/ingestion/identity";
import { hydrateMessage, JobError, receive, resolveIdentity, runJob, simulatedEmail } from "@/lib/ingestion/queue";
import { FakeLLM } from "../fixtures/fake-client";
import { extraction, quote } from "../fixtures/bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const load = async (ref: string) => readFileSync(ref);
const T = (s: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, s));
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  message_id: "m1", channel: "email", received_at: T(0).toISOString(), from: "x@y.example", subject: "", body: "", attachments: [], ...o,
});
const v3file = "stage1/vendors/vendor_3/Indus_Fibreboard_Offer_SCPL_RFQ014.docx";

describe("inbound ingestion + identity", () => {
  it("(1,3) inbound event creates a job; exact POC + RFx ID → matched → queued", () => {
    const m = simulatedEmail(ctx, "VND-1003", { now: T(0) });
    const job = receive(ctx, m, [], T(1));
    expect(job.identity).toMatchObject({ status: "matched", vendor: { vendor_id: "VND-1003" }, rfx: { status: "matched" } });
    expect(job.identity.vendor.candidates[0].signals[0]).toMatch(/known POC/);
    expect(job.history.map((h) => h.state)).toEqual(["received", "queued"]);
    expect(job.message.attachments[0].ref).toBe(v3file);
  });

  it("(4) ambiguous / unmatched senders go to identity review – never guessed", () => {
    const amb = matchIdentity(ctx, msg({ from: "sales@mail.example", subject: `RE: ${ctx.rfx_id}`, body: "Quote from Godavari Packaging and Deccan Corrupack consortium" }));
    expect(amb.status).toBe("ambiguous");
    expect(amb.vendor.vendor_id).toBeNull();
    const job = receive(ctx, simulatedEmail(ctx, "VND-1003", { unknownSender: true, now: T(0) }), [], T(1));
    expect(job.state).toBe("needs_identity_review");
    expect(job.identity.status).toBe("unmatched");
    expect(matchIdentity(ctx, msg({ from: "ananya.reddy@indusfibreboard.example", subject: "Quote" })).status).toBe("unmatched"); // vendor ok, RFx missing
  });

  it("domain, RFx token and prior thread signals", () => {
    expect(matchIdentity(ctx, msg({ from: "ops@ganeshpackwell.example", subject: "RFQ 014 rates" }))).toMatchObject({ status: "probable", vendor: { vendor_id: "VND-1002" }, rfx: { status: "probable" } });
    const r = matchIdentity(ctx, msg({ from: "noreply@mail.example", subject: `RE: ${ctx.rfx_id}`, thread_id: "t-9" }), { "t-9": "VND-1005" });
    expect(r.vendor.vendor_id).toBe("VND-1005");
  });

  it("(5) buyer resolves identity: assign vendor → queued → processed by the existing agent; reject → failed", async () => {
    const job = receive(ctx, simulatedEmail(ctx, "VND-1003", { unknownSender: true, now: T(0) }), [], T(1));
    await expect(runJob(new FakeLLM([]), ctx, job, load)).rejects.toThrow(JobError);
    const resolved = resolveIdentity(ctx, job, { type: "select_vendor", vendor_id: "VND-1003", note: "known by phone" }, T(2));
    expect(resolved).toMatchObject({ state: "queued", vendor_id: "VND-1003", identity_decision: { by: "buyer", action: "select_vendor" } });
    const llm = new FakeLLM([extraction({ quotes: [quote("CP-001", 8)] })]);
    const out = await runJob(llm, ctx, resolved, load, () => T(3));
    expect(out.job.state).toBe("completed");
    expect(out.bid?.vendor.vendor_id).toBe("VND-1003");
    expect(llm.calls[0].prompt).toContain("Indus_Fibreboard_Offer_SCPL_RFQ014.docx");
    expect(resolveIdentity(ctx, receive(ctx, simulatedEmail(ctx, "VND-1003", { unknownSender: true }), []), { type: "reject" }).state).toBe("failed");
  });

  it("(2) queue transitions incl. retrying on overload and failure on quota exhaustion; no bid on failure", async () => {
    const job = receive(ctx, simulatedEmail(ctx, "VND-1003", { now: T(0) }), [], T(1));
    const overloaded = Object.assign(new Error("503"), { code: "MODEL_UNAVAILABLE", kind: "overloaded" });
    const r1 = await runJob(new FakeLLM([overloaded]), ctx, job, load, () => T(2));
    expect(r1).toMatchObject({ bid: null, job: { state: "retrying", attempts: 1, last_error: { kind: "overloaded" } } });
    const quota = Object.assign(new Error("quota"), { code: "MODEL_UNAVAILABLE", kind: "quota_exhausted" });
    const r2 = await runJob(new FakeLLM([quota]), ctx, r1.job, load, () => T(3));
    expect(r2.job.state).toBe("failed");
    expect(r2.job.history.map((h) => h.state)).toEqual(["received", "queued", "processing", "retrying", "processing", "failed"]);
  });

  it("email-body responses are hydrated from the registered fixture and passed as the document", async () => {
    const m = await hydrateMessage(simulatedEmail(ctx, "VND-1005", { now: T(0) }), load);
    expect(m.body).toContain("same as last year's pricing");
    const job = receive(ctx, m, [], T(1));
    expect(job.state).toBe("queued");
    const llm = new FakeLLM([extraction({ quotes: [quote("CP-001", 44, "per kg", { price_basis: "rate_per_kg" })] })]);
    const out = await runJob(llm, ctx, job, load, () => T(2));
    expect(out.job.state).toBe("completed");
    expect(llm.calls[0].prompt).toContain("same as last year's pricing");
  });

  it("(8) safe write: a failure never replaces the last good bid; success keeps the previous version", async () => {
    const job = receive(ctx, simulatedEmail(ctx, "VND-1003", { now: T(0) }), [], T(1));
    const good = (await runJob(new FakeLLM([extraction({ quotes: [quote("CP-001", 8)] })]), ctx, job, load, () => T(2))).bid!;
    let v = commitOutcome(emptyVersions(), "VND-1003", { ok: true, bid: good }, "inbound", T(3));
    v = commitOutcome(v, "VND-1003", { ok: false, error: { code: "MODEL_UNAVAILABLE", message: "503", details: ["kind:overloaded"] } }, "reprocess", T(4));
    expect(v.active["VND-1003"]).toBe(good);
    expect(v.failures[0]).toMatchObject({ vendor_id: "VND-1003", code: "MODEL_UNAVAILABLE", kind: "overloaded" });
    const newer = { ...good, response_metadata: { ...good.response_metadata, processed_at: T(5).toISOString() } };
    v = commitOutcome(v, "VND-1003", { ok: true, bid: newer }, "reprocess", T(6));
    expect(v.active["VND-1003"]).toBe(newer);
    expect(v.previous["VND-1003"][0].bid).toBe(good);
  });
});
