import { describe, expect, it } from "vitest";
import { classifyOpenAIError, createLLMClient, FallbackClient, ModelUnavailableError, OpenAIClient, providerSwitches, type LLMClient, type StructuredRequest } from "@/lib/ai/client";
import { getLLMSettings, type OpenAIConfig } from "@/lib/ai/model";

const base = { LLM_PRIMARY_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "pinned-openai", GEMINI_API_KEY: "g-test", GEMINI_MODEL: "pinned-gemini" };
const req: StructuredRequest = { system: "", prompt: "", jsonSchema: {} };
const unavailable = (kind: string) => Object.assign(new ModelUnavailableError(`primary ${kind}`, kind as never));
class Scripted implements LLMClient {
  calls = 0;
  constructor(readonly model: string, private outcomes: (string | Error)[]) {}
  async generateJson() { this.calls++; const o = this.outcomes.shift(); if (o instanceof Error) throw o; return o ?? "{}"; }
}
const on = { quota_exhausted: true, rate_limited: true, overloaded: true, timeout: true };

describe("provider settings", () => {
  it("OpenAI primary with a verified free Gemini fallback", () => {
    const st = getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", LLM_FALLBACK_PROVIDER: "free", FREE_PROVIDER: "gemini", FREE_MODEL: "free-gemini" });
    expect(st.primary).toMatchObject({ provider: "openai", model: "pinned-openai", timeoutMs: 90000 });
    expect(st.fallback).toMatchObject({ provider: "gemini", model: "free-gemini" });
    expect(st.max_attempts).toBe(3);
  });

  it("never accepts a paid provider as the 'free' fallback, or one without credentials/model", () => {
    expect(getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", FREE_PROVIDER: "openai", FREE_MODEL: "x" }).fallback_status).toMatch(/not a verified free API provider/);
    expect(getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", FREE_PROVIDER: "anthropic", FREE_MODEL: "x" }).fallback).toBeNull();
    expect(getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", FREE_PROVIDER: "gemini" }).fallback_status).toMatch(/FREE_MODEL is not set/);
    expect(getLLMSettings({ ...base, GEMINI_API_KEY: "", LLM_FALLBACK_ENABLED: "true", FREE_PROVIDER: "gemini", FREE_MODEL: "m" }).fallback_status).toMatch(/GEMINI_API_KEY is not set/);
    expect(getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", LLM_FALLBACK_PROVIDER: "openai", FREE_PROVIDER: "gemini", FREE_MODEL: "m" }).fallback).toBeNull();
    expect(getLLMSettings({ ...base, FREE_PROVIDER: "gemini", FREE_MODEL: "m" }).fallback_status).toMatch(/disabled/); // not enabled
  });

  it("OPENAI_MODEL is required (pinned), and legacy AI_PROVIDER still works", () => {
    expect(() => getLLMSettings({ ...base, OPENAI_MODEL: "" })).toThrow(/OPENAI_MODEL is not set/);
    expect(getLLMSettings({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "g", GEMINI_MODEL: "m" }).primary.provider).toBe("gemini");
  });
});

describe("OpenAI client", () => {
  it("classifies quota vs rate-limit vs outage vs auth", () => {
    expect(classifyOpenAIError({ status: 429, code: "insufficient_quota", message: "You exceeded your current quota" }, "m", 1000)).toMatchObject({ kind: "quota_exhausted", retryable: false });
    expect(classifyOpenAIError({ status: 429, message: "Rate limit reached" }, "m", 1000)).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(classifyOpenAIError({ status: 503, message: "x" }, "m", 1000)).toMatchObject({ kind: "overloaded", retryable: true });
    expect(classifyOpenAIError({ status: 401, message: "bad key" }, "m", 1000)).toMatchObject({ kind: "other" });
  });

  it("bounded retries (max 3 attempts) and no retry on quota exhaustion", async () => {
    const cfg: OpenAIConfig = { provider: "openai", apiKey: "sk-test", model: "pinned", timeoutMs: 1000, maxOutputTokens: 100, reasoningEffort: null };
    class S extends OpenAIClient { constructor(private e: unknown[]) { super(cfg, { sleep: async () => {} }); } protected async callOnce() { const x = this.e.shift(); if (x) throw x; return "{}"; } }
    const busy = new S([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(busy.generateJson(req)).rejects.toMatchObject({ kind: "overloaded" });
    expect(busy.calls).toBe(3);
    const broke = new S([{ status: 429, code: "insufficient_quota", message: "quota" }]);
    await expect(broke.generateJson(req)).rejects.toMatchObject({ kind: "quota_exhausted" });
    expect(broke.calls).toBe(1);
  });
});

describe("shared fallback (recorded, never fake)", () => {
  it("switches to the free provider on quota exhaustion and records the switch", async () => {
    const p = new Scripted("openai-m", [unavailable("quota_exhausted")]), f = new Scripted("gemini-free", ["{\"ok\":1}"]);
    const c = new FallbackClient(p, f, on, "openai:openai-m", "gemini:gemini-free");
    expect(await c.generateJson(req)).toBe("{\"ok\":1}");
    expect(c.model).toBe("gemini-free"); // artifacts record the model that actually produced them
    expect(providerSwitches(c)).toMatchObject([{ from: "openai:openai-m", to: "gemini:gemini-free", kind: "quota_exhausted" }]);
    expect(await c.generateJson(req)).toBe("{}"); // next call tries the primary again
    expect(c.model).toBe("openai-m");
  });

  it("does not mask non-availability errors and respects per-kind switches", async () => {
    const schemaish = new Error("400 invalid request");
    const c = new FallbackClient(new Scripted("p", [schemaish]), new Scripted("f", ["{}"]), on, "p", "f");
    await expect(c.generateJson(req)).rejects.toBe(schemaish);
    const noRate = new FallbackClient(new Scripted("p", [unavailable("rate_limited")]), new Scripted("f", ["{}"]), { ...on, rate_limited: false }, "p", "f");
    await expect(noRate.generateJson(req)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("without a configured free provider: clear, actionable failure (caller keeps last good artifact)", async () => {
    const c = new FallbackClient(new Scripted("p", [unavailable("quota_exhausted")]), null, on, "openai:p", null);
    await expect(c.generateJson(req)).rejects.toThrow(/No free fallback provider is configured/);
    const both = new FallbackClient(new Scripted("p", [unavailable("overloaded")]), new Scripted("f", [unavailable("quota_exhausted")]), on, "openai:p", "gemini:f");
    await expect(both.generateJson(req)).rejects.toThrow(/fallback gemini:f also failed.*retry later/i);
  });

  it("evaluations get the primary only (no provider switching)", () => {
    const st = getLLMSettings({ ...base, LLM_FALLBACK_ENABLED: "true", FREE_PROVIDER: "gemini", FREE_MODEL: "free-gemini" });
    const c = createLLMClient(undefined, { settings: st, fallback: false }) as FallbackClient;
    expect(c.fallback).toBeNull();
    expect((createLLMClient(undefined, { settings: st }) as FallbackClient).fallback?.model).toBe("free-gemini");
  });
});
