/** Browser-side store for processed bids and the analyst conversation (stateless server, Vercel-friendly). */
import type { CanonicalBid } from "@/lib/bids/schema";
import { emptyDecision, type DecisionAuditEvent, type DecisionState } from "@/lib/scenarios/types";
import { commitOutcome, emptyVersions, type BidVersions, type ProcessingOutcome } from "@/lib/bids/versions";
import type { IngestionJob } from "@/lib/ingestion/queue";
import type { ReleasedEvent } from "@/lib/event/released";
import type { RfqEntry } from "@/lib/rfq/registry";

const BIDS_KEY = "stage3.bids.v1";
const CHAT_KEY = "stage3.analyst.v1";

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}
// ------------------------------------------------------------------ active released event (RFx hand-off)
const EVENT_KEY = "stage2.released_event.v1";
export function loadActiveEvent(): ReleasedEvent | null { return read<ReleasedEvent | null>(EVENT_KEY, null); }
export function saveActiveEvent(e: ReleasedEvent | null) { if (e) write(EVENT_KEY, e); else { try { localStorage.removeItem(EVENT_KEY); } catch { /* ignore */ } } }
/** Bids, jobs, decisions and chat are kept per RFx so a newly released event never mixes with another event's data. */
function ns(key: string): string {
  const e = loadActiveEvent();
  return e ? `${key}::${e.rfx.rfx_id}` : key;
}

function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn("localStorage write failed", e); }
}

export const loadBids = (): Record<string, CanonicalBid> => read(ns(BIDS_KEY), {});
export const saveBids = (b: Record<string, CanonicalBid>) => write(ns(BIDS_KEY), b);
export const loadChat = <T,>(): T[] => read<T[]>(ns(CHAT_KEY), []);
export const saveChat = (c: unknown[]) => write(ns(CHAT_KEY), c);

/** POST helper for Stage 3/4 APIs: automatically includes the active released event (if any). */
export async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const event = loadActiveEvent();
  const payload = event && body && typeof body === "object" ? { ...(body as Record<string, unknown>), event } : body;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: res.status, data: (await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }))) as T };
}

/** Uploads stay under serverless body limits: images are downscaled in the browser, others sent as-is (≤ 4 MB). */
export async function fileToUpload(file: File): Promise<{ name: string; data_base64: string }> {
  if (file.type.startsWith("image/")) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.88));
    return { name: file.name.replace(/\.\w+$/, ".jpg"), data_base64: await blobToBase64(blob) };
  }
  if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is larger than 4 MB`);
  return { name: file.name, data_base64: await blobToBase64(file) };
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------------ Stage 4 decision state
const DECISION_KEY = "stage4.decision.v1";
export const loadDecision = (): DecisionState => ({ ...emptyDecision(), ...read<Partial<DecisionState>>(ns(DECISION_KEY), {}) });
export const saveDecision = (d: DecisionState) => write(ns(DECISION_KEY), d);

export function withAudit(d: DecisionState, e: Omit<DecisionAuditEvent, "at">): DecisionState {
  return { ...d, audit: [...d.audit, { ...e, at: new Date().toISOString() }].slice(-500) };
}

/** Only the parts of a bid the server trusts (keeps request bodies small; server recomputes the rest). */
export function bidEnvelope(b: CanonicalBid) {
  return { schema_version: b.schema_version, vendor: b.vendor, response_metadata: b.response_metadata, extraction: b.extraction,
    overrides: b.overrides, audit_log: b.audit_log, trace: b.trace, chunks: b.chunks, finalized_at: b.finalized_at };
}

// ------------------------------------------------------------------ safe-write versions + ingestion jobs

const PREV_KEY = "stage3.bids.previous.v1";
const FAIL_KEY = "stage3.bids.failures.v1";
const JOBS_KEY = "stage5.jobs.v1";

export function loadVersions(): BidVersions {
  return { ...emptyVersions(), active: loadBids(), previous: read(ns(PREV_KEY), {}), failures: read(ns(FAIL_KEY), []) };
}
/** Activate a successful result (keeping the previous version) or record a failure without touching the active bid. */
export function commitProcessing(vendorId: string, outcome: ProcessingOutcome, source: string): BidVersions {
  const next = commitOutcome(loadVersions(), vendorId, outcome, source);
  saveBids(next.active);
  write(ns(PREV_KEY), next.previous);
  write(ns(FAIL_KEY), next.failures);
  return next;
}
export const loadJobs = (): IngestionJob[] => read(ns(JOBS_KEY), []);
export const saveJobs = (j: IngestionJob[]) => write(ns(JOBS_KEY), j.slice(-50));

// ------------------------------------------------------------------ RFQ register (all events, not namespaced)
const RFQ_KEY = "rfq.register.v1";
export const loadRfqs = (): RfqEntry[] => read<RfqEntry[]>(RFQ_KEY, []);
/** Applies a register transition and persists it; notifies open pages (nav count, register page). */
export function updateRfqs(fn: (list: RfqEntry[]) => RfqEntry[]): RfqEntry[] {
  const next = fn(loadRfqs());
  write(RFQ_KEY, next);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("rfq-register-changed"));
  return next;
}
