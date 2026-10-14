/**
 * Vendor + RFx identity matching for inbound responses (deterministic, explainable signals).
 * Never guesses: ambiguous or unmatched results go to human review.
 */
import type { EventContext, InvitedVendor } from "@/lib/event/context";

export interface InboundAttachment { name: string; ref?: string; data_base64?: string }

export interface InboundMessage {
  message_id: string;
  channel: "email" | "webhook" | "simulated" | "portal";
  received_at: string;
  from: string;
  to?: string | null;
  subject: string;
  body: string;
  thread_id?: string | null;
  attachments: InboundAttachment[];
  /** Simulation only: registered fixture file whose text becomes the body (server fills it before matching). */
  body_ref?: string | null;
}

export type MatchStatus = "matched" | "probable" | "ambiguous" | "unmatched";

export interface VendorCandidate { vendor_id: string; vendor_name: string; score: number; signals: string[] }

export interface IdentityResult {
  status: MatchStatus;
  rfx: { status: MatchStatus; rfx_id: string | null; signals: string[] };
  vendor: { status: MatchStatus; vendor_id: string | null; candidates: VendorCandidate[] };
  contact: { email: string; known_poc: boolean };
  summary: string;
}

/** Shared mailbox / consumer domains never identify a vendor on their own. */
export const GENERIC_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "rediffmail.com", "icloud.com", "mail.example"]);

const lower = (s: string) => s.toLowerCase();
const emailOf = (s: string) => (s.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? s).toLowerCase();
const domainOf = (e: string) => e.split("@")[1] ?? "";
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const STOP = new Set(["pvt", "ltd", "private", "limited", "industries", "solutions", "works", "the", "and", "co"]);
const nameTokens = (n: string) => n.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t.toLowerCase()));

const tokenIn = (text: string, token: string | null | undefined) => !!token && compact(text).includes(compact(token));

function rfxSignals(ctx: EventContext, text: string): IdentityResult["rfx"] {
  const signals: string[] = [];
  const c = compact(text);
  const tok = ctx.vendors.find((v) => tokenIn(text, v.response_token));
  if (tok) signals.push(`response token ${tok.response_token} issued for ${ctx.rfx_id}`);
  if (c.includes(compact(ctx.rfx_id))) signals.unshift(`RFx ID ${ctx.rfx_id} found`);
  const short = ctx.rfx_id.match(/RFQ.*?(\d{3})$/i)?.[1];
  if (!signals.length && short && new RegExp(`\\bRF[QX][\\s\\-/#:]*0*${Number(short)}\\b|RFQ${short}`, "i").test(text)) signals.push(`RFx token RFQ ${short} found`);
  return signals.length
    ? { status: signals.some((s) => s.startsWith("RFx ID") || s.startsWith("response token")) ? "matched" : "probable", rfx_id: ctx.rfx_id, signals }
    : { status: "unmatched", rfx_id: null, signals: ["No RFx ID or token in subject/body"] };
}

export function matchIdentity(ctx: EventContext, m: InboundMessage, priorThreads: Record<string, string> = {}): IdentityResult {
  const sender = emailOf(m.from);
  const domain = domainOf(sender);
  const text = `${m.subject}\n${m.body}\n${m.attachments.map((a) => a.name).join(" ")}`;
  const rfx = rfxSignals(ctx, `${m.subject}\n${m.body}`);
  const scored: VendorCandidate[] = ctx.vendors.map((v: InvitedVendor) => {
    const signals: string[] = [];
    let score = 0;
    const poc = v.contact_email.toLowerCase();
    if (sender === poc) { score += 5; signals.push(`sender is known POC ${poc}`); }
    else if (domain && !GENERIC_DOMAINS.has(domain) && domain === domainOf(poc)) { score += 3; signals.push(`sender domain @${domain} matches vendor master`); }
    if (tokenIn(text, v.response_token)) { score += 5; signals.push(`response token ${v.response_token}`); }
    if (m.thread_id && priorThreads[m.thread_id] === v.vendor_id) { score += 5; signals.push(`reply on an existing thread with ${v.vendor_id}`); }
    const toks = nameTokens(v.vendor_name);
    const hits = toks.filter((t) => lower(text).includes(lower(t)));
    if (hits.length && hits.length >= Math.min(2, toks.length)) { score += 2; signals.push(`vendor name in message/attachments (${hits.join(", ")})`); }
    return { vendor_id: v.vendor_id, vendor_name: v.vendor_name, score, signals };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);

  const top = scored[0], second = scored[1];
  const vStatus: MatchStatus = !top ? "unmatched"
    : second && top.score - second.score < 2 ? "ambiguous"
    : top.score >= 5 ? "matched" : top.score >= 3 ? "probable" : "ambiguous";
  const vendorId = vStatus === "matched" || vStatus === "probable" ? top.vendor_id : null;
  const status: MatchStatus =
    vStatus === "unmatched" || rfx.status === "unmatched" ? "unmatched"
    : vStatus === "ambiguous" ? "ambiguous"
    : vStatus === "matched" && rfx.status === "matched" ? "matched" : "probable";
  const known = ctx.vendors.some((v) => v.contact_email.toLowerCase() === sender);
  const summary = status === "matched" ? `Matched ${top.vendor_name} (${top.signals.join("; ")}) and ${rfx.signals[0]}.`
    : status === "probable" ? `Probable: ${top.vendor_name} (${top.signals.join("; ")}); RFx ${rfx.status}.`
    : status === "ambiguous" ? `Ambiguous sender: ${scored.slice(0, 3).map((c) => `${c.vendor_name} (${c.score})`).join(" vs ")}. Needs buyer confirmation.`
    : `Could not identify ${vStatus === "unmatched" ? "the vendor" : ""}${vStatus === "unmatched" && rfx.status === "unmatched" ? " or " : ""}${rfx.status === "unmatched" ? "the RFx" : ""}. Needs buyer review.`;
  return { status, rfx, vendor: { status: vStatus, vendor_id: vendorId, candidates: scored.slice(0, 5) }, contact: { email: sender, known_poc: known }, summary };
}
