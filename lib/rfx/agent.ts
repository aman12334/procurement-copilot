/**
 * RFx Creation Agent: buyer prompt -> LLM (Gemini or Claude, structured output) -> Zod validation
 * (one corrective retry) -> business validation. Depends only on the LLMClient interface.
 */
import type { z } from "zod";
import { providerSwitches, type LLMClient } from "@/lib/ai/client";
import {
  RFX_PROMPT_VERSION,
  RFX_SYSTEM_PROMPT,
  buildGeneratePrompt,
  buildRefinePrompt,
  buildSectionPrompt,
} from "@/lib/ai/prompts/rfx-system";
import { log } from "@/lib/log";
import { runStructuredCall, type StructuredErrorCode, type StructuredOutcome } from "@/lib/ai/structured";
import {
  RfxDraftSchema,
  SECTIONS,
  sectionResponseSchema,
  type Assumption,
  type RfxDraft,
  type SectionId,
  type UnresolvedField,
} from "./schema";
import { validateBusinessRules, type ValidationIssue } from "./validate";

export { MAX_ATTEMPTS } from "@/lib/ai/structured";

export interface AgentMeta {
  model: string;
  promptVersion: string;
  attempts: number;
  retried: boolean;
  provider_switches?: ReturnType<typeof providerSwitches>;
}
export type AgentErrorCode = StructuredErrorCode | "BAD_REQUEST";
export type AgentResult =
  | { ok: true; rfx: RfxDraft; issues: ValidationIssue[]; meta: AgentMeta }
  | { ok: false; error: { code: AgentErrorCode; message: string; details: string[] }; meta: AgentMeta };

/** Stage 2 entry point kept for compatibility: RFx system prompt + shared structured call. */
export function runStructured<T>(client: LLMClient, label: string, prompt: string, schema: z.ZodType<T>) {
  return runStructuredCall(client, { label, system: RFX_SYSTEM_PROMPT, prompt, schema });
}

function finish(client: LLMClient, label: string, out: StructuredOutcome<RfxDraft>): AgentResult {
  const meta: AgentMeta = { model: client.model, promptVersion: RFX_PROMPT_VERSION, attempts: out.attempts, retried: out.attempts > 1, provider_switches: providerSwitches(client) };
  if (!out.ok) {
    log("error", "rfx.failed", { label, ...meta, code: out.code, details: out.details });
    return { ok: false, error: { code: out.code, message: out.message, details: out.details }, meta };
  }
  const issues = validateBusinessRules(out.data);
  log("info", "rfx.final", { label, ...meta, issues: issues.length, rfx: out.data });
  return { ok: true, rfx: out.data, issues, meta };
}

export async function generateRfx(client: LLMClient, buyerInput: string, today?: Date): Promise<AgentResult> {
  log("info", "rfx.generate.request", { model: client.model, buyerInput });
  const out = await runStructured(client, "generate", buildGeneratePrompt(buyerInput, today), RfxDraftSchema);
  return finish(client, "generate", out);
}

/** Conversational change request applied to the whole draft (other content preserved by instruction). */
export async function refineRfx(client: LLMClient, rfx: RfxDraft, instruction: string, today?: Date): Promise<AgentResult> {
  log("info", "rfx.refine.request", { model: client.model, instruction });
  const out = await runStructured(client, "refine", buildRefinePrompt(JSON.stringify(rfx), instruction, today), RfxDraftSchema);
  return finish(client, "refine", out);
}

function mergeAssumptions(existing: Assumption[], added: Assumption[]): Assumption[] {
  const ids = new Set(existing.map((a) => a.id));
  const seen = new Set(existing.map((a) => `${a.field}|${a.assumption}`));
  let n = existing.length;
  const out = [...existing];
  for (const a of added) {
    if (seen.has(`${a.field}|${a.assumption}`)) continue;
    let id = a.id;
    while (ids.has(id)) id = `A-${String(++n).padStart(2, "0")}`;
    ids.add(id);
    out.push({ ...a, id });
  }
  return out;
}

function mergeUnresolved(existing: UnresolvedField[], added: UnresolvedField[]): UnresolvedField[] {
  const fields = new Set(existing.map((u) => u.field));
  return [...existing, ...added.filter((u) => !fields.has(u.field))];
}

/** Merge a regenerated section into the draft; everything outside the section is preserved. */
export function mergeSection(rfx: RfxDraft, section: SectionId, data: Record<string, unknown>): RfxDraft {
  const next: RfxDraft = structuredClone(rfx);
  for (const k of SECTIONS[section].keys) (next as Record<string, unknown>)[k] = data[k];
  if (Array.isArray(data.new_assumptions)) next.assumptions = mergeAssumptions(next.assumptions, data.new_assumptions as Assumption[]);
  if (Array.isArray(data.new_unresolved_fields))
    next.unresolved_fields = mergeUnresolved(next.unresolved_fields, data.new_unresolved_fields as UnresolvedField[]);
  return RfxDraftSchema.parse(next);
}

export async function regenerateSection(
  client: LLMClient,
  rfx: RfxDraft,
  section: SectionId,
  instruction?: string,
  today?: Date,
): Promise<AgentResult> {
  log("info", "rfx.section.request", { model: client.model, section, instruction });
  const schema = sectionResponseSchema(section);
  const prompt = buildSectionPrompt(
    JSON.stringify(rfx), SECTIONS[section].label, SECTIONS[section].keys, Object.keys(schema.shape), instruction, today);
  const out = await runStructured(client, `section:${section}`, prompt, schema);
  if (!out.ok) return finish(client, `section:${section}`, out as StructuredOutcome<RfxDraft>);
  return finish(client, `section:${section}`, { ok: true, data: mergeSection(rfx, section, out.data), attempts: out.attempts });
}
