import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { demoResponseToken, loadEventContext, type EventContext } from "@/lib/event/context";
import { contextFromReleased, newResponseToken, releaseBlockers } from "@/lib/event/released";
import { matchIdentity, type InboundMessage } from "@/lib/ingestion/identity";
import { JobError, runJob, simulatedEmail, submitDirect } from "@/lib/ingestion/queue";
import { auditGenerated } from "@/lib/scenarios/audit";
import { recommend } from "@/lib/scenarios/recommend";
import { runAll } from "@/lib/scenarios/standard";
import { emptyDecision } from "@/lib/scenarios/types";
import { FakeLLM } from "../fixtures/fake-client";
import { extraction, quote } from "../fixtures/bids";
import { completeRfx } from "../fixtures/rfx";
import { scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const T = new Date("2026-10-14T10:00:00Z");
const msg = (o: Partial<InboundMessage>): InboundMessage => ({ message_id: "m", channel: "email", received_at: T.toISOString(), from: "x@y.example", subject: "", body: "", attachments: [], ...o });
const v = (id: string) => ctx.vendors.find((x) => x.vendor_id === id)!;

describe("per-vendor response token", () => {
  it("demo event vendors get stable, distinct tokens; simulated emails quote them", () => {
    const toks = ctx.vendors.map((x) => x.response_token);
    expect(toks.every((t) => /^RSP-[A-F0-9]{6}$/.test(t!))).toBe(true);
    expect(new Set(toks).size).toBe(toks.length);
    expect(v("VND-1003").response_token).toBe(demoResponseToken(ctx.rfx_id, "VND-1003"));
    expect(simulatedEmail(ctx, "VND-1003", { now: T }).subject).toContain(v("VND-1003").response_token!);
  });

  it("a token alone (generic mailbox, no RFx ID) identifies vendor and event", () => {
    const r = matchIdentity(ctx, msg({ from: "accounts@gmail.com", subject: `Quote ref ${v("VND-1002").response_token}` }));
    expect(r).toMatchObject({ status: "matched", vendor: { vendor_id: "VND-1002" }, rfx: { status: "matched" } });
    expect(r.vendor.candidates[0].signals.join()).toMatch(/response token/);
  });

  it("a token that conflicts with the sender's POC is ambiguous – never guessed", () => {
    const r = matchIdentity(ctx, msg({ from: v("VND-1001").contact_email, subject: `RE: ${ctx.rfx_id} ${v("VND-1004").response_token}` }));
    expect(r.status).toBe("ambiguous");
    expect(r.vendor.vendor_id).toBeNull();
  });

  it("released events carry random tokens through; duplicates block release", () => {
    const a = newResponseToken(), b = newResponseToken();
    expect(a).toMatch(/^RSP-[A-Z0-9]{6}$/);
    expect(a).not.toBe(b);
    const vendors = [{ ...v("VND-1003"), response_token: a }, { ...v("VND-1005"), response_token: a }]
      .map(({ vendor_id, vendor_no, vendor_name, contact_email, response_token }) => ({ vendor_id, vendor_no, vendor_name, contact_email, response_token }));
    expect(releaseBlockers(completeRfx(), vendors, new Date("2026-10-13T00:00:00Z"))).toContain("Response tokens must be unique.");
    vendors[1].response_token = b;
    const rc = contextFromReleased({ status: "open", released_at: T.toISOString(), rfx: completeRfx(), vendors }, ctx);
    expect(rc.vendors.map((x) => x.response_token)).toEqual([a, b]);
  });
});

describe("Load & process / Upload go through the ingestion queue", () => {
  it("submitDirect creates a queued, buyer-identified job that runs through the agent", async () => {
    const file = v("VND-1005").response_files[0];
    const job = submitDirect(ctx, "VND-1005", [{ name: file.split("/").pop()!, ref: file }], T);
    expect(job).toMatchObject({ state: "queued", vendor_id: "VND-1005", rfx_id: ctx.rfx_id, message: { channel: "portal" },
      identity: { status: "matched" }, identity_decision: { by: "buyer", vendor_id: "VND-1005" } });
    expect(job.history.map((h) => h.state)).toEqual(["received", "queued"]);
    const out = await runJob(new FakeLLM([extraction({ quotes: [quote("CP-001", 7)] })]), ctx, job, async (r) => readFileSync(r), () => T);
    expect(out.job.state).toBe("completed");
    expect(out.bid?.vendor.vendor_id).toBe("VND-1005");
  });

  it("rejects unknown vendors and empty submissions", () => {
    expect(() => submitDirect(ctx, "VND-9999", [{ name: "a.pdf", ref: "x" }])).toThrow(JobError);
    expect(() => submitDirect(ctx, "VND-1001", [])).toThrow(/no file/);
  });
});

describe("decision audit for engine output", () => {
  it("logs scenarios/recommendation once per distinct result", () => {
    const bids = scenarioBids(ctx);
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const counts = { finalized_bids: 5, total_bids: 5 };
    const d1 = auditGenerated(emptyDecision(), scenarios, rec, counts, T);
    expect(d1.audit.map((e) => e.type)).toEqual(["scenarios_generated", "recommendation_generated"]);
    expect(d1.audit[1].scenario_id).toBe(rec.recommended_scenario_id);
    expect(auditGenerated(d1, scenarios, rec, counts, T)).toBe(d1); // unchanged → nothing logged
    const changed = scenarios.map((s, i) => (i === 0 ? { ...s, total_evaluated_cost: (s.total_evaluated_cost ?? 0) + 1000 } : s));
    const d2 = auditGenerated(d1, changed, rec, counts, T);
    expect(d2.audit.map((e) => e.type)).toEqual(["scenarios_generated", "recommendation_generated", "scenarios_generated"]);
  });
});
