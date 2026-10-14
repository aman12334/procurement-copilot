import { beforeAll, describe, expect, it } from "vitest";
import { askAnalyst, type Plan } from "@/lib/analyst/agent";
import { EvidenceIndex } from "@/lib/analyst/retrieval";
import { AnalystTools, emptyToolArgs, type ToolArgs } from "@/lib/analyst/tools";
import { computeCanonicalBid } from "@/lib/bids/compute";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext, type EventContext } from "@/lib/event/context";
import { FakeLLM } from "../fixtures/fake-client";
import { allFullAnswers, ev, extraction, quote, term } from "../fixtures/bids";

let ctx: EventContext;
let bids: CanonicalBid[];
const A = (o: Partial<ToolArgs> = {}): ToolArgs => emptyToolArgs(o);

beforeAll(async () => {
  ctx = await loadEventContext();
  const qids = ctx.questions.map((q) => q.qid);
  const mk = (id: string, no: number, prices: Record<string, number>, o: Parameters<typeof extraction>[0] = {}) => computeCanonicalBid({
    ctx, vendor: { vendor_id: id, vendor_name: `Vendor${no} Ltd`, vendor_no: no }, source_type: "pdf", source_files: [`v${no}.pdf`], model: "fake",
    processed_at: "2026-10-14T00:00:00Z", doc_chunks: [{ source_file: `v${no}.pdf`, location: "page 2", page: 2, kind: "document", text: o.document_overview ?? `Vendor ${no} general terms` }],
    extraction: extraction({ questionnaire_answers: allFullAnswers(qids), quotes: Object.entries(prices).map(([l, p]) => quote(l, p)), ...o }),
  });
  bids = [
    mk("VND-1001", 1, { "CP-001": 8, "CP-002": 12, "CP-003": 16 }),
    mk("VND-1002", 2, { "CP-001": 7, "CP-002": 11 }, {
      document_overview: "1. Rates are FOR our Chakan works. For supplies to Bengaluru & Hyderabad plants freight extra at actuals.",
      terms: [term("freight", "For supplies to Bengaluru & Hyderabad plants freight extra at actuals.", { freight_basis: "at_actuals", freight_plants: ["BLR", "HYD"], evidence: ev("freight extra at actuals", "page 2 note 1", 2, "v2.pdf") }),
              term("freight", "Rates are FOR our Chakan works", { freight_basis: "included", freight_plants: ["PNQ"] })],
    }),
    mk("VND-1004", 4, { "CP-001": 6, "CP-002": 9, "CP-003": 12 }, {
      questionnaire_answers: allFullAnswers(qids).map((a) => (a.qid === "Q01" ? { ...a, compliance: "none" as const, answer_text: "ISO 9001: Applied – audit Dec 2026" } : a)),
    }),
  ];
});

describe("Sourcing Analyst – retrieval and deterministic tools", () => {
  it("(23) RAG retrieval finds the buried freight footnote for the right vendor", () => {
    const idx = new EvidenceIndex(bids.flatMap((b) => b.chunks));
    const hits = idx.search("what did vendor 2 say about freight", { vendorIds: ["VND-1002"] });
    expect(hits[0].chunk.vendor_id).toBe("VND-1002");
    expect(hits[0].chunk.text).toMatch(/freight extra at actuals/i);
    expect(idx.search("freight", { vendorIds: ["VND-1004"] }).every((h) => h.chunk.vendor_id === "VND-1004")).toBe(true);
  });

  it("(24) structured queries: missing lines, qualification, review items", () => {
    const t = new AnalystTools(ctx, bids);
    expect((t.run("get_missing_lines", A({ vendor_id: "Vendor 2" })) as { missing_count: number }).missing_count).toBe(28);
    const q = t.run("get_qualification_status", A({ vendor_id: "VND-1004" })) as { vendors: { qualification: string; mandatory_failures: string[] }[] };
    expect(q.vendors[0]).toMatchObject({ qualification: "NOT QUALIFIED", mandatory_failures: ["Q01"] });
    const r = t.run("get_review_items", A({ vendor_id: "VND-1002" })) as { items: { reason: string }[] };
    expect(r.items.map((i) => i.reason)).toContain("incomplete_freight");
  });

  it("(25) calculations are code: totals, common lines, lowest qualified per line, scenarios", () => {
    const t = new AnalystTools(ctx, bids);
    const common = t.run("get_common_quoted_lines", A()) as { common_lines: string[] };
    expect(common.common_lines).toEqual(["CP-001", "CP-002"]);
    const qty = (id: string) => ctx.lines.find((l) => l.line_id === id)!.annual_qty;
    const total = t.run("calculate_total_for_vendor", A({ vendor_id: "VND-1001", line_scope: "common" })) as { annual_value_inr: number };
    expect(total.annual_value_inr).toBe(Math.round(8 * qty("CP-001") + 12 * qty("CP-002"))); // freight included → evaluation = price
    const low = t.run("calculate_lowest_qualified_supplier_by_line", A()) as { lines: { rfx_line_id: string; lowest_vendor: string }[]; vendors_considered: string[] };
    expect(low.vendors_considered.some((v) => v.includes("VND-1004"))).toBe(false); // not qualified
    expect(low.lines.find((l) => l.rfx_line_id === "CP-003")!.lowest_vendor).toContain("VND-1001");
    const sc = t.run("run_scenario", A({ qualified_only: true })) as { cheapest: string; excluded_vendors: { vendor: string }[] };
    expect(sc.excluded_vendors[0].vendor).toContain("VND-1004");
    const all = t.run("run_scenario", A({})) as { cheapest: string };
    expect(all.cheapest).toContain("VND-1004");
  });
});

describe("Sourcing Analyst – grounded answers and follow-ups (mocked model)", () => {
  const plan = (o: Partial<Plan>): Plan => ({ resolved_question: "q", intent: "comparison", tool_calls: [], retrieval_queries: [], ...o });

  it("(26) answer cites tool and document refs; invented citations are stripped", async () => {
    const llm = new FakeLLM([
      plan({ resolved_question: "What did Vendor 2 say about freight?", intent: "factual_retrieval",
        tool_calls: [{ tool: "get_vendor_commercial_summary", args: A({ vendor_id: "VND-1002" }), purpose: "terms" }],
        retrieval_queries: [{ query: "freight", vendor_ids: ["VND-1002"] }] }),
      { answer_markdown: "Freight is extra at actuals for Bengaluru and Hyderabad [T1] [D:VND-1002#1] [D:VND-9999#1].", table: null,
        citations: ["T1", "T7"], unresolved_issues: ["Landed cost unresolved for BLR/HYD"], cannot_compute: null },
    ]);
    const r = await askAnalyst(llm, ctx, bids, "What did Vendor 2 say about freight?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tool_results[0]).toMatchObject({ tool: "get_vendor_commercial_summary", ok: true });
    expect(r.retrieved.length).toBeGreaterThan(0);
    expect(r.citations.map((c) => c.ref)).toEqual(expect.arrayContaining(["T1"]));
    expect(r.invalid_citations).toEqual(expect.arrayContaining(["T7", "D:VND-9999#1"]));
    expect(llm.calls[1].prompt).toContain("[T1] get_vendor_commercial_summary");
    expect(llm.calls[1].prompt).toMatch(/\[D:VND-1002#\d+\]/);
  });

  it("(27) conversational follow-up: prior turns go to the planner so 'now exclude…' is resolved", async () => {
    const llm = new FakeLLM([
      plan({ resolved_question: "Compare Vendor 1 and Vendor 2 excluding lines under review",
        tool_calls: [{ tool: "compare_vendors", args: A({ vendor_ids: ["VND-1001", "VND-1002"], exclude_under_review: true }), purpose: "compare" }] }),
      { answer_markdown: "Vendor 2 is cheaper on the common lines [T1].", table: null, citations: ["T1"], unresolved_issues: [], cannot_compute: null },
    ]);
    const history = [{ question: "Compare Vendors 1 and 2.", resolved_question: "Compare Vendor 1 and Vendor 2", answer_summary: "Vendor 2 cheaper on 2 common lines." }];
    const r = await askAnalyst(llm, ctx, bids, "Now exclude anything still under review.", history);
    expect(llm.calls[0].prompt).toContain("Buyer: Compare Vendors 1 and 2.");
    expect(llm.calls[0].prompt).toContain("Buyer's new question: Now exclude anything still under review.");
    expect(r.ok && r.turn.resolved_question).toBe("Compare Vendor 1 and Vendor 2 excluding lines under review");
    expect(r.ok && (r.tool_results[0].result as { exclude_under_review: boolean }).exclude_under_review).toBe(true);
  });

  it("tool errors are reported to the answer step instead of crashing", async () => {
    const llm = new FakeLLM([
      plan({ tool_calls: [{ tool: "get_vendor_bid", args: A({ vendor_id: "VND-7777" }), purpose: "x" }] }),
      { answer_markdown: "No bid exists for that vendor [T1].", table: null, citations: ["T1"], unresolved_issues: [], cannot_compute: "unknown vendor" },
    ]);
    const r = await askAnalyst(llm, ctx, bids, "Show vendor 7777");
    expect(r.ok && r.tool_results[0].ok).toBe(false);
    expect(llm.calls[1].prompt).toContain("No processed bid for vendor");
  });
});
