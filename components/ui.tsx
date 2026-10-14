"use client";
import { useState, type ReactNode } from "react";
import type { Source } from "@/lib/rfx/schema";

const SOURCE_LABEL: Record<Source, string> = {
  explicit: "explicit", inferred: "inferred", generated_assumption: "assumption", unresolved: "unresolved",
};

export function SourceBadge({ source }: { source: Source }) {
  return <span className={`badge ${source}`} title={`Source: ${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function Text({ value, onChange, editing, multiline, placeholder, wide }: {
  value: string | null; onChange: (v: string | null) => void; editing: boolean; multiline?: boolean; placeholder?: string; wide?: boolean;
}) {
  if (!editing) return value ? <span className="val">{value}</span> : <span className="val nil">{placeholder ?? "—"}</span>;
  const common = { className: "fld", value: value ?? "", placeholder, style: wide ? { minWidth: 220 } : undefined };
  return multiline
    ? <textarea {...common} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
    : <input {...common} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />;
}

export function Num({ value, onChange, editing, placeholder }: {
  value: number | null; onChange: (v: number | null) => void; editing: boolean; placeholder?: string;
}) {
  if (!editing) return value === null ? <span className="val nil">{placeholder ?? "—"}</span> : <span className="val">{value.toLocaleString("en-IN")}</span>;
  return (
    <input className="fld" type="number" value={value ?? ""} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
  );
}

export function Section({ id, label, count, children, onRegenerate, busy, extra }: {
  id: string; label: string; count?: string; children: ReactNode; extra?: ReactNode;
  onRegenerate?: (instruction: string) => void; busy?: boolean;
}) {
  return (
    <section className="section" id={`sec-${id}`}>
      <header>
        <h2>{label}</h2>
        {count && <span className="count">{count}</span>}
        <span className="spacer" />
        {extra}
        {onRegenerate && <RegenerateControl onRegenerate={onRegenerate} busy={busy} />}
      </header>
      <div className="body">{children}</div>
    </section>
  );
}

function RegenerateControl({ onRegenerate, busy }: { onRegenerate: (instruction: string) => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) return <button className="btn small" disabled={busy} onClick={() => setOpen(true)}>Regenerate section</button>;
  return (
    <div className="regen">
      <input className="fld" autoFocus placeholder="Optional instruction, e.g. 'add a question on pallet compliance'" value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { onRegenerate(text); setOpen(false); setText(""); } }} />
      <button className="btn small primary" disabled={busy} onClick={() => { onRegenerate(text); setOpen(false); setText(""); }}>Regenerate</button>
      <button className="btn small" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
