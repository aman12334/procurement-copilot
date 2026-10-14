/**
 * Central AI configuration. The only place that reads provider env vars.
 * Server-side only: never import this from a client component.
 *
 *   LLM_PRIMARY_PROVIDER (alias AI_PROVIDER) = openai | gemini | anthropic
 *     openai    -> OPENAI_API_KEY, OPENAI_MODEL (pinned, required), OPENAI_TIMEOUT_MS, OPENAI_MAX_OUTPUT_TOKENS
 *     gemini    -> GEMINI_API_KEY, GEMINI_MODEL (pinned, required), GEMINI_THINKING_LEVEL, GEMINI_TIMEOUT_MS
 *     anthropic -> ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_EFFORT, ANTHROPIC_TIMEOUT_MS
 *   Fallback: LLM_FALLBACK_ENABLED, LLM_FALLBACK_PROVIDER=free, FREE_PROVIDER, FREE_MODEL, LLM_FALLBACK_ON_*
 */
import "server-only";

export const AI_PROVIDERS = ["openai", "gemini", "anthropic"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

export const THINKING_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const; // MINIMAL is rejected by gemini-3.8-flash
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
export const CLAUDE_EFFORTS = ["low", "medium", "high"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export interface GeminiConfig {
  provider: "gemini";
  apiKey: string;
  model: string;
  temperature: number;
  /** Gemini reasoning effort. LOW keeps RFx generation well inside serverless time limits. */
  thinkingLevel: ThinkingLevelName;
  /** Per-request timeout; a hung call becomes a controlled MODEL_UNAVAILABLE error. */
  timeoutMs: number;
}

export interface AnthropicConfig {
  provider: "anthropic";
  apiKey: string;
  model: string;
  /** Claude effort level (controls thinking depth and token spend). */
  effort: ClaudeEffort;
  timeoutMs: number;
}

export interface OpenAIConfig {
  provider: "openai";
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Only sent when set (reasoning models): none | minimal | low | medium | high. */
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
}

export type AIConfig = OpenAIConfig | GeminiConfig | AnthropicConfig;

export class AIConfigError extends Error {
  readonly code = "AI_CONFIG_MISSING";
}

// 90 s per attempt keeps 3 attempts + backoff inside the 300 s serverless limit.
const timeout = (v: string | undefined) => (Number(v) > 0 ? Number(v) : 90_000);

function missingKey(name: string): AIConfigError {
  return new AIConfigError(
    `${name} is not set. Add it to .env.local in the project root (local dev) or to the ` +
      "Vercel project's Environment Variables (deployed), then restart the server. " +
      "Do not use a NEXT_PUBLIC_ prefix – the key is only read server-side.",
  );
}

const PUBLIC_SECRET_VARS = ["NEXT_PUBLIC_OPENAI_API_KEY", "NEXT_PUBLIC_GEMINI_API_KEY", "NEXT_PUBLIC_ANTHROPIC_API_KEY"];

/** The primary provider's configuration (what every feature uses first). */
export function getAIConfig(env: Record<string, string | undefined> = process.env): AIConfig {
  for (const k of PUBLIC_SECRET_VARS) {
    if (env[k]) throw new AIConfigError(`${k} is set – this would expose the key to browsers. Remove it and use the non-public name.`);
  }
  const raw = env.LLM_PRIMARY_PROVIDER ?? env.AI_PROVIDER;
  const provider = (raw?.trim().toLowerCase() || "gemini") as AIProvider;
  if (!AI_PROVIDERS.includes(provider)) {
    throw new AIConfigError(`LLM_PRIMARY_PROVIDER must be one of ${AI_PROVIDERS.join(", ")} (got "${raw}").`);
  }
  return providerConfig(provider, env);
}

export function providerConfig(provider: AIProvider, env: Record<string, string | undefined>, modelOverride?: string): AIConfig {
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw missingKey("OPENAI_API_KEY");
    const model = (modelOverride ?? env.OPENAI_MODEL)?.trim();
    if (!model) throw new AIConfigError("OPENAI_MODEL is not set. Set it to a model id available to your OpenAI account (run `npm run llm:models`); it is never chosen automatically.");
    const maxOut = Number(env.OPENAI_MAX_OUTPUT_TOKENS);
    const effort = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || null;
    if (effort && !["none", "minimal", "low", "medium", "high"].includes(effort))
      throw new AIConfigError(`OPENAI_REASONING_EFFORT must be none, minimal, low, medium or high (got "${effort}").`);
    return { provider, apiKey, model, timeoutMs: timeout(env.OPENAI_TIMEOUT_MS), maxOutputTokens: maxOut > 0 ? maxOut : 16_000,
      reasoningEffort: effort as OpenAIConfig["reasoningEffort"] };
  }

  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw missingKey("ANTHROPIC_API_KEY");
    const effort = (env.ANTHROPIC_EFFORT?.trim().toLowerCase() || "low") as ClaudeEffort;
    if (!CLAUDE_EFFORTS.includes(effort)) {
      throw new AIConfigError(`ANTHROPIC_EFFORT must be one of ${CLAUDE_EFFORTS.join(", ")} (got "${env.ANTHROPIC_EFFORT}").`);
    }
    return { provider, apiKey, model: (modelOverride ?? env.ANTHROPIC_MODEL)?.trim() || DEFAULT_ANTHROPIC_MODEL, effort, timeoutMs: timeout(env.ANTHROPIC_TIMEOUT_MS) };
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw missingKey("GEMINI_API_KEY");
  // The model is pinned by configuration: no default and no automatic switching.
  const model = (modelOverride ?? env.GEMINI_MODEL)?.trim();
  if (!model) throw new AIConfigError("GEMINI_MODEL is not set. Add the exact Gemini model id to .env.local (e.g. GEMINI_MODEL=gemini-3.7-flash) or the Vercel environment; it is never chosen automatically.");
  const level = (env.GEMINI_THINKING_LEVEL?.trim().toUpperCase() || "LOW") as ThinkingLevelName;
  if (!THINKING_LEVELS.includes(level)) {
    throw new AIConfigError(`GEMINI_THINKING_LEVEL must be one of ${THINKING_LEVELS.join(", ")} (got "${env.GEMINI_THINKING_LEVEL}").`);
  }
  return { provider: "gemini", apiKey, model, temperature: 0.2, thinkingLevel: level, timeoutMs: timeout(env.GEMINI_TIMEOUT_MS) };
}

/**
 * Providers whose API has a genuinely free tier that we have verified for this account.
 * Gemini: Google AI Studio free tier (the account's quota errors report "generate_content_free_tier_requests").
 * OpenAI and Anthropic have no free API tier and are never accepted as the "free" fallback.
 */
export const VERIFIED_FREE_PROVIDERS: AIProvider[] = ["gemini"];

export type FallbackKind = "quota_exhausted" | "rate_limited" | "overloaded" | "timeout";

export interface LLMSettings {
  primary: AIConfig;
  fallback: AIConfig | null;
  fallback_status: string;
  max_attempts: number;
  fallback_on: Record<FallbackKind, boolean>;
}

const flag = (v: string | undefined, d: boolean) => (v === undefined || v.trim() === "" ? d : /^(1|true|yes|on)$/i.test(v.trim()));

/** Primary + optional free fallback. Invalid fallback config disables fallback (with a reason) rather than guessing. */
export function getLLMSettings(env: Record<string, string | undefined> = process.env): LLMSettings {
  const primary = getAIConfig(env);
  const maxAttempts = Math.min(5, Math.max(1, Number(env.LLM_MAX_RETRIES) || 3));
  const fallback_on: Record<FallbackKind, boolean> = {
    quota_exhausted: flag(env.LLM_FALLBACK_ON_QUOTA, true),
    rate_limited: flag(env.LLM_FALLBACK_ON_RATE_LIMIT, true),
    overloaded: flag(env.LLM_FALLBACK_ON_PROVIDER_UNAVAILABLE, true),
    timeout: flag(env.LLM_FALLBACK_ON_PROVIDER_UNAVAILABLE, true),
  };
  const base = { primary, max_attempts: maxAttempts, fallback_on };
  if (!flag(env.LLM_FALLBACK_ENABLED, false)) return { ...base, fallback: null, fallback_status: "disabled (LLM_FALLBACK_ENABLED is not true)" };
  if ((env.LLM_FALLBACK_PROVIDER ?? "free").trim().toLowerCase() !== "free")
    return { ...base, fallback: null, fallback_status: "disabled: only LLM_FALLBACK_PROVIDER=free is supported (no paid-to-paid fallback)" };
  const fp = env.FREE_PROVIDER?.trim().toLowerCase() as AIProvider | undefined;
  if (!fp) return { ...base, fallback: null, fallback_status: "disabled: FREE_PROVIDER is not set" };
  if (!VERIFIED_FREE_PROVIDERS.includes(fp)) return { ...base, fallback: null, fallback_status: `disabled: "${fp}" is not a verified free API provider` };
  if (fp === primary.provider) return { ...base, fallback: null, fallback_status: "disabled: FREE_PROVIDER is the same as the primary provider" };
  if (!env.FREE_MODEL?.trim()) return { ...base, fallback: null, fallback_status: "disabled: FREE_MODEL is not set" };
  try {
    const fallback = providerConfig(fp, env, env.FREE_MODEL.trim());
    return { ...base, fallback, fallback_status: `enabled: ${fp} ${fallback.model} (free tier)` };
  } catch (e) {
    return { ...base, fallback: null, fallback_status: `disabled: ${(e as Error).message}` };
  }
}

/** Safe-to-log view of the config. */
export function describeAIConfig(cfg: AIConfig) {
  const { apiKey: _omit, ...rest } = cfg;
  return { ...rest, apiKey: "[redacted]" };
}
