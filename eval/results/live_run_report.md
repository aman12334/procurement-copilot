# Live end-to-end run

| | |
|---|---|
| Status | **passed** |
| Model | gpt-6-luna |
| Prompt versions | {"rfx":"rfx-system.v2","bid_extraction":"bid-extraction.v3","analyst":"analyst.v3"} |
| Vendor fixture | VND-1003 (Indus Fibreboard – DOCX) |
| LLM calls | 2 |
| Retries | 0 |
| Job states | received → queued → completed |

## identity
```json
{
  "status": "matched",
  "vendor": "VND-1003",
  "rfx": "SCPL/PKG/RFQ/2026-27/014",
  "summary": "Matched Indus Fibreboard Solutions Ltd. (sender is known POC ananya.reddy@indusfibreboard.example; vendor name in message/attachments (Indus, Fibreboard)) and RFx ID SCPL/PKG/RFQ/2026-27/014 found."
}
```

## processing_result
```json
{
  "quoted_lines": "29/30",
  "missing": [
    "CP-021"
  ],
  "technical": "94/100 QUALIFIED",
  "usd_lines": [
    "CP-028 USD 0.74 per piece → ₹65.49",
    "CP-029 USD 1.93 per piece → ₹170.81",
    "CP-030 USD 4.13 per piece → ₹365.51"
  ]
}
```

## exceptions_found
```json
[
  "terms:validity:conflicting_values [major] Price validity is stated differently in 2 places (2026-12-31 vs 2027-01-07). Earliest date suggested as the conservative value.",
  "terms:14:ambiguous_text [minor] Unquantified price_escalation condition: \"Given the expected revision in kraft paper prices from January\".",
  "line:CP-014:specification_mismatch [major] CP-014: Vendor dimensions are 450 x 350 x 300; RFx dimensions are 450 x 350 x 250."
]
```

## hitl_action
```json
{
  "item": "terms:validity:conflicting_values",
  "action": "accept",
  "suggested": "2026-12-31",
  "open_before": 3,
  "open_after": 2,
  "audit_record": {
    "review_item_id": "terms:validity:conflicting_values",
    "action": "accept",
    "model_extracted_value": "2026-12-31 | 2027-01-07",
    "human_corrected_value": null,
    "final_value": "2026-12-31",
    "resolution": "human_accepted",
    "note": "live e2e: buyer accepted suggested value",
    "at": "2026-10-14T00:14:40.929Z"
  }
}
```

## downstream_recomputation
```json
{
  "ok": true,
  "finalized": true,
  "comparison": [
    "VND-1001: 30 lines, tech 89, ₹126041850",
    "VND-1002: 27 lines, tech 81, ₹101334900",
    "VND-1004: 28 lines, tech 46, ₹100201500",
    "VND-1005: 20 lines, tech 68, ₹75820200",
    "VND-1003: 29 lines, tech 94, ₹125468650"
  ],
  "recommended": "SCN-003 Lowest cost, max 2 suppliers ₹117694450 (VND-1002, VND-1001)",
  "vendor3_in_recommendation": false
}
```

## analyst
```json
{
  "question": "Why is Vendor 3 not currently the recommended supplier, and what would need to change for it to become competitive?",
  "tools": [
    "explain_vendor_exclusion",
    "run_sensitivity"
  ],
  "citations": [
    "T1",
    "T2"
  ],
  "invalid_citations": [],
  "unsupported_numbers": [],
  "grounded": true,
  "answer": "Vendor 3 (Indus Fibreboard Solutions Ltd.) is qualified, with no mandatory failures, and is eligible for consideration. It is not recommended in SCN-003 because the scenario allows a maximum of two suppliers and other suppliers provide a lower total; this is not an exclusion based on qualification. Vendor 3 is cheaper than an awarded supplier on CP-015, but that does not outweigh the overall supplier-limit decision [T1].\n\nThe sensitivity test shows one change that would make Vendor 3 competitive in this scenario: a modeled 5% reduction in its prices changes the recommended suppliers from Vendor 2 and Vendor 1 to Vendor 2 and Vendor 3. The reported scenario cost changes from 117,694,450 to 117,255,850, with a reported delta of -438,600 [T2]. These are sensitivity results, not a confirmed offer or an award."
}
```
