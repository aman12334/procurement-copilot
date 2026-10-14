"use client";
/** Right panel: renders every RFx section, editable in place when `editing` is on. */
import { useRef } from "react";
import { lineItemsFromCsv } from "@/lib/rfx/csv";
import * as E from "@/lib/rfx/edit";
import {
  COMMERCIAL_TERM_KEYS,
  SECTIONS,
  type LineItem,
  type Question,
  type RfxDraft,
  type SectionId,
} from "@/lib/rfx/schema";
import type { ValidationIssue } from "@/lib/rfx/validate";
import { Num, Section, SourceBadge, Text } from "./ui";

type Update = (fn: (r: RfxDraft) => RfxDraft) => void;
type SecProps = { id: SectionId; label: string; busy: boolean; onRegenerate: (i: string) => void };
interface Props {
  rfx: RfxDraft;
  editing: boolean;
  update: Update;
  issues: ValidationIssue[];
  busy: boolean;
  onRegenerate: (section: SectionId, instruction: string) => void;
  onAskInChat: (text: string) => void;
  onNotice: (text: string) => void;
}

const human = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const ANSWER_TYPES: Question["answer_type"][] = ["yes_no", "numeric", "text", "multiple_choice", "document_upload"];

export default function DraftView(p: Props) {
  const { rfx, editing, update, busy } = p;
  const set = (path: string, v: unknown) => update((r) => E.setPath(r, path, v));
  const sec = (id: SectionId): SecProps => ({ id, label: SECTIONS[id].label, busy, onRegenerate: (i: string) => p.onRegenerate(id, i) });
  const errs = p.issues.filter((i) => i.severity === "error");

  return (
    <div>
      <div className="legend">
        Source: <SourceBadge source="explicit" /> stated by buyer <SourceBadge source="inferred" /> derived
        <SourceBadge source="generated_assumption" /> drafting default <SourceBadge source="unresolved" /> needs input
      </div>

      <div className={`issues ${errs.length ? "has-err" : ""}`}>
        <strong>Validation:</strong>{" "}
        {p.issues.length === 0 ? "all checks passed." : `${errs.length} error(s), ${p.issues.length - errs.length} warning(s)`}
        {p.issues.length > 0 && (
          <ul>{p.issues.map((i, n) => <li key={n} className={i.severity}><code>{i.path}</code> – {i.message}</li>)}</ul>
        )}
      </div>

      {/* ---------------- overview */}
      <Section {...sec("overview")}>
        <div className="grid2">
          <span className="k">RFx ID</span><Text editing={editing} value={rfx.rfx_id} onChange={(v) => set("rfx_id", v ?? "")} />
          <span className="k">Title</span><Text editing={editing} value={rfx.title} onChange={(v) => set("title", v ?? "")} />
          <span className="k">Category</span><Text editing={editing} value={rfx.category} onChange={(v) => set("category", v ?? "")} />
          <span className="k">Buyer company</span><Text editing={editing} value={rfx.buyer.company} placeholder="unresolved" onChange={(v) => set("buyer.company", v)} />
          <span className="k">Business unit</span><Text editing={editing} value={rfx.buyer.business_unit} onChange={(v) => set("buyer.business_unit", v)} />
          <span className="k">Response deadline</span>
          {editing
            ? <input className="fld" type="date" value={rfx.response_deadline ?? ""} onChange={(e) => update((r) => {
                const n = E.setPath(r, "response_deadline", e.target.value || null);
                if (e.target.value) n.unresolved_fields = n.unresolved_fields.filter((u) => u.field !== "response_deadline");
                return n;
              })} />
            : <Text editing={false} value={rfx.response_deadline} placeholder="unresolved" onChange={() => {}} />}
          <span className="k">Locations</span>
          <div>
            <table className="tbl"><thead><tr><th>Code</th><th>Name</th><th>State</th><th>Address</th>{editing && <th />}</tr></thead>
              <tbody>{rfx.buyer.locations.map((l, i) => (
                <tr key={i}>
                  <td><Text editing={editing} value={l.code} onChange={(v) => set(`buyer.locations.${i}.code`, (v ?? "").toUpperCase())} /></td>
                  <td><Text editing={editing} value={l.name} onChange={(v) => set(`buyer.locations.${i}.name`, v ?? "")} /></td>
                  <td><Text editing={editing} value={l.state} onChange={(v) => set(`buyer.locations.${i}.state`, v)} /></td>
                  <td><Text editing={editing} value={l.address} onChange={(v) => set(`buyer.locations.${i}.address`, v)} /></td>
                  {editing && <td><button className="btn small danger" onClick={() => update((r) => { const n = structuredClone(r); n.buyer.locations.splice(i, 1); return n; })}>✕</button></td>}
                </tr>))}
              </tbody></table>
            {rfx.buyer.locations.length === 0 && <span className="val nil">No locations – unresolved</span>}
            {editing && <button className="btn small" style={{ marginTop: 6 }} onClick={() => update((r) => {
              const n = structuredClone(r); n.buyer.locations.push({ code: "", name: "", address: null, state: null });
              n.unresolved_fields = n.unresolved_fields.filter((u) => u.field !== "buyer.locations"); return n;
            })}>Add location</button>}
          </div>
        </div>
      </Section>

      {/* ---------------- scope */}
      <Section {...sec("scope")}>
        <div className="grid2">
          <span className="k">Description</span><Text editing={editing} multiline value={rfx.scope.description} onChange={(v) => set("scope.description", v ?? "")} />
          <span className="k">Annual volume</span><Num editing={editing} value={rfx.scope.annual_volume} onChange={(v) => set("scope.annual_volume", v)} />
          <span className="k">Volume unit</span><Text editing={editing} value={rfx.scope.annual_volume_uom} onChange={(v) => set("scope.annual_volume_uom", v)} />
          <span className="k">Line count (stated)</span><Num editing={editing} value={rfx.scope.line_count} onChange={(v) => set("scope.line_count", v)} />
          <span className="k">Currency</span><Text editing={editing} value={rfx.scope.currency} onChange={(v) => set("scope.currency", v ?? "")} />
          <span className="k">Contract period</span><Text editing={editing} value={rfx.scope.contract_period} onChange={(v) => set("scope.contract_period", v)} />
          <span className="k">Partial bids allowed</span>
          {editing
            ? <select className="sel" value={String(rfx.scope.partial_bids_allowed)} onChange={(e) => set("scope.partial_bids_allowed", e.target.value === "null" ? null : e.target.value === "true")}>
                <option value="true">Yes</option><option value="false">No</option><option value="null">Not specified</option></select>
            : <span className="val">{rfx.scope.partial_bids_allowed === null ? "Not specified" : rfx.scope.partial_bids_allowed ? "Yes" : "No"}</span>}
        </div>
      </Section>

      <LineItems {...p} sec={sec("line_items")} />

      {/* ---------------- commercial requirements */}
      <Section {...sec("commercial_requirements")} count={`${rfx.commercial_requirements.length} fields vendors must quote`}>
        <table className="tbl"><thead><tr><th>Field</th><th>Description</th><th>Required</th>{editing && <th />}</tr></thead>
          <tbody>{rfx.commercial_requirements.map((c, i) => (
            <tr key={i}>
              <td><Text editing={editing} value={c.field} onChange={(v) => set(`commercial_requirements.${i}.field`, v ?? "")} /></td>
              <td className="wide"><Text editing={editing} value={c.description} onChange={(v) => set(`commercial_requirements.${i}.description`, v ?? "")} /></td>
              <td>{editing ? <input type="checkbox" checked={c.required} onChange={(e) => set(`commercial_requirements.${i}.required`, e.target.checked)} /> : c.required ? "Yes" : "No"}</td>
              {editing && <td><button className="btn small danger" onClick={() => update((r) => { const n = structuredClone(r); n.commercial_requirements.splice(i, 1); return n; })}>✕</button></td>}
            </tr>))}
          </tbody></table>
        {editing && <button className="btn small" style={{ marginTop: 8 }} onClick={() => update((r) => { const n = structuredClone(r); n.commercial_requirements.push({ field: "", description: "", required: false }); return n; })}>Add field</button>}
      </Section>

      <Questionnaire {...p} sec={sec("technical_questionnaire")} />

      {(["mandatory_requirements", "preferred_requirements"] as const).map((list) => (
        <Section key={list} {...sec(list)} count={`${rfx[list].length}`}>
          {rfx[list].length === 0 && <span className="val nil">None</span>}
          {rfx[list].map((r, i) => (
            <div className="req-row" key={r.id + i}>
              <Text editing={editing} value={r.id} onChange={(v) => update((d) => E.updateRequirement(d, list, i, { id: v ?? "" }))} />
              <Text editing={editing} value={r.area} onChange={(v) => update((d) => E.updateRequirement(d, list, i, { area: v ?? "" }))} />
              <div><Text editing={editing} multiline value={r.requirement} onChange={(v) => update((d) => E.updateRequirement(d, list, i, { requirement: v ?? "" }))} /> <SourceBadge source={r.source} /></div>
              <button className="btn small" title="Move to the other list" onClick={() => update((d) => E.toggleRequirementType(d, list, i))}>
                {list === "mandatory_requirements" ? "→ Preferred" : "→ Mandatory"}</button>
              {editing ? <button className="btn small danger" onClick={() => update((d) => E.removeRequirement(d, list, i))}>✕</button> : <span />}
            </div>
          ))}
          {editing && <button className="btn small" style={{ marginTop: 8 }} onClick={() => update((d) => E.addRequirement(d, list))}>Add requirement</button>}
        </Section>
      ))}

      {/* ---------------- evaluation */}
      <Section {...sec("evaluation_criteria")} extra={<WeightTotal values={rfx.evaluation_criteria.map((c) => c.weight)} unit="%" />}>
        <table className="tbl"><thead><tr><th>Criterion</th><th>Description</th><th>Weight %</th><th>Source</th>{editing && <th />}</tr></thead>
          <tbody>{rfx.evaluation_criteria.map((c, i) => (
            <tr key={i}>
              <td><Text editing={editing} value={c.name} onChange={(v) => set(`evaluation_criteria.${i}.name`, v ?? "")} /></td>
              <td className="wide"><Text editing={editing} value={c.description} onChange={(v) => set(`evaluation_criteria.${i}.description`, v ?? "")} /></td>
              <td style={{ width: 90 }}><Num editing={editing} value={c.weight} onChange={(v) => update((r) => E.setCriterionWeight(r, i, v ?? 0))} /></td>
              <td><SourceBadge source={c.source} /></td>
              {editing && <td><button className="btn small danger" onClick={() => update((r) => { const n = structuredClone(r); n.evaluation_criteria.splice(i, 1); return n; })}>✕</button></td>}
            </tr>))}
          </tbody></table>
        {editing && <button className="btn small" style={{ marginTop: 8 }} onClick={() => update((r) => {
          const n = structuredClone(r); n.evaluation_criteria.push({ criterion_id: `EC-${n.evaluation_criteria.length + 1}`, name: "", description: "", weight: 0, source: "explicit" }); return n;
        })}>Add criterion</button>}
      </Section>

      {/* ---------------- commercial terms */}
      <Section {...sec("commercial_terms")}>
        <SourcedGrid rfx={rfx} editing={editing} update={update} base="commercial_terms" keys={COMMERCIAL_TERM_KEYS} />
      </Section>

      {/* ---------------- delivery */}
      <Section {...sec("delivery_requirements")}>
        <div className="grid2" style={{ marginBottom: 8 }}>
          <span className="k">Max lead time (days)</span>
          <Num editing={editing} value={rfx.delivery_requirements.lead_time_days} placeholder="unresolved" onChange={(v) => set("delivery_requirements.lead_time_days", v)} />
        </div>
        <SourcedGrid rfx={rfx} editing={editing} update={update} base="delivery_requirements"
          keys={["lead_time", "delivery_terms", "delivery_schedule", "packaging_and_palletisation", "service_level"]} />
      </Section>

      {/* ---------------- assumptions */}
      <Section {...sec("assumptions")} count={`${rfx.assumptions.length}`}>
        {rfx.assumptions.length === 0 && <span className="val nil">None</span>}
        {rfx.assumptions.map((a, i) => (
          <div className="list-item" key={a.id + i}>
            <div><span className="badge generated_assumption">{a.id}</span> <code>{a.field}</code> — {a.assumption}
              <div className="sub">{a.rationale}</div></div>
            {editing && <button className="btn small danger" onClick={() => update((r) => { const n = structuredClone(r); n.assumptions.splice(i, 1); return n; })}>✕</button>}
          </div>))}
      </Section>

      {/* ---------------- unresolved */}
      <Section {...sec("unresolved_fields")} count={`${rfx.unresolved_fields.length}`}>
        {rfx.unresolved_fields.length === 0 && <span className="val nil">Nothing unresolved</span>}
        {rfx.unresolved_fields.map((u, i) => (
          <div className="list-item" key={u.field + i}>
            <div><span className={`badge ${u.criticality}`}>{u.criticality}</span> <code>{u.field}</code> — {u.reason}
              <div className="sub">Ask: {u.suggested_question}</div></div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn small" onClick={() => p.onAskInChat(`${u.field}: `)}>Answer in chat</button>
              {editing && <button className="btn small danger" onClick={() => update((r) => { const n = structuredClone(r); n.unresolved_fields.splice(i, 1); return n; })}>✕</button>}
            </div>
          </div>))}
      </Section>
    </div>
  );
}

function WeightTotal({ values, unit }: { values: number[]; unit: string }) {
  const t = Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
  return <span className={`total ${t === 100 ? "good" : "bad"}`}>Total {t}{unit}{t === 100 ? " ✓" : " (must be 100)"}</span>;
}

function SourcedGrid({ rfx, editing, update, base, keys }: {
  rfx: RfxDraft; editing: boolean; update: Update; base: "commercial_terms" | "delivery_requirements"; keys: readonly string[];
}) {
  const obj = rfx[base] as unknown as Record<string, { value: string | null; source: Parameters<typeof SourceBadge>[0]["source"]; note: string | null }>;
  return (
    <table className="tbl"><thead><tr><th>Term</th><th>Value</th><th>Source</th><th>Note</th></tr></thead>
      <tbody>{keys.map((k) => (
        <tr key={k}>
          <td style={{ whiteSpace: "nowrap" }}>{human(k)}</td>
          <td className="wide"><Text editing={editing} value={obj[k].value} placeholder="unresolved" onChange={(v) => update((r) => E.setSourcedValue(r, `${base}.${k}`, v))} /></td>
          <td><SourceBadge source={obj[k].source} /></td>
          <td className="hint">{obj[k].note}</td>
        </tr>))}
      </tbody></table>
  );
}

function LineItems(p: Props & { sec: SecProps }) {
  const { rfx, editing, update } = p;
  const file = useRef<HTMLInputElement>(null);
  const upd = (i: number, patch: Partial<LineItem>) => update((r) => E.updateLineItem(r, i, patch));
  const cols: [keyof LineItem, string, "text" | "num", boolean?][] = [
    ["line_id", "Line ID", "text"], ["sku", "SKU", "text"], ["item_description", "Description", "text", true], ["category", "Category", "text"],
    ["style", "Carton type", "text"], ["ply", "Ply", "num"], ["flute", "Flute", "text"], ["dimensions_text", "Dimensions (mm)", "text"],
    ["combined_board_gsm", "GSM", "num"], ["min_bursting_factor_outer_liner", "BF", "num"], ["recycled_content_min_pct", "Recycled %", "num"],
    ["printing", "Print", "text"], ["coating", "Coating", "text"], ["annual_qty", "Annual qty", "num"], ["uom", "UoM", "text"],
  ];
  const total = rfx.line_items.reduce((s, l) => s + (l.annual_qty ?? 0), 0);

  async function importCsv(f: File) {
    const { items, errors } = lineItemsFromCsv(await f.text(), rfx.category);
    if (errors.length) p.onNotice(`CSV import: ${errors.length} problem(s):\n${errors.slice(0, 5).join("\n")}`);
    if (items.length) {
      update((r) => E.replaceLineItems(r, items));
      p.onNotice(`Imported ${items.length} line items from ${f.name}.`);
    }
  }

  return (
    <Section {...p.sec} count={`${rfx.line_items.length} lines · ${total.toLocaleString("en-IN")} units`}
      extra={<>
        <button className="btn small" onClick={() => update((r) => E.addLineItem(r))}>Add line item</button>
        <button className="btn small" onClick={() => file.current?.click()} title="CSV with rfx_master.csv column names">Import CSV</button>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ""; }} />
      </>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}<th>Plant</th><th>Notes</th><th>Source</th><th /></tr></thead>
          <tbody>{rfx.line_items.map((l, i) => (
            <tr key={i}>
              {cols.map(([k, , kind, wide]) => (
                <td key={k} className={wide ? "wide" : undefined}>
                  {kind === "num"
                    ? <Num editing={editing} value={l[k] as number | null} onChange={(v) => upd(i, { [k]: v } as Partial<LineItem>)} />
                    : <Text editing={editing} value={l[k] as string | null} onChange={(v) => upd(i, { [k]: k === "line_id" || k === "item_description" || k === "uom" || k === "category" ? v ?? "" : v } as Partial<LineItem>)} />}
                </td>))}
              <td>{editing
                ? <select className="sel" value={l.delivery_plant ?? ""} onChange={(e) => upd(i, { delivery_plant: e.target.value || null })}>
                    <option value="">—</option>{rfx.buyer.locations.map((x) => <option key={x.code} value={x.code}>{x.code}</option>)}</select>
                : <span className="val">{l.delivery_plant ?? "—"}</span>}</td>
              <td className="wide"><Text editing={editing} value={l.notes} onChange={(v) => upd(i, { notes: v })} /></td>
              <td><SourceBadge source={l.source} /></td>
              <td><button className="btn small danger" title="Remove line" onClick={() => update((r) => E.removeLineItem(r, i))}>✕</button></td>
            </tr>))}
          </tbody>
        </table>
      </div>
      {rfx.scope.line_count !== null && rfx.line_items.length < rfx.scope.line_count &&
        <p className="hint">Scope states {rfx.scope.line_count} SKUs; {rfx.line_items.length} defined. Import your SKU list (CSV, rfx_master format) or add lines.</p>}
    </Section>
  );
}

function Questionnaire(p: Props & { sec: SecProps }) {
  const { rfx, editing, update } = p;
  const upd = (i: number, patch: Partial<Question>) => update((r) => E.updateQuestion(r, i, patch));
  return (
    <Section {...p.sec} count={`${rfx.technical_questionnaire.length} questions`}
      extra={<>
        <WeightTotal values={rfx.technical_questionnaire.map((q) => q.max_points)} unit=" pts" />
        <button className="btn small" onClick={() => update((r) => E.addQuestion(r))}>Add question</button>
      </>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>ID</th><th>Topic</th><th>Question</th><th>Answer</th><th>Mandatory</th><th>Points</th><th>Scoring rule</th><th>Rationale</th><th>Source</th><th /></tr></thead>
          <tbody>{rfx.technical_questionnaire.map((q, i) => (
            <tr key={i}>
              <td><Text editing={editing} value={q.qid} onChange={(v) => upd(i, { qid: v ?? "" })} /></td>
              <td><Text editing={editing} value={q.topic} onChange={(v) => upd(i, { topic: v ?? "" })} /></td>
              <td className="wide"><Text editing={editing} multiline value={q.question} onChange={(v) => upd(i, { question: v ?? "" })} /></td>
              <td>{editing
                ? <select className="sel" value={q.answer_type} onChange={(e) => upd(i, { answer_type: e.target.value as Question["answer_type"] })}>
                    {ANSWER_TYPES.map((a) => <option key={a}>{a}</option>)}</select>
                : <span className="val">{q.answer_type}</span>}</td>
              <td>
                <button className={`btn small`} title="Toggle mandatory / preferred" onClick={() => upd(i, { mandatory: !q.mandatory })}>
                  <span className={`badge ${q.mandatory ? "mand" : "pref"}`}>{q.mandatory ? "mandatory" : "preferred"}</span></button>
              </td>
              <td style={{ width: 80 }}><Num editing={editing} value={q.max_points} onChange={(v) => upd(i, { max_points: v ?? 0 })} /></td>
              <td className="wide"><Text editing={editing} multiline value={q.scoring_rule} onChange={(v) => upd(i, { scoring_rule: v ?? "" })} /></td>
              <td className="wide"><Text editing={editing} multiline value={q.rationale} onChange={(v) => upd(i, { rationale: v ?? "" })} /></td>
              <td><SourceBadge source={q.source} /></td>
              <td><button className="btn small danger" title="Remove question" onClick={() => update((r) => E.removeQuestion(r, i))}>✕</button></td>
            </tr>))}
          </tbody>
        </table>
      </div>
      <div className="grid2" style={{ marginTop: 10 }}>
        <span className="k">Qualification min score</span>
        <Num editing={editing} value={rfx.qualification.min_total_score} onChange={(v) => update((r) => E.setPath(r, "qualification.min_total_score", v))} />
        <span className="k">Qualification rule</span>
        <Text editing={editing} multiline value={rfx.qualification.rule} onChange={(v) => update((r) => E.setPath(r, "qualification.rule", v ?? ""))} />
      </div>
    </Section>
  );
}
