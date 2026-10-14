/** Five finalized fixture bids with exactly known prices for deterministic scenario tests. */
import { computeCanonicalBid } from "@/lib/bids/compute";
import type { CanonicalBid } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { allFullAnswers, extraction, quote, term } from "./bids";

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const FACTORS = { V1: 1.0, V2: 0.88, V3: 0.95, V4: 0.8, V5: 0.85 };

export function scenarioBids(ctx: EventContext, opts: { v5Finalized?: boolean } = {}): CanonicalBid[] {
  const ids = ctx.lines.map((l) => l.line_id);
  const price = (id: string, f: number) => r2(ctx.historical[id].price_inr * f);
  const answers = (score: "high" | "mid" | "fail") => allFullAnswers(ctx.questions.map((q) => q.qid)).map((a) =>
    score === "fail" && a.qid === "Q01" ? { ...a, compliance: "none" as const }
    : score === "mid" && ["Q02", "Q11", "Q12"].includes(a.qid) ? { ...a, compliance: "none" as const } : a);
  const mk = (no: number, lines: string[], f: number, score: "high" | "mid" | "fail", extra: Parameters<typeof extraction>[0] = {}, finalized = true, dup?: string) =>
    computeCanonicalBid({
      ctx, vendor: { vendor_id: `VND-100${no}`, vendor_name: `Fixture ${no}`, vendor_no: no }, source_type: "pdf", source_files: [`v${no}.pdf`], model: "fake",
      processed_at: "2026-10-14T00:00:00Z", finalized_at: finalized ? "2026-10-14T01:00:00Z" : null,
      overrides: dup ? { [`line:${dup}:duplicate_quote`]: { review_item_id: `line:${dup}:duplicate_quote`, action: "unresolved", at: "2026-10-14T00:30:00Z" } } : {},
      extraction: extraction({ questionnaire_answers: answers(score), ...extra,
        quotes: [...lines.map((id) => quote(id, price(id, f))), ...(dup ? [quote(dup, price(dup, f) + 1)] : [])] }),
    });
  return [
    mk(1, ids, FACTORS.V1, "high"),
    mk(2, ids.slice(0, 20), FACTORS.V2, "mid", { terms: [
      term("freight", "FOR Chakan", { freight_basis: "included", freight_plants: ["PNQ"] }),
      term("freight", "BLR/HYD freight at actuals", { freight_basis: "at_actuals", freight_plants: ["BLR", "HYD"], is_quantified: false }),
    ] }),
    mk(3, ids, FACTORS.V3, "high"),
    mk(4, ids, FACTORS.V4, "fail"),
    mk(5, ids.slice(20), FACTORS.V5, "high", {}, opts.v5Finalized ?? true, "CP-025"),
  ];
}
