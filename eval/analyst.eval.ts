/**
 * OFFLINE + LIVE: Sourcing Analyst golden questions over the bids saved by `npm run eval:process`.
 * Expectations come from the Stage 1 ground truth (evaluation_answers, manifest). Writes eval/results/analyst_report.{json,md}.
 *   npm run eval:analyst          (EVAL_Q=1,2,5 to run a subset)
 */
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
import { assertFrozen, loadEvalConfig, writeRunStatus } from "./config";
// Frozen config: abort (no model switching) if the runtime model/dataset differs from eval/eval.config.json.
try { assertFrozen(loadEvalConfig()); } catch (e) { writeRunStatus("analyst", "config_mismatch", { error: (e as Error).message }); throw e; }

interface Golden {
  id: number | string;
  category: "factual_retrieval" | "structured_comparison" | "calculation" | "qualification" | "exception_awareness" | "grounded_explanation" | "follow_up"
    | "recommendation" | "why_not" | "scenario_modification" | "sensitivity";
  chain?: "demo";                    // run in order; history = all previous turns of the chain; scenario state carried
  expected_intents?: string[];
  context_check?: (plan: { tool_calls: { tool: string; args: Record<string, unknown> }[] }, prevScenarios: string[]) => boolean;
  question: string;
  expected_tools: string[];          // any of these must be planned
  must_mention: RegExp[];            // all must match answer text + table
  needs_document_citation?: boolean; // at least one D: citation
  follow_up_of?: number | string;    // run after this question, with its turn in history
  plan_check?: (plan: { tool_calls: { tool: string; args: Record<string, unknown> }[] }) => boolean;
}

const V = (n: number, name: string) => new RegExp(`Vendor ${n}|${name}`, "i");
const GOLDEN: Golden[] = [
  { id: 1, category: "calculation", question: "Which qualified vendor is cheapest on the commonly quoted lines?", expected_tools: ["run_scenario", "compare_vendors", "calculate_total_for_vendor", "get_common_quoted_lines"], must_mention: [V(2, "Shree Ganesh")] },
  { id: 2, category: "qualification", question: "Why did Vendor 4 fail qualification?", expected_tools: ["get_qualification_status"], must_mention: [/ISO 9001/i, /mandatory|Q01/i] },
  { id: 3, category: "structured_comparison", question: "Which vendor has the strongest technical score?", expected_tools: ["get_qualification_status", "list_vendors", "compare_vendors"], must_mention: [V(3, "Indus")] },
  { id: 4, category: "structured_comparison", question: "Which lines did Vendor 2 not quote?", expected_tools: ["get_missing_lines"], must_mention: [/CP-015/, /CP-029/, /CP-030/] },
  { id: 5, category: "factual_retrieval", question: "What did Vendor 2 say about freight?", expected_tools: ["get_vendor_commercial_summary"], must_mention: [/actuals/i, /Bengaluru|BLR/i], needs_document_citation: true },
  { id: 6, category: "exception_awareness", question: "What terms conflict in Vendor 3's response?", expected_tools: ["get_vendor_commercial_summary", "get_review_items"], must_mention: [/validity/i, /90 days|2027-01-07/i, /31 December|2026-12-31|Dec/i] },
  { id: 7, category: "factual_retrieval", question: "What did Vendor 3 say about price validity?", expected_tools: ["get_vendor_commercial_summary"], must_mention: [/90 days/i, /31 December|2026-12-31/i], needs_document_citation: true },
  { id: 8, category: "exception_awareness", question: "Show me all unresolved exceptions.", expected_tools: ["get_review_items"], must_mention: [/CP-011|duplicate/i, /CP-010|handwritten/i] },
  { id: 9, category: "calculation", question: "Which vendor has the biggest variance from historical price?", expected_tools: ["get_historical_variance"], must_mention: [V(3, "Indus")] },
  { id: 10, category: "calculation", question: "Which SKU has the largest historical price variance?", expected_tools: ["get_historical_variance"], must_mention: [/CP-026/] },
  { id: 11, category: "structured_comparison", question: "Compare Vendor 1 and Vendor 3 on price, lead time and technical score.", expected_tools: ["compare_vendors"], must_mention: [V(1, "Deccan"), V(3, "Indus")] },
  { id: 12, category: "follow_up", follow_up_of: 11, question: "Now exclude anything still under review.", expected_tools: ["compare_vendors", "calculate_total_for_vendor", "run_scenario"], must_mention: [V(1, "Deccan"), V(3, "Indus")],
    plan_check: (p) => p.tool_calls.some((c) => c.args.exclude_under_review === true) },
  { id: 13, category: "qualification", question: "Which vendor is cheaper but technically weaker?", expected_tools: ["run_scenario", "compare_vendors", "get_qualification_status", "list_vendors", "get_historical_variance"], must_mention: [V(4, "Sri Vaigai")] },
  { id: 14, category: "calculation", question: "What is the lowest-cost qualified supplier per line, and the basket total?", expected_tools: ["calculate_lowest_qualified_supplier_by_line"], must_mention: [V(2, "Shree Ganesh")] },
  { id: 15, category: "grounded_explanation", question: "Where did Vendor 3's MOQ for CP-015 come from?", expected_tools: ["get_vendor_bid", "get_line_item_comparison", "get_vendor_commercial_summary"], must_mention: [/25,?000/], needs_document_citation: true },
  { id: 16, category: "grounded_explanation", question: "Which certification evidence supports Vendor 1's ISO 9001 compliance?", expected_tools: ["get_qualification_status"], must_mention: [/ISO 9001/i, /48812|valid/i] },
  { id: 17, category: "exception_awareness", question: "Which quoted lines still require human review?", expected_tools: ["get_review_items", "list_vendors", "get_vendor_bid"], must_mention: [/CP-0\d\d/] },
  { id: 18, category: "grounded_explanation", question: "Why should I not choose Vendor 4?", expected_tools: ["get_qualification_status", "get_vendor_bid", "get_review_items", "get_missing_lines", "explain_vendor_exclusion", "get_recommended_scenario"], must_mention: [/ISO 9001/i, /not qualified|fail/i] },

  // ---------------- Stage 4: the suggested demo conversation (one chain, scenario state carried between turns)
  { id: "D1", chain: "demo", category: "calculation", question: "Which qualified vendor is cheapest?", expected_tools: ["get_scenarios", "compare_vendors", "run_scenario", "get_recommended_scenario", "calculate_total_for_vendor"], must_mention: [V(2, "Shree Ganesh")] },
  { id: "D2", chain: "demo", category: "why_not", question: "Why is Vendor 4 not recommended even though it is cheaper?", expected_tools: ["explain_vendor_exclusion", "get_qualification_status", "get_recommended_scenario"], must_mention: [/qualif/i, /ISO 9001|Q01|mandatory/i] },
  { id: "D3", chain: "demo", category: "scenario_modification", question: "What if we split the award to the cheapest qualified vendor per line?", expected_tools: ["get_scenarios", "get_scenario_allocation", "run_sourcing_scenario", "compare_scenarios", "get_supplier_award_share", "calculate_lowest_qualified_supplier_by_line"], must_mention: [V(2, "Shree Ganesh"), /suppl/i] },
  { id: "D4", chain: "demo", category: "follow_up", question: "Restrict it to a maximum of two suppliers.", expected_tools: ["run_sourcing_scenario", "get_scenarios", "compare_scenarios", "get_scenario_allocation"], must_mention: [/two|2/i],
    context_check: (p, prev) => p.tool_calls.some((c) => (c.args.constraints as { max_suppliers?: number } | null)?.max_suppliers === 2 || JSON.stringify(c.args).includes("SCN-003") || prev.some((id) => JSON.stringify(c.args).includes(id))) },
  { id: "D5", chain: "demo", category: "calculation", question: "How much does that save compared with last year?", expected_tools: ["calculate_savings", "get_scenarios", "compare_scenarios"], must_mention: [/sav/i, /histor|last year|FY25/i],
    context_check: (p, prev) => p.tool_calls.some((c) => prev.some((id) => JSON.stringify(c.args).includes(id))) },
  { id: "D6", chain: "demo", category: "scenario_modification", question: "What if I prioritize technical quality and accept up to 5% higher cost?", expected_tools: ["run_sourcing_scenario", "get_scenarios", "compare_scenarios"], must_mention: [/technical|quality/i],
    context_check: (p) => p.tool_calls.some((c) => { const k = c.args.constraints as { objective?: string; cost_tolerance_pct?: number } | null; return (k?.objective === "maximize_quality" && k.cost_tolerance_pct === 5) || JSON.stringify(c.args).includes("SCN-005"); }) },
  { id: "D7", chain: "demo", category: "recommendation", question: "Why is that recommendation better?", expected_tools: ["get_recommended_scenario", "compare_scenarios"], must_mention: [/cost|technical|score/i] },
  { id: "D8", chain: "demo", category: "exception_awareness", question: "What unresolved issues could change the decision?", expected_tools: ["get_scenario_risks", "get_review_items", "run_sensitivity", "get_recommended_scenario"], must_mention: [/freight|validity|review|unresolved/i] },
  { id: "D9", chain: "demo", category: "factual_retrieval", question: "Show me the source for Vendor 2's freight condition.", expected_tools: ["get_vendor_commercial_summary"], must_mention: [/actuals/i], needs_document_citation: true },
  { id: "D10", chain: "demo", category: "recommendation", question: "Which scenario would you recommend and why?", expected_tools: ["get_recommended_scenario"], must_mention: [/SCN-003|two suppliers|2 suppliers|max(imum)? 2/i] },

  // ---------------- Stage 4: sensitivity, exclusion and single-source challenges
  { id: "S1", category: "sensitivity", question: "What would happen to the recommendation if Vendor 2's prices rose by 5%?", expected_tools: ["run_sensitivity"], must_mention: [V(2, "Shree Ganesh"), /5\s?%/],
    context_check: (p) => p.tool_calls.some((c) => c.tool === "run_sensitivity" && (c.args.what_if === null || JSON.stringify(c.args.what_if).includes("5"))) },
  { id: "S2", category: "scenario_modification", question: "What happens if I exclude Vendor 2?", expected_tools: ["run_sourcing_scenario", "run_sensitivity"], must_mention: [V(1, "Deccan")],
    context_check: (p) => p.tool_calls.some((c) => JSON.stringify(c.args).includes("VND-1002")) },
  { id: "S3", category: "scenario_modification", question: "What if I only want one supplier?", expected_tools: ["get_scenarios", "run_sourcing_scenario", "get_scenario_allocation"], must_mention: [V(1, "Deccan")] },
];

/** Numbers in the answer that do not appear anywhere in the tool results / retrieved text (unsupported claims). */
function unsupportedNumbers(answer: string, evidence: string): string[] {
  const nums = [...answer.matchAll(/(?<![A-Z]-)(?:₹\s?)?\b\d[\d,]*(?:\.\d+)?\b/g)].map((m) => m[0].replace(/[₹\s,]/g, ""))
    .filter((n) => n.length >= 2 && !/^(19|20)\d\d$/.test(n));
  const hay = evidence.replace(/,/g, "");
  return [...new Set(nums)].filter((n) => !hay.includes(n) && !hay.includes(String(Number(n))));
}

describe("Sourcing Analyst golden questions (live model)", () => {
  it("answers the golden set and writes the report", async () => {
    const { loadEventContext } = await import("@/lib/event/context");
    const { createLLMClient } = await import("@/lib/ai/client");
    const { askAnalyst } = await import("@/lib/analyst/agent");
    const { loadReviewedBids } = await import("./helpers");
    const { emptyDecision } = await import("@/lib/scenarios/types");
    const ctx = await loadEventContext();
    const bids = loadReviewedBids(ctx);
    let decision = emptyDecision();
    expect(bids.length).toBeGreaterThan(0);
    const client = createLLMClient(undefined, { fallback: false }); // evals never switch provider/model
    const only = process.env.EVAL_Q?.split(",").map((x) => x.trim());
    const rows: Record<string, unknown>[] = [];
    const turns: Record<string, { question: string; resolved_question: string; answer_summary: string; scenario_ids?: string[] }> = {};
    const chainTurns: { question: string; resolved_question: string; answer_summary: string; scenario_ids?: string[] }[] = [];
    for (const g of GOLDEN.filter((x) => !only || only.includes(String(x.id)))) {
      const history = g.chain ? [...chainTurns] : g.follow_up_of && turns[String(g.follow_up_of)] ? [turns[String(g.follow_up_of)]] : [];
      const prevScenarios = history.flatMap((h) => h.scenario_ids ?? []);
      const t0 = Date.now();
      const r = await askAnalyst(client, ctx, bids, g.question, history, g.chain ? decision : emptyDecision());
      if (!r.ok) { rows.push({ id: g.id, category: g.category, question: g.question, ok: false, error: r.error.message }); continue; }
      turns[String(g.id)] = r.turn;
      if (g.chain) { chainTurns.push(r.turn); decision = { ...decision, custom_scenarios: [...decision.custom_scenarios, ...r.new_scenarios] }; }
      const text = `${r.answer.answer_markdown}\n${r.answer.table ? [r.answer.table.columns, ...r.answer.table.rows].map((x) => x.join(" | ")).join("\n") : ""}`;
      const evidenceText = JSON.stringify(r.tool_results.map((t) => t.result)) + r.retrieved.map((d) => d.chunk.text).join(" ");
      const tools = r.plan.tool_calls.map((c) => c.tool);
      const unsupported = unsupportedNumbers(text, evidenceText);
      rows.push({
        id: g.id, category: g.category, question: g.question, ok: true, ms: Date.now() - t0,
        answer_correct: g.must_mention.every((re) => re.test(text)),
        missing_mentions: g.must_mention.filter((re) => !re.test(text)).map(String),
        tool_selection_correct: tools.some((t) => g.expected_tools.includes(t)) && (!g.plan_check || g.plan_check(r.plan)),
        intent: r.plan.intent, intent_correct: !g.expected_intents || g.expected_intents.includes(r.plan.intent),
        context_retained: g.context_check ? g.context_check(r.plan, prevScenarios) : null,
        new_scenarios: r.new_scenarios.map((x) => x.scenario_id),
        tools, grounded: r.citations.length > 0 && r.invalid_citations.length === 0,
        document_grounded: !g.needs_document_citation || r.citations.some((c) => c.kind === "document"),
        calculation_correct: g.category !== "calculation" ? null : g.must_mention.every((re) => re.test(text)) && unsupported.length === 0,
        citations: r.citations.length, invalid_citations: r.invalid_citations, unsupported_numbers: unsupported,
        answer: r.answer.answer_markdown.slice(0, 900),
      });
    }
    const ok = rows.filter((r) => r.ok);
    const rate = (k: string) => Math.round((ok.filter((r) => r[k] === true).length / Math.max(1, ok.filter((r) => r[k] !== null).length)) * 1000) / 10;
    const totalCites = ok.reduce((s, r) => s + (r.citations as number) + (r.invalid_citations as string[]).length, 0);
    const summary = {
      model: client.model, questions: rows.length, answered: ok.length,
      answer_correctness_pct: rate("answer_correct"), tool_selection_pct: rate("tool_selection_correct"),
      evidence_grounding_pct: rate("grounded"), document_grounding_pct: rate("document_grounded"), calculation_correctness_pct: rate("calculation_correct"),
      intent_correctness_pct: rate("intent_correct"), context_retention_pct: rate("context_retained"),
      unsupported_claim_rate_pct: Math.round((ok.filter((r) => (r.unsupported_numbers as string[]).length > 0 || (r.invalid_citations as string[]).length > 0).length / Math.max(1, ok.length)) * 1000) / 10,
      invalid_citation_share_pct: Math.round((ok.reduce((s, r) => s + (r.invalid_citations as string[]).length, 0) / Math.max(1, totalCites)) * 1000) / 10,
    };
    writeFileSync("eval/results/analyst_report.json", JSON.stringify({ generated_at: new Date().toISOString(), summary, rows }, null, 2));
    const md = `# Sourcing Analyst – golden question evaluation\n\nModel ${summary.model} · ${summary.answered}/${summary.questions} answered\n\n` +
      `| Metric | Value |\n|---|---|\n${Object.entries(summary).filter(([k]) => k.endsWith("_pct")).map(([k, v]) => `| ${k.replace(/_pct$/, "").replace(/_/g, " ")} | ${v}% |`).join("\n")}\n\n` +
      `| # | Category | Question | Correct | Tools | Grounded | Notes |\n|---|---|---|---|---|---|---|\n` +
      rows.map((r) => `| ${r.id} | ${r.category} | ${r.question} | ${r.ok ? (r.answer_correct ? "✅" : "❌") : "error"} | ${r.ok ? (r.tool_selection_correct ? "✅" : "❌") + " " + (r.tools as string[]).join(", ") : ""} | ${r.ok ? (r.grounded && r.document_grounded ? "✅" : "❌") : ""} | ${r.ok ? [...(r.missing_mentions as string[]).map((m) => `missing ${m}`), ...((r.unsupported_numbers as string[]).length ? [`unsupported numbers: ${(r.unsupported_numbers as string[]).join(", ")}`] : []), ...((r.invalid_citations as string[]).length ? [`invalid cites: ${(r.invalid_citations as string[]).join(", ")}`] : [])].join("; ") : r.error} |`).join("\n") + "\n";
    writeFileSync("eval/results/analyst_report.md", md);
    console.log(md);
  });
});
