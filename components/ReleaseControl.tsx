"use client";
/** Stage 2 → 3 hand-off: finalize the RFx, choose invited vendors/POCs and open the event for responses. */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { loadActiveEvent, saveActiveEvent, updateRfqs } from "@/lib/client/bid-store";
import { markReleased } from "@/lib/rfq/registry";
import { buildInvitations, type Invitation } from "@/lib/event/invitation";
import InvitationList from "./InvitationList";
import { newResponseToken, releaseBlockers, type ReleasedVendor } from "@/lib/event/released";
import type { RfxDraft } from "@/lib/rfx/schema";

export default function ReleaseControl({ rfx, draftId }: { rfx: RfxDraft | null; draftId: string }) {
  const [open, setOpen] = useState(false);
  const [vendors, setVendors] = useState<(ReleasedVendor & { invited: boolean })[]>([]);
  const [released, setReleased] = useState<string | null>(null);
  const [sent, setSent] = useState<Invitation[]>([]);

  useEffect(() => {
    const ev = loadActiveEvent();
    setReleased(ev ? `${ev.rfx.rfx_id} · released ${ev.released_at.slice(0, 16).replace("T", " ")}` : null);
    setSent(ev ? buildInvitations(ev) : []);
    fetch("/api/event").then((r) => r.json()).then((e: { vendors: ReleasedVendor[] }) => {
      const prior = new Map((ev?.vendors ?? []).map((v) => [v.vendor_id, v]));
      // Fresh, random response reference per vendor for a new release; kept across re-releases of the same event.
      setVendors(e.vendors.map(({ vendor_id, vendor_no, vendor_name, contact_email }) => {
        const p = prior.get(vendor_id);
        return { vendor_id, vendor_no, vendor_name, contact_email, ...(p ?? {}), response_token: p?.response_token ?? newResponseToken(), invited: ev ? !!p : true };
      }));
    }).catch(() => {});
  }, [open]);

  const invited = vendors.filter((v) => v.invited).map(({ invited: _i, ...v }) => v);
  const blockers = useMemo(() => (rfx ? releaseBlockers(rfx, invited) : ["Generate or load an RFx first."]), [rfx, invited]);

  function release() {
    if (!rfx || blockers.length) return;
    const ev = { status: "open" as const, released_at: new Date().toISOString(), rfx, vendors: invited };
    saveActiveEvent(ev);
    updateRfqs((l) => markReleased(l, draftId, ev));
    setSent(buildInvitations(ev));
    setReleased(`${rfx.rfx_id} · released ${ev.released_at.slice(0, 16).replace("T", " ")}`);
    window.dispatchEvent(new Event("rfx-event-changed"));
  }

  function revert() {
    saveActiveEvent(null);
    setReleased(null);
    setSent([]);
    window.dispatchEvent(new Event("rfx-event-changed"));
  }

  return (
    <>
      <button className="btn" onClick={() => setOpen((o) => !o)}>{released ? "Event released ✓" : "Finalize & release"}</button>
      {open && (
        <div className="release-panel">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong>Finalize RFx and open for vendor responses</strong>
            <span style={{ flex: 1 }} />
            <button className="btn small" onClick={() => setOpen(false)}>Close</button>
          </div>
          <p className="hint">The released RFx becomes the structure every vendor response is matched, extracted, normalized, compared and scored against. Releasing sends each invited vendor an invitation over the simulated email channel (preview below).</p>
          {released && <div className="evidence" style={{ borderLeftColor: "var(--ok)" }}>Active event: {released}. <Link href="/bids">Go to bid processing →</Link> <button className="btn small" onClick={revert}>Use Stage 1 demo event instead</button></div>}
          {released && <InvitationList invitations={sent} />}
          <strong style={{ fontSize: 13 }}>Invited vendors & POCs</strong>
          <table className="tbl"><thead><tr><th>Invite</th><th>Vendor ID</th><th>Name</th><th>POC email</th><th title="Vendors quote this reference in their response; it identifies vendor + event">Response ref</th></tr></thead>
            <tbody>{vendors.map((v, i) => (
              <tr key={v.vendor_id}>
                <td><input type="checkbox" checked={v.invited} onChange={(e) => setVendors((xs) => xs.map((x, j) => (j === i ? { ...x, invited: e.target.checked } : x)))} /></td>
                <td>{v.vendor_id}</td><td>{v.vendor_name}</td>
                <td><input className="fld" value={v.contact_email} onChange={(e) => setVendors((xs) => xs.map((x, j) => (j === i ? { ...x, contact_email: e.target.value } : x)))} /></td>
                <td><code>{v.response_token}</code></td>
              </tr>))}
            </tbody></table>
          {blockers.length > 0
            ? <div className="issues has-err"><strong>Fix before release ({blockers.length}):</strong><ul>{blockers.slice(0, 12).map((b, i) => <li key={i} className="error">{b}</li>)}</ul>
                <span className="hint">Tip: “Import CSV” on Line items accepts stage1/buyer/rfx_master.csv for the full SKU list.</span></div>
            : <div className="hint" style={{ color: "var(--ok)" }}>Ready: {rfx!.line_items.length} lines, {rfx!.technical_questionnaire.length} questions, {invited.length} vendors, responses due {rfx!.response_deadline}.</div>}
          <div style={{ marginTop: 8 }}><button className="btn primary" disabled={!!blockers.length} onClick={release}>{released ? "Re-release with current draft" : "Finalize & release RFx"}</button></div>
        </div>
      )}
    </>
  );
}
