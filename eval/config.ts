/**
 * Frozen evaluation configuration. Live eval runs must use exactly this model / prompts / dataset;
 * a mismatch aborts the run, and an unavailable model marks the run "infrastructure_blocked" (no model switching).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface EvalConfig {
  frozen_at: string;
  provider: string;
  model: string;
  prompt_versions: Record<string, string>;
  dataset: { root: string; folders: string[]; sha256: string };
  fx: { usd_inr: number; source: string };
  normalization: { freight_loading_pct: number; outlier_high_ratio: number; outlier_low_ratio: number };
  rules: Record<string, string | number | boolean>;
}

export const CONFIG_PATH = "eval/eval.config.json";
export const DATASET_FOLDERS = ["stage1/buyer", "stage1/vendors", "stage1/images"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; }).sort();
}

export function datasetHash(folders = DATASET_FOLDERS): string {
  const h = createHash("sha256");
  for (const f of folders.flatMap(files)) { h.update(f); h.update(readFileSync(f)); }
  return h.digest("hex");
}

export function loadEvalConfig(): EvalConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export class EvalConfigError extends Error {}

/** Throws if the runtime would use a different model, provider or dataset than the frozen config. */
export function assertFrozen(cfg: EvalConfig, env: Record<string, string | undefined> = process.env, opts: { checkDataset?: boolean } = {}) {
  const provider = (env.LLM_PRIMARY_PROVIDER ?? env.AI_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== cfg.provider) throw new EvalConfigError(`Primary provider is ${provider} but eval is frozen to ${cfg.provider}. Re-freeze deliberately with npm run eval:freeze.`);
  const model = provider === "openai" ? env.OPENAI_MODEL : provider === "anthropic" ? env.ANTHROPIC_MODEL : env.GEMINI_MODEL;
  if (!model) throw new EvalConfigError(`${provider.toUpperCase()}_MODEL is not set.`);
  if (model !== cfg.model) throw new EvalConfigError(`Configured model ${model} differs from the frozen eval model ${cfg.model}. Update eval/eval.config.json deliberately (npm run eval:freeze); models are never switched automatically.`);
  if (opts.checkDataset !== false) {
    const h = datasetHash(cfg.dataset.folders);
    if (h !== cfg.dataset.sha256) throw new EvalConfigError(`Stage 1 dataset changed (sha256 ${h.slice(0, 12)}… vs frozen ${cfg.dataset.sha256.slice(0, 12)}…).`);
  }
}

export type RunStatus = "passed" | "failed" | "infrastructure_blocked" | "config_mismatch";

export function writeRunStatus(name: string, status: RunStatus, detail: Record<string, unknown>) {
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(`eval/results/${name}.status.json`, JSON.stringify({ name, status, at: new Date().toISOString(), ...detail }, null, 2));
}
