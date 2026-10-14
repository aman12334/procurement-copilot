/**
 * Minimal LLM abstraction. The RFx agent depends only on `LLMClient`, so tests can
 * inject a fake and never call the live API.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { log } from "@/lib/log";
import { getLLMSettings, type AIConfig, type AnthropicConfig, type FallbackKind, type GeminiConfig, type LLMSettings, type OpenAIConfig } from "./model";

/** A file passed to the model natively (PDF document understanding or image vision). */
export interface Attachment {
  name: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}

export interface StructuredRequest {
  system: string;
  prompt: string;
  /** JSON Schema (already sanitized for Gemini) describing the required output. */
  jsonSchema: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface LLMClient {
  readonly model: string;
  generateJson(req: StructuredRequest): Promise<string>;
}

export type UnavailableKind = "quota_exhausted" | "rate_limited" | "overloaded" | "timeout";

/** Model overloaded, rate-limited, out of quota or timed out. `kind` lets callers record a precise failure state. */
export class ModelUnavailableError extends Error {
  readonly code = "MODEL_UNAVAILABLE";
  constructor(message: string, readonly kind: UnavailableKind = "overloaded") { super(message); }
}

/** Bounded exponential backoff for 500/503 and short 429s: at most 3 attempts in total (2 waits). */
export const BACKOFF_MS = [2000, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeminiFailure { kind: UnavailableKind | "other"; retryable: boolean; message: string }

/** Pure classification of a Gemini SDK error (unit-tested). */
export function classifyGeminiError(e: unknown, model: string, timeoutMs: number): GeminiFailure {
  const status = e instanceof ApiError ? e.status : (e as { status?: number })?.status;
  const msg = (e as Error)?.message ?? String(e);
  const text = `${(e as Error)?.name ?? ""} ${msg}`;
  if (status === 429) {
    const q = describeQuotaError(msg);
    if (q && (q.daily || (q.retryAfterS ?? 0) > 20)) return { kind: "quota_exhausted", retryable: false, message: q.summary };
    return { kind: "rate_limited", retryable: true, message: `Gemini rate limit reached for ${model} (HTTP 429). Please try again in a minute.` };
  }
  if (status === 504 || /abort|timed? ?out|timeout|deadline/i.test(text))
    return { kind: "timeout", retryable: false, message: `Gemini (${model}) did not respond within ${Math.round(timeoutMs / 1000)} s. Please try again.` };
  if (status === 500 || status === 503)
    return { kind: "overloaded", retryable: true, message: `Gemini (${model}) is temporarily unavailable (HTTP ${status}, high demand). Please try again shortly.` };
  return { kind: "other", retryable: false, message: msg };
}

/** Reads Google's quota details from a 429 so we don't retry an exhausted daily quota. */
export function describeQuotaError(message: string): { retryAfterS: number | null; daily: boolean; summary: string } | null {
  let body: { error?: { details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string }[] }[] } };
  try {
    body = JSON.parse(message);
  } catch {
    return null;
  }
  const details = body.error?.details ?? [];
  const retry = details.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay;
  const retryAfterS = retry ? Number.parseFloat(retry) : null;
  const v = details.find((d) => d["@type"]?.endsWith("QuotaFailure"))?.violations?.[0];
  const daily = /PerDay/i.test(v?.quotaId ?? "");
  const wait = retryAfterS === null ? "later" : retryAfterS >= 3600
    ? `in about ${Math.floor(retryAfterS / 3600)} h ${Math.round((retryAfterS % 3600) / 60)} min`
    : retryAfterS >= 60 ? `in about ${Math.round(retryAfterS / 60)} min` : `in ${Math.ceil(retryAfterS)} s`;
  const summary = daily
    ? `Gemini free-tier daily quota exhausted (${v?.quotaValue ?? "?"} requests/day for this model). It resets ${wait}. ` +
      "Enable billing on the Google AI project or wait for the reset (the configured model is never switched automatically)."
    : `Gemini rate limit reached. Try again ${wait}.`;
  return { retryAfterS, daily, summary };
}

export class GeminiClient implements LLMClient {
  private ai: GoogleGenAI;
  readonly model: string;

  constructor(private cfg: GeminiConfig, private opts: { backoffMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}) {
    this.ai = new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: { timeout: cfg.timeoutMs } });
    this.model = cfg.model;
  }

  /** Calls made to the API so far (including retries) – used by run reports. */
  calls = 0;
  retries = 0;

  /**
   * One call plus bounded exponential backoff for overloaded / short rate-limit responses (max 3 attempts).
   * Quota exhaustion and timeouts fail immediately. The configured model is never changed.
   */
  async generateJson(req: StructuredRequest): Promise<string> {
    const backoff = this.opts.backoffMs ?? BACKOFF_MS;
    const wait = this.opts.sleep ?? sleep;
    for (let attempt = 1; ; attempt++) {
      try {
        this.calls++;
        return await this.callOnce(req);
      } catch (e) {
        const f = classifyGeminiError(e, this.model, this.cfg.timeoutMs);
        if (f.retryable && attempt <= backoff.length) {
          this.retries++;
          log("warn", "gemini.transient_retry", { model: this.model, kind: f.kind, attempt, backoffMs: backoff[attempt - 1] });
          await wait(backoff[attempt - 1]);
          continue;
        }
        if (f.kind !== "other") {
          log("warn", "gemini.unavailable", { model: this.model, kind: f.kind, attempts: attempt });
          throw new ModelUnavailableError(f.message, f.kind);
        }
        throw e;
      }
    }
  }

  protected async callOnce(req: StructuredRequest): Promise<string> {
    const started = Date.now();
    const res = await this.ai.models.generateContent({
      model: this.cfg.model,
      contents: [{
        role: "user",
        parts: [
          ...(req.attachments ?? []).flatMap((a) => [
            { text: `Attached file: ${a.name}` },
            { inlineData: { mimeType: a.mimeType, data: a.dataBase64 } },
          ]),
          { text: req.prompt },
        ],
      }],
      config: {
        systemInstruction: req.system,
        temperature: this.cfg.temperature,
        responseMimeType: "application/json",
        responseJsonSchema: req.jsonSchema,
        thinkingConfig: { thinkingLevel: ThinkingLevel[this.cfg.thinkingLevel] },
      },
    });
    const u = res.usageMetadata;
    log("info", "gemini.call", {
      model: this.cfg.model, thinkingLevel: this.cfg.thinkingLevel, durationMs: Date.now() - started,
      promptTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtTokens: u?.thoughtsTokenCount,
      finishReason: res.candidates?.[0]?.finishReason,
    });
    const text = res.text;
    if (!text) {
      const reason = res.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(`Gemini returned an empty response (finishReason: ${reason}).`);
    }
    return text;
  }
}

// ------------------------------------------------------------------ Claude

/** Claude structured outputs reject numeric bounds and unknown keywords: strip them (the agent re-validates with Zod). */
function toClaudeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toClaudeSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "propertyOrdering" || k === "minimum" || k === "maximum") continue;
    out[k] = k === "properties"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toClaudeSchema(pv)]))
      : toClaudeSchema(v);
  }
  return out;
}

const CLAUDE_MAX_TOKENS = 32_000;

function claudeAttachments(atts: Attachment[] = []): Anthropic.ContentBlockParam[] {
  return atts.flatMap((a): Anthropic.ContentBlockParam[] => [
    { type: "text", text: `Attached file: ${a.name}` },
    a.mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.dataBase64 } }
      : { type: "image", source: { type: "base64", media_type: a.mimeType, data: a.dataBase64 } },
  ]);
}

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  readonly model: string;

  constructor(private cfg: AnthropicConfig) {
    // The SDK itself retries 408/409/429/5xx (incl. 529 overloaded) twice with backoff.
    this.client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 2 });
    this.model = cfg.model;
  }

  async generateJson(req: StructuredRequest): Promise<string> {
    const started = Date.now();
    let msg: Anthropic.Message;
    try {
      // Streaming keeps long structured outputs clear of HTTP timeouts; we only need the final message.
      msg = await this.client.messages
        .stream({
          model: this.cfg.model,
          max_tokens: CLAUDE_MAX_TOKENS,
          system: req.system,
          messages: [{ role: "user", content: [...claudeAttachments(req.attachments), { type: "text", text: req.prompt }] }],
          output_config: {
            effort: this.cfg.effort,
            format: { type: "json_schema", schema: toClaudeSchema(req.jsonSchema) as Record<string, unknown> },
          },
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        throw new Error("Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in .env.local.");
      if (e instanceof Anthropic.RateLimitError)
        throw new ModelUnavailableError("Claude rate limit reached (429). Please try again in a minute, or check your Anthropic credit balance.", "rate_limited");
      if (e instanceof Anthropic.APIConnectionTimeoutError)
        throw new ModelUnavailableError(`Claude did not respond within ${Math.round(this.cfg.timeoutMs / 1000)} s. Please try again.`, "timeout");
      if (e instanceof Anthropic.APIError && (e.status === undefined || e.status >= 500))
        throw new ModelUnavailableError(`Claude is temporarily unavailable (HTTP ${e.status ?? "connection error"}). Please try again shortly.`);
      if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message))
        throw new Error("Anthropic account has no credit. Add credits in the Anthropic Console (Plans & Billing).");
      throw e;
    }
    log("info", "claude.call", {
      model: this.cfg.model, effort: this.cfg.effort, durationMs: Date.now() - started,
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, stopReason: msg.stop_reason,
    });
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to answer this request (refusal).");
    if (msg.stop_reason === "max_tokens") throw new Error(`Claude's output hit the ${CLAUDE_MAX_TOKENS}-token limit before the RFx was complete.`);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new Error(`Claude returned no text (stop_reason: ${msg.stop_reason}).`);
    return text;
  }
}

// ------------------------------------------------------------------ OpenAI

/** Pure classification of an OpenAI SDK error (unit-tested). */
export function classifyOpenAIError(e: unknown, model: string, timeoutMs: number): GeminiFailure {
  const status = (e as { status?: number })?.status;
  const code = String((e as { code?: string })?.code ?? (e as { error?: { code?: string } })?.error?.code ?? "");
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof OpenAI.APIConnectionTimeoutError || /timed? ?out|timeout/i.test(`${(e as Error)?.name} ${msg}`) && !status)
    return { kind: "timeout", retryable: false, message: `OpenAI (${model}) did not respond within ${Math.round(timeoutMs / 1000)} s.` };
  if (status === 429 && /insufficient_quota|billing|quota/i.test(`${code} ${msg}`))
    return { kind: "quota_exhausted", retryable: false, message: `OpenAI credit/quota exhausted for this account (${code || "insufficient_quota"}). Add credit or raise the project budget at platform.openai.com.` };
  if (status === 429) return { kind: "rate_limited", retryable: true, message: `OpenAI rate limit reached for ${model} (HTTP 429).` };
  if (status !== undefined && status >= 500) return { kind: "overloaded", retryable: true, message: `OpenAI (${model}) is temporarily unavailable (HTTP ${status}).` };
  if (e instanceof OpenAI.APIConnectionError) return { kind: "overloaded", retryable: true, message: `Could not reach OpenAI (${msg}).` };
  if (status === 401) return { kind: "other", retryable: false, message: "OpenAI rejected the API key (401). Check OPENAI_API_KEY." };
  if (status === 404) return { kind: "other", retryable: false, message: `OpenAI model "${model}" is not available to this account (404). Check OPENAI_MODEL with \`npm run llm:models\`.` };
  return { kind: "other", retryable: false, message: msg };
}

/** OpenAI rejects some JSON Schema keywords in response formats; strip ours (Zod re-validates the output). */
function toOpenAISchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenAISchema);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => k !== "propertyOrdering")
    .map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toOpenAISchema(pv)])) : toOpenAISchema(v)]));
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  readonly model: string;
  calls = 0;
  retries = 0;

  constructor(private cfg: OpenAIConfig, private opts: { backoffMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}) {
    // SDK retries disabled: one consistent, bounded retry policy (BACKOFF_MS) across providers.
    this.client = new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0 });
    this.model = cfg.model;
  }

  async generateJson(req: StructuredRequest): Promise<string> {
    const backoff = this.opts.backoffMs ?? BACKOFF_MS;
    const wait = this.opts.sleep ?? sleep;
    for (let attempt = 1; ; attempt++) {
      try {
        this.calls++;
        return await this.callOnce(req);
      } catch (e) {
        const f = classifyOpenAIError(e, this.model, this.cfg.timeoutMs);
        if (f.retryable && attempt <= backoff.length) {
          this.retries++;
          log("warn", "openai.transient_retry", { model: this.model, kind: f.kind, attempt, backoffMs: backoff[attempt - 1] });
          await wait(backoff[attempt - 1]);
          continue;
        }
        if (f.kind !== "other") { log("warn", "openai.unavailable", { model: this.model, kind: f.kind, attempts: attempt }); throw new ModelUnavailableError(f.message, f.kind); }
        throw new Error(f.message);
      }
    }
  }

  protected async callOnce(req: StructuredRequest): Promise<string> {
    const started = Date.now();
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = (req.attachments ?? []).flatMap((a): OpenAI.Chat.ChatCompletionContentPart[] => [
      { type: "text", text: `Attached file: ${a.name}` },
      a.mimeType === "application/pdf"
        ? { type: "file", file: { filename: a.name, file_data: `data:application/pdf;base64,${a.dataBase64}` } }
        : { type: "image_url", image_url: { url: `data:${a.mimeType};base64,${a.dataBase64}`, detail: "high" } },
    ]);
    const res = await this.client.chat.completions.create({
      model: this.cfg.model,
      messages: [{ role: "system", content: req.system }, { role: "user", content: [...parts, { type: "text", text: req.prompt }] }],
      response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: toOpenAISchema(req.jsonSchema) as Record<string, unknown>, strict: false } },
      max_completion_tokens: this.cfg.maxOutputTokens,
      ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
    });
    const choice = res.choices[0];
    log("info", "openai.call", { model: this.cfg.model, durationMs: Date.now() - started, promptTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens, finishReason: choice?.finish_reason });
    if (choice?.message?.refusal) throw new Error(`OpenAI declined the request: ${choice.message.refusal}`);
    if (choice?.finish_reason === "length") throw new Error(`OpenAI output hit the ${this.cfg.maxOutputTokens}-token limit (OPENAI_MAX_OUTPUT_TOKENS).`);
    const text = choice?.message?.content;
    if (!text) throw new Error(`OpenAI returned no content (finish_reason: ${choice?.finish_reason}).`);
    return text;
  }
}

// ------------------------------------------------------------------ provider factory + recorded fallback

export interface ProviderSwitch { at: string; from: string; to: string; kind: string; reason: string }

/**
 * Shared fallback used by every feature (RFx, extraction, analyst). Switches to the configured FREE provider only for
 * the failure kinds enabled in settings, and records every switch. Non-availability errors are never masked.
 */
export class FallbackClient implements LLMClient {
  readonly switches: ProviderSwitch[] = [];
  private active: LLMClient;

  constructor(readonly primary: LLMClient, readonly fallback: LLMClient | null, private on: Record<FallbackKind, boolean>, readonly primaryLabel: string, readonly fallbackLabel: string | null,
    private noFallbackReason = "No free fallback provider is configured (set LLM_FALLBACK_ENABLED=true, FREE_PROVIDER, FREE_MODEL).") {
    this.active = primary;
  }

  /** The model that produced the most recent result (primary unless a recorded switch happened). */
  get model() { return this.active.model; }
  get usedFallback() { return this.switches.length > 0; }

  async generateJson(req: StructuredRequest): Promise<string> {
    this.active = this.primary;
    try {
      return await this.primary.generateJson(req);
    } catch (e) {
      const kind = (e as { kind?: FallbackKind }).kind;
      const eligible = (e as { code?: string }).code === "MODEL_UNAVAILABLE" && kind && this.on[kind];
      if (!eligible) throw e;
      if (!this.fallback) {
        throw new ModelUnavailableError(`${(e as Error).message} ${this.noFallbackReason} The last successful result is kept – retry later.`, kind);
      }
      const sw = { at: new Date().toISOString(), from: this.primaryLabel, to: this.fallbackLabel!, kind, reason: (e as Error).message };
      this.switches.push(sw);
      log("warn", "llm.provider_switch", sw);
      this.active = this.fallback;
      try {
        return await this.fallback.generateJson(req);
      } catch (e2) {
        const k2 = (e2 as { kind?: FallbackKind }).kind;
        throw new ModelUnavailableError(`Primary ${this.primaryLabel} failed (${kind}) and fallback ${this.fallbackLabel} also failed: ${(e2 as Error).message}. Please retry later.`, k2 ?? kind);
      }
    }
  }
}

export function clientFor(cfg: AIConfig, maxAttempts = 3): LLMClient {
  const backoffMs = BACKOFF_MS.slice(0, Math.max(0, maxAttempts - 1));
  return cfg.provider === "openai" ? new OpenAIClient(cfg, { backoffMs })
    : cfg.provider === "anthropic" ? new ClaudeClient(cfg)
    : new GeminiClient(cfg, { backoffMs });
}

/**
 * Builds the client every feature uses.
 *  - createLLMClient()                        → primary + recorded free fallback (per LLM_* settings)
 *  - createLLMClient(undefined, {fallback:false}) → primary only (evaluations: no provider/model switching)
 *  - createLLMClient(cfg)                      → exactly that provider
 */
export function createLLMClient(cfg?: AIConfig, opts: { fallback?: boolean; settings?: LLMSettings } = {}): LLMClient {
  if (cfg) return clientFor(cfg);
  const st = opts.settings ?? getLLMSettings();
  const primary = clientFor(st.primary, st.max_attempts);
  const fb = opts.fallback === false || !st.fallback ? null : clientFor(st.fallback, st.max_attempts);
  return new FallbackClient(primary, fb, st.fallback_on, `${st.primary.provider}:${st.primary.model}`, st.fallback ? `${st.fallback.provider}:${st.fallback.model}` : null,
    opts.fallback === false ? "Fallback is disabled for this run (evaluations never switch provider)." : `Fallback ${st.fallback_status}.`);
}

/** Provider switches recorded during a request (empty for direct clients). */
export function providerSwitches(c: LLMClient): ProviderSwitch[] {
  return c instanceof FallbackClient ? [...c.switches] : [];
}
