/**
 * OFFLINE (no model calls): Stage 4 scenario + recommendation evaluation on the real processed bids.
 * Simulates the buyer review (accept every open item) and finalization, then checks expected PROPERTIES against the
 * Stage 1 ground truth (not prose). Writes eval/results/decision_report.{json,md} and sample exports.
 *   npm run eval:decision
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyReviewAction, finalizeBid, recompute } from "@/lib/bids/hitl";
import type { CanonicalBid } from "@/lib/bids/schema";
import { loadEventContext } from "@/lib/event/context";
import { runScenario } from "@/lib/scenarios/engine";
import { buildAwardSummary, renderAwardPdf } from "@/lib/scenarios/export";
import { recommend } from "@/lib/scenarios/recommend";
import { runSensitivity, standardWhatIfs } from "@/lib/scenarios/sensitivity";
import { runAll } from "@/lib/scenarios/standard";
import { emptyConstraints, emptyDecision } from "@/lib/scenarios/types";

const gt = JSON.parse(readFileSync("stage1/ground_truth/canonical_vendor_bids.json", "utf8"));

describe("Stage 4 decision evaluation (deterministic)", () => {
  it("checks scenario and recommendation properties and writes the report", async () => {
    const ctx = await loadEventContext();
    const dir = "eval/results/bids";
    let bids: CanonicalBid[] = readdirSync(dir).filter((f) => /^VND-\d+\.json$/.test(f)).map((f) => recompute(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")), ctx));
    expect(bids.length).toBe(5);
    bids = bids.map((b) => {
      let x = b;
      for (let i = 0; i < 30 && x.exceptions.some((e) => e.status === "open"); i++) {
        const it = x.exceptions.find((e) => e.status === "open")!;
        x = applyReviewAction(x, { review_item_id: it.id, action: "accept", note: "eval: simulated buyer review" }, ctx);
      }
      return finalizeBid(x, ctx);
    });

    const { scenarios } = runAll(ctx, bids, []);
    const rec = recommend(ctx, bids, scenarios);
    const S = (id: string) => scenarios.find((s) => s.scenario_id === id)!;
    const chosen = S(rec.recommended_scenario_id!);
    const failed: string[] = gt.evaluation_answers.failed_qualification;
    const checks: { name: string; pass: boolean; detail: string }[] = [];
    const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

    check("Failed vendors never recommended", !chosen.suppliers.some((s) => failed.includes(s.vendor_id)), `recommended suppliers ${chosen.suppliers.map((s) => s.vendor_id).join(", ")}; GT failed ${failed.join(", ")}`);
    check("Failed vendors excluded from every qualified scenario", scenarios.every((s) => !s.suppliers.some((x) => failed.includes(x.vendor_id))), "SCN-001..006");
    const ss = S("SCN-001");
    const fullCover = bids.filter((b) => b.processing_summary.quoted_lines === 30 && b.processing_summary.qualification_status === "QUALIFIED").map((b) => b.vendor.vendor_id);
    check("Single source = cheapest qualified full-coverage vendor", ss.status === "complete" && fullCover.includes(ss.suppliers[0]?.vendor_id), `${ss.suppliers[0]?.vendor_id} (full-coverage qualified: ${fullCover.join(", ")})`);
    const perLine = S("SCN-002");
    check("Cheapest qualified vendor (GT) holds the largest share of the per-line split", perLine.suppliers[0]?.vendor_id === gt.evaluation_answers.cheapest_qualified, `largest ${perLine.suppliers[0]?.vendor_id} ${perLine.suppliers[0]?.spend_pct}%; GT cheapest qualified ${gt.evaluation_answers.cheapest_qualified}`);
    check("Max-2 uses ≤2 suppliers and covers all lines", S("SCN-003").supplier_count <= 2 && S("SCN-003").status === "complete", `${S("SCN-003").supplier_count} suppliers`);
    check("Max-3 uses ≤3 suppliers", S("SCN-004").supplier_count <= 3, `${S("SCN-004").supplier_count}`);
    check("Per-line ≤ max-3 ≤ max-2 ≤ single source (cost)", perLine.total_evaluated_cost <= S("SCN-004").total_evaluated_cost && S("SCN-004").total_evaluated_cost <= S("SCN-003").total_evaluated_cost && S("SCN-003").total_evaluated_cost <= ss.total_evaluated_cost,
      [perLine, S("SCN-004"), S("SCN-003"), ss].map((s) => s.total_evaluated_cost).join(" ≤ "));
    const q = S("SCN-005");
    check("Quality-first: within 5% and higher technical score; technically strongest vendor (GT) has the largest share", q.total_evaluated_cost <= S("SCN-004").total_evaluated_cost * 1.05 + 1 && (q.weighted_technical_score ?? 0) >= (S("SCN-004").weighted_technical_score ?? 0) && q.suppliers[0]?.vendor_id === gt.evaluation_answers.technically_strongest,
      `cost ${q.total_evaluated_cost} vs ceiling ${Math.round(S("SCN-004").total_evaluated_cost * 1.05)}; tech ${q.weighted_technical_score}; top ${q.suppliers[0]?.vendor_id}; GT strongest ${gt.evaluation_answers.technically_strongest}`);
    const histExpected = Math.round(chosen.allocations.reduce((s, a) => s + ctx.historical[a.rfx_line_id].price_inr * a.annual_qty, 0));
    check("Historical benchmark from the buyer's historical file", chosen.historical_cost === histExpected, `${chosen.historical_cost} vs ${histExpected}`);
    check("Savings = historical − evaluated", chosen.savings_vs_historical === chosen.historical_cost - chosen.total_evaluated_cost, `${chosen.savings_vs_historical}`);
    check("Recommendation total equals scenario engine total", rec.key_reasons[0].includes(`₹${chosen.total_evaluated_cost.toLocaleString("en-IN")}`), rec.key_reasons[0].slice(0, 120));
    const alt = rec.alternative_scenario_id ? S(rec.alternative_scenario_id) : null;
    check("Alternative cost delta is exact", !alt || rec.cost_delta_to_alternative === alt.total_evaluated_cost - chosen.total_evaluated_cost, `${rec.cost_delta_to_alternative}`);
    const shares = chosen.suppliers.reduce((s, x) => s + x.spend_pct, 0);
    check("Concentration shares sum to 100% and lines to 30", Math.round(shares) === 100 && chosen.suppliers.reduce((s, x) => s + x.lines, 0) === 30, `${shares}%`);
    const v2blr = chosen.allocations.find((a) => a.awarded_vendor_id === "VND-1002" && a.delivery_plant !== "PNQ");
    check("Missing freight is never fabricated (estimated & flagged)", !v2blr || (v2blr.freight_basis === "rfx_loading" && !chosen.freight.landed_cost_complete && chosen.risks.some((r) => r.code === "freight_estimated")), v2blr ? `${v2blr.rfx_line_id} ${v2blr.freight_basis}` : "no V2 BLR/HYD line awarded");
    // Unresolved-critical exclusion: mark one V2 critical item unresolved and require exclusion
    const v2 = bids.find((b) => b.vendor.vendor_id === "VND-1002")!;
    const raw2 = recompute(JSON.parse(readFileSync(`${dir}/VND-1002.json`, "utf8")), ctx);
    const crit = raw2.exceptions.find((e) => e.severity === "critical");
    let critPass = true, critDetail = "no critical item in V2";
    if (crit) {
      let x = applyReviewAction(raw2, { review_item_id: crit.id, action: "unresolved" }, ctx);
      for (let i = 0; i < 30 && x.exceptions.some((e) => e.status === "open"); i++) x = applyReviewAction(x, { review_item_id: x.exceptions.find((e) => e.status === "open")!.id, action: "accept" }, ctx);
      x = finalizeBid(x, ctx);
      const withCrit = bids.map((b) => (b === v2 ? x : b));
      const s = runScenario(ctx, withCrit, { scenario_id: "T", name: "T", kind: "custom", constraints: { ...emptyConstraints(), exclude_unresolved_critical: true } });
      critPass = !s.suppliers.some((y) => y.vendor_id === "VND-1002") && s.excluded_vendors.some((e) => e.vendor_id === "VND-1002");
      critDetail = `${crit.id} unresolved → V2 excluded: ${critPass}`;
    }
    check("Unresolved-critical exclusion when the constraint is active", critPass, critDetail);
    const sens = runSensitivity(ctx, bids, [], false, standardWhatIfs(scenarios, rec, bids, ctx), { scenarios, rec });
    const v4s = sens.find((x) => x.label.includes("Vendor 4"));
    check("Sensitivity: qualifying the cheapest failed vendor changes the recommendation", !!v4s?.recommendation_changes && (v4s.cost_delta ?? 0) < 0, `${v4s?.label}: ${v4s?.cost_delta}`);

    const decision = { ...emptyDecision(), selected_scenario_id: chosen.scenario_id, status: "approved" as const,
      audit: [{ at: new Date().toISOString(), type: "recommendation_approved" as const, scenario_id: chosen.scenario_id, detail: "eval sample export" }] };
    const summary = buildAwardSummary(ctx, bids, scenarios, rec, decision);
    writeFileSync("eval/results/sample_award_recommendation.json", JSON.stringify(summary, null, 2));
    writeFileSync("eval/results/sample_award_recommendation.pdf", await renderAwardPdf(summary));

    const passed = checks.filter((c) => c.pass).length;
    const md = `# Stage 4 decision evaluation\n\n${passed}/${checks.length} property checks passed\n\n| Check | Result | Detail |\n|---|---|---|\n` +
      checks.map((c) => `| ${c.name} | ${c.pass ? "✅" : "❌"} | ${c.detail.replace(/\|/g, "/")} |`).join("\n") +
      `\n\n## Scenarios\n| ID | Name | Status | Cost | Savings | Suppliers | Tech |\n|---|---|---|---|---|---|---|\n` +
      scenarios.map((s) => `| ${s.scenario_id} | ${s.name} | ${s.status} | ₹${s.total_evaluated_cost.toLocaleString("en-IN")} | ${s.savings_percent}% | ${s.suppliers.map((x) => `${x.vendor_id} ${x.spend_pct}%`).join(", ")} | ${s.weighted_technical_score} |`).join("\n") +
      `\n\n## Recommendation: ${rec.recommended_scenario_id} ${rec.recommended_name}\n${rec.decision_log.map((d) => `- **${d.rule}** ${d.outcome}`).join("\n")}\n\n## Sensitivity\n${sens.map((x) => `- ${x.label}: ${x.recommendation_changes ? "changes" : "no change"} (${x.cost_delta ?? "—"})`).join("\n")}\n`;
    writeFileSync("eval/results/decision_report.json", JSON.stringify({ checks, recommendation: rec, scenarios: scenarios.map((s) => ({ ...s, allocations: undefined })) }, null, 2));
    writeFileSync("eval/results/decision_report.md", md);
    console.log(md);
    expect(passed).toBe(checks.length);
  });
});
