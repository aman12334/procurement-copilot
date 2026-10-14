import { beforeAll, describe, expect, it } from "vitest";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { buildInvitations, toEml } from "@/lib/event/invitation";
import { contextFromReleased, type ReleasedEvent } from "@/lib/event/released";
import { matchIdentity } from "@/lib/ingestion/identity";
import { markReleased, registerDraft } from "@/lib/rfq/registry";
import { completeRfx } from "../fixtures/rfx";

let defaults: EventContext;
beforeAll(async () => { defaults = await loadEventContext(); });
const ev = (): ReleasedEvent => ({ status: "open", released_at: "2026-10-14T09:00:00.000Z", rfx: { ...completeRfx(), rfx_id: "RFX-2026-PKG-900" },
  vendors: [
    { vendor_id: "VND-1003", vendor_no: 3, vendor_name: "Indus Fibreboard Solutions Ltd.", contact_email: "ananya.reddy@indusfibreboard.example", response_token: "RSP-AB12CD" },
    { vendor_id: "VND-1005", vendor_no: 5, vendor_name: "Godavari Packaging Works", contact_email: "srinivas@godavaripack.example", response_token: "RSP-ZX98YW" },
  ] });

describe("outbound invitations (simulated email channel)", () => {
  it("one invitation per invited vendor, built from the released RFx", () => {
    const inv = buildInvitations(ev());
    expect(inv).toHaveLength(2);
    expect(inv[0]).toMatchObject({ to: "ananya.reddy@indusfibreboard.example", channel: "simulated_email", status: "sent_simulated", sent_at: "2026-10-14T09:00:00.000Z", response_token: "RSP-AB12CD" });
    expect(inv[0].subject).toBe("RFQ RFX-2026-PKG-900 – Annual Rate Contract – Corrugated Packaging [Response ref: RSP-AB12CD]");
    for (const s of ["Response deadline: 2026-10-30", "Line items: 3", "Bengaluru Plant (BLR)", "ISO 9001:2015 certification", "Payment terms: 45 days from invoice", "12 questions (100 points"])
      expect(inv[0].body).toContain(s);
    expect(inv[1].body).toContain("RSP-ZX98YW");
    expect(inv[0].body).not.toContain("RSP-ZX98YW"); // each vendor only sees its own reference
    expect(toEml(inv[0])).toMatch(/^From: procurement@sahyadricp\.example\r\nTo: ananya\.reddy@indusfibreboard\.example\r\nSubject: RFQ RFX-2026-PKG-900/);
  });

  it("release records the invitations on the RFQ register entry", () => {
    const l = markReleased(registerDraft([], { id: "d1", rfx: completeRfx() }), "d1", ev());
    expect(l[0].invitations?.map((i) => i.vendor_id)).toEqual(["VND-1003", "VND-1005"]);
  });

  it("a reply that keeps the invitation subject is matched to the right vendor and RFx", () => {
    const e = ev();
    const ctx = contextFromReleased(e, defaults);
    const inv = buildInvitations(e)[1];
    const r = matchIdentity(ctx, { message_id: "m", channel: "email", received_at: e.released_at, from: "accounts@gmail.com", subject: `RE: ${inv.subject}`, body: "rates attached", attachments: [] });
    expect(r).toMatchObject({ status: "matched", vendor: { vendor_id: "VND-1005" }, rfx: { status: "matched", rfx_id: "RFX-2026-PKG-900" } });
  });
});
