"use client";
/** Outbound invitations (simulated email): what each vendor received, previewable and downloadable as .eml. */
import { useState } from "react";
import { toEml, type Invitation } from "@/lib/event/invitation";
import { download } from "./Chart";

export default function InvitationList({ invitations }: { invitations: Invitation[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!invitations.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <strong style={{ fontSize: 13 }}>Invitations sent ({invitations.length}) · channel: simulated email</strong>
      <div className="hint">Generated from the released RFx; no real email leaves the app. Each vendor's response ref identifies their reply.</div>
      <table className="tbl"><thead><tr><th>Vendor</th><th>To</th><th>Response ref</th><th>Sent</th><th /></tr></thead>
        <tbody>{invitations.map((inv) => (
          <tr key={inv.vendor_id}>
            <td>{inv.vendor_name}</td><td>{inv.to}</td><td><code>{inv.response_token ?? "—"}</code></td>
            <td><span className="chip finalized">sent (simulated)</span> <span className="hint">{new Date(inv.sent_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></td>
            <td style={{ whiteSpace: "nowrap" }}>
              <button className="btn small" onClick={() => setOpen(open === inv.vendor_id ? null : inv.vendor_id)}>{open === inv.vendor_id ? "Hide" : "Preview"}</button>{" "}
              <button className="btn small" onClick={() => download(`${inv.vendor_id}-invitation.eml`, toEml(inv), "message/rfc822")}>.eml</button>
            </td>
          </tr>))}
        </tbody></table>
      {open && (() => { const inv = invitations.find((x) => x.vendor_id === open)!; return (
        <div className="evidence" style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>
          <div className="hint">From: {inv.from} · To: {inv.to}</div><strong>{inv.subject}</strong>{"\n\n"}{inv.body}
        </div>); })()}
    </div>
  );
}
