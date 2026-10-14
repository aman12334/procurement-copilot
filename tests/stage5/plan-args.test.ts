import { describe, expect, it } from "vitest";
import { PlanSchema } from "@/lib/analyst/agent";
import { toModelJsonSchema } from "@/lib/rfx/schema";

describe("analyst plan tolerance (regression from live run)", () => {
  it("accepts tool args with omitted optional keys and fills them with null; the model still sees the full arg schema", () => {
    const r = PlanSchema.safeParse({ resolved_question: "q", intent: "qualification", retrieval_queries: [],
      tool_calls: [{ tool: "explain_vendor_exclusion", args: { vendor_id: "VND-1003", scenario_id: "SCN-003" }, purpose: "why" }] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.tool_calls[0].args).toMatchObject({ vendor_id: "VND-1003", scenario_id: "SCN-003", vendor_ids: null, rfx_line_id: null, constraints: null });
    const js = JSON.stringify(toModelJsonSchema(PlanSchema));
    expect(js).toContain("explain_vendor_exclusion");
    expect(js).toContain("exclude_unresolved_critical");
  });
});
