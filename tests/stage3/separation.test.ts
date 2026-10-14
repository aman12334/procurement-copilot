/** (22) Runtime code must never read offline evaluation data. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenPathError, readEventFile, resolveEventPath } from "@/lib/event/files";

const RUNTIME_DIRS = ["app", "lib", "components"];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
  });
}

describe("production / evaluation separation", () => {
  it("no runtime source file references the ground-truth or generator folders", () => {
    const offenders = RUNTIME_DIRS.flatMap(walk).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /ground_truth|stage1\/_build|canonical_vendor_bids|edge_case_manifest|vendor_qualification\.json|normalized_line_items/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("no runtime file imports from eval/ or tests/", () => {
    const offenders = RUNTIME_DIRS.flatMap(walk).filter((f) => /from ["'](\.\.\/)+(eval|tests)\/|from ["']@\/(eval|tests)\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the runtime file guard refuses evaluation folders even when asked directly", async () => {
    const gt = ["stage1", "ground" + "_truth", "canonical_vendor_bids.json"].join("/");
    expect(() => resolveEventPath(gt)).toThrow(ForbiddenPathError);
    expect(() => resolveEventPath("stage1/_build/model.py")).toThrow(ForbiddenPathError);
    expect(() => resolveEventPath("stage1/buyer/../" + "ground_truth/x.json")).toThrow(ForbiddenPathError);
    expect(() => resolveEventPath("../secrets.txt")).toThrow(ForbiddenPathError);
    await expect(readEventFile(gt)).rejects.toThrow(ForbiddenPathError);
    expect(resolveEventPath("stage1/buyer/rfx_master.csv")).toContain("rfx_master.csv");
  });

  it("Vercel bundling excludes evaluation data from the runtime functions", () => {
    const cfg = readFileSync("next.config.ts", "utf8");
    expect(cfg).toMatch(/outputFileTracingExcludes[\s\S]*stage1\/ground_truth[\s\S]*stage1\/_build/);
  });
});
