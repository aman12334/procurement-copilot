"use client";
/** Stage 3 – Sourcing Analyst: grounded Q&A over processed bids, evidence and exceptions. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalBid } from "@/lib/bids/schema";
import Link from "next/link";
import { bidEnvelope, loadBids, loadChat, loadDecision, postJson, saveChat, saveDecision, withAudit } from "@/lib/client/bid-store";
import type { ScenarioSpec } from "@/lib/scenarios/types";
import type { ChartData } from "@/lib/analyst/charts";
import Chart, { download, formatChartValue } from "./Chart";

interface Citation { ref: string; kind: "tool" | "document"; label: string; source_file?: string; location?: string; text?: string }
interface Turn {
  question: string;
  ok: boolean;
  answer?: { answer_markdown: string; table: { title: string; columns: string[]; rows: string[][] } | null; unresolved_issues: string[]; cannot_compute: string | null };
  charts?: ChartData[];
  citations?: Citation[];
  invalid_citations?: string[];
  unsupported_numbers?: string[];
  tools?: { ref: string; tool: string; args: Record<string, unknown>; ok: boolean }[];
  resolved_question?: string;
  scenario_ids?: string[];
  new_scenarios?: { scenario_id: string; name: string }[];
  error?: string;
}

const SUGGESTED = [
  "Which qualified vendor is cheapest?",
  "Why is Vendor 4 not recommended even though it is cheaper?",
  "What if we split the award to the cheapest qualified vendor per line?",
  "Restrict it to a maximum of two suppliers.",
  "How much does that save compared with last year?",
  "What if I prioritize technical quality and accept up to 5% higher cost?",
  "Why is that recommendation better?",
  "What unresolved issues could change the decision?",
  "Show me the source for Vendor 2's freight condition.",
  "Which scenario would you recommend and why?",
];

export default function AnalystWorkspace() {
  const [bids, setBids] = useState<Record<string, CanonicalBid>>({});
  const [trustedOnly, setTrustedOnly] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setBids(loadBids()); setTurns(loadChat<Turn>()); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [turns, busy]);

  const all = Object.values(bids);
  const used = useMemo(() => all.filter((b) => !trustedOnly || b.review_state === "finalized"), [all, trustedOnly]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    const history = turns.filter((t) => t.ok && t.answer).slice(-6).map((t) => ({ question: t.question, resolved_question: t.resolved_question ?? t.question, answer_summary: t.answer!.answer_markdown.slice(0, 500), scenario_ids: t.scenario_ids ?? [] }));
    let decision = withAudit(loadDecision(), { type: "buyer_question", detail: question });
    const { data } = await postJson<{ ok: true; answer: Turn["answer"]; citations: Citation[]; invalid_citations: string[]; tool_results: Turn["tools"]; turn: { resolved_question: string; scenario_ids?: string[] }; new_scenarios: ScenarioSpec[] } | { ok: false; error: { message: string } }>(
      "/api/analyst", { question, history, bids: used.map(bidEnvelope), decision });
    if (data.ok) {
      for (const sc of data.new_scenarios) {
        decision = withAudit({ ...decision, custom_scenarios: [...decision.custom_scenarios, sc] },
          { type: sc.constraints.base_scenario_id ? "scenario_modified" : "scenario_created", scenario_id: sc.scenario_id, detail: `Analyst created "${sc.name}" from: ${question}`, data: { constraints: sc.constraints } });
      }
    }
    saveDecision(decision);
    const t: Turn = data.ok
      ? { question, ok: true, answer: data.answer, charts: (data as { charts?: ChartData[] }).charts ?? [], citations: data.citations, invalid_citations: data.invalid_citations, unsupported_numbers: (data as { unsupported_numbers?: string[] }).unsupported_numbers ?? [], tools: data.tool_results, resolved_question: data.turn.resolved_question,
          scenario_ids: data.turn.scenario_ids ?? [], new_scenarios: data.new_scenarios.map((x) => ({ scenario_id: x.scenario_id, name: x.name })) }
      : { question, ok: false, error: data.error.message };
    const next = [...turns, t];
    setTurns(next);
    saveChat(next);
    setBusy(false);
  }

  return (
    <div className="chat-page">
      <section className="chat" style={{ borderRight: "1px solid var(--line)" }}>
        <div className="log" ref={logRef}>
          {turns.length === 0 && (
            <div className="msg agent">Ask about the processed bids – prices, coverage, qualification, exceptions, what a vendor wrote, or scenarios.
              Numbers come from deterministic tools; quotes come from the vendors' documents. Follow-ups keep context within this event.</div>
          )}
          {turns.map((t, i) => (
            <div key={i} style={{ display: "contents" }}>
              <div className="msg buyer">{t.question}</div>
              <div className={`msg agent ${t.ok ? "" : "error"}`} style={{ maxWidth: "100%" }}>
                {t.ok && t.answer ? <AnswerView t={t} /> : t.error}
              </div>
            </div>
          ))}
          {busy && <div className="msg agent"><em>Planning, running tools and checking evidence… (can take a minute)</em></div>}
        </div>
        <div className="composer">
          <div className="suggest">{SUGGESTED.map((s) => <button key={s} className="btn small" disabled={busy || !used.length} onClick={() => ask(s)}>{s}</button>)}</div>
          <textarea style={{ minHeight: 70 }} value={input} placeholder={used.length ? "Ask the Sourcing Analyst…" : "Process vendor responses first (Bid Processing)."}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(input); }} />
          <div className="row">
            <button className="btn primary" disabled={busy || !input.trim() || !used.length} onClick={() => ask(input)}>Ask</button>
            <button className="btn" disabled={busy || !turns.length} onClick={() => { setTurns([]); saveChat([]); }}>New conversation</button>
            <span className="hint">⌘/Ctrl + Enter</span>
          </div>
        </div>
      </section>
      <aside className="side">
        <strong style={{ fontSize: 13 }}>Bid dataset</strong>
        <label className="hint"><input type="checkbox" checked={trustedOnly} onChange={(e) => setTrustedOnly(e.target.checked)} /> Finalized (trusted) bids only</label>
        {all.length === 0 && <div className="hint">No processed bids in this browser yet.</div>}
        {all.map((b) => (
          <div key={b.vendor.vendor_id} className="vcard" style={{ cursor: "default", opacity: used.includes(b) ? 1 : 0.45 }}>
            <h3>Vendor {b.vendor.vendor_no} · {b.vendor.vendor_name}</h3>
            <div className="row">
              <span className={`chip ${b.review_state}`}>{b.review_state.replace(/_/g, " ")}</span>
              <span className="chip">{b.processing_summary.quoted_lines}/{b.processing_summary.rfx_lines}</span>
              {b.processing_summary.open_review_items > 0 && <span className="chip needs_review">{b.processing_summary.open_review_items} open</span>}
            </div>
          </div>
        ))}
        {!trustedOnly && all.some((b) => b.review_state !== "finalized") && (
          <p className="hint">Some bids are not finalized; answers will call out open review items that affect them.</p>
        )}
      </aside>
    </div>
  );
}

function AnswerView({ t }: { t: Turn }) {
  const [openCite, setOpenCite] = useState<string | null>(null);
  const a = t.answer!;
  return (
    <div className="answer">
      <Markdown text={a.answer_markdown} />
      {a.table && (
        <div className="tbl-wrap">
          <div className="hint" style={{ fontWeight: 600 }}>{a.table.title}</div>
          <table className="tbl"><thead><tr>{a.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{a.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
        </div>
      )}
      {t.charts?.map((c, i) => <Chart key={i} c={c} />)}
      <div className="row" style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button className="btn small" onClick={() => download(`analyst-answer-${Date.now()}.md`, answerMarkdown(t), "text/markdown")}>Export answer (.md)</button>
        {a.table && <button className="btn small" onClick={() => download(`${slug(a.table!.title)}.csv`, tableCsv(a.table!))}>Table CSV</button>}
      </div>
      {a.cannot_compute && <div className="evidence" style={{ borderLeftColor: "var(--warn)" }}>Cannot compute: {a.cannot_compute}</div>}
      {a.unresolved_issues.length > 0 && (
        <div className="evidence" style={{ borderLeftColor: "var(--warn)" }}><strong>Unresolved issues affecting this answer</strong><ul>{a.unresolved_issues.map((u, i) => <li key={i}>{u}</li>)}</ul></div>
      )}
      {!!t.citations?.length && (
        <div style={{ marginTop: 6 }}>
          <span className="hint">Sources: </span>
          {t.citations.map((c) => (
            <span key={c.ref} className="cite" onClick={() => setOpenCite(openCite === c.ref ? null : c.ref)}>
              [{c.ref}] {c.kind === "document" ? `${c.label} · ${c.source_file} · ${c.location}` : c.label}{"  "}
            </span>
          ))}
          {openCite && (() => { const c = t.citations!.find((x) => x.ref === openCite)!; return c.text ? <div className="evidence"><span className="loc">{c.source_file} · {c.location}</span><br />“{c.text}”</div> : null; })()}
        </div>
      )}
      {!!t.unsupported_numbers?.length && (
        <div className="evidence" style={{ borderLeftColor: "var(--err)" }}>Check: these figures were not found in the tool results or evidence and may be unsupported: {t.unsupported_numbers.join(", ")}</div>
      )}
      {!!t.new_scenarios?.length && (
        <div className="evidence" style={{ borderLeftColor: "var(--ok)" }}>New scenario{t.new_scenarios.length > 1 ? "s" : ""}: {t.new_scenarios.map((x) => `${x.scenario_id} ${x.name}`).join(", ")} – <Link href="/decision">view, compare or approve in Decision →</Link></div>
      )}
      <details style={{ marginTop: 6 }}>
        <summary className="hint">How this was answered</summary>
        <div className="hint">Resolved question: {t.resolved_question}{t.scenario_ids?.length ? ` · scenarios: ${t.scenario_ids.join(", ")}` : ""}</div>
        {t.tools?.map((x) => <div key={x.ref} className="hint">[{x.ref}] {x.tool}({JSON.stringify(x.args)}) {x.ok ? "" : "– error"}</div>)}
        {!!t.invalid_citations?.length && <div className="hint" style={{ color: "var(--err)" }}>Removed unsupported citations: {t.invalid_citations.join(", ")}</div>}
      </details>
    </div>
  );
}

/** Minimal, safe markdown: paragraphs, bullet lists, **bold** (no HTML injection). */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>)}</ul>;
        return <p key={i}>{lines.map((l, j) => <span key={j}>{inline(l)}{j < lines.length - 1 && <br />}</span>)}</p>;
      })}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function tableCsv(t: { columns: string[]; rows: string[][] }) {
  return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

/** The whole answer as Markdown: text, table, chart data (as tables), sources – for pasting into an email or memo. */
function answerMarkdown(t: Turn): string {
  const a = t.answer!;
  const md = [`## ${t.question}`, "", a.answer_markdown, ""];
  if (a.table) md.push(`**${a.table.title}**`, "", `| ${a.table.columns.join(" | ")} |`, `| ${a.table.columns.map(() => "---").join(" | ")} |`, ...a.table.rows.map((r) => `| ${r.join(" | ")} |`), "");
  for (const c of t.charts ?? []) {
    md.push(`**${c.title}** (computed from ${c.source})`, "", "| | | value | note |", "|---|---|---|---|");
    for (const g of c.groups) for (const b of g.bars) md.push(`| ${g.label} | ${b.label} | ${formatChartValue(b.value, c.unit)} | ${b.note ?? ""} |`);
    md.push("");
  }
  if (a.unresolved_issues.length) md.push("**Unresolved issues**", ...a.unresolved_issues.map((u) => `- ${u}`), "");
  if (t.citations?.length) md.push("**Sources**", ...t.citations.map((c) => `- [${c.ref}] ${c.kind === "document" ? `${c.label} · ${c.source_file} · ${c.location}` : c.label}`));
  return md.join("\n");
}
