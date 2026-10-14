/**
 * Outbound RFx invitations (channel: simulated email). Built deterministically from the released RFx so the
 * buyer can see exactly what each vendor receives; nothing is sent to a real mailbox.
 */
import type { RfxDraft } from "@/lib/rfx/schema";
import type { ReleasedEvent, ReleasedVendor } from "./released";

export interface Invitation {
  vendor_id: string;
  vendor_name: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  response_token: string | null;
  channel: "simulated_email";
  status: "sent_simulated";
  sent_at: string;
}

export const BUYER_MAILBOX = "procurement@sahyadricp.example";

const val = (v: { value: string | null } | undefined) => v?.value?.trim() || null;

export function buildInvitation(rfx: RfxDraft, vendor: ReleasedVendor, sentAt: string, from = BUYER_MAILBOX): Invitation {
  const ref = vendor.response_token ?? null;
  const t = rfx.commercial_terms;
  const plants = rfx.buyer.locations.map((l) => `${l.name} (${l.code})`).join(", ");
  const mandatory = rfx.mandatory_requirements.map((r) => `  - ${r.requirement}`);
  const terms = [
    ["Currency", val(t.currency)], ["Price basis", val(t.price_basis)], ["Freight", val(t.freight_treatment)], ["Taxes", val(t.taxes)],
    ["Payment terms", val(t.payment_terms)], ["Price validity", val(t.price_validity)],
    ["Lead time", val(rfx.delivery_requirements.lead_time)], ["Delivery terms", val(rfx.delivery_requirements.delivery_terms)],
  ].filter(([, v]) => v).map(([k, v]) => `  - ${k}: ${v}`);
  const qPoints = rfx.technical_questionnaire.reduce((a, q) => a + q.max_points, 0);
  const subject = `RFQ ${rfx.rfx_id} – ${rfx.title}${ref ? ` [Response ref: ${ref}]` : ""}`;
  const body = [
    `Dear ${vendor.vendor_name} team,`,
    "",
    `${rfx.buyer.company ?? "We"} invite${rfx.buyer.company ? "s" : ""} you to quote for: ${rfx.title}.`,
    "",
    `Scope: ${rfx.scope.description}`,
    `Line items: ${rfx.line_items.length} (please quote every line you can supply; partial bids ${rfx.scope.partial_bids_allowed === false ? "are NOT" : "are"} accepted).`,
    plants ? `Delivery locations: ${plants}.` : "",
    rfx.scope.contract_period ? `Contract period: ${rfx.scope.contract_period}.` : "",
    "",
    mandatory.length ? "Mandatory requirements:" : "", ...mandatory,
    "",
    terms.length ? "Commercial terms requested:" : "", ...terms,
    "",
    `Technical questionnaire: ${rfx.technical_questionnaire.length} questions (${qPoints} points; qualification ${rfx.qualification.min_total_score ?? "as stated"}+ and all mandatory items).`,
    "",
    `Response deadline: ${rfx.response_deadline ?? "to be confirmed"}.`,
    "",
    "How to respond: reply to this email in any format you prefer – your own Excel, PDF, Word, a photo of your rate card,",
    `or prices in the email text. Please keep ${ref ? `the response reference ${ref}` : `RFQ ${rfx.rfx_id}`} in the subject,`,
    "state prices per unit with currency, freight to each plant, payment terms and validity, and attach any certificates.",
    "",
    "Regards,",
    `Procurement – ${rfx.buyer.company ?? "Buyer"}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  return { vendor_id: vendor.vendor_id, vendor_name: vendor.vendor_name, to: vendor.contact_email, from, subject, body, response_token: ref,
    channel: "simulated_email", status: "sent_simulated", sent_at: sentAt };
}

export function buildInvitations(ev: ReleasedEvent): Invitation[] {
  return ev.vendors.map((v) => buildInvitation(ev.rfx, v, ev.released_at));
}

/** RFC 822 text so the buyer can open the exact invitation in a mail client. */
export function toEml(inv: Invitation): string {
  return [`From: ${inv.from}`, `To: ${inv.to}`, `Subject: ${inv.subject}`, `Date: ${new Date(inv.sent_at).toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "X-Channel: simulated", "", inv.body, ""].join("\r\n");
}
