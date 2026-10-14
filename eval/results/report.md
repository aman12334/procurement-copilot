# Bid Processing – offline evaluation

Generated 2026-10-13T19:32:30.823Z

| Response | Type | Lines found | Raw price | UoM | Currency | Normalized | Freight | Questionnaire | Tech score | Review flags P/R |
|---|---|---|---|---|---|---|---|---|---|---|
| VND-1001 | xlsx | 30/30 (P 100%) | 100% | 100% | 100% | 100% | 100% | 100% | 89 vs 89 (status ✓) | 50% / 100% |
| VND-1002 | pdf | 27/27 (P 100%) | 100% | 100% | 100% | 100% | 100% | 100% | 81 vs 81 (status ✓) | 100% / 100% |
| VND-1003 | docx | 29/29 (P 100%) | 100% | 100% | 100% | 100% | 100% | 100% | 94 vs 94 (status ✓) | 100% / 100% |
| VND-1004 | image | 28/28 (P 100%) | 100% | 100% | 100% | 100% | 100% | 85.7% | 46 vs 44 (status ✓) | 100% / 100% |
| VND-1004__vendor_4_rate_card_angled | image | 28/28 (P 100%) | 100% | 100% | 100% | 100% | 100% | 85.7% | 46 vs 44 (status ✓) | 100% / 100% |
| VND-1004__vendor_4_rate_card_glare | image | 28/28 (P 100%) | 100% | 100% | 100% | 100% | 100% | 85.7% | 47 vs 44 (status ✓) | 100% / 100% |
| VND-1004__vendor_4_rate_card_partial | image | 28/28 (P 100%) | 100% | 100% | 100% | 100% | 100% | 85.7% | 49 vs 44 (status ✓) | 100% / 100% |
| VND-1005 | email | 20/20 (P 100%) | 100% | 100% | 100% | 100% | 100% | 92.9% | 68 vs 71 (status ✗) | 100% / 100% |

## Edge cases
Detected 29/32 (recall 90.6%); HITL-expected recall 91.7%

- ✅ EC-01 Missing SKUs across vendors
- ✅ EC-02 Comments embedded in Excel cells
- ✅ EC-03 Vendor quotes 27 of 30 lines
- ✅ EC-04 USD-denominated quote
- ✅ EC-05 Price per 100 pieces
- ✅ EC-06 Rate card partitions/pads per 100 nos (asterisk footnote)
- ✅ EC-07 'Per box' unit
- ✅ EC-08 Freight condition buried in footnote
- ✅ EC-09 Per-kg pricing
- ✅ EC-10 MOQ constraints
- ✅ EC-11 MOQ described in prose, not table
- ❌ EC-12 Lead-time condition in prose
- ✅ EC-13 Ambiguous image-based price (handwritten correction)
- ✅ EC-14 Possible price outlier
- ✅ EC-15 Duplicated SKU with mismatched description and price
- ✅ EC-16 Slightly mismatched SKU description
- ✅ EC-17 Reference to last year's pricing
- ❌ EC-18 Conflicting commercial term – table vs note
- ✅ EC-19 Discount condition buried in note
- ❌ EC-20 Hard-to-read row in image
- ✅ EC-21 Quote not meeting mandatory spec (uncoated)
- ✅ EC-22 Missing mandatory certification / failed questionnaire
- ✅ EC-23 Strong pricing but poor technical qualification
- ✅ EC-24 Different price-validity periods
- ✅ EC-25 Payment terms outside the main table
- ✅ EC-26 Unclear condition
- ✅ EC-27 Freight excluded
- ✅ EC-28 Renamed columns, reordered lines, freight in separate column
- ✅ EC-29 Shorthand item references
- ✅ EC-30 Unquantified tooling charges
- ✅ EC-31 Lines split across PDF pages
- ✅ EC-32 Image quality variants

## Exceptions (line level, 5 primary responses)
Precision 88.9% · Recall 100% · False-review rate 0.7%

## HITL simulation
| Vendor | Open before | Open after | Corrections | Values preserved | Downstream recomputed | Finalized |
|---|---|---|---|---|---|---|
| VND-1001 | 3 | 0 | 0 | ✓ | ✓ | ✓ |
| VND-1002 | 5 | 0 | 1 | ✓ | ✓ | ✓ |
| VND-1003 | 1 | 0 | 0 | ✓ | ✓ | ✓ |
| VND-1004 | 5 | 0 | 0 | ✓ | ✓ | ✓ |
| VND-1005 | 8 | 0 | 0 | ✓ | ✓ | ✓ |

## Misses
### VND-1001
- none

### VND-1002
- none

### VND-1003
- CP-015: lead 14 vs 28
- CP-017: lead 14 vs 28

### VND-1004
- Q11: none/0 vs unanswered/0
- Q13: partial/2 vs unanswered/0

### VND-1004__vendor_4_rate_card_angled
- Q09: partial/5 vs 1_of_3_plants_within_350km/3
- Q11: none/0 vs unanswered/0

### VND-1004__vendor_4_rate_card_glare
- Q08: full/6 vs partial/3
- Q11: none/0 vs unanswered/0

### VND-1004__vendor_4_rate_card_partial
- Q09: partial/8 vs 1_of_3_plants_within_350km/3
- Q11: none/0 vs unanswered/0

### VND-1005
- CP-016: moq null vs 5000
- CP-017: moq null vs 5000
- Q12: none/0 vs partial/3
