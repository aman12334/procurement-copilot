/**
 * Opt-in live test against the configured provider (AI_PROVIDER: gemini | anthropic): `npm run test:live`.
 * Skipped unless RFX_LIVE_TEST is set (default `npm test` never calls a real API).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

function live0() { return !!process.env.RFX_LIVE_TEST; }
// Next skips .env.local when NODE_ENV=test, so load it explicitly for this opt-in test.
if (live0() && existsSync(".env.local")) process.loadEnvFile(".env.local");
const live = !!process.env.RFX_LIVE_TEST;

describe.skipIf(!live)("live LLM (opt-in)", () => {
  it("generates a schema-valid RFx from the demo prompt and regenerates one section", async () => {
    const { createLLMClient } = await import("@/lib/ai/client");
    const { generateRfx, regenerateSection } = await import("@/lib/rfx/agent");
    const { DEMO_BUYER_PROMPT } = await import("@/lib/rfx/demo");
    const client = createLLMClient();
    const r = await generateRfx(client, DEMO_BUYER_PROMPT);
    if (!r.ok) console.error(r.error);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    console.log(JSON.stringify({ meta: r.meta, issues: r.issues, unresolved: r.rfx.unresolved_fields.map((u) => u.field) }, null, 2));
    expect(r.rfx.delivery_requirements.lead_time_days).toBe(14);
    expect(r.rfx.buyer.locations.map((l) => l.code).sort()).toEqual(["BLR", "HYD", "PNQ"]);
    expect(r.rfx.evaluation_criteria.reduce((s, c) => s + c.weight, 0)).toBe(100);

    const q = await regenerateSection(client, r.rfx, "technical_questionnaire", "Add a question on pallet compliance");
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.rfx.line_items).toEqual(r.rfx.line_items);
  }, 560_000);
});
