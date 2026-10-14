import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, generateRfx, refineRfx, regenerateSection } from "@/lib/rfx/agent";
import { RFX_SYSTEM_PROMPT } from "@/lib/ai/prompts/rfx-system";
import { AIConfigError, getAIConfig } from "@/lib/ai/model";
import { describeQuotaError } from "@/lib/ai/client";
import { DEMO_BUYER_PROMPT } from "@/lib/rfx/demo";
import { FakeLLM } from "./fixtures/fake-client";
import { completeRfx, vagueRfx } from "./fixtures/rfx";

describe("RFx agent (fake LLM, no live API)", () => {
  it("(1) complete buyer request -> valid structured RFx, explicit facts preserved", async () => {
    const llm = new FakeLLM([completeRfx()]);
    const r = await generateRfx(llm, DEMO_BUYER_PROMPT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toMatchObject({ attempts: 1, retried: false, model: "fake-gemini-flash" });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.rfx.delivery_requirements.lead_time_days).toBe(14);
    expect(r.rfx.delivery_requirements.lead_time.source).toBe("explicit");
    expect(r.rfx.commercial_terms.payment_terms.source).toBe("generated_assumption");
    // request contents: system prompt, buyer text, and a Gemini-compatible JSON schema
    expect(llm.calls[0].system).toBe(RFX_SYSTEM_PROMPT);
    expect(llm.calls[0].prompt).toContain("Bengaluru, Pune and Hyderabad");
    expect(JSON.stringify(llm.calls[0].jsonSchema)).not.toMatch(/"const"|"\$schema"/);
  });

  it("(2) vague request -> usable draft with gaps visible as unresolved fields", async () => {
    const r = await generateRfx(new FakeLLM([vagueRfx()]), "I need some boxes.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.rfx.unresolved_fields.map((u) => u.field);
    expect(fields).toEqual(expect.arrayContaining(["buyer.locations", "response_deadline", "line_items"]));
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("(8) malformed output twice -> controlled error after exactly one retry", async () => {
    const llm = new FakeLLM(["Sure! Here is your RFx: {not json", "```json\n{\"rfx_id\": 1}\n```"]);
    const r = await generateRfx(llm, DEMO_BUYER_PROMPT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(llm.calls).toHaveLength(MAX_ATTEMPTS);
    expect(r.error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(r.error.details.length).toBeGreaterThan(0);
    expect(llm.calls[1].prompt).toContain("not valid JSON");
  });

  it("(9) single retry after schema failure, violations fed back, then success", async () => {
    const broken = { ...completeRfx(), evaluation_criteria: "heavy on price" };
    const llm = new FakeLLM([broken, completeRfx()]);
    const r = await generateRfx(llm, DEMO_BUYER_PROMPT);
    expect(r.ok).toBe(true);
    expect(r.meta).toMatchObject({ attempts: 2, retried: true });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].prompt).toContain("failed schema validation");
    expect(llm.calls[1].prompt).toContain("evaluation_criteria");
  });

  it("API failure is not retried and returns MODEL_CALL_FAILED", async () => {
    const llm = new FakeLLM([new Error("429 quota exceeded")]);
    const r = await generateRfx(llm, DEMO_BUYER_PROMPT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MODEL_CALL_FAILED");
    expect(llm.calls).toHaveLength(1);
  });

  it("overloaded / timed-out Gemini surfaces as MODEL_UNAVAILABLE without a schema retry", async () => {
    const err = Object.assign(new Error("Gemini is temporarily unavailable (HTTP 503, high demand)."), { code: "MODEL_UNAVAILABLE" });
    const llm = new FakeLLM([err]);
    const r = await generateRfx(llm, DEMO_BUYER_PROMPT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "MODEL_UNAVAILABLE", message: expect.stringContaining("high demand") });
    expect(llm.calls).toHaveLength(1);
  });

  it("(11) regenerating only the questionnaire preserves every other section", async () => {
    const original = completeRfx();
    const newQs = [
      { qid: "Q01", topic: "ISO 9001", question: "Upload ISO 9001 certificate.", answer_type: "document_upload", mandatory: true, max_points: 60,
        scoring_rule: "Valid certificate = 60", rationale: "Mandatory", source: "explicit" },
      { qid: "Q02", topic: "Moisture", question: "Cobb value achievable?", answer_type: "numeric", mandatory: false, max_points: 40,
        scoring_rule: "<= 40 g/m2 = 40", rationale: "Coated items", source: "generated_assumption" },
    ];
    const llm = new FakeLLM([{
      technical_questionnaire: newQs,
      qualification: { min_total_score: 60, rule: "Score >= 60 and mandatory questions compliant." },
      new_assumptions: [{ id: "A-01", field: "qualification.min_total_score", assumption: "60", rationale: "Short questionnaire" }],
      new_unresolved_fields: [],
    }]);
    const r = await regenerateSection(llm, original, "technical_questionnaire", "Make it shorter");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rfx.technical_questionnaire).toHaveLength(2);
    const { technical_questionnaire: _a, qualification: _b, assumptions: newAssumptions, ...rest } = r.rfx;
    const { technical_questionnaire: _c, qualification: _d, assumptions: oldAssumptions, ...restOriginal } = original;
    expect(rest).toEqual(restOriginal);
    expect(newAssumptions).toHaveLength(oldAssumptions.length + 1);
    expect(new Set(newAssumptions.map((a) => a.id)).size).toBe(newAssumptions.length); // id collision renumbered
    expect(llm.calls[0].prompt).toContain('Regenerate ONLY the "Technical questionnaire" section');
    expect(Object.keys((llm.calls[0].jsonSchema as { properties: object }).properties)).toEqual(
      ["technical_questionnaire", "qualification", "new_assumptions", "new_unresolved_fields"]);
  });

  it("refine sends the current draft and the change request", async () => {
    const updated = completeRfx();
    updated.commercial_terms.payment_terms = { value: "60 days from GRN", source: "explicit", note: null };
    const llm = new FakeLLM([updated]);
    const r = await refineRfx(llm, completeRfx(), "Payment terms should be 60 days from GRN");
    expect(r.ok && r.rfx.commercial_terms.payment_terms.value).toBe("60 days from GRN");
    expect(llm.calls[0].prompt).toContain('"rfx_id":"RFX-DRAFT-PKG"');
  });

  it("recognises an exhausted daily free-tier quota from Google's 429 body", () => {
    const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20194s" },
    ] } });
    const q = describeQuotaError(body)!;
    expect(q).toMatchObject({ daily: true, retryAfterS: 20194 });
    expect(q.summary).toContain("20 requests/day");
    expect(q.summary).toContain("5 h 37 min");
    expect(describeQuotaError("not json")).toBeNull();
  });

  it("missing GEMINI_API_KEY fails loudly with a developer-facing message", () => {
    expect(() => getAIConfig({})).toThrow(AIConfigError);
    expect(() => getAIConfig({})).toThrow(/GEMINI_API_KEY is not set/);
    expect(() => getAIConfig({ GEMINI_API_KEY: "k", NEXT_PUBLIC_GEMINI_API_KEY: "k" })).toThrow(/NEXT_PUBLIC/);
    expect(getAIConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-x-flash" }).model).toBe("gemini-x-flash");
    expect(() => getAIConfig({ GEMINI_API_KEY: "k" })).toThrow(/GEMINI_MODEL is not set/); // model pinned, no default
    expect(getAIConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL: "m" })).toMatchObject({ model: "m", thinkingLevel: "LOW", timeoutMs: 90000 });
    expect(() => getAIConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL: "m", GEMINI_THINKING_LEVEL: "MINIMAL" })).toThrow(/GEMINI_THINKING_LEVEL/);
  });

  it("AI_PROVIDER=anthropic selects Claude Haiku with its own key", () => {
    expect(() => getAIConfig({ AI_PROVIDER: "anthropic", GEMINI_API_KEY: "g" })).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(getAIConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a" })).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" });
    expect(() => getAIConfig({ AI_PROVIDER: "mistral" })).toThrow(/LLM_PRIMARY_PROVIDER must be one of/);
    expect(() => getAIConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", NEXT_PUBLIC_ANTHROPIC_API_KEY: "a" })).toThrow(/NEXT_PUBLIC/);
  });
});
