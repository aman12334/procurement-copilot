"use client";
/** Stage 3 – Bid Processing: process vendor responses, inspect canonical bids and evidence, close the HITL loop. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalBid, CanonicalLineItem, Evidence, ReviewItem } from "@/lib/bids/schema";
import { bidEnvelope, commitProcessing, fileToUpload, loadBids, loadJobs, postJson, saveBids, saveJobs } from "@/lib/client/bid-store";
import type { IngestionJob } from "@/lib/ingestion/queue";

interface EventVendor { vendor_id: string; vendor_no: number; vendor_name: string; response_files: string[]; alternate_files: string[] }
interface EventInfo { rfx_id: string; title: string; lines: { line_id: string }[]; vendors: EventVendor[]; evaluation: { usd_inr: number; fx_source: string; freight_loading_pct: number } }
type ApiErr = { ok: false; error: { code: string; message: string; details: string[] } };
type Tab = "overview" | "lines" | "review" | "questionnaire" | "debug";

const STATE_LABEL: Record<string, string> = {
  not_processed: "Not processed", processing: "Processing…", processed: "Processed",
  processed_with_exceptions: "Processed with exceptions", needs_review: "Needs review", finalized: "Finalized", error: "Failed",
};
const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));

export default function BidWorkspace() {
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [bids, setBids] = useState<Record<string, CanonicalBid>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const uploadFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBids(loadBids());
    setJobs(loadJobs());
    postJson<EventInfo>("/api/event", {}).then(({ data: e }) => { setEvent(e); setSel((s) => s ?? e.vendors[0]?.vendor_id ?? null); });
  }, []);
  const persist = (next: Record<string, CanonicalBid>) => { setBids(next); saveBids(next); };

  /** One job list for every path (inbound email, manual load, upload); functional updates keep parallel runs safe. */
  const upsertJob = (j: IngestionJob) => setJobs((prev) => { const next = [...prev.filter((x) => x.job_id !== j.job_id), j]; saveJobs(next); return next; });

  /** Runs a queued/retrying job. Only a validated bid replaces the active one; failures are recorded and the previous bid kept. */
  async function processJob(job: IngestionJob, source: string) {
    const vid = job.vendor_id!;
    upsertJob({ ...job, state: "processing" });
    setBusy((b) => ({ ...b, [vid]: true }));
    setErrors((e) => ({ ...e, [vid]: "" }));
    const { data } = await postJson<{ ok: true; job: IngestionJob; bid: CanonicalBid | null } | ApiErr>("/api/ingest", { action: "process", job });
    setBusy((b) => ({ ...b, [vid]: false }));
    const error = !data.ok ? data.error : data.bid ? null
      : { code: data.job.last_error?.code ?? "PROCESSING_FAILED", message: data.job.last_error?.message ?? "Processing failed.", details: [] as string[] };
    upsertJob(data.ok ? data.job : { ...job, last_error: { code: data.error.code, kind: null, message: data.error.message } });
    const next = commitProcessing(vid, data.ok && data.bid ? { ok: true, bid: data.bid } : { ok: false, error: error! }, source);
    setBids(next.active);
    if (!error) { setSel(vid); setTab("overview"); }
    else setErrors((e) => ({ ...e, [vid]: `${error.message}${error.details?.length ? " – " + error.details.slice(0, 3).join("; ") : ""}${next.active[vid] ? " (previous bid kept)" : ""}${data.ok && data.job.state === "retrying" ? " – retry from Inbound responses" : ""}` }));
  }

  /** "Load & process" and "Upload…" go through the same ingestion queue as inbound email (buyer-confirmed identity). */
  async function process(v: EventVendor, upload?: { name: string; data_base64: string }[]) {
    setBusy((b) => ({ ...b, [v.vendor_id]: true }));
    setErrors((e) => ({ ...e, [v.vendor_id]: "" }));
    const body = upload ? { action: "submit", vendor_id: v.vendor_id, upload } : { action: "submit", vendor_id: v.vendor_id, files: [variant[v.vendor_id] ?? v.response_files[0]] };
    const { data } = await postJson<{ ok: true; job: IngestionJob } | ApiErr>("/api/ingest", body);
    if (!data.ok) {
      setBusy((b) => ({ ...b, [v.vendor_id]: false }));
      setErrors((e) => ({ ...e, [v.vendor_id]: data.error.message }));
      return;
    }
    upsertJob(data.job);
    await processJob(data.job, upload ? "upload" : "stored response");
  }

  async function review(bid: CanonicalBid, body: Record<string, unknown>) {
    const { data } = await postJson<{ ok: true; bid: CanonicalBid } | ApiErr>("/api/bids/review", { bid: bidEnvelope(bid), ...body });
    if (data.ok) persist({ ...bids, [bid.vendor.vendor_id]: data.bid });
    else alert(data.error.message);
  }

  async function onUpload(files: FileList | null) {
    const v = event?.vendors.find((x) => x.vendor_id === uploadFor.current);
    if (!files?.length || !v) return;
    try { await process(v, await Promise.all([...files].map(fileToUpload))); }
    catch (e) { setErrors((er) => ({ ...er, [v.vendor_id]: (e as Error).message })); }
  }

  const bid = sel ? bids[sel] : undefined;
  const vendor = event?.vendors.find((v) => v.vendor_id === sel);

  return (
    <div className="page">
      <aside className="side">
        {event && <InboundQueue vendors={event.vendors} jobs={jobs} upsertJob={upsertJob} processJob={processJob} />}
        <div className="hint">{event ? <>{event.rfx_id} · {event.lines.length} RFx lines · FX 1 USD = ₹{event.evaluation.usd_inr} · freight loading {event.evaluation.freight_loading_pct}%</> : "Loading event…"}</div>
        {event?.vendors.map((v) => {
          const b = bids[v.vendor_id];
          const state = busy[v.vendor_id] ? "processing" : errors[v.vendor_id] ? "error" : b?.review_state ?? "not_processed";
          return (
            <div key={v.vendor_id} className={`vcard ${sel === v.vendor_id ? "sel" : ""}`} onClick={() => setSel(v.vendor_id)}>
              <h3>Vendor {v.vendor_no} · {v.vendor_name}</h3>
              <div className="sub">{b ? b.response_metadata.source_files.join(", ") : v.response_files.join(", ")}</div>
              <div className="row">
                <span className={`chip ${state}`}>{STATE_LABEL[state]}</span>
                {b && <span className="chip">{b.processing_summary.quoted_lines}/{b.processing_summary.rfx_lines} lines</span>}
                {b && b.processing_summary.open_review_items > 0 && <span className="chip needs_review">{b.processing_summary.open_review_items} open</span>}
              </div>
              {v.alternate_files.length > 0 && (
                <div className="row" onClick={(e) => e.stopPropagation()}>
                  <select className="sel" value={variant[v.vendor_id] ?? v.response_files[0]} onChange={(e) => setVariant((x) => ({ ...x, [v.vendor_id]: e.target.value }))}>
                    {[...v.response_files, ...v.alternate_files].map((f) => <option key={f}>{f}</option>)}
                  </select>
                </div>
              )}
              <div className="row" onClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" disabled={busy[v.vendor_id]} onClick={() => process(v)}>{b ? "Reprocess" : "Load & process"}</button>
                <button className="btn small" disabled={busy[v.vendor_id]} onClick={() => { uploadFor.current = v.vendor_id; fileInput.current?.click(); }}>Upload…</button>
              </div>
              {errors[v.vendor_id] && <div className="hint" style={{ color: "var(--err)", marginTop: 6 }}>{errors[v.vendor_id]}</div>}
            </div>
          );
        })}
        <input ref={fileInput} type="file" hidden multiple accept=".xlsx,.pdf,.docx,.png,.jpg,.jpeg,.txt,.eml"
          onChange={(e) => { onUpload(e.target.files); e.target.value = ""; }} />
        <p className="hint">Processing reads the vendor's document with the AI model (≈1 min). Prices, conversions, counts and checks are computed by code. Bids are kept in this browser.</p>
      </aside>

      <main className="content">
        {!bid || !vendor ? (
          <div className="empty">{vendor ? <>Vendor {vendor.vendor_no} has not been processed yet.<br />Click <strong>Load &amp; process</strong>.</> : "Select a vendor."}</div>
        ) : (
          <BidDetail bid={bid} tab={tab} setTab={setTab} lineIds={event?.lines.map((l) => l.line_id) ?? []} onReview={(body) => review(bid, body)} />
        )}
      </main>
    </div>
  );
}

function BidDetail({ bid, tab, setTab, lineIds, onReview }: { bid: CanonicalBid; tab: Tab; setTab: (t: Tab) => void; lineIds: string[]; onReview: (b: Record<string, unknown>) => void }) {
  const s = bid.processing_summary;
  const open = bid.exceptions.filter((e) => e.status === "open");
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Vendor {bid.vendor.vendor_no} · {bid.vendor.vendor_name}</h2>
        <span className={`chip ${bid.review_state}`}>{STATE_LABEL[bid.review_state]}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {bid.review_state === "finalized"
          ? <button className="btn small" onClick={() => onReview({ op: "reopen" })}>Reopen</button>
          : <button className="btn small primary" disabled={open.length > 0} title={open.length ? "Resolve or mark unresolved all open items first" : "Mark as trusted"} onClick={() => onReview({ op: "finalize" })}>Finalize bid</button>}
      </div>
      <div className="hint">{bid.response_metadata.source_type.toUpperCase()} · {bid.response_metadata.source_files.join(", ")} · ref {bid.response_metadata.quote_reference ?? "—"} · quote date {bid.response_metadata.quote_date ?? "—"} · processed by {bid.response_metadata.model}</div>

      <div className="tabs">
        {(["overview", "lines", "review", "questionnaire", "debug"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "review" ? `Review queue (${open.length})` : t === "debug" ? "Trace & raw extraction" : t === "lines" ? `Line items (${s.quoted_lines})` : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview bid={bid} />}
      {tab === "lines" && <Lines bid={bid} />}
      {tab === "review" && <Review bid={bid} lineIds={lineIds} onReview={onReview} />}
      {tab === "questionnaire" && <Questionnaire bid={bid} />}
      {tab === "debug" && (
        <div>
          <h3 style={{ fontSize: 14 }}>Processing trace</h3>
          <table className="tbl"><tbody>{bid.trace.map((t, i) => <tr key={i}><td className="hint">{t.at.slice(11, 19)}</td><td><code>{t.step}</code></td><td>{t.message}</td></tr>)}</tbody></table>
          <h3 style={{ fontSize: 14 }}>Audit log ({bid.audit_log.length})</h3>
          <pre className="json">{JSON.stringify(bid.audit_log, null, 2)}</pre>
          <h3 style={{ fontSize: 14 }}>Raw model extraction (never modified by review)</h3>
          <pre className="json">{JSON.stringify(bid.extraction, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>;
}

function Overview({ bid }: { bid: CanonicalBid }) {
  const s = bid.processing_summary;
  const t = bid.commercial_terms;
  return (
    <div>
      <div className="stats">
        <Stat k="Lines quoted" v={`${s.quoted_lines}/${s.rfx_lines}`} />
        <Stat k="Missing (declined)" v={`${s.missing_lines} (${s.declined_lines})`} />
        <Stat k="Duplicates" v={s.duplicate_lines} />
        <Stat k="Ambiguous matches" v={s.ambiguous_matches} />
        <Stat k="Open review items" v={s.open_review_items} />
        <Stat k="Resolved / unresolved" v={`${s.resolved_review_items} / ${s.unresolved_review_items}`} />
        <Stat k="Technical score" v={`${s.technical_score}/${s.technical_max}`} />
        <Stat k="Qualification" v={<span style={{ color: s.qualification_status === "QUALIFIED" ? "var(--ok)" : "var(--err)", fontSize: 14 }}>{s.qualification_status}</span>} />
        <Stat k={`Annual value (${s.annual_value_lines_counted} lines, evaluation basis)`} v={s.annual_value_evaluated_inr ? `₹${(s.annual_value_evaluated_inr / 1e7).toFixed(2)} Cr` : "—"} />
      </div>
      <section className="section" style={{ marginTop: 14 }}>
        <header><h2>Commercial terms</h2></header>
        <div className="body grid2">
          <span className="k">Payment</span><span>{t.payment_terms ?? "—"}</span>
          <span className="k">Price validity</span>
          <div>{t.price_validity_until ?? "—"}{t.price_validity_statements.length > 1 && <span className="badge high" style={{ marginLeft: 6 }}>conflicting statements</span>}
            {t.price_validity_statements.map((v, i) => <EvidenceBox key={i} e={v.evidence} />)}</div>
          <span className="k">Freight</span><div>{t.freight_statements.length ? t.freight_statements.map((f, i) => <div key={i}>{f.statement} <span className="hint">({f.freight_basis ?? "?"}{f.freight_plants.length ? `: ${f.freight_plants.join(", ")}` : ""})</span><EvidenceBox e={f.evidence} /></div>) : "—"}</div>
          <span className="k">Tax</span><span>{t.tax ?? "—"}</span>
          <span className="k">Discounts / rebates</span><div>{t.discounts.length ? t.discounts.map((d, i) => <div key={i}>{d.statement}{d.is_conditional && <span className="badge medium" style={{ marginLeft: 6 }}>conditional</span>}<EvidenceBox e={d.evidence} /></div>) : "—"}</div>
          <span className="k">Tooling</span><div>{t.tooling.length ? t.tooling.map((d, i) => <div key={i}>{d.statement}</div>) : "—"}</div>
          <span className="k">Other terms</span><div>{t.other_terms.map((d, i) => <div key={i}><code>{d.topic}</code> {d.statement}</div>)}</div>
          <span className="k">Missing RFx lines</span><div>{bid.missing_rfx_lines.join(", ") || "none"}{bid.declined_rfx_lines.length > 0 && <div className="hint">Declined: {bid.declined_rfx_lines.map((d) => d.rfx_line_id).join(", ")} – “{bid.declined_rfx_lines[0].statement}”</div>}</div>
        </div>
      </section>
    </div>
  );
}

function EvidenceBox({ e }: { e: Evidence }) {
  return <div className="evidence"><span className="loc">{e.source_file} · {e.location}{e.page ? ` · p.${e.page}` : ""}</span><br />“{e.source_text}”</div>;
}

function Lines({ bid }: { bid: CanonicalBid }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>RFx line</th><th>Match</th><th>Vendor description</th><th>Raw</th><th>Unit</th><th>Normalized ₹/unit</th><th>Freight</th><th>Evaluation ₹</th><th>vs hist.</th><th>MOQ</th><th>Lead</th><th>Status</th></tr></thead>
        <tbody>
          {bid.line_items.map((l) => (
            <LineRow key={l.rfx_line_id} l={l} open={open === l.rfx_line_id} toggle={() => setOpen(open === l.rfx_line_id ? null : l.rfx_line_id)} />
          ))}
        </tbody>
      </table>
      {bid.unmatched_rows.length > 0 && <p className="hint">{bid.unmatched_rows.length} unmatched row(s) – see the review queue.</p>}
    </div>
  );
}

function LineRow({ l, open, toggle }: { l: CanonicalLineItem; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr onClick={toggle} style={{ cursor: "pointer" }}>
        <td><strong>{l.rfx_line_id}</strong></td>
        <td><span className="hint">{l.match_status}</span></td>
        <td className="wide">{l.vendor_description}</td>
        <td>{l.raw_price_text} {l.raw_currency && l.raw_currency !== "INR" ? l.raw_currency : ""}</td>
        <td>{l.raw_uom}</td>
        <td>{l.candidate_quotes.length > 1 ? <span className="badge high">{l.candidate_quotes.map((c) => c.normalized_unit_price_inr).join(" / ")}</span> : inr(l.normalized_unit_price_inr)}</td>
        <td>{l.freight.basis.replace(/_/g, " ")}{l.freight.amount !== null ? ` ₹${l.freight.amount}` : ""}</td>
        <td>{inr(l.evaluation_unit_price_inr)}</td>
        <td>{l.variance_vs_historical_pct === null ? "—" : `${l.variance_vs_historical_pct > 0 ? "+" : ""}${l.variance_vs_historical_pct}%`}</td>
        <td>{l.moq ?? "—"}{l.moq_exceeds_monthly_calloff ? " ⚠" : ""}</td>
        <td>{l.lead_time_days ?? "—"}</td>
        <td><span className={`st ${l.review_status}`}>{l.review_status.replace("_", " ")}</span>{l.review_reasons.length > 0 && <div className="hint">{l.review_reasons.join(", ")}</div>}</td>
      </tr>
      {open && (
        <tr><td colSpan={12}>
          <div className="hint">Normalization: {l.normalization_method}{l.evaluation_basis ? ` · Evaluation: ${l.evaluation_basis}` : ""}{l.spec_deviation ? ` · Spec: ${l.spec_deviation}` : ""}{l.remarks ? ` · Remarks: ${l.remarks}` : ""}</div>
          {l.evidence.map((e, i) => <EvidenceBox key={i} e={e} />)}
          {l.freight.evidence.map((e, i) => <EvidenceBox key={`f${i}`} e={e} />)}
          <div className="evidence" style={{ borderLeftColor: "var(--ok)" }}>
            <strong>Value history</strong> · source “{l.evidence[0]?.source_text}” → model {l.raw_price_text} ({l.raw_uom}{l.raw_currency ? `, ${l.raw_currency}` : ""})
            → normalized ₹{l.candidate_quotes.length > 1 ? l.candidate_quotes.map((c) => c.normalized_unit_price_inr).join(" / ") : l.normalization_method.startsWith("Human") ? "(see correction)" : String(l.normalized_unit_price_inr)} via {l.normalization_method}
            {l.resolution && <> → human {l.resolution.resolution.replace("human_", "")}{l.resolution.human_corrected_value !== null ? ` ${l.resolution.human_corrected_value}` : ""} ({l.resolution.at.slice(0, 16).replace("T", " ")}{l.resolution.note ? `, “${l.resolution.note}”` : ""})</>}
            {" "}→ final ₹{String(l.normalized_unit_price_inr ?? "—")} [{l.review_status}]
          </div>
        </td></tr>
      )}
    </>
  );
}

function Review({ bid, lineIds, onReview }: { bid: CanonicalBid; lineIds: string[]; onReview: (b: Record<string, unknown>) => void }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const items = useMemo(() => bid.exceptions.filter((e) => filter === "all" || e.status === "open"), [bid, filter]);
  return (
    <div>
      <div className="row" style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button className={`btn small ${filter === "open" ? "primary" : ""}`} onClick={() => setFilter("open")}>Open ({bid.exceptions.filter((e) => e.status === "open").length})</button>
        <button className={`btn small ${filter === "all" ? "primary" : ""}`} onClick={() => setFilter("all")}>All ({bid.exceptions.length})</button>
      </div>
      {items.length === 0 && <div className="hint">Nothing {filter === "open" ? "open" : "flagged"}. {filter === "open" && bid.review_state !== "finalized" ? "You can finalize this bid." : ""}</div>}
      {items.map((it) => <ReviewCard key={it.id} it={it} lineIds={lineIds} disabled={bid.review_state === "finalized"} onReview={onReview} />)}
    </div>
  );
}

function ReviewCard({ it, lineIds, disabled, onReview }: { it: ReviewItem; lineIds: string[]; disabled: boolean; onReview: (b: Record<string, unknown>) => void }) {
  const [val, setVal] = useState("");
  const [target, setTarget] = useState("");
  const mapping = it.reason === "unmatched_sku" || it.reason === "ambiguous_match";
  const [note, setNote] = useState("");
  const numeric = it.scope === "line";
  const act = (action: string, value?: number | string) => onReview({ action: { review_item_id: it.id, action, value: value ?? null, note: note || null } });
  return (
    <div className={`ritem ${it.severity}`}>
      <div><span className={`badge ${it.severity === "critical" ? "high" : it.severity === "major" ? "medium" : "low"}`}>{it.severity}</span> <code>{it.reason}</code> {it.rfx_line_id && <strong>{it.rfx_line_id}</strong>} <span className="hint">· {it.status}</span></div>
      <div style={{ margin: "4px 0" }}>{it.message}</div>
      {it.candidates.length > 0 && <div className="hint">Candidates: {it.candidates.join(" · ")}{it.suggested_value !== null ? ` · suggested ${it.suggested_value}` : ""}</div>}
      {it.evidence.slice(0, 3).map((e, i) => <EvidenceBox key={i} e={e} />)}
      {it.resolution
        ? <div className="hint">Resolution: {it.resolution.resolution} · model {String(it.resolution.model_extracted_value)} → final {String(it.resolution.final_value)} {it.resolution.note ? `· “${it.resolution.note}”` : ""}</div>
        : !disabled && (
          <div className="acts">
            <button className="btn small primary" onClick={() => act("accept")}>Accept{it.suggested_value !== null ? ` (${it.suggested_value})` : ""}</button>
            <input className="fld" placeholder={numeric ? "Corrected ₹/unit" : it.field === "price_validity_until" ? "YYYY-MM-DD" : "value"} value={val} onChange={(e) => setVal(e.target.value)} />
            <button className="btn small" disabled={!val} onClick={() => act("edit", numeric ? Number(val) : val)}>Edit</button>
            <button className="btn small danger" onClick={() => act("reject")}>Reject</button>
            <button className="btn small" onClick={() => act("unresolved")}>Mark unresolved</button>
            {mapping && <>
              <select className="sel" value={target} onChange={(e) => setTarget(e.target.value)} title="Move this vendor row to another RFx line; prices are re-normalized for that line">
                <option value="">Map to line…</option>{lineIds.filter((l) => l !== it.rfx_line_id).map((l) => <option key={l}>{l}</option>)}</select>
              <button className="btn small" disabled={!target} onClick={() => act("remap", target)}>Re-map</button>
            </>}
            <input className="fld" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 180 }} />
          </div>
        )}
    </div>
  );
}

function Questionnaire({ bid }: { bid: CanonicalBid }) {
  return (
    <table className="tbl">
      <thead><tr><th>Q</th><th>Topic</th><th>Mandatory</th><th>Vendor answer</th><th>Compliance</th><th>Points</th><th>Evidence</th></tr></thead>
      <tbody>{bid.questionnaire_answers.map((q) => (
        <tr key={q.qid}>
          <td>{q.qid}</td><td>{q.topic}</td>
          <td>{q.mandatory ? <span className={`badge ${q.mandatory_pass ? "pref" : "mand"}`}>{q.mandatory_pass ? "pass" : "FAIL"}</span> : ""}</td>
          <td className="wide">{q.answer_text ?? <span className="val nil">not answered</span>}<div className="hint">{q.rationale}</div></td>
          <td>{q.compliance}</td><td>{q.points}/{q.max_points}</td>
          <td className="hint">{q.evidence ? `${q.evidence.location}` : "—"}</td>
        </tr>))}
      </tbody>
    </table>
  );
}


const JOB_LABEL: Record<IngestionJob["state"], string> = {
  received: "Email received", queued: "Queued", processing: "Processing…", completed: "Completed",
  needs_identity_review: "Needs identity review", retrying: "Retry pending", failed: "Failed",
};

/** Async ingestion: simulated inbound emails go through the event/queue path, not straight to the agent. */
function InboundQueue({ vendors, jobs, upsertJob, processJob }: {
  vendors: EventVendor[]; jobs: IngestionJob[]; upsertJob: (j: IngestionJob) => void; processJob: (j: IngestionJob, source: string) => Promise<void>;
}) {
  const [who, setWho] = useState(vendors[0]?.vendor_id ?? "");
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const sourceOf = (j: IngestionJob) => (j.message.channel === "portal" ? "manual load" : "inbound email");

  async function simulate(unknown: boolean) {
    setBusy(true);
    const { data } = await postJson<{ ok: true; job: IngestionJob } | ApiErr>("/api/ingest", { action: "simulate", vendor_id: who, unknown_sender: unknown, prior_jobs: jobs });
    if (data.ok) {
      upsertJob(data.job);
      if (data.job.state === "queued") await processJob(data.job, sourceOf(data.job)); // event-driven: queued jobs are picked up immediately
    } else alert(data.error.message);
    setBusy(false);
  }

  async function resolve(job: IngestionJob, type: "confirm" | "select_vendor" | "reject") {
    setBusy(true);
    const { data } = await postJson<{ ok: true; job: IngestionJob } | ApiErr>("/api/ingest", { action: "resolve", job, resolution: { type, vendor_id: pick[job.job_id] ?? null } });
    if (data.ok) { upsertJob(data.job); if (data.job.state === "queued") await processJob(data.job, sourceOf(data.job)); }
    else alert(data.error.message);
    setBusy(false);
  }

  return (
    <div className="vcard" style={{ cursor: "default" }}>
      <h3>Inbound responses</h3>
      <div className="row">
        <select className="sel" value={who} onChange={(e) => setWho(e.target.value)}>{vendors.map((v) => <option key={v.vendor_id} value={v.vendor_id}>V{v.vendor_no} fixture</option>)}</select>
        <button className="btn small primary" disabled={busy} onClick={() => simulate(false)}>Simulate vendor email received</button>
        <button className="btn small" disabled={busy} onClick={() => simulate(true)} title="Same fixture sent from an unknown address without the RFx ID">Unknown sender</button>
      </div>
      {[...jobs].reverse().slice(0, 6).map((j) => (
        <div key={j.job_id} style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 6 }}>
          <div className="sub">{j.message.channel === "portal" ? "Manual · " : ""}<span className={`chip ${j.state === "completed" ? "processed" : j.state === "failed" ? "error" : j.state === "needs_identity_review" ? "needs_review" : "processing"}`}>{JOB_LABEL[j.state]}</span> {j.identity.contact.email} · identity {j.identity.status}{j.vendor_id ? ` → ${j.vendor_id}` : ""}</div>
          <div className="hint">{j.history.map((h) => JOB_LABEL[h.state]).join(" → ")}</div>
          <div className="hint">{j.history.at(-1)?.note}</div>
          {j.state === "needs_identity_review" && (
            <div className="row">
              {j.identity.vendor.candidates[0] && <button className="btn small" disabled={busy} onClick={() => resolve(j, "confirm")}>Confirm {j.identity.vendor.candidates[0].vendor_id}</button>}
              <select className="sel" value={pick[j.job_id] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [j.job_id]: e.target.value }))}>
                <option value="">select vendor…</option>{vendors.map((v) => <option key={v.vendor_id} value={v.vendor_id}>V{v.vendor_no} {v.vendor_name}</option>)}</select>
              <button className="btn small" disabled={busy || !pick[j.job_id]} onClick={() => resolve(j, "select_vendor")}>Assign</button>
              <button className="btn small danger" disabled={busy} onClick={() => resolve(j, "reject")}>Reject</button>
            </div>
          )}
          {j.state === "retrying" && <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); await processJob(j, sourceOf(j)); setBusy(false); }}>Retry now</button>}
        </div>
      ))}
    </div>
  );
}
