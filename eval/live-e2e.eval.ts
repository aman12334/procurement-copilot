/**
 * ONE controlled live end-to-end run (real model, frozen config). `npm run live:e2e`
 * Simulated inbound email (Vendor 3) → identity → queue → Gemini extraction → canonical bid → exceptions → HITL action
 * → recomputation → comparison + scenarios → one Sourcing Analyst question. Other vendors reuse previously processed
 * bids (no model calls). Writes eval/results/live_run_report.{json,md}. Never overwrites earlier artifacts on failure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertFrozen, loadEvalConfig, writeRunStatus } from "./config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const VENDOR = "VND-1003";
const QUESTION = "Why is Vendor 3 not currently the recommended supplier, and what would need to change for it to become competitive?";

describe("live end-to-end (one run)", () => {
  it("runs the full path once and writes the report", async () => {
    const frozen = loadEvalConfig();
    try { assertFrozen(frozen); } catch (e) { writeRunStatus("live_e2e", "config_mismatch", { error: (e as Error).message }); throw e; }
    console.log(`LIVE RUN – frozen ${frozen.provider}:${frozen.model}, prompts ${JSON.stringify(frozen.prompt_versions)}`);
    const { loadEventContext } = await import("@/lib/event/context");
    const { createLLMClient, FallbackClient } = await import("@/lib/ai/client");
    const { readEventFile } = await import("@/lib/event/files");
    const { simulatedEmail, receive, runJob, hydrateMessage } = await import("@/lib/ingestion/queue");
    const { applyReviewAction, finalizeBid } = await import("@/lib/bids/hitl");
    const { askAnalyst } = await import("@/lib/analyst/agent");
    const { runAll } = await import("@/lib/scenarios/standard");
    const { recommend } = await import("@/lib/scenarios/recommend");
    const { loadReviewedBids } = await import("./helpers");
    const ctx = await loadEventContext();
    const client = createLLMClient(undefined, { fallback: false }); // evals never switch provider/model
    const inner = (client instanceof FallbackClient ? client.primary : client) as unknown as { calls?: number; retries?: number };
    const counts = () => ({ calls: inner.calls ?? NaN, retries: inner.retries ?? NaN });
    const report: Record<string, unknown> = { started_at: new Date().toISOString(), model: client.model, prompt_versions: frozen.prompt_versions, vendor_fixture: `${VENDOR} (Indus Fibreboard – DOCX)` };
    const finish = (status: "passed" | "failed" | "infrastructure_blocked", extra: Record<string, unknown> = {}) => {
      Object.assign(report, extra, { llm_calls: counts().calls, retries: counts().retries, status, finished_at: new Date().toISOString() });
      writeFileSync("eval/results/live_run_report.json", JSON.stringify(report, null, 2));
      writeFileSync("eval/results/live_run_report.md", toMd(report));
      writeRunStatus("live_e2e", status, { model: client.model });
      console.log(toMd(report));
    };

    // 1-3 inbound email → identity → queue
    const load = (ref: string) => readEventFile(ref);
    const message = await hydrateMessage(simulatedEmail(ctx, VENDOR), load);
    let job = receive(ctx, message);
    report.identity = { status: job.identity.status, vendor: job.identity.vendor.vendor_id, rfx: job.identity.rfx.rfx_id, summary: job.identity.summary };
    expect(job.state).toBe("queued");

    // 4-7 existing Bid Processing Agent via the queue
    const reuse = process.env.LIVE_REUSE_BID === "1" && existsSync(`eval/results/live_run_bid_${VENDOR}.json`);
    const out = reuse
      ? { job: { ...job, state: "completed" as const, history: [...job.history, { at: new Date().toISOString(), state: "completed" as const, note: "reused bid extracted earlier in this live run (no new extraction call)" }] },
          bid: JSON.parse(readFileSync(`eval/results/live_run_bid_${VENDOR}.json`, "utf8")) as import("@/lib/bids/schema").CanonicalBid }
      : await runJob(client, ctx, job, load);
    if (reuse) report.reused_extraction = `eval/results/live_run_bid_${VENDOR}.json`;
    job = out.job;
    report.job_states = job.history.map((h) => h.state);
    if (!out.bid) {
      finish(job.last_error?.code === "MODEL_UNAVAILABLE" ? "infrastructure_blocked" : "failed", { processing_result: job.history.at(-1)?.note, error: job.last_error });
      throw new Error(`Processing did not complete: ${job.last_error?.message}`);
    }
    let bid = out.bid;
    if (!reuse) writeFileSync(`eval/results/live_run_bid_${VENDOR}.json`, JSON.stringify(bid, null, 2)); // separate file – earlier artifacts untouched
    const s0 = bid.processing_summary;
    report.processing_result = { quoted_lines: `${s0.quoted_lines}/${s0.rfx_lines}`, missing: bid.missing_rfx_lines, technical: `${s0.technical_score}/100 ${s0.qualification_status}`,
      usd_lines: bid.line_items.filter((l) => l.raw_currency === "USD").map((l) => `${l.rfx_line_id} ${l.raw_price_text} → ₹${l.normalized_unit_price_inr}`) };
    report.exceptions_found = bid.exceptions.map((e) => `${e.id} [${e.severity}] ${e.message.slice(0, 140)}`);

    // 8-9 HITL action + downstream recomputation
    const target = bid.exceptions.find((e) => e.status === "open" && e.id === "terms:validity:conflicting_values")
      ?? bid.exceptions.find((e) => e.status === "open" && e.scope === "line") ?? bid.exceptions.find((e) => e.status === "open");
    let recomputeOk = true;
    if (target) {
      const before = bid;
      bid = applyReviewAction(bid, { review_item_id: target.id, action: "accept", note: "live e2e: buyer accepted suggested value" }, ctx);
      recomputeOk = bid.processing_summary.open_review_items === before.processing_summary.open_review_items - 1
        && JSON.stringify(bid.extraction) === JSON.stringify(before.extraction) && bid.audit_log.length === before.audit_log.length + 1;
      report.hitl_action = { item: target.id, action: "accept", suggested: target.suggested_value, open_before: before.processing_summary.open_review_items, open_after: bid.processing_summary.open_review_items,
        audit_record: bid.audit_log.at(-1) };
    } else report.hitl_action = "no review items";
    for (let i = 0; i < 30 && bid.exceptions.some((e) => e.status === "open"); i++)
      bid = applyReviewAction(bid, { review_item_id: bid.exceptions.find((e) => e.status === "open")!.id, action: "accept", note: "live e2e: remaining items accepted" }, ctx);
    bid = finalizeBid(bid, ctx);

    // 10 comparison + scenarios recomputed with the new bid (other vendors: previously processed, no model calls)
    const others = loadReviewedBids(ctx).filter((b) => b.vendor.vendor_id !== VENDOR);
    const bids = [...others, bid];
    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const chosen = scenarios.find((x) => x.scenario_id === rec.recommended_scenario_id)!;
    report.downstream_recomputation = { ok: recomputeOk && !!chosen, finalized: bid.review_state === "finalized",
      comparison: bids.map((b) => `${b.vendor.vendor_id}: ${b.processing_summary.quoted_lines} lines, tech ${b.processing_summary.technical_score}, ₹${b.processing_summary.annual_value_evaluated_inr}`),
      recommended: `${chosen.scenario_id} ${chosen.name} ₹${chosen.total_evaluated_cost} (${chosen.suppliers.map((x) => x.vendor_id).join(", ")})`,
      vendor3_in_recommendation: chosen.suppliers.some((x) => x.vendor_id === VENDOR) };

    // 11-12 one Sourcing Analyst question
    const a = await askAnalyst(client, ctx, bids, QUESTION, []);
    if (!a.ok) {
      finish(a.error.code === "MODEL_UNAVAILABLE" ? "infrastructure_blocked" : "failed", { analyst_question: QUESTION, analyst_error: a.error });
      throw new Error(`Analyst failed: ${a.error.message}`);
    }
    const scenarioTools = a.tool_results.filter((t) => ["get_scenarios", "get_recommended_scenario", "explain_vendor_exclusion", "run_sensitivity", "run_sourcing_scenario", "compare_scenarios", "get_scenario_allocation"].includes(t.tool));
    const grounded = a.citations.length > 0 && a.invalid_citations.length === 0 && a.unsupported_numbers.length === 0 && scenarioTools.length > 0;
    report.analyst = { question: QUESTION, tools: a.tool_results.map((t) => `${t.tool}${t.ok ? "" : " (error)"}`), citations: a.citations.map((c) => c.ref),
      invalid_citations: a.invalid_citations, unsupported_numbers: a.unsupported_numbers, grounded, answer: a.answer.answer_markdown };
    const passed = recomputeOk && grounded && bid.review_state === "finalized";
    finish(passed ? "passed" : "failed");
    expect(passed).toBe(true);
  }, 900_000);
});

function toMd(r: Record<string, unknown>) {
  const j = (v: unknown) => (typeof v === "string" ? v : "```json\n" + JSON.stringify(v, null, 2) + "\n```");
  return `# Live end-to-end run\n\n| | |\n|---|---|\n| Status | **${r.status}** |\n| Model | ${r.model} |\n| Prompt versions | ${JSON.stringify(r.prompt_versions)} |\n| Vendor fixture | ${r.vendor_fixture} |\n| LLM calls | ${r.llm_calls} |\n| Retries | ${r.retries} |\n| Job states | ${(r.job_states as string[] | undefined)?.join(" → ") ?? "-"} |\n\n` +
    ["identity", "processing_result", "exceptions_found", "hitl_action", "downstream_recomputation", "analyst", "error", "analyst_error"].filter((k) => r[k] !== undefined).map((k) => `## ${k}\n${j(r[k])}`).join("\n\n") + "\n";
}
