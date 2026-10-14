/**
 * Safe-write semantics for processed bids:
 *   successful, schema-validated result → keep the old version in history → activate the new one
 *   failure → keep the last good version active, record the failure separately
 */
import type { CanonicalBid } from "./schema";

export interface BidVersions {
  active: Record<string, CanonicalBid>;
  previous: Record<string, { bid: CanonicalBid; replaced_at: string }[]>;
  failures: { vendor_id: string; at: string; code: string; kind: string | null; message: string; source: string }[];
}

export const emptyVersions = (): BidVersions => ({ active: {}, previous: {}, failures: [] });
const KEEP_PREVIOUS = 3;

export type ProcessingOutcome =
  | { ok: true; bid: CanonicalBid }
  | { ok: false; error: { code: string; message: string; details?: string[] } };

export function commitOutcome(v: BidVersions, vendorId: string, outcome: ProcessingOutcome, source: string, now = new Date()): BidVersions {
  if (!outcome.ok) {
    const kind = outcome.error.details?.find((d) => d.startsWith("kind:"))?.slice(5) ?? null;
    return { ...v, failures: [...v.failures, { vendor_id: vendorId, at: now.toISOString(), code: outcome.error.code, kind, message: outcome.error.message, source }].slice(-50) };
  }
  const prev = v.active[vendorId];
  return {
    active: { ...v.active, [vendorId]: outcome.bid },
    previous: prev ? { ...v.previous, [vendorId]: [{ bid: prev, replaced_at: now.toISOString() }, ...(v.previous[vendorId] ?? [])].slice(0, KEEP_PREVIOUS) } : v.previous,
    failures: v.failures,
  };
}
