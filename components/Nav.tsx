"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { loadActiveEvent, loadRfqs } from "@/lib/client/bid-store";

const LINKS = [
  { href: "/", label: "1 · RFx" },
  { href: "/bids", label: "2 · Bid processing & review" },
  { href: "/compare", label: "3 · Comparison" },
  { href: "/analyst", label: "4 · Sourcing Analyst" },
  { href: "/decision", label: "5 · Decision & export" },
];

export default function Nav() {
  const path = usePathname();
  const [event, setEvent] = useState<string>("");
  const [rfqCount, setRfqCount] = useState(0);
  useEffect(() => {
    const read = () => { const e = loadActiveEvent(); setEvent(e ? `Event: ${e.rfx.rfx_id} (released RFx · open)` : "Event: Stage 1 demo RFx"); };
    const readRfqs = () => setRfqCount(loadRfqs().length);
    read(); readRfqs();
    window.addEventListener("rfx-event-changed", read);
    window.addEventListener("rfq-register-changed", readRfqs);
    return () => { window.removeEventListener("rfx-event-changed", read); window.removeEventListener("rfq-register-changed", readRfqs); };
  }, [path]);
  return (
    <nav className="nav">
      <strong>Procurement Copilot</strong>
      <span className="nav-event" title="All bid processing, comparison, analysis and decisions use this RFx">{event}</span>
      <Link href="/rfqs" className={path === "/rfqs" ? "active" : ""} title="All RFQs generated, released and awarded">RFQ register ({rfqCount})</Link>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? "active" : ""}>{l.label}</Link>
      ))}
      {(() => {
        const i = LINKS.findIndex((l) => l.href === path);
        const next = i >= 0 && i < LINKS.length - 1 ? LINKS[i + 1] : null;
        return next ? <Link href={next.href} className="next">Next: {next.label.replace(/^\d · /, "")} →</Link> : null;
      })()}
    </nav>
  );
}
