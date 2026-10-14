# Stage 1 – Synthetic Corrugated Packaging Sourcing Event

**Buyer:** Sahyadri Consumer Products Pvt. Ltd. (SCPL), a fictional Indian FMCG manufacturer with plants in Bengaluru (Hoskote), Pune (Chakan) and Hyderabad (Patancheru)
**Event:** `SCPL/PKG/RFQ/2026-27/014`, the annual rate contract for corrugated packaging. Issued 21-Sep-2026, responses due 12-Oct-2026.
**Scope:** 30 lines (3/5/7-ply RSC, printed, die-cut, partitions, pads, sleeve, export cartons), about 6.83 M units (6,825,000) and about 2,213 MT a year. Historical spend is about ₹11.9 Cr.

All names, GSTINs, emails (`*.example`) and certificate numbers are fictitious.

## Layout

```
stage1/
├── buyer/                      what the buyer issued
│   ├── rfx_master.xlsx / .csv  30 lines: specs, GSM/BF, BS, recycled %, print, plant, qty, reference box weight
│   ├── buyer_requirements.json BR-01..BR-20 (mandatory/preferred), evaluation rules, FX, freight loading
│   ├── technical_questionnaire.json  14 questions, 100 pts, mandatory Q01/Q04/Q05/Q06/Q10, threshold 70
│   ├── commercial_terms.json   response fields + standard terms + deviation rules
│   └── historical_reference_prices.csv  FY25-26 delivered price for all 30 lines (+ last-year supplier)
├── vendors/                    messy vendor responses (no ground truth inside)
│   ├── vendor_1/  Deccan Corrupack – Excel (.xlsx)
│   ├── vendor_2/  Shree Ganesh Packwell – PDF on letterhead (3 pages)
│   ├── vendor_3/  Indus Fibreboard – Word (.docx), tables + prose
│   ├── vendor_4/  Sri Vaigai Corrugators – printable rate card (.html + .pdf), source of the images
│   └── vendor_5/  Godavari Packaging – plain-text email
├── images/                     Vendor 4 rate card captured in Chrome and then degraded
│   ├── vendor_4_rate_card_clear.png
│   ├── vendor_4_rate_card_angled.png
│   ├── vendor_4_rate_card_partial.png
│   └── vendor_4_rate_card_glare.png
├── ground_truth/               HIDDEN – evaluation only
│   ├── canonical_vendor_bids.json   per vendor: header terms, deviations, qualification, 30 line records, evaluation answers
│   ├── normalized_line_items.csv    150 rows (5 vendors × 30 lines), flat
│   ├── vendor_qualification.json    per-question answers, points, mandatory failures, status
│   └── edge_case_manifest.json      32 planted edge cases with expected interpretation/confidence/HITL
└── _build/                     deterministic generator (contains ground truth logic – keep away from the agent)
    ├── run_all.sh              rebuilds everything + runs validate.py
    └── model.py, ground_truth.py, edge_cases.py, vendors.py, make_images.py, validate.py
```

## Normalization conventions (used by the ground truth)

- **Basis:** INR per piece (per set for partitions), ex-GST, delivered to the plant.
- **Units:** `per box` = 1 piece. `per 100 nos` ÷ 100. `per kg` × `reference_weight_g`/1000 from `rfx_master`.
- **FX:** 1 USD = ₹88.50, the fixed evaluation rate in the RFx. The vendor's own indicative rate is ignored.
- **Freight:** quoted freight is added to the price. Where freight is excluded or charged "at actuals", a 5% loading is added (BR-10).
- **Conditional discounts and rebates** are not applied to the normalized price. They are recorded at vendor level.
- **Ambiguous duplicates** use the conservative (higher) price. Conflicting validity dates use the earlier date.

## Rebuild / verify

```bash
./_build/run_all.sh
```
