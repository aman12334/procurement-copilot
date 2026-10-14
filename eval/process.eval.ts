/**
 * LIVE: runs the Bid Processing Agent on Stage 1 vendor responses and saves canonical bids to eval/results/bids.
 *   npm run eval:process                 → all vendors (+ Vendor 4 image variants)
 *   EVAL_VENDORS=VND-1005 npm run eval:process
 * Uses the runtime code path only (no ground truth here).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
import { assertFrozen, loadEvalConfig, writeRunStatus } from "./config";
// Frozen config: abort (no model switching) if the runtime model/dataset differs from eval/eval.config.json.
try { assertFrozen(loadEvalConfig()); } catch (e) { writeRunStatus("process", "config_mismatch", { error: (e as Error).message }); throw e; }
const OUT = "eval/results/bids";
mkdirSync(OUT, { recursive: true });

describe("live bid processing", async () => {
  const { loadEventContext } = await import("@/lib/event/context");
  const { createLLMClient } = await import("@/lib/ai/client");
  const { processVendorResponse } = await import("@/lib/bids/agent");
  const ctx = await loadEventContext();
  const only = process.env.EVAL_VENDORS?.split(",").map((s) => s.trim());
  const variants = process.env.EVAL_VARIANTS !== "0";
  const jobs = ctx.vendors.filter((v) => !only || only.includes(v.vendor_id)).flatMap((v) => [
    { key: v.vendor_id, vendor: v, file: v.response_files[0] },
    ...(variants ? (v.alternate_files ?? []).map((f) => ({ key: `${v.vendor_id}__${f.split("/").pop()!.replace(/\.\w+$/, "")}`, vendor: v, file: f })) : []),
  ]);

  for (const job of jobs) {
    it(`processes ${job.key} (${job.file.split("/").pop()})`, async () => {
      const client = createLLMClient(undefined, { fallback: false }); // evals never switch provider/model
      const t0 = Date.now();
      const r = await processVendorResponse(client, ctx, job.vendor, [{ name: job.file.split("/").pop()!, data: readFileSync(job.file) }]);
      const ms = Date.now() - t0;
      if (!r.ok) {
        writeFileSync(`${OUT}/${job.key}.error.json`, JSON.stringify({ ...r, ms }, null, 2));
        console.error(job.key, r.error);
      }
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      writeFileSync(`${OUT}/${job.key}.json`, JSON.stringify({ ...r.bid, _eval: { ms, attempts: r.attempts } }, null, 2));
      rmSync(`${OUT}/${job.key}.error.json`, { force: true });
      const s = r.bid.processing_summary;
      console.log(`${job.key}: ${ms} ms, attempts ${r.attempts}, quoted ${s.quoted_lines}/${s.rfx_lines}, review items ${s.review_items}, tech ${s.technical_score} ${s.qualification_status}`);
    });
  }
});
