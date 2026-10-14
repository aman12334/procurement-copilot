/**
 * RFQ register: every RFx the buyer generates or imports, its release and the order allocation made after the
 * final decision. Pure transitions (tested); the browser store persists the list (stateless server).
 * Allocation records the buyer's award decision here – it does not send a PO or contact suppliers.
 */
import { buildInvitations, type Invitation } from "@/lib/event/invitation";
import type { ReleasedEvent } from "@/lib/event/released";
import type { RfxDraft } from "@/lib/rfx/schema";
import type { Scenario } from "@/lib/scenarios/types";

export type RfqStatus = "draft" | "released" | "awarded";

export interface RfqAwardSupplier { vendor_id: string; vendor: string; lines: number; spend_inr: number; spend_pct: number }

export interface RfqAward {
  scenario_id: string;
  scenario_name: string;
  suppliers: RfqAwardSupplier[];
  lines_awarded: number;
  total_value_inr: number;
  approved_at: string | null;
  allocated_at: string;
  note: string | null;
}

export interface RfqEntry {
  id: string;
  rfx_id: string;
  title: string;
  category: string;
  source: "generated" | "imported" | "saved_draft" | "stage1_demo";
  created_at: string;
  updated_at: string;
  status: RfqStatus;
  released_at: string | null;
  vendors_invited: { vendor_id: string; vendor_name: string }[];
  line_count: number;
  draft: RfxDraft | null;
  event: ReleasedEvent | null;
  award: RfqAward | null;
  /** Earlier allocations for this RFQ (re-allocation keeps the history). */
  award_history: RfqAward[];
  /** Outbound invitations generated at release (simulated email channel). Older entries may not have it. */
  invitations?: Invitation[];
}

const MAX_ENTRIES = 200;
const iso = (d: Date) => d.toISOString();
const replace = (list: RfqEntry[], e: RfqEntry) => [...list.filter((x) => x.id !== e.id), e].slice(-MAX_ENTRIES);

/** Adds a generated/imported draft, or refreshes the snapshot of an existing entry (status and dates kept). */
export function registerDraft(list: RfqEntry[], input: { id: string; rfx: RfxDraft; source?: RfqEntry["source"] }, now = new Date(), opts: { onlyIfExists?: boolean } = {}): RfqEntry[] {
  const prev = list.find((e) => e.id === input.id);
  if (!prev && opts.onlyIfExists) return list;
  const { rfx } = input;
  const base: RfqEntry = prev ?? {
    id: input.id, rfx_id: rfx.rfx_id, title: rfx.title, category: rfx.category, source: input.source ?? "generated",
    created_at: iso(now), updated_at: iso(now), status: "draft", released_at: null, vendors_invited: [], line_count: 0,
    draft: null, event: null, award: null, award_history: [],
  };
  // A released RFx keeps its released ID/title in the register; later draft edits only update the working snapshot.
  const header = base.status === "draft" ? { rfx_id: rfx.rfx_id, title: rfx.title, category: rfx.category, line_count: rfx.line_items.length } : {};
  return replace(list, { ...base, ...header, draft: rfx, updated_at: iso(now) });
}

export function markReleased(list: RfqEntry[], id: string, event: ReleasedEvent, now = new Date()): RfqEntry[] {
  const withEntry = list.some((e) => e.id === id) ? list : registerDraft(list, { id, rfx: event.rfx, source: "saved_draft" }, now);
  const e = withEntry.find((x) => x.id === id)!;
  return replace(withEntry, {
    ...e, rfx_id: event.rfx.rfx_id, title: event.rfx.title, category: event.rfx.category, line_count: event.rfx.line_items.length,
    status: e.status === "awarded" ? "awarded" : "released", released_at: event.released_at, event, draft: event.rfx,
    vendors_invited: event.vendors.map((v) => ({ vendor_id: v.vendor_id, vendor_name: v.vendor_name })), invitations: buildInvitations(event), updated_at: iso(now),
  });
}

/** Award summary from the approved scenario (numbers come from the deterministic scenario engine). */
export function awardFromScenario(s: Scenario, approvedAt: string | null, now = new Date(), note: string | null = null): RfqAward {
  return {
    scenario_id: s.scenario_id, scenario_name: s.name,
    suppliers: s.suppliers.map((x) => ({ vendor_id: x.vendor_id, vendor: x.vendor, lines: x.lines, spend_inr: x.spend_inr, spend_pct: x.spend_pct })),
    lines_awarded: s.covered_lines, total_value_inr: s.total_evaluated_cost, approved_at: approvedAt, allocated_at: iso(now), note,
  };
}

export class AllocationError extends Error {}

/**
 * Records the order allocation on the RFQ the decision was made for: the released entry with that RFx ID
 * (latest release wins), else any entry with that ID, else a register entry for the Stage 1 demo event.
 */
export function recordAllocation(list: RfqEntry[], target: { rfx_id: string; title: string }, award: RfqAward, now = new Date()): RfqEntry[] {
  if (!award.suppliers.length) throw new AllocationError("The approved scenario awards no supplier.");
  const candidates = list.filter((e) => e.rfx_id === target.rfx_id)
    .sort((a, b) => Number(!!b.released_at) - Number(!!a.released_at) || (b.released_at ?? b.created_at).localeCompare(a.released_at ?? a.created_at));
  const e: RfqEntry = candidates[0] ?? {
    id: `stage1-${target.rfx_id}`, rfx_id: target.rfx_id, title: target.title, category: "Corrugated packaging", source: "stage1_demo",
    created_at: iso(now), updated_at: iso(now), status: "released", released_at: null, vendors_invited: [], line_count: award.lines_awarded,
    draft: null, event: null, award: null, award_history: [],
  };
  return replace(list, { ...e, status: "awarded", award, award_history: e.award ? [...e.award_history, e.award] : e.award_history, updated_at: iso(now) });
}

export function registerSummary(list: RfqEntry[]) {
  return {
    total: list.length,
    drafts: list.filter((e) => e.status === "draft").length,
    released: list.filter((e) => e.status === "released").length,
    awarded: list.filter((e) => e.status === "awarded").length,
    awarded_value_inr: list.reduce((a, e) => a + (e.award?.total_value_inr ?? 0), 0),
  };
}
