/** `npm run eval:freeze` – (re)writes eval/eval.config.json from the current configuration. Run deliberately. */
import { existsSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { ANALYST_PROMPT_VERSION } from "@/lib/ai/prompts/analyst";
import { BID_PROMPT_VERSION } from "@/lib/ai/prompts/bid-extraction";
import { RFX_PROMPT_VERSION } from "@/lib/ai/prompts/rfx-system";
import { loadEventContext } from "@/lib/event/context";
import { RECOMMENDATION_POLICY } from "@/lib/scenarios/recommend";
import { CONFIG_PATH, DATASET_FOLDERS, datasetHash, type EvalConfig } from "./config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

it("freezes the evaluation config", async () => {
  const { getAIConfig } = await import("@/lib/ai/model");
  const primary = getAIConfig(); // throws if the primary provider's key/model is missing
  const ctx = await loadEventContext();
  const cfg: EvalConfig = {
    frozen_at: new Date().toISOString(), provider: primary.provider, model: primary.model,
    prompt_versions: { rfx: RFX_PROMPT_VERSION, bid_extraction: BID_PROMPT_VERSION, analyst: ANALYST_PROMPT_VERSION },
    dataset: { root: "stage1", folders: DATASET_FOLDERS, sha256: datasetHash() },
    fx: { usd_inr: ctx.evaluation.usd_inr, source: ctx.evaluation.fx_source },
    normalization: { freight_loading_pct: ctx.evaluation.freight_loading_pct, outlier_high_ratio: ctx.evaluation.outlier_high_ratio, outlier_low_ratio: ctx.evaluation.outlier_low_ratio },
    rules: { qualification_min_score: ctx.qualification.min_total_score, schema_retries: 1, max_api_attempts_503: 3, quota_exhaustion_retries: 0, model_switching: false, provider_fallback_in_evals: false,
      ...Object.fromEntries(Object.entries(RECOMMENDATION_POLICY).map(([k, v]) => [`recommendation_${k}`, v])) },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`frozen ${CONFIG_PATH}: model ${cfg.model}, dataset ${cfg.dataset.sha256.slice(0, 12)}…`);
});
