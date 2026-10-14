/**
 * POST /api/rfx – the only entry point to the RFx Creation Agent.
 * Runs server-side (Node runtime) so provider API keys never reach the browser.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createLLMClient, type LLMClient } from "@/lib/ai/client";
import { AIConfigError, describeAIConfig, getLLMSettings } from "@/lib/ai/model";
import { generateRfx, generateRfxParallel, refineRfx, regenerateSection } from "@/lib/rfx/agent";
import { RfxDraftSchema, SECTION_IDS } from "@/lib/rfx/schema";
import { log } from "@/lib/log";

export const runtime = "nodejs";
// Models can queue requests under load; allow two model attempts plus headroom (Vercel Fluid compute max 300 s).
export const maxDuration = 300;

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), buyer_input: z.string().trim().min(10, "Describe the requirement in at least a sentence.").max(20000) }),
  z.object({ action: z.literal("refine"), rfx: RfxDraftSchema, instruction: z.string().trim().min(3).max(5000) }),
  z.object({ action: z.literal("regenerate_section"), rfx: RfxDraftSchema, section: z.enum(SECTION_IDS as [string, ...string[]]), instruction: z.string().max(5000).optional() }),
]);

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Request body must be JSON.", details: [] } }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid request.", details } }, { status: 400 });
  }

  let client: LLMClient;
  try {
    const st = getLLMSettings();
    log("info", "rfx.request", { action: parsed.data.action, ai: describeAIConfig(st.primary), fallback: st.fallback_status });
    client = createLLMClient(undefined, { settings: st });
  } catch (e) {
    if (e instanceof AIConfigError) {
      log("error", "rfx.config_missing", { message: e.message });
      return NextResponse.json({ ok: false, error: { code: e.code, message: e.message, details: [] } }, { status: 503 });
    }
    throw e;
  }

  const r = parsed.data;
  const result =
    // Parallel parts by default (fast); RFX_GENERATION_MODE=single uses the one-call draft (the frozen eval path).
    r.action === "generate" ? await (process.env.RFX_GENERATION_MODE?.trim() === "single" ? generateRfx : generateRfxParallel)(client, r.buyer_input)
    : r.action === "refine" ? await refineRfx(client, r.rfx, r.instruction)
    : await regenerateSection(client, r.rfx, r.section as (typeof SECTION_IDS)[number], r.instruction);

  const status = result.ok ? 200
    : result.error.code === "MODEL_UNAVAILABLE" ? 503
    : result.error.code === "MODEL_CALL_FAILED" ? 502 : 422;
  return NextResponse.json(result, { status });
}
