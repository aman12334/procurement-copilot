/**
 * Sourcing Analyst: question → plan (model) → structured tools + evidence retrieval (code) → grounded answer (model)
 * → citation check (code). Conversation context is passed in by the caller (scoped to the current event).
 */
import { z } from "zod";
import { providerSwitches, type LLMClient } from "@/lib/ai/client";
import { ANALYST_ANSWER_SYSTEM, ANALYST_PLANNER_SYSTEM, ANALYST_PROMPT_VERSION, buildAnswerPrompt, buildPlannerPrompt } from "@/lib/ai/prompts/analyst";
import { runStructuredCall, type StructuredErrorCode } from "@/lib/ai/structured";
import type { CanonicalBid, DocumentChunk } from "@/lib/bids/schema";
import type { EventContext } from "@/lib/event/context";
import { log } from "@/lib/log";
import { EvidenceIndex } from "./retrieval";
import { AnalystTools, TOOL_NAMES, ToolArgsInputSchema, type ToolName } from "./tools";
import { buildChart, ChartRequestSchema, type ChartData } from "./charts";
import { emptyDecision, type DecisionState, type ScenarioSpec } from "@/lib/scenarios/types";

export const PlanSchema = z.object({
  resolved_question: z.string(),
  intent: z.enum(["factual_retrieval", "structured_lookup", "comparison", "calculation", "qualification", "exceptions", "scenario", "other"]),
  tool_calls: z.array(z.object({ tool: z.enum(TOOL_NAMES), args: ToolArgsInputSchema, purpose: z.string() })),
  retrieval_queries: z.array(z.object({ query: z.string(), vendor_ids: z.array(z.string()) })),
});
export type Plan = z.infer<typeof PlanSchema>;

export const AnswerSchema = z.object({
  answer_markdown: z.string(),
  table: z.object({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }).nullable(),
  charts: z.array(ChartRequestSchema).describe("0-2 charts when a visual helps; the app computes every value"),
  citations: z.array(z.string()).describe("Reference ids used, e.g. T1, D:VND-1002#9"),
  unresolved_issues: z.array(z.string()),
  cannot_compute: z.string().nullable(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export interface HistoryTurn { question: string; resolved_question: string; answer_summary: string; scenario_ids?: string[] }

export interface ResolvedCitation {
  ref: string;
  kind: "tool" | "document";
  label: string;
  source_file?: string;
  location?: string;
  text?: string;
}

export type AnalystResult =
  | {
      ok: true; answer: Answer; charts: ChartData[]; chart_errors: string[]; plan: Plan; citations: ResolvedCitation[]; invalid_citations: string[]; unsupported_numbers: string[];
      tool_results: { ref: string; tool: ToolName; args: Record<string, unknown>; ok: boolean; result: unknown }[];
      retrieved: { ref: string; chunk: DocumentChunk; score: number }[];
      turn: HistoryTurn; new_scenarios: ScenarioSpec[]; meta: { model: string; promptVersion: string; calls: number; provider_switches: { at: string; from: string; to: string; kind: string; reason: string }[] };
    }
  | { ok: false; error: { code: StructuredErrorCode | "NO_BIDS"; message: string; details: string[] } };

export async function askAnalyst(
  client: LLMClient, ctx: EventContext, bids: CanonicalBid[], question: string, history: HistoryTurn[] = [], decision: DecisionState = emptyDecision(),
): Promise<AnalystResult> {
  if (!bids.length) return { ok: false, error: { code: "NO_BIDS", message: "No processed bids yet. Process vendor responses first.", details: [] } };
  const hist = history.slice(-6);
  log("info", "analyst.question", { model: client.model, question, history: hist.length, bids: bids.length });

  // Deterministic scenario overview so the planner can refer to scenario IDs and the current focus.
  const tools = new AnalystTools(ctx, bids, decision);
  let scenarioBlock = "";
  try {
    const sc = tools.getScenarios();
    scenarioBlock = sc.scenarios.map((s) => `${s.scenario_id} ${s.name} [${s.status}] cost ₹${s.total_evaluated_cost_inr.toLocaleString("en-IN")}, ${s.supplier_count} supplier(s)${s.scenario_id === sc.recommended_scenario_id ? " ← RECOMMENDED" : ""}`).join("\n");
  } catch { scenarioBlock = "(scenarios unavailable)"; }
  const current = [...hist].reverse().find((h) => h.scenario_ids?.length)?.scenario_ids?.at(-1) ?? null;

  // 1. PLAN
  const plan = await runStructuredCall(client, {
    label: "analyst:plan", system: ANALYST_PLANNER_SYSTEM, prompt: buildPlannerPrompt(ctx, bids, hist, question, scenarioBlock, current), schema: PlanSchema,
  });
  if (!plan.ok) return { ok: false, error: { code: plan.code, message: plan.message, details: plan.details } };

  // 2. EXECUTE (deterministic)
  const toolResults = plan.data.tool_calls.slice(0, 6).map((c, i) => {
    // run_sourcing_scenario returns the new scenario id; later calls in the same plan may refer to "SCN-NEW".
    if (c.args.scenario_id === "SCN-NEW" && tools.created.length) c.args.scenario_id = tools.created.at(-1)!.scenario_id;
    if (c.args.scenario_ids) c.args.scenario_ids = c.args.scenario_ids.map((x) => (x === "SCN-NEW" && tools.created.length ? tools.created.at(-1)!.scenario_id : x));
    const ref = `T${i + 1}`;
    try {
      return { ref, tool: c.tool, args: compactArgs(c.args), ok: true, result: tools.run(c.tool, c.args) };
    } catch (e) {
      return { ref, tool: c.tool, args: compactArgs(c.args), ok: false, result: { error: (e as Error).message } };
    }
  });
  const index = new EvidenceIndex(bids.flatMap((b) => b.chunks));
  const seen = new Set<string>();
  const retrieved = plan.data.retrieval_queries.slice(0, 4).flatMap((q) => {
    const ids = q.vendor_ids.map((v) => { try { return tools.vendor(v).vendor.vendor_id; } catch { return null; } }).filter((x): x is string => !!x);
    return index.search(q.query, { vendorIds: ids, k: 6 });
  }).filter((h) => (seen.has(h.chunk.chunk_id) ? false : (seen.add(h.chunk.chunk_id), true))).slice(0, 14)
    .map((h) => ({ ref: `D:${h.chunk.chunk_id}`, chunk: h.chunk, score: h.score }));
  log("info", "analyst.plan_executed", { intent: plan.data.intent, tools: toolResults.map((t) => `${t.tool}${t.ok ? "" : "(error)"}`), retrieved: retrieved.length });

  // 3. ANSWER (grounded)
  const toolBlocks = toolResults.map((t) => `[${t.ref}] ${t.tool}(${JSON.stringify(t.args)})\n${truncateJson(t.result, 9000)}`).join("\n\n");
  const docBlocks = retrieved.map((r) => `[${r.ref}] ${vendorName(bids, r.chunk.vendor_id)} – ${r.chunk.source_file}, ${r.chunk.location} (${r.chunk.kind}):\n"${r.chunk.text}"`).join("\n\n");
  const ans = await runStructuredCall(client, {
    label: "analyst:answer", system: ANALYST_ANSWER_SYSTEM, prompt: buildAnswerPrompt(question, plan.data.resolved_question, toolBlocks, docBlocks), schema: AnswerSchema,
    defaults: { charts: [] },
  });
  if (!ans.ok) return { ok: false, error: { code: ans.code, message: ans.message, details: ans.details } };

  // 4. GROUNDING CHECK (code): keep only citations that exist; collect inline refs too.
  const valid = new Map<string, ResolvedCitation>();
  for (const t of toolResults) valid.set(t.ref, { ref: t.ref, kind: "tool", label: `${t.tool} (computed)` });
  for (const r of retrieved) valid.set(r.ref, { ref: r.ref, kind: "document", label: vendorName(bids, r.chunk.vendor_id), source_file: r.chunk.source_file, location: r.chunk.location, text: r.chunk.text });
  const inline = [...ans.data.answer_markdown.matchAll(/\[((?:T\d+)|(?:D:[^\]\s]+))\]/g)].map((m) => m[1]);
  const all = [...new Set([...ans.data.citations.map((c) => c.replace(/^\[|\]$/g, "")), ...inline])];
  const citations = all.filter((c) => valid.has(c)).map((c) => valid.get(c)!);
  const invalid = all.filter((c) => !valid.has(c));
  if (invalid.length) log("warn", "analyst.invalid_citations", { invalid });

  // Numbers must come from tools or evidence: flag any figure in the answer that is not present in them.
  const evidenceText = (JSON.stringify(toolResults.map((t) => t.result)) + " " + retrieved.map((r) => r.chunk.text).join(" ")).replace(/,/g, "");
  const answerText = `${ans.data.answer_markdown} ${ans.data.table ? ans.data.table.rows.flat().join(" ") : ""}`;
  const unsupported = unsupportedNumbers(answerText, evidenceText);
  if (unsupported.length) log("warn", "analyst.unsupported_numbers", { unsupported });

  // Charts: model picks kind/subject only; values are computed here from bids + scenario engine.
  const charts: ChartData[] = [];
  const chartErrors: string[] = [];
  for (const c of ans.data.charts.slice(0, 3)) {
    try { charts.push(buildChart(c, tools, { min_total_score: ctx.qualification.min_total_score })); }
    catch (e) { chartErrors.push(`${c.kind}: ${(e as Error).message}`); }
  }

  const turn: HistoryTurn = { question, resolved_question: plan.data.resolved_question, answer_summary: ans.data.answer_markdown.slice(0, 500), scenario_ids: [...tools.touchedScenarios] };
  return {
    ok: true, answer: ans.data, charts, chart_errors: chartErrors, plan: plan.data, citations, invalid_citations: invalid, unsupported_numbers: unsupported, tool_results: toolResults, retrieved, turn, new_scenarios: [...tools.created],
    meta: { model: client.model, promptVersion: ANALYST_PROMPT_VERSION, calls: plan.attempts + ans.attempts, provider_switches: providerSwitches(client) },
  };
}

function compactArgs(a: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
}

function vendorName(bids: CanonicalBid[], id: string) {
  const b = bids.find((x) => x.vendor.vendor_id === id);
  return b ? `Vendor ${b.vendor.vendor_no} (${b.vendor.vendor_name})` : id;
}

function truncateJson(v: unknown, n: number) {
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + `…[truncated ${s.length - n} chars]` : s;
}

/** Figures (≥2 digits, excluding years and IDs like CP-011) in the answer that do not occur in tool output / evidence. */
export function unsupportedNumbers(answer: string, evidence: string): string[] {
  const nums = [...answer.replace(/\b(?:CP|SCN|SCN-C|VND|Q|BR|REF)-?\d+/g, " ").matchAll(/(?:₹\s?)?\b\d[\d,]*(?:\.\d+)?\b/g)]
    .map((m) => m[0].replace(/[₹\s,]/g, "")).filter((n) => n.length >= 2 && !/^(19|20)\d\d$/.test(n));
  const variants = (n: string) => [n, String(Number(n)), Number(n).toFixed(2), (Number(n) * 1e7).toFixed(0), (Number(n) * 1e5).toFixed(0)];
  return [...new Set(nums)].filter((n) => !variants(n).some((v) => evidence.includes(v)));
}
