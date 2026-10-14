"use client";
/**
 * Two-panel workspace: RFx Copilot (left) + editable RFx draft (right).
 * All LLM work goes through POST /api/rfx (server-side); this component never sees an API key.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_BUYER_PROMPT } from "@/lib/rfx/demo";
import { SECTIONS, SECTION_IDS, type RfxDraft, type SectionId } from "@/lib/rfx/schema";
import { deleteDraft, listDrafts, loadDraft, saveDraft, type KVStore, type SavedDraftMeta } from "@/lib/rfx/storage";
import { validateBusinessRules, validateSchema } from "@/lib/rfx/validate";
import DraftView from "./DraftView";
import ReleaseControl from "./ReleaseControl";

interface Msg { role: "buyer" | "agent"; text: string; error?: boolean; meta?: string }
type Target = "refine" | "new" | SectionId;

interface ApiOk { ok: true; rfx: RfxDraft; issues: unknown[]; meta: { model: string; attempts: number; retried: boolean } }
interface ApiErr { ok: false; error: { code: string; message: string; details: string[] } }

function browserStore(): KVStore | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export default function RfxWorkspace() {
  const [rfx, setRfx] = useState<RfxDraft | null>(null);
  const [messages, setMessages] = useState<Msg[]>([{
    role: "agent",
    text: "Describe what you need to source – category, sites, volumes, mandatory and preferred requirements, commercial expectations, deadline. I'll draft a structured RFx and flag assumptions and gaps. A demo prompt based on the Stage 1 packaging event is pre-filled.",
  }]);
  const [input, setInput] = useState(DEMO_BUYER_PROMPT);
  const [target, setTarget] = useState<Target>("refine");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftId, setDraftId] = useState<string>(() => `draft-${Date.now().toString(36)}`);
  const [saved, setSaved] = useState<SavedDraftMeta[]>([]);
  const [health, setHealth] = useState<{ configured: boolean; provider?: string; model?: string; fallback?: string | null; message?: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth({ configured: false, message: "Health check failed." }));
    const s = browserStore();
    if (s) setSaved(listDrafts(s));
  }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);

  const issues = useMemo(() => (rfx ? validateBusinessRules(rfx) : []), [rfx]);
  const say = (m: Msg) => setMessages((x) => [...x, m]);

  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await fetch("/api/rfx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as ApiOk | ApiErr;
      if (!data.ok) {
        say({ role: "agent", error: true, text: `${data.error.message}${data.error.details.length ? `\n• ${data.error.details.slice(0, 6).join("\n• ")}` : ""}`, meta: data.error.code });
        return;
      }
      setRfx(data.rfx);
      const errs = validateBusinessRules(data.rfx).filter((i) => i.severity === "error").length;
      say({
        role: "agent",
        text: `${label} done. ${data.rfx.assumptions.length} assumption(s), ${data.rfx.unresolved_fields.length} unresolved field(s)` +
          `${errs ? `, ${errs} validation error(s) to review` : ""}. Review the draft on the right – everything is editable.`,
        meta: `${data.meta.model} · ${data.meta.attempts} attempt(s)${data.meta.retried ? " · schema retry used" : ""}`,
      });
    } catch (e) {
      say({ role: "agent", error: true, text: `Request failed: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    say({ role: "buyer", text: rfx && target !== "refine" && target !== "new" ? `[${SECTIONS[target].label}] ${text}` : text });
    setInput("");
    if (!rfx || target === "new") {
      setDraftId(`draft-${Date.now().toString(36)}`);
      return call({ action: "generate", buyer_input: text }, "RFx generation");
    }
    if (target === "refine") return call({ action: "refine", rfx, instruction: text }, "Change");
    return call({ action: "regenerate_section", rfx, section: target, instruction: text }, `${SECTIONS[target].label} regeneration`);
  }

  function regenerate(section: SectionId, instruction: string) {
    if (!rfx || busy) return;
    say({ role: "buyer", text: `Regenerate “${SECTIONS[section].label}”${instruction ? `: ${instruction}` : ""}` });
    call({ action: "regenerate_section", rfx, section, instruction: instruction || undefined }, `${SECTIONS[section].label} regeneration`);
  }

  function save() {
    const s = browserStore();
    if (!s || !rfx) return;
    saveDraft(s, { draft_id: draftId, title: rfx.title || rfx.rfx_id, rfx, conversation: messages.filter((m) => !m.error).map(({ role, text }) => ({ role, text })) });
    setSaved(listDrafts(s));
    say({ role: "agent", text: `Draft saved in this browser (${draftId}).` });
  }

  function load(id: string) {
    const s = browserStore();
    if (!s || !id) return;
    const d = loadDraft(s, id);
    if (!d) { say({ role: "agent", error: true, text: "That saved draft could not be loaded (missing or no longer valid)." }); return; }
    setRfx(d.rfx);
    setDraftId(d.draft_id);
    setMessages([...(d.conversation ?? []), { role: "agent", text: `Loaded draft “${d.title}” saved ${new Date(d.saved_at).toLocaleString()}.` }]);
    setInput("");
  }

  function remove(id: string) {
    const s = browserStore();
    if (!s) return;
    deleteDraft(s, id);
    setSaved(listDrafts(s));
  }

  function exportJson() {
    if (!rfx) return;
    const blob = new Blob([JSON.stringify(rfx, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(rfx.rfx_id || "rfx").replace(/[^\w.-]+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importJson(f: File) {
    try {
      const r = validateSchema(JSON.parse(await f.text()));
      if (!r.ok || !r.data) { say({ role: "agent", error: true, text: `Not a valid RFx JSON:\n• ${r.errors.slice(0, 6).join("\n• ")}` }); return; }
      setRfx(r.data);
      setDraftId(`draft-${Date.now().toString(36)}`);
      say({ role: "agent", text: `Imported ${f.name}.` });
    } catch (e) {
      say({ role: "agent", error: true, text: `Could not read JSON: ${(e as Error).message}` });
    }
  }
  const jsonFile = useRef<HTMLInputElement>(null);

  const placeholder = !rfx
    ? "Describe the sourcing requirement…"
    : target === "refine" ? "Ask for a change, e.g. 'Payment terms 60 days from GRN; add Chennai plant'"
    : target === "new" ? "Describe a new requirement to draft from scratch…"
    : `Instruction for ${SECTIONS[target].label}…`;

  return (
    <div className="app">
      <div className="topbar">
        <h1>RFx Copilot</h1>
        {health && <span className={`status ${health.configured ? "" : "off"}`}>{health.configured ? `${health.provider === "anthropic" ? "Claude" : health.provider === "openai" ? "OpenAI" : "Gemini"}: ${health.model}${health.fallback ? ` · free fallback ${health.fallback}` : ""}` : "AI model not configured"}</span>}
        <span className="spacer" />
        <button className="btn" disabled={!rfx} onClick={() => setEditing((e) => !e)}>{editing ? "Done editing" : "Edit"}</button>
        <button className="btn" disabled={!rfx} onClick={save}>Save draft</button>
        <select className="sel" value="" onChange={(e) => load(e.target.value)} disabled={!saved.length}>
          <option value="">{saved.length ? `Load draft (${saved.length})` : "No saved drafts"}</option>
          {saved.map((d) => <option key={d.draft_id} value={d.draft_id}>{d.title} – {new Date(d.saved_at).toLocaleString()}</option>)}
        </select>
        {saved.some((d) => d.draft_id === draftId) && <button className="btn small danger" onClick={() => remove(draftId)} title="Delete this saved draft">Delete saved</button>}
        <button className="btn" disabled={!rfx} onClick={exportJson}>Export JSON</button>
        <ReleaseControl rfx={rfx} />
        <button className="btn" onClick={() => jsonFile.current?.click()}>Import JSON</button>
        <input ref={jsonFile} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
      </div>
      {health && !health.configured && <div className="banner">{health.message}</div>}

      <div className="main">
        <aside className="chat">
          <div className="log" ref={logRef}>
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role} ${m.error ? "error" : ""}`}>{m.text}{m.meta && <span className="meta">{m.meta}</span>}</div>
            ))}
            {busy && <div className="msg agent"><em>{busy} in progress… (can take a minute or more when the model is busy)</em></div>}
          </div>
          <div className="composer">
            {rfx && (
              <div className="row">
                <label className="hint" htmlFor="target">Apply to</label>
                <select id="target" className="sel" value={target} onChange={(e) => setTarget(e.target.value as Target)}>
                  <option value="refine">Whole RFx (change request)</option>
                  {SECTION_IDS.map((s) => <option key={s} value={s}>Section: {SECTIONS[s].label}</option>)}
                  <option value="new">New RFx from scratch</option>
                </select>
              </div>
            )}
            <textarea value={input} placeholder={placeholder} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
            <div className="row">
              <button className="btn primary" disabled={!!busy || !input.trim()} onClick={submit}>
                {!rfx || target === "new" ? "Generate RFx" : target === "refine" ? "Apply change" : "Regenerate section"}
              </button>
              {!rfx && <button className="btn" disabled={!!busy} onClick={() => setInput(DEMO_BUYER_PROMPT)}>Use demo prompt</button>}
              <span className="hint">⌘/Ctrl + Enter to send</span>
            </div>
          </div>
        </aside>

        <main className="draft">
          {!rfx
            ? <div className="empty">No RFx yet.<br />Describe your requirement on the left and click <strong>Generate RFx</strong>,<br />or load a saved draft / import RFx JSON.</div>
            : <DraftView rfx={rfx} editing={editing} update={(fn) => setRfx((r) => (r ? fn(r) : r))} issues={issues} busy={!!busy}
                onRegenerate={regenerate}
                onAskInChat={(t) => { setTarget("refine"); setInput(t); }}
                onNotice={(t) => say({ role: "agent", text: t })} />}
        </main>
      </div>
    </div>
  );
}
