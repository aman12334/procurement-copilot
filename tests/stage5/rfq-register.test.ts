import { beforeAll, describe, expect, it } from "vitest";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import type { ReleasedEvent } from "@/lib/event/released";
import { AllocationError, awardFromScenario, markReleased, recordAllocation, registerDraft, registerSummary, type RfqEntry } from "@/lib/rfq/registry";
import { recommend } from "@/lib/scenarios/recommend";
import { runAll } from "@/lib/scenarios/standard";
import { completeRfx } from "../fixtures/rfx";
import { scenarioBids } from "../fixtures/scenario-bids";

let ctx: EventContext;
beforeAll(async () => { ctx = await loadEventContext(); });
const T = (m: number) => new Date(Date.UTC(2026, 9, 14, 10, m));
const ev = (rfx = completeRfx()): ReleasedEvent => ({ status: "open", released_at: T(5).toISOString(), rfx,
  vendors: [{ vendor_id: "VND-1003", vendor_no: 3, vendor_name: "Indus", contact_email: "a@b.example" }] });
const approvedScenario = () => {
  const bids = scenarioBids(ctx);
  const { scenarios } = runAll(ctx, bids, []);
  const rec = recommend(ctx, bids, scenarios);
  return scenarios.find((s) => s.scenario_id === rec.recommended_scenario_id)!;
};

describe("RFQ register", () => {
  it("records generated drafts with creation date; edits refresh the snapshot but keep created_at", () => {
    let l: RfqEntry[] = registerDraft([], { id: "d1", rfx: completeRfx(), source: "generated" }, T(0));
    expect(l[0]).toMatchObject({ id: "d1", rfx_id: "RFX-DRAFT-PKG", status: "draft", created_at: T(0).toISOString(), source: "generated", line_count: 3 });
    l = registerDraft(l, { id: "d1", rfx: { ...completeRfx(), title: "Edited" } }, T(2), { onlyIfExists: true });
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ title: "Edited", created_at: T(0).toISOString(), updated_at: T(2).toISOString() });
    expect(registerDraft(l, { id: "other", rfx: completeRfx() }, T(3), { onlyIfExists: true })).toBe(l); // untracked drafts are not added by edits
  });

  it("release marks the entry released with vendors and the event snapshot", () => {
    let l = registerDraft([], { id: "d1", rfx: completeRfx() }, T(0));
    l = markReleased(l, "d1", ev(), T(5));
    expect(l[0]).toMatchObject({ status: "released", released_at: T(5).toISOString(), vendors_invited: [{ vendor_id: "VND-1003" }] });
    expect(l[0].event?.rfx.rfx_id).toBe("RFX-DRAFT-PKG");
    // A saved draft never registered is added on release.
    expect(markReleased([], "d9", ev(), T(5))[0]).toMatchObject({ id: "d9", source: "saved_draft", status: "released" });
  });

  it("allocation after approval: award from the scenario engine, reflected in the entry; re-allocation keeps history", () => {
    const s = approvedScenario();
    let l = markReleased(registerDraft([], { id: "d1", rfx: completeRfx() }, T(0)), "d1", ev(), T(5));
    l = recordAllocation(l, { rfx_id: "RFX-DRAFT-PKG", title: "x" }, awardFromScenario(s, T(8).toISOString(), T(9)), T(9));
    expect(l[0].status).toBe("awarded");
    expect(l[0].award).toMatchObject({ scenario_id: s.scenario_id, total_value_inr: s.total_evaluated_cost, lines_awarded: s.covered_lines, approved_at: T(8).toISOString() });
    expect(l[0].award!.suppliers.map((x) => x.vendor_id)).toEqual(s.suppliers.map((x) => x.vendor_id));
    l = recordAllocation(l, { rfx_id: "RFX-DRAFT-PKG", title: "x" }, awardFromScenario(s, null, T(20)), T(20));
    expect(l[0].award_history).toHaveLength(1);
    expect(markReleased(l, "d1", ev(), T(30))[0].status).toBe("awarded"); // re-release never un-awards
  });

  it("allocating the Stage 1 demo event creates its register entry; empty awards are refused", () => {
    const s = approvedScenario();
    const l = recordAllocation([], { rfx_id: ctx.rfx_id, title: ctx.title }, awardFromScenario(s, null, T(1)), T(1));
    expect(l[0]).toMatchObject({ rfx_id: ctx.rfx_id, source: "stage1_demo", status: "awarded" });
    expect(() => recordAllocation([], { rfx_id: "X", title: "x" }, { ...awardFromScenario(s, null), suppliers: [] })).toThrow(AllocationError);
    expect(registerSummary(l)).toMatchObject({ total: 1, awarded: 1, awarded_value_inr: s.total_evaluated_cost });
  });
});
