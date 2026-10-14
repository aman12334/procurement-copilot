# Stage 4 decision evaluation

16/16 property checks passed

| Check | Result | Detail |
|---|---|---|
| Failed vendors never recommended | ✅ | recommended suppliers VND-1002, VND-1001; GT failed VND-1004 |
| Failed vendors excluded from every qualified scenario | ✅ | SCN-001..006 |
| Single source = cheapest qualified full-coverage vendor | ✅ | VND-1001 (full-coverage qualified: VND-1001) |
| Cheapest qualified vendor (GT) holds the largest share of the per-line split | ✅ | largest VND-1002 71.7%; GT cheapest qualified VND-1002 |
| Max-2 uses ≤2 suppliers and covers all lines | ✅ | 2 suppliers |
| Max-3 uses ≤3 suppliers | ✅ | 3 |
| Per-line ≤ max-3 ≤ max-2 ≤ single source (cost) | ✅ | 117674450 ≤ 117674450 ≤ 117694450 ≤ 126041850 |
| Quality-first: within 5% and higher technical score; technically strongest vendor (GT) has the largest share | ✅ | cost 123504850 vs ceiling 123558173; tech 91.6; top VND-1003; GT strongest VND-1003 |
| Historical benchmark from the buyer's historical file | ✅ | 118850100 vs 118850100 |
| Savings = historical − evaluated | ✅ | 1155650 |
| Recommendation total equals scenario engine total | ✅ | Lowest cost, max 2 suppliers: total evaluated cost ₹11,76,94,450 across all 30 lines with 2 supplier(s) (Vendor 2 (Shree |
| Alternative cost delta is exact | ✅ | 5810400 |
| Concentration shares sum to 100% and lines to 30 | ✅ | 100% |
| Missing freight is never fabricated (estimated & flagged) | ✅ | CP-003 rfx_loading |
| Unresolved-critical exclusion when the constraint is active | ✅ | line:CP-011:duplicate_quote unresolved → V2 excluded: true |
| Sensitivity: qualifying the cheapest failed vendor changes the recommendation | ✅ | Vendor 4 (Sri Vaigai Corrugators) becomes technically qualified: -7097200 |

## Scenarios
| ID | Name | Status | Cost | Savings | Suppliers | Tech |
|---|---|---|---|---|---|---|
| SCN-001 | Best single-source award | complete | ₹12,60,41,850 | -6.1% | VND-1001 100% | 89 |
| SCN-002 | Cheapest qualified supplier per line | complete | ₹11,76,74,450 | 1% | VND-1002 71.7%, VND-1001 23%, VND-1003 5.4% | 83.5 |
| SCN-003 | Lowest cost, max 2 suppliers | complete | ₹11,76,94,450 | 1% | VND-1002 71.6%, VND-1001 28.4% | 83.3 |
| SCN-004 | Lowest cost, max 3 suppliers | complete | ₹11,76,74,450 | 1% | VND-1002 71.7%, VND-1001 23%, VND-1003 5.4% | 83.5 |
| SCN-005 | Quality-first (≤5% above cheapest, max 3 suppliers) | complete | ₹12,35,04,850 | -3.9% | VND-1003 69.8%, VND-1001 18.6%, VND-1002 11.6% | 91.6 |
| SCN-006 | Risk-adjusted (no unresolved critical issues, ≥50% coverage) | complete | ₹11,76,74,450 | 1% | VND-1002 71.7%, VND-1001 23%, VND-1003 5.4% | 83.5 |

## Recommendation: SCN-003 Lowest cost, max 2 suppliers
- **R1 coverage** 6/6 scenarios cover all 30 lines; incomplete: none.
- **R2 qualification** 6 complete scenarios award only technically qualified vendors (mandatory requirements enforced).
- **R3 lowest cost** Lowest-cost qualified complete scenario: SCN-002 Cheapest qualified supplier per line at ₹11,76,74,450.
- **R4 unresolved critical** SCN-002 has no unresolved critical dependencies.
- **R5 consolidation** SCN-003 uses 2 supplier(s) instead of 3 for +0% (≤1%) – preferred.
- **R6 concentration** Largest supplier share 71.6% is within the 80% limit.

## Sensitivity
- Vendor 2 (Shree Ganesh Packwell Pvt. Ltd.) prices rise 5%: no change (3951200)
- Remove Vendor 2 (Shree Ganesh Packwell Pvt. Ltd.): changes (6725700)
- USD strengthens 5% (₹92.93): no change (0)
- Vendor 4 (Sri Vaigai Corrugators) becomes technically qualified: changes (-7097200)
- Vendor 5 (Godavari Packaging Works) becomes technically qualified: no change (0)
- Freight for 'extra/at actuals' lines assumed at 8% instead of the RFx 5% loading: no change (1293000)
