"use client";
/** RFQ register: every generated/imported RFQ, its release and the order allocation from the final decision. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { loadActiveEvent, loadRfqs, saveActiveEvent } from "@/lib/client/bid-store";
import { registerSummary, type RfqEntry } from "@/lib/rfq/registry";
import InvitationList from "./InvitationList";

const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const STATUS_CHIP: Record<RfqEntry["status"], string> = { draft: "not_processed", released: "processing", awarded: "finalized" };
type Filter = "all" | RfqEntry["status"];

export default function RfqRegister() {
  const router = useRouter();
  const [list, setList] = useState<RfqEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const read = () => { setList(loadRfqs()); setActive(loadActiveEvent()?.rfx.rfx_id ?? null); };
    read();
    window.addEventListener("rfq-register-changed", read);
    window.addEventListener("rfx-event-changed", read);
    return () => { window.removeEventListener("rfq-register-changed", read); window.removeEventListener("rfx-event-changed", read); };
  }, []);

  const sum = useMemo(() => registerSummary(list), [list]);
  const rows = useMemo(() => [...list]
    .filter((e) => filter === "all" || e.status === filter)
    .filter((e) => !q.trim() || `${e.rfx_id} ${e.title} ${e.award?.suppliers.map((s) => s.vendor).join(" ") ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)), [list, filter, q]);

  function makeActive(e: RfqEntry) {
    if (!e.event) return;
    saveActiveEvent(e.event);
    window.dispatchEvent(new Event("rfx-event-changed"));
    router.push("/bids");
  }

  return (
    <div className="content" style={{ flex: 1 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>RFQ register</h2>
        <span className="chip">{sum.total} total</span>
        <span className="chip not_processed">{sum.drafts} draft</span>
        <span className="chip processing">{sum.released} released</span>
        <span className="chip finalized">{sum.awarded} awarded · {inr(sum.awarded_value_inr)}</span>
        <span style={{ flex: 1 }} />
        <input className="fld" placeholder="Search ID, title, vendor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <select className="sel" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All statuses</option><option value="draft">Draft</option><option value="released">Released</option><option value="awarded">Awarded</option>
        </select>
        <Link className="btn small primary" href="/">+ New RFQ</Link>
      </div>
      <p className="hint">Every RFQ generated or imported in this browser. Click a row for details; “Open” loads it on the RFx page. Allocation is recorded from the Decision page after approval (no PO is sent).</p>

      {rows.length === 0 ? (
        <div className="empty">{list.length ? "No RFQs match the filter." : <>No RFQs yet. <Link href="/">Generate your first RFQ →</Link></>}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>RFx ID</th><th>Title</th><th>Created</th><th>Status</th><th>Released</th><th>Vendors invited</th><th>Lines</th><th>Allocated to</th><th>Order value</th><th>Allocated on</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <FragmentRow key={e.id} e={e} active={active === e.rfx_id && !!e.event} expanded={open === e.id}
                onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} onActivate={() => makeActive(e)} />
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ e, active, expanded, onToggle, onActivate }: { e: RfqEntry; active: boolean; expanded: boolean; onToggle: () => void; onActivate: () => void }) {
  return (
    <>
      <tr className={`scn-row ${expanded ? "sel" : ""}`} onClick={onToggle} style={{ cursor: "pointer" }}>
        <td><strong>{e.rfx_id}</strong>{active && <span className="tag sel2">ACTIVE</span>}</td>
        <td>{e.title}<div className="hint">{e.category} · {e.source.replace("_", " ")}</div></td>
        <td>{when(e.created_at)}</td>
        <td><span className={`chip ${STATUS_CHIP[e.status]}`}>{e.status}</span></td>
        <td>{when(e.released_at)}</td>
        <td>{e.vendors_invited.length || "—"}{e.invitations?.length ? <div className="hint">{e.invitations.length} invitation(s) sent</div> : null}</td>
        <td>{e.line_count || "—"}</td>
        <td>{e.award ? e.award.suppliers.map((s) => <div key={s.vendor_id}>{s.vendor} <span className="hint">({s.lines} lines · {s.spend_pct}%)</span></div>) : <span className="hint">not allocated</span>}</td>
        <td>{e.award ? inr(e.award.total_value_inr) : "—"}</td>
        <td>{when(e.award?.allocated_at)}</td>
        <td onClick={(ev) => ev.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
          {(e.draft || e.event) && <Link className="btn small" href={`/?rfq=${encodeURIComponent(e.id)}`}>Open</Link>}{" "}
          {e.event && !active && <button className="btn small" onClick={onActivate} title="Make this the event used by bids, comparison, analyst and decision">Make active</button>}{" "}
          {active && <Link className="btn small" href="/decision">Decision →</Link>}
        </td>
      </tr>
      {expanded && (
        <tr><td colSpan={11} style={{ background: "var(--panel)" }}>
          <div className="cols2">
            <div>
              <strong>RFQ</strong>
              <div className="hint">Created {when(e.created_at)} · updated {when(e.updated_at)} · source {e.source.replace("_", " ")}</div>
              <div className="hint">Response deadline {e.event?.rfx.response_deadline ?? e.draft?.response_deadline ?? "—"} · plants {(e.event?.rfx ?? e.draft)?.buyer.locations.map((l) => l.code).join(", ") || "—"}</div>
              {e.vendors_invited.length > 0 && <div className="hint">Invited: {e.vendors_invited.map((v) => v.vendor_name).join(", ")}</div>}
              {!!e.invitations?.length && <InvitationList invitations={e.invitations} />}
            </div>
            <div>
              <strong>Order allocation</strong>
              {e.award ? (
                <>
                  <div className="hint">{e.award.scenario_id} {e.award.scenario_name} · {e.award.lines_awarded} lines · {inr(e.award.total_value_inr)} · approved {when(e.award.approved_at)} · allocated {when(e.award.allocated_at)}</div>
                  <ul>{e.award.suppliers.map((s) => <li key={s.vendor_id}>{s.vendor} ({s.vendor_id}): {s.lines} lines, {inr(s.spend_inr)} ({s.spend_pct}%)</li>)}</ul>
                  {e.award_history.length > 0 && <div className="hint">Previous allocations: {e.award_history.map((h) => `${h.scenario_id} on ${when(h.allocated_at)}`).join("; ")}</div>}
                </>
              ) : <div className="hint">Not allocated. {e.status === "draft" ? "Release the RFQ, process bids, then approve and allocate on the Decision page." : "Approve a scenario on the Decision page, then click “Allocate order to vendor(s)”."}</div>}
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}
