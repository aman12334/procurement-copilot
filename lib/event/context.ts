/**
 * Sourcing-event context: everything the runtime knows about the RFx, loaded only from
 * buyer-issued files (stage1/buyer) and the invited-supplier registry (data/event).
 */
import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/rfx/csv";
import { readEventText } from "./files";

export interface RfxLine {
  line_id: string;
  item_description: string;
  style: string | null;
  dimensions_text: string | null;
  ply: number | null;
  flute: string | null;
  printing: string | null;
  coating: string | null;
  delivery_plant: string;
  annual_qty: number;
  uom: string;
  reference_weight_g: number | null;
  recycled_content_min_pct: number | null;
  end_use: string | null;
}

export interface QuestionDef {
  qid: string;
  topic: string;
  question: string;
  mandatory: boolean;
  max_points: number;
  partial_points: number | null;
  full: string;
  partial: string;
}

export interface InvitedVendor {
  vendor_id: string;
  vendor_no: number;
  vendor_name: string;
  contact_email: string;
  response_files: string[];
  alternate_files?: string[];
  /** Event-specific reference the vendor quotes in its response (strong identity signal). */
  response_token?: string | null;
}

export interface HistoricalPrice {
  line_id: string;
  price_inr: number;
  last_year_supplier: string;
  basis: string;
}

export interface EvaluationConfig {
  usd_inr: number;
  fx_source: string;
  freight_loading_pct: number;
  freight_loading_source: string;
  outlier_high_ratio: number;
  outlier_low_ratio: number;
}

export interface EventContext {
  rfx_id: string;
  title: string;
  buyer_name: string;
  issue_date: string;
  response_due_date: string;
  contract_start: string | null;
  contract_end: string | null;
  plants: { code: string; name: string; state: string }[];
  lines: RfxLine[];
  questions: QuestionDef[];
  qualification: { min_total_score: number; rule: string };
  requirements: { id: string; area: string; requirement: string; type: string }[];
  historical: Record<string, HistoricalPrice>;
  vendors: InvitedVendor[];
  evaluation: EvaluationConfig;
  /** Where the event came from: the Stage 1 demo event (default) or an RFx finalized and released in Stage 2. */
  source?: "stage1_default" | "released_rfx";
  released_at?: string | null;
}

const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v));

function csvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** FX and freight-loading come from the buyer's RFx; env vars may override them explicitly. */
export function evaluationConfig(
  buyerReq: { event?: { evaluation_fx?: { USD_INR?: number }; freight_loading_pct?: number } },
  env: Record<string, string | undefined> = process.env,
): EvaluationConfig {
  const envFx = Number(env.EVAL_USD_INR);
  const rfxFx = buyerReq.event?.evaluation_fx?.USD_INR;
  const usd_inr = envFx > 0 ? envFx : rfxFx ?? 88.5;
  const envLoad = Number(env.EVAL_FREIGHT_LOADING_PCT);
  const rfxLoad = buyerReq.event?.freight_loading_pct;
  return {
    usd_inr,
    fx_source: envFx > 0 ? "env:EVAL_USD_INR" : rfxFx ? "stage1/buyer/buyer_requirements.json event.evaluation_fx.USD_INR" : "default 88.50",
    freight_loading_pct: envLoad >= 0 && env.EVAL_FREIGHT_LOADING_PCT ? envLoad : rfxLoad ?? 5,
    freight_loading_source: env.EVAL_FREIGHT_LOADING_PCT ? "env:EVAL_FREIGHT_LOADING_PCT" : "stage1/buyer/buyer_requirements.json BR-10",
    outlier_high_ratio: 1.5,
    outlier_low_ratio: 0.6,
  };
}

let cached: Promise<EventContext> | null = null;

export function loadEventContext(): Promise<EventContext> {
  cached ??= buildContext().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

async function buildContext(): Promise<EventContext> {
  const [master, req, tq, hist, registry] = await Promise.all([
    readEventText("stage1/buyer/rfx_master.csv"),
    readEventText("stage1/buyer/buyer_requirements.json").then(JSON.parse),
    readEventText("stage1/buyer/technical_questionnaire.json").then(JSON.parse),
    readEventText("stage1/buyer/historical_reference_prices.csv"),
    readEventText("data/event/vendor_registry.json").then(JSON.parse),
  ]);
  const lines: RfxLine[] = csvObjects(master).map((r) => ({
    line_id: r.line_id,
    item_description: r.item_description,
    style: r.style || null,
    dimensions_text: r.dimensions_text || null,
    ply: num(r.ply),
    flute: r.flute || null,
    printing: r.printing || null,
    coating: r.coating || null,
    delivery_plant: r.delivery_plant,
    annual_qty: Number(r.annual_qty),
    uom: r.uom || "piece",
    reference_weight_g: num(r.reference_weight_g),
    recycled_content_min_pct: num(r.recycled_content_min_pct),
    end_use: r.end_use || null,
  }));
  const historical: Record<string, HistoricalPrice> = {};
  for (const r of csvObjects(hist)) {
    historical[r.line_id] = {
      line_id: r.line_id,
      price_inr: Number(r.fy2025_26_price_inr),
      last_year_supplier: r.last_year_supplier,
      basis: r.price_basis,
    };
  }
  return {
    rfx_id: req.event.rfx_id,
    title: req.event.title,
    buyer_name: req.buyer.name,
    issue_date: req.event.issue_date,
    response_due_date: req.event.response_due_date,
    contract_start: req.event.contract_period?.start ?? null,
    contract_end: req.event.contract_period?.end ?? null,
    plants: req.plants.map((p: { code: string; name: string; state: string }) => ({ code: p.code, name: p.name, state: p.state })),
    lines,
    questions: tq.questions,
    qualification: { min_total_score: tq.qualification.min_total_score, rule: tq.qualification.rule },
    requirements: req.requirements.map((r: { id: string; area: string; requirement: string; type: string }) => ({
      id: r.id, area: r.area, requirement: r.requirement, type: r.type,
    })),
    historical,
    vendors: (registry.vendors as InvitedVendor[]).map((v) => ({ ...v, response_token: v.response_token ?? demoResponseToken(req.event.rfx_id, v.vendor_id) })),
    evaluation: evaluationConfig(req),
    source: "stage1_default",
    released_at: null,
  };
}

/** Deterministic token for the Stage 1 demo event (released events get random tokens at release time). */
export function demoResponseToken(rfxId: string, vendorId: string): string {
  return `RSP-${createHash("sha256").update(`${rfxId}|${vendorId}`).digest("hex").slice(0, 6).toUpperCase()}`;
}
