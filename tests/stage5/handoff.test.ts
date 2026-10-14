import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { processVendorResponse } from "@/lib/bids/agent";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { contextFromReleased, releaseBlockers, ReleasedEventSchema, type ReleasedEvent, type ReleasedVendor } from "@/lib/event/released";
import { matchIdentity } from "@/lib/ingestion/identity";
import { receive, simulatedEmail } from "@/lib/ingestion/queue";
import { lineItemsFromCsv } from "@/lib/rfx/csv";
import { FakeLLM } from "../fixtures/fake-client";
import { extraction, quote } from "../fixtures/bids";
import { completeRfx } from "../fixtures/rfx";

const TODAY = new Date("2026-10-13T00:00:00Z");
let defaults: EventContext;
beforeAll(async () => { defaults = await loadEventContext(); });

const vendorsFrom = (ctx: EventContext, ids: string[]): ReleasedVendor[] =>
  ctx.vendors.filter((v) => ids.includes(v.vendor_id)).map(({ vendor_id, vendor_no, vendor_name, contact_email }) => ({ vendor_id, vendor_no, vendor_name, contact_email }));

function releasedRfx() {
  const r = completeRfx();
  r.rfx_id = "RFX-2026-PKG-777";
  r.title = "Released packaging event";
  r.line_items = lineItemsFromCsv(readFileSync("stage1/buyer/rfx_master.csv", "utf8")).items.slice(0, 4);
  r.line_items[1] = { ...r.line_items[1], annual_qty: 123456, additional_specs: [{ name: "reference_weight_g", value: "250" }] };
  r.scope = { ...r.scope, line_count: 4 };
  return r;
}
const released = (ids = ["VND-1003", "VND-1005"]): ReleasedEvent =>
  ({ status: "open", released_at: "2026-10-13T09:00:00.000Z", rfx: releasedRfx(), vendors: vendorsFrom(defaults, ids) });

describe("RFx hand-off: released RFx becomes the evaluated event", () => {
  it("release blockers: complete draft + vendors is releasable; gaps are reported", () => {
    const ev = released();
    expect(releaseBlockers(ev.rfx, ev.vendors, TODAY)).toEqual([]);
    expect(ReleasedEventSchema.safeParse(ev).success).toBe(true);
    const bad = releasedRfx();
    bad.line_items[0] = { ...bad.line_items[0], annual_qty: null, delivery_plant: "XYZ" };
    bad.technical_questionnaire = [];
    const b = releaseBlockers(bad, [], TODAY).join("\n");
    expect(b).toMatch(/annual quantity is required/);
    expect(b).toMatch(/delivery plant must be one of the buyer locations/);
    expect(b).toMatch(/technical questionnaire/);
    expect(b).toMatch(/Invite at least one vendor/);
    const dup = released().vendors;
    expect(releaseBlockers(releasedRfx(), [...dup, dup[0]], TODAY)).toContain("Vendor IDs must be unique.");
  });

  it("maps lines, questions, plants, vendors and keeps server-only config from the defaults", () => {
    const ctx = contextFromReleased(released(), defaults);
    expect(ctx).toMatchObject({ rfx_id: "RFX-2026-PKG-777", source: "released_rfx", released_at: "2026-10-13T09:00:00.000Z", issue_date: "2026-10-13" });
    expect(ctx.lines.map((l) => l.line_id)).toEqual(["CP-001", "CP-002", "CP-003", "CP-004"]);
    expect(ctx.lines[1]).toMatchObject({ annual_qty: 123456, reference_weight_g: 250 });
    expect(ctx.questions).toHaveLength(12);
    expect(ctx.questions[0]).toMatchObject({ qid: "Q01", max_points: 12, partial_points: 6 });
    expect(ctx.vendors.map((v) => v.vendor_id)).toEqual(["VND-1003", "VND-1005"]);
    expect(ctx.vendors[0].response_files.length).toBeGreaterThan(0); // fixture files come from the server registry only
    expect(Object.keys(ctx.historical).every((id) => ctx.lines.some((l) => l.line_id === id))).toBe(true);
    expect(ctx.evaluation).toEqual(defaults.evaluation);
    expect(defaults.source).toBe("stage1_default");
  });

  it("identity matching uses the released RFx ID and only the invited vendors", () => {
    const ctx = contextFromReleased(released(), defaults);
    const job = receive(ctx, simulatedEmail(ctx, "VND-1003", { now: TODAY }), [], TODAY);
    expect(job.identity).toMatchObject({ status: "matched", rfx: { rfx_id: "RFX-2026-PKG-777" }, vendor: { vendor_id: "VND-1003" } });
    // A reply quoting the old Stage 1 RFx ID is not silently attached to the released event.
    const old = matchIdentity(ctx, { message_id: "x", channel: "email", received_at: TODAY.toISOString(), from: ctx.vendors[0].contact_email,
      subject: `RE: ${defaults.rfx_id}`, body: "", attachments: [] });
    expect(old.rfx.status).toBe("unmatched");
    // A vendor that was not invited cannot be matched.
    const notInvited = defaults.vendors.find((v) => v.vendor_id === "VND-1001")!;
    const r = matchIdentity(ctx, { message_id: "y", channel: "email", received_at: TODAY.toISOString(), from: notInvited.contact_email,
      subject: "RE: RFX-2026-PKG-777", body: "", attachments: [] });
    expect(r.vendor.vendor_id).toBeNull();
  });

  it("bid processing evaluates against the released lines (prompt + missing-line computation)", async () => {
    const ctx = contextFromReleased(released(), defaults);
    const llm = new FakeLLM([extraction({ quotes: [quote("CP-002", 44, "per piece")] })]);
    const v5 = ctx.vendors.find((v) => v.vendor_id === "VND-1005")!;
    const res = await processVendorResponse(llm, ctx, v5,
      [{ name: "Godavari_Packaging_email_response.txt", data: readFileSync("stage1/vendors/vendor_5/Godavari_Packaging_email_response.txt") }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(llm.calls[0].prompt).toContain("RFX-2026-PKG-777");
    expect(llm.calls[0].prompt).toContain("CP-004");
    expect(llm.calls[0].prompt).not.toContain("CP-030");
    expect(res.bid.processing_summary.rfx_lines).toBe(4);
    expect(res.bid.missing_rfx_lines).toEqual(["CP-001", "CP-003", "CP-004"]);
  });
});

describe("browser store is namespaced per released RFx", () => {
  it("bids saved under one event are invisible after switching events, and come back on revert", async () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
    };
    const store = await import("@/lib/client/bid-store");
    store.saveBids({ demo: {} as never });
    store.saveActiveEvent(released());
    expect(store.loadActiveEvent()?.rfx.rfx_id).toBe("RFX-2026-PKG-777");
    expect(store.loadBids()).toEqual({});
    store.saveBids({ rel: {} as never });
    expect([...mem.keys()]).toContain("stage3.bids.v1::RFX-2026-PKG-777");
    store.saveActiveEvent(null);
    expect(Object.keys(store.loadBids())).toEqual(["demo"]);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
